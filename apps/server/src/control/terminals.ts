import type { TmuxKey } from '@termhub/agent-protocol';
import { requireAgentVersion } from '../agent/errors.js';
import { agents } from '../agent/registry.js';
import { captureScreen } from '../agent/screen.js';
import type { Machine, Tab, TabState } from '../db/repositories/types.js';
import { HttpError } from '../lib/errors.js';
import { nextTerminalName } from '../lib/tab-names.js';
import { killTmuxSession } from '../terminal/machine-exec.js';
import { ensureSession, INPUT_MAX_CHARS, sendKeyToSession, sendTextToSession, TERMINAL_RPC_MIN_AGENT_VERSION } from '../terminal/session-ops.js';
import { ControlError, type ControlContext } from './context.js';
import { assertTerminal, clamp, offline, SCREEN_DEFAULT_LINES, SCREEN_MAX_LINES, waitForState } from './screen.js';
import { publicBus } from '../public/bus.js';
import { publishTabOpened, publishTabRemoved } from '../monitor/tab-events.js';

export { INPUT_MAX_CHARS };

/** Tabs one token may keep open at a time (spec §4.2): a runaway loop cannot bury the project in tabs. */
export const MAX_TABS_PER_TOKEN = 10;
export const RUN_DEFAULT_SECONDS = 30;
export const RUN_MAX_SECONDS = 90;
const SETTLE_POLL_MS = 1000;
/** Budget-bounded window given to the hook to mark the tab "working" right after we typed a command,
 * before falling back to the screen poll (spec §4.2 line 118: run_command must actually wait). */
const WORKING_WAIT_MS = 2 * SETTLE_POLL_MS;

/** Online and new enough to answer the terminal RPCs — checked before anything is created or typed. */
function assertReady(machine: Machine): void {
  if (machine.type !== 'agent') return;
  if (!agents.isOnline(machine.id)) throw offline();
  requireAgentVersion(machine, TERMINAL_RPC_MIN_AGENT_VERSION); // HttpError 409 AGENT_OUTDATED
}

/** A terminal tab with a session name, on a machine that can answer right now. */
async function terminal(ctx: ControlContext, tabId: string): Promise<{ tab: Tab; machine: Machine; cwd: string; session: string }> {
  const { tab, machine, cwd } = await ctx.scoped.tab(tabId);
  assertTerminal(tab);
  assertReady(machine);
  return { tab, machine, cwd, session: tab.tmux_session };
}

/** No hooks report state (or they never marked the tab "working" for this command): settle by
 * screen instead — two identical captures in a row mean nothing is moving. Mirrors the exact
 * abort/deadline semantics of the original single-branch loop: aborting or two matching captures
 * resolve as "not timed out", only running past the deadline sets `timed_out`. */
async function settleByScreen(machine: Machine, session: string, lines: number, deadline: number, signal?: AbortSignal): Promise<boolean> {
  let previous: string | null = null;
  for (;;) {
    if (signal?.aborted) return false;
    const now = await captureScreen(machine, session, lines);
    if (previous !== null && now === previous) return false;
    previous = now;
    if (Date.now() + SETTLE_POLL_MS >= deadline) return true;
    await new Promise((r) => setTimeout(r, SETTLE_POLL_MS));
  }
}

