import { randomUUID } from 'node:crypto';
import { type TmuxKey } from '@termhub/agent-protocol';
import { buildPaneForegroundScript, buildScrollScript, parsePaneForeground, type PaneForeground } from '@termhub/machine-ops';
import { agentRpc, requireAgentVersion, requireTranscriptCapable } from '../agent/errors.js';
import type { Machine } from '../db/repositories/types.js';
import { HttpError } from '../lib/errors.js';
import { REMOTE_PATH_PREFIX, assertSessionName, runOnMachine, shellQuote } from './machine-exec.js';

/** The agent release that answers tmux.ensure / tmux.sendText / tmux.sendKey (spec §4.3). */
export const TERMINAL_RPC_MIN_AGENT_VERSION = '0.2.0';

/**
 * The agent release that understands `tmux.sendText`'s `paste` field. An older agent silently
 * drops an unknown field and would type a multi-line prompt as keystrokes — the exact bug a paste
 * request exists to avoid — so a paste is refused outright instead of degrading to typing.
 */
export const TERMINAL_PASTE_MIN_AGENT_VERSION = '0.3.0';

/** The agent release that answers `tmux.scroll` (TER-465): the mouse wheel over a terminal tab. */
export const TERMINAL_SCROLL_MIN_AGENT_VERSION = '0.12.0';

/** The agent release that answers `tmux.foreground` (TER-643): whether the tab's agent is still in front. */
export const TERMINAL_FOREGROUND_MIN_AGENT_VERSION = '0.14.0';

/** The largest text the monitor's input route (or a future MCP tool) may type in one call. */
export const INPUT_MAX_CHARS = 4000;

/** Pause between the typed text and the Enter that submits it: TUIs read a burst of bytes as a paste. */
const ENTER_PAUSE = '0.3';
const TIMEOUT_MS = 10_000;

/** Runs one tmux script on a local/ssh machine; the agent branch never reaches here. */
async function shell(machine: Machine, script: string): Promise<string> {
  const r = await runOnMachine(machine, { file: 'sh', args: ['-c', script] }, `${REMOTE_PATH_PREFIX}${script}`, TIMEOUT_MS);
  if (r.timedOut) throw new HttpError(504, 'A máquina não respondeu', 'MACHINE_TIMEOUT');
  if (r.code !== 0) throw new HttpError(502, r.stderr.trim().split('\n')[0] || 'Falha ao falar com o tmux da máquina', 'MACHINE_FAILED');
  return r.stdout;
}

/** Makes sure the tab's tmux session exists, detached, in the project's directory. Idempotent. */
export async function ensureSession(machine: Machine, session: string, cwd: string): Promise<{ created: boolean }> {
  assertSessionName(session);
  if (machine.type === 'agent') {
    requireAgentVersion(machine, TERMINAL_RPC_MIN_AGENT_VERSION);
    return agentRpc(machine, 'tmux.ensure', { session, cwd });
  }
  const name = shellQuote(session);
  const out = await shell(
    machine,
    `tmux has-session -t ${shellQuote(`=${session}`)} 2>/dev/null || { tmux new-session -d -s ${name} -c ${shellQuote(cwd)} && echo created; }`,
  );
  return { created: out.includes('created') };
}

/**
 * Types `text` literally into the session and, with `enter`, presses Enter on its own afterwards.
 * With `opts.paste`, `text` is delivered as one tmux paste instead of typed keystrokes, so a TUI
 * that understands bracketed paste reads an embedded newline as part of the pasted text rather
 * than as Enter (see tmux.ts's `pasteText` on the agent side for why).
 */
