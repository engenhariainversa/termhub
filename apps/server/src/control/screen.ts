import { captureScreen, captureStyledScreen } from '../agent/screen.js';
import { agents } from '../agent/registry.js';
import type { Tab, TabState } from '../db/repositories/types.js';
import { HttpError } from '../lib/errors.js';
import { monitorBus } from '../monitor/bus.js';
import { renderStyled } from '../terminal/ansi.js';
import { ControlError, type ControlContext } from './context.js';

export const SCREEN_DEFAULT_LINES = 200;
export const SCREEN_MAX_LINES = 2000;
export const WAIT_DEFAULT_SECONDS = 60;
export const WAIT_MAX_SECONDS = 90;

/** Shared by every control op that talks to a machine (spec §4.4: "nothing is queued for offline machines"). */
export const offline = () => new ControlError('MACHINE_OFFLINE', 'A máquina está offline: o termhub-agent dela não está conectado');

/** Shared clamp for every "how many seconds/lines" input across the control ops. */
export const clamp = (v: number | undefined, def: number, max: number) => Math.max(1, Math.min(max, Math.trunc(v ?? def)));

/** Shared guard: only a terminal tab (one with a tmux session) can be read from or written to. */
export function assertTerminal(tab: Tab): asserts tab is Tab & { tmux_session: string } {
  if (tab.kind !== 'terminal' || !tab.tmux_session) throw new ControlError('NOT_A_TERMINAL', 'Esta aba não é um terminal');
}

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
): Promise<{ tab_id: string; lines: number; text: string; styled: boolean }> {
  const { tab, machine } = await ctx.scoped.tab(input.tab_id);
  assertTerminal(tab);
  if (machine.type === 'agent' && !agents.isOnline(machine.id)) throw offline();
  const lines = clamp(input.lines, SCREEN_DEFAULT_LINES, SCREEN_MAX_LINES);
  try {
    if (opts.plain) return { tab_id: tab.id, lines, text: await captureScreen(machine, tab.tmux_session, lines), styled: false };
    const shot = await captureStyledScreen(machine, tab.tmux_session, lines);
    return { tab_id: tab.id, lines, text: shot.styled ? renderStyled(shot.text) : shot.text, styled: shot.styled };
  } catch (e) {
    // agentRpc turns a connection that dropped mid-call into a bare 503 (toHttpError)
    if (e instanceof HttpError && e.statusCode === 503) throw offline();
    throw e;
  }
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
 */
export async function waitForState(ctx: ControlContext, input: { tab_id: string; timeout_seconds?: number }, signal?: AbortSignal): Promise<WaitResult> {
  const { tab } = await ctx.scoped.tab(input.tab_id);
  if (tab.state === null) {
    return { ...result(tab, false), note: 'Esta aba não tem estado do monitor (hooks não instalados na máquina ou nenhuma ferramenta rodou nela). Use read_screen para ver o terminal.' };
  }
  if (tab.state !== 'working') return result(tab, false);

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
      if (change.tab.state !== 'working') finish(result(change.tab, false));
    });
    const timer = setTimeout(() => finish(result(last, true)), timeoutMs);
    const onAbort = () => finish(result(last, true));
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    // The tab may have left working between the read above and the subscription; a failed re-read just keeps waiting.
    ctx.repos.tabs.findById(tab.id).then(
      (now) => {
        if (now && now.state !== 'working') finish(result(now, false));
      },
      () => {},
    );
  });
}
