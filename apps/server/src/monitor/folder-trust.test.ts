import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import type { Machine, Tab } from '../db/repositories/types.js';

const publish = vi.fn();
vi.mock('./bus.js', () => ({ monitorBus: { publish: (...a: unknown[]) => publish(...a) } }));
const recordFeed = vi.fn(async () => {});
vi.mock('../automation/events.js', () => ({ recordEvent: (...a: unknown[]) => recordFeed(...(a as [])) }));

const { LAUNCH_CHECKS_MS, checkLaunch, followLaunch, resetAnsweredForTests, settleTrustDialog } = await import('./folder-trust.js');

const AT = '2026-10-24T18:00:00.000Z';
const TRUST = readFileSync(new URL('./fixtures/claude-screens/trust-2.1.289.txt', import.meta.url), 'utf8');
const NO_SELECTED = TRUST.replace('❯ 1. Yes, I trust this folder', '  1. Yes, I trust this folder').replace('   2. No, exit', ' ❯ 2. No, exit');
const PROMPT = '● Pronto.\n\n✻ Brewed for 3s\n\n────────────\n❯ \n────────────';

const tab = (over: Partial<Tab> = {}): Tab & { tmux_session: string } =>
  ({ id: 't1', project_id: 'p1', machine_id: 'm1', name: 'api', kind: 'terminal', tmux_session: 'th-t1', state: null, state_tool: null, state_at: null, cwd: null, ...over }) as Tab & { tmux_session: string };
const machine = { id: 'm1', owner_id: 'u1', type: 'agent' } as Machine;
const log = () => ({ info: vi.fn(), warn: vi.fn() });

function setup(opts: { tab?: Tab | undefined; trustProjectFolder?: boolean; screen?: string } = {}) {
  const recordEvent = vi.fn(async (_id: string, ev: { kind: Tab['state'] }) => ({ tab: tab({ state: ev.kind }), event: {} }));
  const repos = {
    tabs: { recordEvent, findById: vi.fn(async () => ('tab' in opts ? opts.tab : tab())) },
    projectSetup: { get: vi.fn(async () => ({ data: { agent: { trust_project_folder: opts.trustProjectFolder ?? true } } })) },
  } as unknown as Repositories;
  let clock = 0;
  const deps = { capture: vi.fn(async () => opts.screen ?? TRUST), sendEnter: vi.fn(async () => {}), now: () => clock };
  return { repos, recordEvent, deps, tick: (ms: number) => (clock += ms) };
}

beforeEach(() => {
  publish.mockClear();
  recordFeed.mockClear();
  resetAnsweredForTests();
});

describe('settleTrustDialog — the folder trust dialog (TER-1117)', () => {
  it("in the project's own folder: Enter on \"Yes\", a feed line, and the tab never becomes trust_prompt", async () => {
    const { repos, recordEvent, deps } = setup();
    const l = log();
    expect(await settleTrustDialog(repos, l as never, tab(), machine, TRUST, deps)).toBe('accepted');
    expect(deps.sendEnter).toHaveBeenCalledWith(machine, 'th-t1');
    expect(recordFeed).toHaveBeenCalledWith(repos, { project_id: 'p1', kind: 'trust_auto_accepted', payload: { tab_id: 't1', tab_name: 'api', folder: 'project' } });
    expect(recordEvent).not.toHaveBeenCalled();
    // ids only: the screen is never logged
    expect(JSON.stringify(l.info.mock.calls)).not.toContain('trust this folder');
  });

  it('sends Enter once, though the launch check and a sweep both see the dialog', async () => {
    const { repos, deps, tick } = setup();
    await settleTrustDialog(repos, log() as never, tab(), machine, TRUST, deps);
    tick(2_000);
    expect(await settleTrustDialog(repos, log() as never, tab(), machine, TRUST, deps)).toBe('unchanged');
    expect(deps.sendEnter).toHaveBeenCalledTimes(1);
  });

  it('a worktree or another folder, the option off in Setup, or "No" selected: the tab becomes trust_prompt and it is published', async () => {
    const cases = [
      { t: tab({ cwd: '/home/p/.termhub/worktrees/x/TER-1' }), screen: TRUST, off: false },
      { t: tab(), screen: TRUST, off: true },
      { t: tab(), screen: NO_SELECTED, off: false },
    ];
    for (const c of cases) {
      publish.mockClear();
      const { repos, recordEvent, deps } = setup({ trustProjectFolder: !c.off });
      expect(await settleTrustDialog(repos, log() as never, c.t, machine, c.screen, deps)).toBe('reported');
      expect(deps.sendEnter).not.toHaveBeenCalled();
      expect(recordEvent).toHaveBeenCalledWith('t1', expect.objectContaining({ kind: 'trust_prompt', tool: 'claude', meta: { event: 'ScreenCheck', screen: 'trust' }, ifStateAt: null }));
      expect(publish).toHaveBeenCalledTimes(1);
    }
  });

  it('a tab whose state moved meanwhile is left alone', async () => {
    const { repos, recordEvent, deps } = setup({ trustProjectFolder: false });
    recordEvent.mockResolvedValueOnce({ tab: tab(), event: null } as never);
    expect(await settleTrustDialog(repos, log() as never, tab({ state: 'working', state_at: AT }), machine, TRUST, deps)).toBe('unchanged');
    expect(publish).not.toHaveBeenCalled();
  });
});

describe('followLaunch — the screen read right after an agent start (TER-1117)', () => {
  it('reads the tab at each step until the dialog is settled', async () => {
    const screens = [PROMPT, TRUST];
    const { repos, deps } = setup();
    deps.capture.mockImplementation(async () => screens.shift() ?? PROMPT);
    const scheduled: number[] = [];
    const queue: (() => void)[] = [];
    followLaunch(repos, log() as never, 't1', machine, deps, (fn, ms) => {
      scheduled.push(ms);
      queue.push(fn);
    });
    // the first read finds the CLI still starting; the second, the dialog
    queue.shift()!();
    await vi.waitFor(() => expect(queue.length).toBe(1));
    queue.shift()!();
    await vi.waitFor(() => expect(deps.sendEnter).toHaveBeenCalledTimes(1));
    expect(scheduled).toEqual([LAUNCH_CHECKS_MS[0], LAUNCH_CHECKS_MS[1] - LAUNCH_CHECKS_MS[0]]);
    expect(queue).toHaveLength(0);
  });

  it('stops when the tab is gone or already waits on the dialog, and goes on while the screen shows nothing', async () => {
    expect(await checkLaunch(setup({ tab: undefined }).repos, log() as never, 't1', machine, setup().deps)).toBe(true);
    const waiting = setup({ tab: tab({ state: 'trust_prompt', state_at: AT }) });
    expect(await checkLaunch(waiting.repos, log() as never, 't1', machine, waiting.deps)).toBe(true);
    expect(waiting.deps.capture).not.toHaveBeenCalled();
    const busy = setup({ screen: PROMPT });
    expect(await checkLaunch(busy.repos, log() as never, 't1', machine, busy.deps)).toBe(false);
  });

  it('a tab that reported working from the start still turns trust_prompt, never stays "working"', async () => {
    const { repos, recordEvent, deps } = setup({ tab: tab({ state: 'working', state_at: AT, cwd: '/elsewhere' }) });
    expect(await checkLaunch(repos, log() as never, 't1', machine, deps)).toBe(true);
    expect(recordEvent).toHaveBeenCalledWith('t1', expect.objectContaining({ kind: 'trust_prompt', ifStateAt: AT }));
  });
});
