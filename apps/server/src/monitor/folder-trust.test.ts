import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import type { Machine, Tab } from '../db/repositories/types.js';

const publish = vi.fn();
vi.mock('./bus.js', () => ({ monitorBus: { publish: (...a: unknown[]) => publish(...a) } }));
const recordFeed = vi.fn(async () => {});
vi.mock('../automation/events.js', () => ({ recordEvent: (...a: unknown[]) => recordFeed(...(a as [])) }));

const { LAUNCH_CHECKS_MS, checkLaunch, followLaunch, pretrustFolder, resetAnsweredForTests, settleTrustDialog, trustedFolderOf } = await import('./folder-trust.js');

const AT = '2026-10-24T18:00:00.000Z';
const TRUST = readFileSync(new URL('./fixtures/claude-screens/trust-2.1.289.txt', import.meta.url), 'utf8');
const NO_SELECTED = TRUST.replace('❯ 1. Yes, I trust this folder', '  1. Yes, I trust this folder').replace('   2. No, exit', ' ❯ 2. No, exit');
const OTHERS = [
  { cli: 'codex', screen: readFileSync(new URL('./fixtures/trust-screens/codex-0.159.3.txt', import.meta.url), 'utf8'), label: 'Codex' },
  { cli: 'cursor', screen: readFileSync(new URL('./fixtures/trust-screens/cursor.txt', import.meta.url), 'utf8'), label: 'Cursor' },
  { cli: 'gemini', screen: readFileSync(new URL('./fixtures/trust-screens/gemini.txt', import.meta.url), 'utf8'), label: 'Gemini CLI' },
] as const;
const PROMPT = '● Pronto.\n\n✻ Brewed for 3s\n\n────────────\n❯ \n────────────';

const tab = (over: Partial<Tab> = {}): Tab & { tmux_session: string } =>
  ({ id: 't1', project_id: 'p1', machine_id: 'm1', name: 'api', kind: 'terminal', tmux_session: 'th-t1', state: null, state_tool: null, state_at: null, cwd: null, ...over }) as Tab & { tmux_session: string };
const machine = { id: 'm1', owner_id: 'u1', type: 'agent' } as Machine;
const log = () => ({ info: vi.fn(), warn: vi.fn() });

const LINK_CWD = '/srv/api';
const WORKTREE = '/home/p/.termhub/worktrees/p1/TER-1';

