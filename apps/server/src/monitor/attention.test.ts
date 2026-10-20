import { describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import type { Machine, Tab } from '../db/repositories/types.js';
import { RUN_SETTLED_MS, checkAuthOnScreen, withRunOutcome } from './attention.js';
import type { Interpreted } from './state.js';

const NOW = new Date('2026-10-08T13:00:00.000Z');
const stop = (kind: Interpreted['kind']): Interpreted => ({ kind, text: 'PR #463 aberto. Próximos passos: você pode acompanhar o deploy.', meta: { event: 'Stop' } });
const ended = (ms: number) => new Date(NOW.getTime() - ms);

describe('withRunOutcome — a turn end right after the tab’s automatic run reported (TER-1046)', () => {
  it('a run reported done: finished, whatever next steps the report lists', () => {
    expect(withRunOutcome(stop('waiting_input'), { status: 'done', ended_at: ended(5_000) }, NOW).kind).toBe('finished');
  });

  it('a run reported blocked (waiting on TER-1020): blocked, not a wait for the person', () => {
    expect(withRunOutcome(stop('waiting_input'), { status: 'blocked', ended_at: ended(5_000) }, NOW).kind).toBe('blocked');
    expect(withRunOutcome(stop('finished'), { status: 'blocked', ended_at: ended(5_000) }, NOW).kind).toBe('blocked');
  });

  it('a run still active, long settled, or none at all leaves the hook’s reading', () => {
    expect(withRunOutcome(stop('waiting_input'), { status: 'running', ended_at: null }, NOW).kind).toBe('waiting_input');
    expect(withRunOutcome(stop('waiting_input'), { status: 'done', ended_at: ended(RUN_SETTLED_MS + 1) }, NOW).kind).toBe('waiting_input');
    expect(withRunOutcome(stop('waiting_input'), null, NOW).kind).toBe('waiting_input');
  });

  it('a login error stays a login error', () => {
    expect(withRunOutcome(stop('auth_required'), { status: 'done', ended_at: ended(5_000) }, NOW).kind).toBe('auth_required');
  });
});

describe('checkAuthOnScreen — the idle reminder over a login error (TER-1046)', () => {
  const AT = '2026-10-08T12:10:00.910Z';
  const LOGIN = '⏺ Login expired · Please run /login\n\n✻ Worked for 0s · done 9:09 AM\n────────────\n❯ \n────────────';
  const PROMPT = '⏺ Pronto.\n\n✻ Worked for 3s\n────────────\n❯ \n────────────';
  const tab = (over: Partial<Tab> = {}) => ({ id: 't1', project_id: 'p1', machine_id: 'm1', tmux_session: 'th-t1', state: 'waiting_input', state_at: AT, ...over }) as Tab;

  function setup(screen: string) {
    const recordEvent = vi.fn(async () => ({ tab: tab({ state: 'auth_required' }), event: {}, rearm: null }));
    const repos = { tabs: { recordEvent }, machines: { findById: vi.fn(async () => ({ id: 'm1', type: 'agent' }) as Machine) } } as unknown as Repositories;
    const deps = { capture: vi.fn(async () => screen), isOnline: () => true, publish: vi.fn() };
    const log = { info: vi.fn(), warn: vi.fn() };
    return { repos, recordEvent, deps, log };
  }

  it('the login error on screen turns the wait into auth_required, only if the wait is still there', async () => {
    const { repos, recordEvent, deps, log } = setup(LOGIN);
    await checkAuthOnScreen(repos, log as never, tab(), deps);
    expect(recordEvent).toHaveBeenCalledWith('t1', expect.objectContaining({ kind: 'auth_required', ifStateAt: AT, ifStateIn: ['waiting_input'], meta: { event: 'ScreenCheck', screen: 'auth' } }));
    expect(deps.publish).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.info.mock.calls)).not.toContain('Login expired');
  });

  it('any other screen, or a tab no longer waiting, changes nothing', async () => {
    const a = setup(PROMPT);
    await checkAuthOnScreen(a.repos, a.log as never, tab(), a.deps);
    expect(a.recordEvent).not.toHaveBeenCalled();
    const b = setup(LOGIN);
    await checkAuthOnScreen(b.repos, b.log as never, tab({ state: 'working' }), b.deps);
    expect(b.deps.capture).not.toHaveBeenCalled();
  });
});
