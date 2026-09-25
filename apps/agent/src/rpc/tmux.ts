import { randomUUID } from 'node:crypto';
import type { RpcParams, RpcResult } from '@termhub/agent-protocol';
import { RpcFailure, run, tmuxPath, type RunResult } from '../exec.js';

/** Pause between the typed text and the Enter that submits it (same value the server used before). */
export const ENTER_PAUSE_MS = 300;

/**
 * Turns a process-level tmux failure into the right RpcFailure: a timeout is always a timeout;
 * `error: 'enoent'` means execFile could not even spawn the binary, which we report as
 * `no_tmux`; `error: 'maxbuffer'` means tmux ran but produced more output than the 8 MiB cap
 * (e.g. an enormous `capture-pane`) — a real (if unusual) failure, but not "tmux missing", so
 * it gets `internal` instead of being folded into `no_tmux` alongside ENOENT.
 */
function processFailure(r: Pick<RunResult, 'error' | 'timedOut'>): RpcFailure | null {
  if (r.timedOut) return new RpcFailure('timeout', 'tmux timed out');
  if (r.error === 'enoent') return new RpcFailure('no_tmux', 'tmux not found');
  if (r.error === 'maxbuffer') return new RpcFailure('internal', 'output too large');
  return null;
}

export async function list(_params: RpcParams<'tmux.list'>): Promise<RpcResult<'tmux.list'>> {
  const r = await run(tmuxPath(), ['list-sessions', '-F', '#{session_name}']);
  const failure = processFailure(r);
  if (failure) throw failure;
  // Non-zero here just means "no tmux server running" — same as the server's own runOnMachine path.
  if (r.code !== 0) return { sessions: [] };
  const sessions = r.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  return { sessions };
}

export async function kill(params: RpcParams<'tmux.kill'>): Promise<RpcResult<'tmux.kill'>> {
  const r = await run(tmuxPath(), ['kill-session', '-t', `=${params.session}`]);
  const failure = processFailure(r);
  if (failure) throw failure;
  return { killed: r.code === 0 };
}

export async function capture(params: RpcParams<'tmux.capture'>): Promise<RpcResult<'tmux.capture'>> {
  // Trailing ':' matters: '-t =name' alone is a target-pane, and tmux only resolves an exact
  // ('=') target-pane string as a session name when it's colon-qualified — with no client
  // attached (as here, run from execFile) a bare '=name' fails with "can't find pane:
  // =name" instead of defaulting to that session's active window/pane. kill-session takes a
  // target-session, which resolves a bare '=name' fine, so it doesn't need this.
  // `-e` keeps colours and attributes as escapes: the server reads a dimmed suggestion off them.
  const r = await run(tmuxPath(), ['capture-pane', '-p', ...(params.escapes ? ['-e'] : []), '-S', `-${params.lines}`, '-t', `=${params.session}:`]);
  const failure = processFailure(r);
  if (failure) throw failure;
  if (r.code !== 0) throw new RpcFailure('notfound', 'session not found');
  return params.escapes ? { text: r.stdout, escapes: true } : { text: r.stdout };
}

/** Target-pane form: tmux only resolves an exact ('=') target-pane when it is colon-qualified (see capture). */
const pane = (session: string) => `=${session}:`;

/** The message tmux printed, first line, for an error meant for the user. */
const why = (stderr: string, fallback: string) => stderr.trim().split('\n')[0] || fallback;

export async function ensure(params: RpcParams<'tmux.ensure'>): Promise<RpcResult<'tmux.ensure'>> {
  const has = await run(tmuxPath(), ['has-session', '-t', `=${params.session}`]);
  const hasFailure = processFailure(has);
  if (hasFailure) throw hasFailure;
  if (has.code === 0) return { created: false };

  const made = await run(tmuxPath(), ['new-session', '-d', '-s', params.session, '-c', params.cwd]);
  const madeFailure = processFailure(made);
  if (madeFailure) throw madeFailure;
  // A bad cwd is the usual reason, and the user is the one who can fix it.
  if (made.code !== 0) throw new RpcFailure('failed', why(made.stderr, 'tmux new-session falhou'), params.cwd);
  return { created: true };
}

