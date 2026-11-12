import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import type { Machine, Tab } from '../db/repositories/types.js';

const publish = vi.fn();
vi.mock('./bus.js', () => ({ monitorBus: { publish: (...a: unknown[]) => publish(...a) } }));
vi.mock('../chat/agent-exited.js', () => ({ AGENT_EXITED_TEXT: 'Agente encerrado sem terminar o turno', AGENT_LEFT_TEXT: 'Agente encerrado', notifyAgentExited: vi.fn() }));

const { BACKGROUND_TIMEOUT_MINUTES, DIALOG_FRESH_MS, DIALOG_RECHECK_MS, DIALOG_WINDOW_MS, RESTING_STATES, STALE_WORKING_MS, UNREPORTED_AFTER_MS, sweepDialogs, sweepStaleWorking, sweepUnreported } = await import('./stale-working.js');

const fixture = (name: string) => readFileSync(new URL(`./fixtures/cli-dialogs/${name}.txt`, import.meta.url), 'utf8');
const TEACH = fixture('claude-teach-auto-mode-2.1.322');
const HOOKS_REVIEW = fixture('codex-hooks-review-0.159.3');
const HOOKS_MENU = fixture('claude-hooks-2.1.322');
const HOOKS_ON_TRUST = HOOKS_REVIEW.replace('› 1. Review hooks', '  1. Review hooks').replace('  2. Trust all and continue', '› 2. Trust all and continue');
const PROMPT = '● Pronto.\n\n✻ Brewed for 3s\n\n────────────\n❯ \n────────────';

const AT = '2026-11-10T10:41:00.000Z';
const tab = (over: Partial<Tab> = {}): Tab => ({ id: 't1', project_id: 'p1', name: 't', kind: 'terminal', tmux_session: 'th-t1', state: 'finished', state_tool: 'claude', state_at: AT, ...over }) as Tab;
const machine = (): Machine => ({ id: 'm1', owner_id: 'u1', type: 'agent' }) as Machine;
const log = () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn() });

function setup(tabs: Tab[], screen: string, opts: { answer?: { text: string; stale: boolean } | null } = {}) {
  const recordEvent = vi.fn(async (_id: string, ev: { kind: Tab['state'] }) => ({ tab: tab({ state: ev.kind }), event: {}, rearm: null }));
  const readLastAnswer = vi.fn(async () => (opts.answer === undefined ? { text: 'Pronto: o PR está aberto.', at: AT, tool: 'claude', stale: false } : opts.answer && { at: AT, tool: 'claude', ...opts.answer }));
  const repos = {
    tabs: { listStaleWorking: vi.fn(async () => tabs), listUnreported: vi.fn(async () => tabs), listResting: vi.fn(async () => tabs), recordEvent, readLastAnswer },
    machines: { findById: vi.fn(async () => machine()) },
  } as unknown as Repositories;
  const capture = vi.fn(async () => screen);
  const deps = {
    capture,
    foreground: vi.fn(async () => null),
    exited: vi.fn(async () => {}),
    isOnline: () => true,
    checked: new Map<string, { stateAt: string; at: number }>(),
    backgroundTimeoutMs: BACKGROUND_TIMEOUT_MINUTES * 60_000,
    screens: new Map<string, string>(),
  };
  return { repos, recordEvent, capture, deps };
}

// TER-1168: Claude killed while the tab rested (no SessionEnd): the tab said "finished" and took messages into its shell
describe('sweepDialogs — the agent left a tab at rest (TER-1168)', () => {
  const now = new Date(Date.parse(AT) + 60_000);

  it('a resting tab whose pane is back at its shell (or dead) becomes idle, Agente encerrado, with no resume card', async () => {
    for (const pane of ['shell', 'dead'] as const) {
      publish.mockClear();
      const { repos, recordEvent, capture, deps } = setup([tab({ state: 'waiting_input' })], PROMPT);
      deps.foreground.mockResolvedValue(pane as never);
      await sweepDialogs(repos, log() as never, now, deps);
      expect(recordEvent).toHaveBeenCalledWith('t1', { kind: 'idle', tool: 'claude', text: 'Agente encerrado', meta: { event: 'AgentExited', pane, resting: true }, ifStateAt: AT, ifStateIn: RESTING_STATES });
      expect(publish).toHaveBeenCalled();
      expect(deps.exited).not.toHaveBeenCalled();
      expect(capture).not.toHaveBeenCalled();
    }
  });

  it('the agent still in front (or a pane it cannot read) reads the screen for a dialog, as before; idle tabs are not asked', async () => {
    const busy = setup([tab()], PROMPT);
    busy.deps.foreground.mockResolvedValue('busy' as never);
    await sweepDialogs(busy.repos, log() as never, now, busy.deps);
    expect(busy.recordEvent).not.toHaveBeenCalled();
    expect(busy.capture).toHaveBeenCalled();
    const idle = setup([tab({ state: 'idle' })], PROMPT);
    await sweepDialogs(idle.repos, log() as never, now, idle.deps);
    expect(idle.deps.foreground).not.toHaveBeenCalled();
  });
});

