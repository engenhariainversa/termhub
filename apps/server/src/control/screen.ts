import { captureScreen, captureStyledScreen } from '../agent/screen.js';
import { agents } from '../agent/registry.js';
import type { Tab, TabState } from '../db/repositories/types.js';
import { HttpError } from '../lib/errors.js';
import { monitorBus } from '../monitor/bus.js';
import { HOOK_TOOLS, LAST_ANSWER_MAX } from '../monitor/state.js';
import { renderStyled } from '../terminal/ansi.js';
import { ControlError, type ControlContext } from './context.js';

export const SCREEN_DEFAULT_LINES = 200;
export const SCREEN_MAX_LINES = 2000;
export const WAIT_DEFAULT_SECONDS = 60;
export const WAIT_MAX_SECONDS = 90;
export const ANSWER_DEFAULT_CHARS = 20_000;
export const ANSWER_MAX_CHARS = 60_000;
export const NO_ANSWER_NOTE = 'Esta aba não tem resposta registrada pelos hooks (hooks não instalados na máquina, ou nenhum turno terminou). Use read_screen para ver o terminal.';
export const FULL_SCREEN_NOTE = 'Se esta aba roda um agente de tela cheia (Claude Code, Codex ou Cursor), o que saiu do topo não está no histórico do tmux. Com os hooks instalados na máquina, read_last_answer traz a última resposta completa.';

/** Shared by every control op that talks to a machine (spec §4.4: "nothing is queued for offline machines"). */
export const offline = () => new ControlError('MACHINE_OFFLINE', 'A máquina está offline: o termhub-agent dela não está conectado');

/** Shared clamp for every "how many seconds/lines" input across the control ops. */
export const clamp = (v: number | undefined, def: number, max: number) => Math.max(1, Math.min(max, Math.trunc(v ?? def)));

/** Shared guard: only a terminal tab (one with a tmux session) can be read from or written to. */
export function assertTerminal(tab: Tab): asserts tab is Tab & { tmux_session: string } {
  if (tab.kind !== 'terminal' || !tab.tmux_session) throw new ControlError('NOT_A_TERMINAL', 'Esta aba não é um terminal');
}

/** A tab that may be drawing the whole screen: its last reported tool is one of the hook tools, or it
 *  has no state at all (no hooks, or nothing ever ran there). `state_tool` outlives the agent, which is
 *  why the note is worded as a condition. */
const maybeFullScreen = (tab: Tab): boolean => tab.state === null || (HOOK_TOOLS as readonly string[]).includes(tab.state_tool ?? '');

/**
 * Last lines of a terminal tab (spec 2026-09-25 tab suggestions §5): dimmed runs come back as ⟦…⟧, so
 * Claude Code's suggested prompt never reads as typed text. `styled: false` when the machine could not
 * keep the attributes (an agent older than 0.5.2). `plain` is for the server's own screen checks, which
 * compare plain text. Never logged.
 */
export async function readScreen(
  ctx: ControlContext,
  input: { tab_id: string; lines?: number },
  opts: { plain?: boolean } = {},
): Promise<{ tab_id: string; lines: number; text: string; styled: boolean; note?: string }> {
  const { tab, machine } = await ctx.scoped.tab(input.tab_id);
  assertTerminal(tab);
  // A moving agent (a deploy) gets a few seconds to attach before this answers "offline" (spec §5.3).
  if (machine.type === 'agent' && !(await agents.awaitAgent(machine))) throw offline();
  const lines = clamp(input.lines, SCREEN_DEFAULT_LINES, SCREEN_MAX_LINES);
  try {
    if (opts.plain) return { tab_id: tab.id, lines, text: await captureScreen(machine, tab.tmux_session, lines), styled: false };
    const shot = await captureStyledScreen(machine, tab.tmux_session, lines);
    return { tab_id: tab.id, lines, text: shot.styled ? renderStyled(shot.text) : shot.text, styled: shot.styled, ...(maybeFullScreen(tab) ? { note: FULL_SCREEN_NOTE } : {}) };
  } catch (e) {
    // agentRpc turns a connection that dropped mid-call into a bare 503 (toHttpError)
    if (e instanceof HttpError && e.statusCode === 503) throw offline();
    throw e;
  }
}

export type LastAnswerResult =
  | { tab_id: string; source: 'hook'; tool: string; at: string; text: string; offset: number; next_offset: number | null; chars: number; cut: boolean; stale: boolean; state: TabState | null; state_at: string | null }
  | { tab_id: string; text: null; note: string };

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/** The end of a page, never between the two halves of a surrogate pair: it moves back one unit, so the
 *  next page starts on the pair, unless that would leave the page empty, then it takes the pair whole. */