/** Opens a tab and starts its tmux session detached, so it is alive without a browser attached. */
export async function openTab(
  ctx: ControlContext,
  input: { project_id: string; machine_id?: string; name?: string },
): Promise<{ tab_id: string; name: string; project_id: string; machine_id: string; tmux_session: string | null; created: boolean }> {
  const { project, machine, link } = await ctx.scoped.projectMachineFor(input.project_id, input.machine_id);
  assertReady(machine);

  if (ctx.token) {
    const open = await ctx.repos.tabs.countOpenByToken(ctx.token.id);
    if (open >= MAX_TABS_PER_TOKEN) {
      throw new ControlError('TAB_LIMIT', `Este token já tem ${open} abas abertas (limite de ${MAX_TABS_PER_TOKEN}): feche alguma com close_tab antes de abrir outra`);
    }
  }

  const existing = await ctx.repos.tabs.listByProject(project.id);
  const name = input.name?.trim() || nextTerminalName(existing.map((t) => t.name));
  const tab = await ctx.repos.tabs.create(project.id, machine.id, name, { created_by_token_id: ctx.token?.id ?? null });
  publishTabOpened(tab, machine);

  try {
    const { created } = await ensureSession(machine, tab.tmux_session as string, link.cwd);
    return { tab_id: tab.id, name: tab.name, project_id: project.id, machine_id: machine.id, tmux_session: tab.tmux_session, created };
  } catch (e) {
    // The tab is kept on purpose (spec §4.4): the error carries its id so the screen can be inspected.
    // The original code travels with it, so the audit row says what actually failed.
    const code = e instanceof ControlError || e instanceof HttpError ? (e.code ?? 'SESSION_FAILED') : 'SESSION_FAILED';
    throw new ControlError(
      code,
      `A aba ${tab.id} foi criada, mas a sessão tmux não subiu: ${e instanceof Error ? e.message : 'erro desconhecido'}. Se não for usá-la, feche-a com close_tab.`,
    );
  }
}

/** Types text into the tab. `enter` defaults to true: the point is almost always to submit it. */
export async function sendInput(ctx: ControlContext, input: { tab_id: string; text: string; enter?: boolean; answering_permission?: boolean }): Promise<{ tab_id: string; sent: true }> {
  if (input.text.length > INPUT_MAX_CHARS) throw new ControlError('TEXT_TOO_LONG', `Texto longo demais: ${input.text.length} caracteres, máximo ${INPUT_MAX_CHARS}`);
  const { tab, machine, cwd, session } = await terminal(ctx, input.tab_id);
  if (tab.state === 'waiting_permission' && !input.answering_permission) {
    throw new ControlError('WAITING_PERMISSION', `Esta aba está esperando uma permissão: "${tab.state_text ?? 'pergunta não registrada'}". Se a sua resposta é para essa pergunta, repita com answering_permission: true.`);
  }
  await ensureSession(machine, session, cwd);
  const enter = input.enter ?? true;
  // An embedded newline means a multi-line prompt: paste it so the TUI reads the newline as part
  // of the text, not as Enter submitting a half-typed line (spec: bracketed paste).
  if (input.text.includes('\n')) {
    await sendTextToSession(machine, session, input.text, enter, { paste: true });
  } else {
    await sendTextToSession(machine, session, input.text, enter);
  }
  return { tab_id: tab.id, sent: true };
}

/** Presses one key from the closed list in the tab. */
export async function sendKey(ctx: ControlContext, input: { tab_id: string; key: TmuxKey }): Promise<{ tab_id: string; key: TmuxKey; sent: true }> {
  const { tab, machine, cwd, session } = await terminal(ctx, input.tab_id);
  await ensureSession(machine, session, cwd);
  await sendKeyToSession(machine, session, input.key);
  return { tab_id: tab.id, key: input.key, sent: true };
}

/**
 * Types a command, presses Enter and comes back with the screen once the tab settles. There is no
 * exit code — this is an interactive session, not a process runner. A command still running when the
 * timeout hits is not an error: the screen comes back with `timed_out: true`.
 */