describe('sweepDialogs — a CLI dialog holds a tab at rest (TER-1166)', () => {
  const now = new Date(Date.parse(AT) + 60_000);

  it('lists Claude and Codex tabs at rest or in a dialog, for DIALOG_WINDOW_MS', async () => {
    const { repos, deps } = setup([], PROMPT);
    await sweepDialogs(repos, log() as never, now, deps);
    expect(repos.tabs.listResting).toHaveBeenCalledWith(new Date(now.getTime() - DIALOG_WINDOW_MS), [...RESTING_STATES, 'cli_dialog']);
  });

  it('"Teach auto mode" after the turn ended: the finished tab becomes cli_dialog, naming it, and it alerts', async () => {
    publish.mockClear();
    const { repos, recordEvent, deps } = setup([tab()], TEACH);
    const l = log();
    await sweepDialogs(repos, l as never, now, deps);
    expect(recordEvent).toHaveBeenCalledWith('t1', {
      kind: 'cli_dialog',
      tool: 'claude',
      text: 'Diálogo do Claude Code aberto: "Teach auto mode about your environment?". O texto digitado na aba se perde até ele fechar',
      meta: { event: 'ScreenCheck', screen: 'cli_dialog', dialog: 'claude_auto_mode_setup' },
      ifStateAt: AT,
      ifStateIn: RESTING_STATES,
    });
    expect(publish).toHaveBeenCalledTimes(1);
    // ids only: the screen is never logged
    expect(JSON.stringify(l.info.mock.calls)).not.toContain('PR #812');
  });

  it('an unnamed dialog (a menu the person opened) and a plain prompt change nothing', async () => {
    for (const screen of [HOOKS_MENU, PROMPT]) {
      const { repos, recordEvent, deps } = setup([tab()], screen);
      await sweepDialogs(repos, log() as never, now, deps);
      expect(recordEvent).not.toHaveBeenCalled();
    }
  });

  it('reads a fresh resting tab at every sweep, an older one every DIALOG_RECHECK_MS', async () => {
    const old = tab({ state_at: new Date(now.getTime() - DIALOG_FRESH_MS - 1).toISOString() });
    const { repos, capture, deps } = setup([old], PROMPT);
    await sweepDialogs(repos, log() as never, now, deps);
    await sweepDialogs(repos, log() as never, new Date(now.getTime() + 60_000), deps);
    expect(capture).toHaveBeenCalledTimes(1);
    await sweepDialogs(repos, log() as never, new Date(now.getTime() + DIALOG_RECHECK_MS), deps);
    expect(capture).toHaveBeenCalledTimes(2);

    const fresh = setup([tab()], PROMPT);
    await sweepDialogs(fresh.repos, log() as never, now, fresh.deps);
    await sweepDialogs(fresh.repos, log() as never, new Date(now.getTime() + 60_000), fresh.deps);
    expect(fresh.capture).toHaveBeenCalledTimes(2);
  });

  it('the dialog closed without a new turn: back to the turn end its last answer reads as, without alerting again', async () => {
    const { repos, recordEvent, deps } = setup([tab({ state: 'cli_dialog' })], PROMPT);
    await sweepDialogs(repos, log() as never, now, deps);
    expect(recordEvent).toHaveBeenCalledWith('t1', expect.objectContaining({ kind: 'finished', text: 'Pronto: o PR está aberto.', continuesWait: true, keepsWaitText: true, ifStateAt: AT, ifStateIn: ['cli_dialog'] }));
  });

  it('a dialog closed on a tab with no answer goes idle; one still open is left as it is', async () => {
    const none = setup([tab({ state: 'cli_dialog' })], PROMPT, { answer: null });
    await sweepDialogs(none.repos, log() as never, now, none.deps);
    expect(none.recordEvent).toHaveBeenCalledWith('t1', expect.objectContaining({ kind: 'idle', text: null }));
    const open = setup([tab({ state: 'cli_dialog' })], TEACH);
    await sweepDialogs(open.repos, log() as never, now, open.deps);
    expect(open.recordEvent).not.toHaveBeenCalled();
  });
});