function setup(opts: { tab?: Tab | undefined; trustProjectFolder?: boolean; screen?: string; link?: boolean; worktree?: string | null } = {}) {
  const recordEvent = vi.fn(async (_id: string, ev: { kind: Tab['state'] }) => ({ tab: tab({ state: ev.kind }), event: {} }));
  const repos = {
    tabs: { recordEvent, findById: vi.fn(async () => ('tab' in opts ? opts.tab : tab())) },
    projectSetup: { get: vi.fn(async () => ({ data: { agent: { trust_project_folder: opts.trustProjectFolder ?? true } } })) },
    projectMachines: { find: vi.fn(async () => (opts.link === false ? undefined : { project_id: 'p1', machine_id: 'm1', cwd: LINK_CWD })) },
    automationRuns: { latestByTab: vi.fn(async () => (opts.worktree ? { project_id: 'p1', worktree_path: opts.worktree } : null)) },
  } as unknown as Repositories;
  let clock = 0;
  const deps = { capture: vi.fn(async () => opts.screen ?? TRUST), sendEnter: vi.fn(async () => {}), sendUp: vi.fn(async () => {}), pause: vi.fn(async () => {}), now: () => clock };
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
    expect(recordFeed).toHaveBeenCalledWith(repos, { project_id: 'p1', kind: 'trust_auto_accepted', payload: { tab_id: 't1', tab_name: 'api', folder: 'project', cli: 'claude' } });
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
      // "No" selected outside the project: never moved, never answered
      { t: tab({ cwd: '/elsewhere' }), screen: NO_SELECTED, off: false },
    ];
    for (const c of cases) {
      publish.mockClear();
      const { repos, recordEvent, deps } = setup({ trustProjectFolder: !c.off, screen: c.screen });
      expect(await settleTrustDialog(repos, log() as never, c.t, machine, c.screen, deps)).toBe('reported');
      expect(deps.sendEnter).not.toHaveBeenCalled();
      expect(deps.sendUp).not.toHaveBeenCalled();
      expect(recordEvent).toHaveBeenCalledWith('t1', expect.objectContaining({ kind: 'trust_prompt', tool: 'claude', meta: { event: 'ScreenCheck', screen: 'trust' }, ifStateAt: null }));
      expect(publish).toHaveBeenCalledTimes(1);
    }
  });

  it('TER-1148: the link\'s folder spelled out in the tab, or the worktree of the tab\'s run, is answered too', async () => {
    const spelled = setup();
    expect(await settleTrustDialog(spelled.repos, log() as never, tab({ cwd: `${LINK_CWD}/` }), machine, TRUST, spelled.deps)).toBe('accepted');
    resetAnsweredForTests();
    recordFeed.mockClear();
    const worktree = setup({ worktree: WORKTREE });
    expect(await settleTrustDialog(worktree.repos, log() as never, tab({ cwd: WORKTREE }), machine, TRUST, worktree.deps)).toBe('accepted');
    expect(recordFeed).toHaveBeenCalledWith(worktree.repos, expect.objectContaining({ payload: expect.objectContaining({ folder: 'worktree' }) }));
  });

  it('TER-1148: a project with no link on this machine is not trusted, whatever the cwd', async () => {
    const { repos } = setup({ link: false });
    expect(await trustedFolderOf(repos, tab())).toBeNull();
    expect(await trustedFolderOf(repos, tab({ cwd: LINK_CWD }))).toBeNull();
  });

  it('TER-1148: the cursor on "No, exit" in the project folder is moved up to "Yes" before the Enter', async () => {
    const { repos, recordEvent, deps } = setup();
    deps.capture.mockResolvedValueOnce(NO_SELECTED).mockResolvedValueOnce(TRUST);
    expect(await settleTrustDialog(repos, log() as never, tab(), machine, NO_SELECTED, deps)).toBe('accepted');
    expect(deps.sendUp).toHaveBeenCalledTimes(2);
    expect(deps.sendEnter).toHaveBeenCalledTimes(1);
    expect(deps.sendUp.mock.invocationCallOrder[1]).toBeLessThan(deps.sendEnter.mock.invocationCallOrder[0]!);
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it('TER-1148: a selection that never reaches "Yes" is never answered: the tab becomes trust_prompt', async () => {
    const { repos, recordEvent, deps } = setup({ screen: NO_SELECTED });
    expect(await settleTrustDialog(repos, log() as never, tab(), machine, NO_SELECTED, deps)).toBe('reported');
    expect(deps.sendUp).toHaveBeenCalledTimes(3);
    expect(deps.sendEnter).not.toHaveBeenCalled();
    expect(recordEvent).toHaveBeenCalledWith('t1', expect.objectContaining({ kind: 'trust_prompt' }));
  });

  it('TER-1122: Codex, Cursor and Gemini get the same answer in the project folder, and their own trust_prompt elsewhere', async () => {
    for (const o of OTHERS) {
      resetAnsweredForTests();
      recordFeed.mockClear();
      const inside = setup();
      expect(await settleTrustDialog(inside.repos, log() as never, tab(), machine, o.screen, inside.deps)).toBe('accepted');
      expect(inside.deps.sendEnter).toHaveBeenCalledWith(machine, 'th-t1');
      expect(recordFeed).toHaveBeenCalledWith(inside.repos, expect.objectContaining({ kind: 'trust_auto_accepted', payload: expect.objectContaining({ cli: o.cli }) }));
      resetAnsweredForTests();
      const outside = setup();
      expect(await settleTrustDialog(outside.repos, log() as never, tab({ cwd: '/elsewhere' }), machine, o.screen, outside.deps)).toBe('reported');
      expect(outside.deps.sendEnter).not.toHaveBeenCalled();
      expect(outside.recordEvent).toHaveBeenCalledWith('t1', expect.objectContaining({ kind: 'trust_prompt', tool: o.cli, text: `O ${o.label} pergunta se esta pasta é confiável` }));
    }
  });

  it('TER-1122: Codex asking to also turn its approvals off is reported, never answered', async () => {
    const screen = '› 1. Yes, allow Codex to work in this folder without asking for approval\n  2. No, ask me to approve edits and commands';
    const { repos, recordEvent, deps } = setup();
    expect(await settleTrustDialog(repos, log() as never, tab(), machine, screen, deps)).toBe('reported');
    expect(deps.sendEnter).not.toHaveBeenCalled();
    expect(recordEvent).toHaveBeenCalledWith('t1', expect.objectContaining({ kind: 'trust_prompt', tool: 'codex' }));
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

  it('TER-1122: a Codex start is followed the same way', async () => {
    const { repos, deps } = setup({ screen: OTHERS[0].screen });
    expect(await checkLaunch(repos, log() as never, 't1', machine, deps)).toBe(true);
    expect(deps.sendEnter).toHaveBeenCalledTimes(1);
  });

  it('a tab that reported working from the start still turns trust_prompt, never stays "working"', async () => {
    const { repos, recordEvent, deps } = setup({ tab: tab({ state: 'working', state_at: AT, cwd: '/elsewhere' }) });
    expect(await checkLaunch(repos, log() as never, 't1', machine, deps)).toBe(true);
    expect(recordEvent).toHaveBeenCalledWith('t1', expect.objectContaining({ kind: 'trust_prompt', ifStateAt: AT }));
  });
});

describe('pretrustFolder — the folder trusted before Claude Code opens it (TER-1148)', () => {
  const agentMachine = (version: string | null) => ({ ...machine, agent_version: version }) as Machine;

  it("marks the project's folder in the machine's Claude accounts, naming the account that starts", async () => {
    const { repos } = setup();
    const rpc = vi.fn(async () => 1);
    expect(await pretrustFolder(repos, log() as never, tab(), agentMachine('0.37.0'), ['~/.claude_work', null, '~/.claude_work'], rpc)).toBe(true);
    expect(rpc).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1' }), LINK_CWD, ['~/.claude_work']);
  });

  it("a run's worktree, but never a folder outside the project, the option off, an older agent or an ssh machine", async () => {
    const wt = setup({ worktree: WORKTREE });
    const rpc = vi.fn(async () => 0);
    expect(await pretrustFolder(wt.repos, log() as never, tab({ cwd: WORKTREE }), agentMachine('0.37.0'), [], rpc)).toBe(true);
    expect(rpc).toHaveBeenLastCalledWith(expect.anything(), WORKTREE, []);
    rpc.mockClear();
    expect(await pretrustFolder(setup().repos, log() as never, tab({ cwd: '/elsewhere' }), agentMachine('0.37.0'), [], rpc)).toBe(false);
    expect(await pretrustFolder(setup({ trustProjectFolder: false }).repos, log() as never, tab(), agentMachine('0.37.0'), [], rpc)).toBe(false);
    expect(await pretrustFolder(setup().repos, log() as never, tab(), agentMachine('0.36.0'), [], rpc)).toBe(false);
    expect(await pretrustFolder(setup().repos, log() as never, tab(), { ...agentMachine('0.37.0'), type: 'ssh' } as Machine, [], rpc)).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('a failed call is logged by code and never thrown: the screen is still followed', async () => {
    const l = log();
    expect(await pretrustFolder(setup().repos, l as never, tab(), agentMachine('0.37.0'), [], vi.fn(async () => Promise.reject(new Error('boom'))))).toBe(false);
    expect(l.warn).toHaveBeenCalledTimes(1);
  });
});