/**
 * Delivers `text` as one tmux paste instead of typed keystrokes: `load-buffer -` reads it from
 * stdin (never argv, never a shell string — see exec.ts's `run` contract), then `paste-buffer -p
 * -d` drops it into the pane bracketed, so a TUI that understands bracketed paste (e.g. Claude
 * Code) reads an embedded newline as part of the pasted text rather than as Enter. Chosen over
 * hand-built `\e[200~ … \e[201~` escape bytes because it needs no escape literals in our code and
 * tmux verified it produces the same unsubmitted-composer result.
 *
 * `load-buffer`/`paste-buffer` act on the *most recent* tmux buffer when no `-b` is given, and
 * the dispatcher does not serialize RPCs (`void handleRpc(...)`): two pastes to different tabs on
 * the same machine can interleave, so an unnamed buffer can carry one conversation's text into
 * another tab. Every call therefore gets its own buffer name (`randomUUID`, collision-proof in
 * practice), and that buffer is always removed — `-d` on a successful paste, `delete-buffer` in
 * the `finally` on every other path — so a failed paste never leaves the user's prompt sitting in
 * tmux's buffer list where anything reaching this tmux server could `show-buffer` it.
 */
async function pasteText(session: string, text: string): Promise<void> {
  const bufferName = `termhub-paste-${randomUUID()}`;
  try {
    const loaded = await run(tmuxPath(), ['load-buffer', '-b', bufferName, '-'], { input: Buffer.from(text, 'utf8') });
    const loadFailure = processFailure(loaded);
    if (loadFailure) throw loadFailure;
    if (loaded.code !== 0) throw new RpcFailure('internal', why(loaded.stderr, 'tmux load-buffer failed'));

    const pasted = await run(tmuxPath(), ['paste-buffer', '-p', '-d', '-b', bufferName, '-t', pane(session)]);
    const pasteFailure = processFailure(pasted);
    if (pasteFailure) throw pasteFailure;
    if (pasted.code !== 0) throw new RpcFailure('notfound', why(pasted.stderr, 'session not found'));
  } finally {
    // Best-effort: `run` never rejects (see exec.ts), and a buffer that is already gone (the
    // common case — `-d` above deleted it) is exactly the outcome we want, so its result is
    // ignored either way. This must never replace the error being thrown out of the `try` above.
    await run(tmuxPath(), ['delete-buffer', '-b', bufferName]);
  }
}

export async function sendText(params: RpcParams<'tmux.sendText'>): Promise<RpcResult<'tmux.sendText'>> {
  if (params.text) {
    if (params.paste) {
      await pasteText(params.session, params.text);
    } else {
      const typed = await run(tmuxPath(), ['send-keys', '-t', pane(params.session), '-l', '--', params.text]);
      const failure = processFailure(typed);
      if (failure) throw failure;
      if (typed.code !== 0) throw new RpcFailure('notfound', why(typed.stderr, 'session not found'));
    }
    // TUIs read a burst of bytes as a paste, so Enter has to arrive on its own.
    if (params.enter) await new Promise((r) => setTimeout(r, ENTER_PAUSE_MS));
  }
  if (params.enter) {
    const entered = await run(tmuxPath(), ['send-keys', '-t', pane(params.session), 'Enter']);
    const failure = processFailure(entered);
    if (failure) throw failure;
    if (entered.code !== 0) throw new RpcFailure('notfound', why(entered.stderr, 'session not found'));
  }
  return { sent: true };
}

export async function sendKey(params: RpcParams<'tmux.sendKey'>): Promise<RpcResult<'tmux.sendKey'>> {
  const r = await run(tmuxPath(), ['send-keys', '-t', pane(params.session), params.key]);
  const failure = processFailure(r);
  if (failure) throw failure;
  if (r.code !== 0) throw new RpcFailure('notfound', why(r.stderr, 'session not found'));
  return { sent: true };
}