describe('the other sweeps also read a named CLI dialog (TER-1166)', () => {
  it('a Codex tab that never reported, on "Hooks need review", becomes cli_dialog', async () => {
    const { repos, recordEvent, deps } = setup([tab({ state: null, state_at: null, state_tool: null, created_at: AT } as Partial<Tab>)], HOOKS_REVIEW);
    await sweepUnreported(repos, log() as never, new Date(Date.parse(AT) + UNREPORTED_AFTER_MS + 1), deps);
    expect(recordEvent).toHaveBeenCalledWith('t1', expect.objectContaining({ kind: 'cli_dialog', tool: 'codex', meta: { event: 'ScreenCheck', screen: 'cli_dialog', dialog: 'codex_hooks_review' }, ifStateIn: [null] }));
  });

  it('a working Claude tab whose hooks went quiet on "Teach auto mode" is cli_dialog, not a permission wait', async () => {
    const { repos, recordEvent, deps } = setup([tab({ state: 'working' })], TEACH);
    await sweepStaleWorking(repos, log() as never, new Date(Date.parse(AT) + STALE_WORKING_MS + 1), deps);
    expect(recordEvent).toHaveBeenCalledTimes(1);
    expect(recordEvent).toHaveBeenCalledWith('t1', expect.objectContaining({ kind: 'cli_dialog', ifStateIn: ['working', 'waiting_background'] }));
  });

  it('a working Codex tab on "Hooks need review" is cli_dialog too', async () => {
    const { repos, recordEvent, deps } = setup([tab({ state: 'working', state_tool: 'codex' })], HOOKS_REVIEW);
    await sweepStaleWorking(repos, log() as never, new Date(Date.parse(AT) + STALE_WORKING_MS + 1), deps);
    expect(recordEvent).toHaveBeenCalledWith('t1', expect.objectContaining({ kind: 'cli_dialog', tool: 'codex' }));
  });
});

// TER-1162: in the project's folder, with the project's option on, the server answers the review itself
describe('Codex hooks review answered by the server (TER-1162)', () => {
  function trusting(tabs: Tab[], on = true) {
    const s = setup(tabs, HOOKS_REVIEW);
    Object.assign(s.repos, {
      projectSetup: { get: vi.fn(async () => ({ data: { agent: { trust_project_folder: on } } })) },
      projectMachines: { find: vi.fn(async () => ({ project_id: 'p1', machine_id: 'm1', cwd: '/srv/api' })) },
      automationRuns: { latestByTab: vi.fn(async () => null) },
    });
    const trust = { capture: vi.fn(async () => HOOKS_ON_TRUST), sendEnter: vi.fn(async () => {}), sendUp: vi.fn(async () => {}), sendDown: vi.fn(async () => {}), pause: vi.fn(async () => {}), now: () => Date.now() };
    return { ...s, deps: { ...s.deps, trust }, trust };
  }
  const unreported = () => tab({ id: `u${Math.random()}`, state: null, state_at: null, state_tool: null, cwd: null, created_at: AT } as Partial<Tab>);

  it('a tab that never reported gets "Trust all and continue" and is not marked cli_dialog', async () => {
    const { repos, recordEvent, deps, trust } = trusting([unreported()]);
    await sweepUnreported(repos, log() as never, new Date(Date.parse(AT) + UNREPORTED_AFTER_MS + 1), deps);
    expect(trust.sendDown).toHaveBeenCalledTimes(1);
    expect(trust.sendEnter).toHaveBeenCalledTimes(1);
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it('a tab already held as cli_dialog (from before this change) is answered too', async () => {
    const { repos, recordEvent, deps, trust } = trusting([tab({ id: 'held', state: 'cli_dialog', state_tool: 'codex', cwd: null } as Partial<Tab>)]);
    await sweepDialogs(repos, log() as never, new Date(Date.parse(AT) + 60_000), deps);
    expect(trust.sendEnter).toHaveBeenCalledTimes(1);
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it('with the option off the tab stays with the person: cli_dialog, no key pressed', async () => {
    const { repos, recordEvent, deps, trust } = trusting([unreported()], false);
    await sweepUnreported(repos, log() as never, new Date(Date.parse(AT) + UNREPORTED_AFTER_MS + 1), deps);
    expect(trust.sendDown).not.toHaveBeenCalled();
    expect(trust.sendEnter).not.toHaveBeenCalled();
    expect(recordEvent).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ kind: 'cli_dialog', meta: expect.objectContaining({ dialog: 'codex_hooks_review' }) }));
  });
});