export async function runCommand(
  ctx: ControlContext,
  input: { tab_id: string; command: string; timeout_seconds?: number; lines?: number },
  signal?: AbortSignal,
): Promise<{ tab_id: string; state: TabState | null; timed_out: boolean; lines: number; text: string }> {
  const { tab, machine, cwd, session } = await terminal(ctx, input.tab_id);
  // run_command is send_input + Enter (spec §4.2 line 118); the permission guard on send_input
  // (line 116) applies here too, but there is no answering_permission for run_command — the pending
  // question must be settled with send_input or send_key first.
  if (tab.state === 'waiting_permission') {
    throw new ControlError(
      'WAITING_PERMISSION',
      `Esta aba está esperando uma permissão: "${tab.state_text ?? 'pergunta não registrada'}". Responda com send_input (answering_permission: true) ou send_key antes de rodar um comando.`,
    );
  }
  if (input.command.length > INPUT_MAX_CHARS) throw new ControlError('TEXT_TOO_LONG', `Comando longo demais: ${input.command.length} caracteres, máximo ${INPUT_MAX_CHARS}`);
  const timeoutMs = clamp(input.timeout_seconds, RUN_DEFAULT_SECONDS, RUN_MAX_SECONDS) * 1000;
  const lines = clamp(input.lines, SCREEN_DEFAULT_LINES, SCREEN_MAX_LINES);

  await ensureSession(machine, session, cwd);
  await sendTextToSession(machine, session, input.command, true);

  const deadline = Date.now() + timeoutMs;
  let timedOut: boolean;
  let state: TabState | null = null;

  if (tab.state !== null) {
    // The machine has monitor hooks, but the tab we read above is from BEFORE we typed the command:
    // the hook has not necessarily marked it "working" yet. Give it a short, budget-bounded window to
    // do so before delegating to waitForState; if it never does, fall back to the screen poll below —
    // run_command must always observe the tab actually settle, one way or the other.
    const workingDeadline = Math.min(deadline, Date.now() + WORKING_WAIT_MS);
    let current: Tab | undefined = tab;
    while (current && current.state !== 'working' && !signal?.aborted && Date.now() < workingDeadline) {
      await new Promise((r) => setTimeout(r, SETTLE_POLL_MS));
      current = await ctx.repos.tabs.findById(tab.id);
    }
    if (current?.state === 'working') {
      const waited = await waitForState(ctx, { tab_id: tab.id, timeout_seconds: Math.max(1, Math.ceil((deadline - Date.now()) / 1000)) }, signal);
      timedOut = waited.timed_out;
      state = waited.state;
    } else {
      state = current?.state ?? tab.state;
      timedOut = await settleByScreen(machine, session, lines, deadline, signal);
    }
  } else {
    // No hooks at all: settle on the screen instead.
    timedOut = await settleByScreen(machine, session, lines, deadline, signal);
  }

  return { tab_id: tab.id, state, timed_out: timedOut, lines, text: await captureScreen(machine, session, lines) };
}

/** Kills the tab's session and removes it. A person's own token closes only the tabs it opened,
 * unless `force`. A gated (chat) token skips that check: the chat gate asked the user for this very
 * call, and its card says whose tab it is (TER-184) — the concierge's token rotates every run, so
 * "opened by this token" would never hold for a tab from an earlier run. */
export async function closeTab(ctx: ControlContext, input: { tab_id: string; force?: boolean }): Promise<{ tab_id: string; killed: boolean }> {
  const { tab, machine } = await ctx.scoped.tab(input.tab_id);
  if (!input.force && ctx.token && !ctx.token.gated && tab.created_by_token_id !== ctx.token.id) {
    throw new ControlError('NOT_YOURS', 'Esta aba não foi aberta por este token: repita com force: true se quer fechá-la mesmo assim');
  }
  let killed = false;
  if (tab.tmux_session) {
    try {
      killed = await killTmuxSession(machine, tab.tmux_session);
    } catch {
      // An unreachable machine must not leave the tab behind; the row goes either way.
      killed = false;
    }
  }
  await ctx.repos.tabs.delete(tab.id);
  publicBus.publishTabRemoved({ tab_id: tab.id, project_id: tab.project_id, machine_id: machine.id });
  publishTabRemoved(tab, machine);
  return { tab_id: tab.id, killed };
}
