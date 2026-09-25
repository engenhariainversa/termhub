import { config } from '../config.js';
import type { Machine } from '../db/repositories/types.js';
import { REMOTE_PATH_PREFIX, assertSessionName, runOnMachine } from '../terminal/machine-exec.js';
import { agentRpc } from './errors.js';

const tmux = () => config.terminal.tmuxPath;
const clampLines = (lines: number) => Math.max(1, Math.min(5000, Math.trunc(lines)));

/** A capture that may carry SGR escapes: `styled` says whether it does (an agent older than 0.5.2 cannot). */
export interface StyledCapture {
  text: string;
  styled: boolean;
}

/**
 * Captures the last `lines` of a tmux pane's output as plain text. Internal helper only
 * (no HTTP route) — used wherever the server needs a snapshot of what's on screen.
 * Returns '' on any local/ssh failure instead of throwing, matching the pre-agent behaviour.
 */
export async function captureScreen(machine: Machine, session: string, lines = 500): Promise<string> {
  assertSessionName(session);
  const n = clampLines(lines);

  if (machine.type === 'agent') {
    const { text } = await agentRpc(machine, 'tmux.capture', { session, lines: n });
    return text;
  }

  // Trailing ':' matters: '-t =name' alone is a target-pane, and tmux only resolves an exact
  // ('=') target-pane string as a session name when it's colon-qualified — with no client
  // attached (as here, an unattended local/ssh exec) a bare '=name' fails with "can't find
  // pane: =name" instead of defaulting to that session's active window/pane.
  const r = await runOnMachine(
    machine,
    { file: tmux(), args: ['capture-pane', '-p', '-S', `-${n}`, '-t', `=${session}:`] },
    `${REMOTE_PATH_PREFIX}tmux capture-pane -p -S -${n} -t '=${session}:'`,
  );
  return r.code === 0 ? r.stdout : '';
}

/**
 * Like `captureScreen`, with the attributes kept as escapes (`capture-pane -e`, spec 2026-09-25 tab
 * suggestions §4): only `terminal/ansi.ts` reads the result. Never logged.
 */
export async function captureStyledScreen(machine: Machine, session: string, lines = 500): Promise<StyledCapture> {
  assertSessionName(session);
  const n = clampLines(lines);

  if (machine.type === 'agent') {
    const r = await agentRpc(machine, 'tmux.capture', { session, lines: n, escapes: true });
    return { text: r.text, styled: r.escapes === true };
  }

  const r = await runOnMachine(
    machine,
    { file: tmux(), args: ['capture-pane', '-p', '-e', '-S', `-${n}`, '-t', `=${session}:`] },
    `${REMOTE_PATH_PREFIX}tmux capture-pane -p -e -S -${n} -t '=${session}:'`,
  );
  return { text: r.code === 0 ? r.stdout : '', styled: true };
}