export async function sendTextToSession(machine: Machine, session: string, text: string, enter: boolean, opts?: { paste?: boolean }): Promise<void> {
  assertSessionName(session);
  const paste = opts?.paste ?? false;
  if (machine.type === 'agent') {
    requireAgentVersion(machine, paste ? TERMINAL_PASTE_MIN_AGENT_VERSION : TERMINAL_RPC_MIN_AGENT_VERSION);
    await agentRpc(machine, 'tmux.sendText', { session, text, enter, paste: paste || undefined });
    return;
  }
  const target = shellQuote(`=${session}:`);
  const parts: string[] = [];
  if (text) {
    if (paste) {
      // Mirrors tmux.ts's pasteText on the agent (see its comment for why a named buffer):
      // load-buffer/paste-buffer act on the most recent buffer when unnamed, and this text must
      // never carry into a concurrent paste on another tab. The whole thing is one `sh -c`
      // script, so the buffer's removal is sequenced with `; ` (not `&&`) to run unconditionally
      // — on a failed paste too — while still failing the fragment (and so the chain below,
      // skipping Enter) exactly when the paste itself failed.
      const bufferName = shellQuote(`termhub-paste-${randomUUID()}`);
      parts.push(
        `RC=0; { printf '%s' ${shellQuote(text)} | tmux load-buffer -b ${bufferName} - && tmux paste-buffer -p -d -b ${bufferName} -t ${target}; } || RC=$?; tmux delete-buffer -b ${bufferName} >/dev/null 2>&1; [ "$RC" -eq 0 ]`,
      );
    } else {
      parts.push(`tmux send-keys -t ${target} -l -- ${shellQuote(text)}`);
    }
  }
  if (enter) {
    if (text) parts.push(`sleep ${ENTER_PAUSE}`);
    parts.push(`tmux send-keys -t ${target} Enter`);
  }
  if (parts.length === 0) return;
  await shell(machine, parts.join(' && '));
}

/** Presses one key from the closed list (spec §4.2) in the session. */
export async function sendKeyToSession(machine: Machine, session: string, key: TmuxKey): Promise<void> {
  assertSessionName(session);
  if (machine.type === 'agent') {
    requireAgentVersion(machine, TERMINAL_RPC_MIN_AGENT_VERSION);
    // Shift+Tab joined the key list with the transcript capability; an older agent refuses it.
    if (key === 'BTab') requireTranscriptCapable(machine);
    await agentRpc(machine, 'tmux.sendKey', { session, key });
    return;
  }
  // `key` comes from TMUX_KEYS, so it is already a fixed token; quoting it keeps the rule "quote everything".
  await shell(machine, `tmux send-keys -t ${shellQuote(`=${session}:`)} ${shellQuote(key)}`);
}

/**
 * A mouse-wheel scroll over the tab (TER-465): `lines` < 0 up, > 0 down, 0 leaves copy-mode. The agent and
 * ssh/local run the same script (`buildScrollScript`), which checks the session name and line count and
 * quotes the target itself — it throws on a bad value before anything reaches the machine.
 */
export async function scrollSession(machine: Machine, session: string, lines: number): Promise<void> {
  const script = buildScrollScript(session, lines);
  if (machine.type === 'agent') {
    requireAgentVersion(machine, TERMINAL_SCROLL_MIN_AGENT_VERSION);
    await agentRpc(machine, 'tmux.scroll', { session, lines });
    return;
  }
  await shell(machine, script);
}

/**
 * What the tab's pane runs in front (TER-643): `shell` once the agent on top of it exited, `busy` while
 * anything else holds the terminal, `dead` for a pane whose process is gone. The agent and ssh/local run
 * the same script (`buildPaneForegroundScript`), which checks and quotes the session name. Throws like the
 * other operations (an outdated agent is AGENT_OUTDATED); an answer that is not one of the words is a
 * MACHINE_FAILED.
 */
export async function paneForeground(machine: Machine, session: string): Promise<PaneForeground> {
  const script = buildPaneForegroundScript(session);
  if (machine.type === 'agent') {
    requireAgentVersion(machine, TERMINAL_FOREGROUND_MIN_AGENT_VERSION);
    return (await agentRpc(machine, 'tmux.foreground', { session })).pane;
  }
  const pane = parsePaneForeground(await shell(machine, script));
  if (!pane) throw new HttpError(502, 'Resposta inesperada do tmux da máquina', 'MACHINE_FAILED');
  return pane;
}