function pageEnd(text: string, offset: number, size: number): number {
  const end = Math.min(text.length, offset + size);
  if (end >= text.length || !isHigh(text.charCodeAt(end - 1)) || !isLow(text.charCodeAt(end))) return end;
  return end - 1 > offset ? end - 1 : end + 1;
}

/**
 * The final message of the agent's last turn in a tab (spec 2026-09-30 last answer), as its hooks
 * delivered it, in pages of at most ANSWER_MAX_CHARS. A read of the database only: no key to the
 * terminal, no card, and the machine may be offline. Never logged. `cut` says the stored answer was
 * capped; `stale` that a turn started after it.
 */
export async function readLastAnswer(ctx: ControlContext, input: { tab_id: string; offset?: number; max_chars?: number }): Promise<LastAnswerResult> {
  const { tab } = await ctx.scoped.tab(input.tab_id);
  const answer = await ctx.repos.tabs.readLastAnswer(tab.id);
  if (!answer) return { tab_id: tab.id, text: null, note: NO_ANSWER_NOTE };
  const offset = Math.max(0, Math.trunc(input.offset ?? 0));
  const size = clamp(input.max_chars, ANSWER_DEFAULT_CHARS, ANSWER_MAX_CHARS);
  const text = answer.text.slice(offset, pageEnd(answer.text, offset, size));
  const end = offset + text.length;
  return {
    tab_id: tab.id,
    source: 'hook',
    tool: answer.tool,
    at: answer.at,
    text,
    offset,
    next_offset: end < answer.text.length ? end : null,
    chars: answer.text.length,
    cut: answer.text.length === LAST_ANSWER_MAX && answer.text.endsWith('…'),
    stale: answer.stale,
    state: tab.state,
    state_at: tab.state_at,
  };
}

export interface WaitResult {
  tab_id: string;
  state: TabState | null;
  state_text: string | null;
  state_at: string | null;
  timed_out: boolean;
  note?: string;
}

const result = (tab: Tab, timedOut: boolean): WaitResult => ({ tab_id: tab.id, state: tab.state, state_text: tab.state_text, state_at: tab.state_at, timed_out: timedOut });

/**
 * Waits until the tab's tool stops working (reported by its hooks) or the timeout. A timeout is a
 * normal answer (`timed_out: true`), not an error — call again to keep waiting. Aborting (client
 * gone) ends the wait the same way and always removes the bus listener.
 *
 * An agent that ended its turn while its own background work runs (`waiting_background`, TER-644) has
 * not stopped: its next turn starts when that work reports, so the wait goes on through it, unless
 * `return_on_background` asks to hear about it.
 */
export async function waitForState(ctx: ControlContext, input: { tab_id: string; timeout_seconds?: number; return_on_background?: boolean }, signal?: AbortSignal): Promise<WaitResult> {
  const { tab } = await ctx.scoped.tab(input.tab_id);
  if (tab.state === null) {
    return { ...result(tab, false), note: 'Esta aba não tem estado do monitor (hooks não instalados na máquina ou nenhuma ferramenta rodou nela). Use read_screen para ver o terminal.' };
  }
  const busy = (state: TabState | null) => state === 'working' || (state === 'waiting_background' && !input.return_on_background);
  if (!busy(tab.state)) return result(tab, false);

  const timeoutMs = clamp(input.timeout_seconds, WAIT_DEFAULT_SECONDS, WAIT_MAX_SECONDS) * 1000;
  return new Promise<WaitResult>((resolve) => {
    let last = tab;
    let done = false;
    const finish = (r: WaitResult) => {
      if (done) return;
      done = true;
      unsubscribe();
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(r);
    };
    const unsubscribe = monitorBus.subscribe((change) => {
      if (change.tab.id !== tab.id) return;
      last = change.tab;
      if (!busy(change.tab.state)) finish(result(change.tab, false));
    });
    const timer = setTimeout(() => finish(result(last, true)), timeoutMs);
    const onAbort = () => finish(result(last, true));
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    // The tab may have left working between the read above and the subscription; a failed re-read just keeps waiting.
    ctx.repos.tabs.findById(tab.id).then(
      (now) => {
        if (now && !busy(now.state)) finish(result(now, false));
      },
      () => {},
    );
  });
}
