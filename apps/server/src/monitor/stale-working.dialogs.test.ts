import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import type { Machine, Tab } from '../db/repositories/types.js';

const publish = vi.fn();
vi.mock('./bus.js', () => ({ monitorBus: { publish: (...a: unknown[]) => publish(...a) } }));
vi.mock('../chat/agent-exited.js', () => ({ AGENT_EXITED_TEXT: 'Agente encerrado sem terminar o turno', notifyAgentExited: vi.fn() }));

const { BACKGROUND_TIMEOUT_MINUTES, DIALOG_FRESH_MS, DIALOG_RECHECK_MS, DIALOG_WINDOW_MS, RESTING_STATES, STALE_WORKING_MS, UNREPORTED_AFTER_MS, sweepDialogs, sweepStaleWorking, sweepUnreported } = await import('./stale-working.js');

const fixture = (name: string) => readFileSync(new URL(`./fixtures/cli-dialogs/${name}.txt`, import.meta.url), 'utf8');
const TEACH = fixture('claude-teach-auto-mode-2.1.322');
const HOOKS_REVIEW = fixture('codex-hooks-review-0.159.3');
const HOOKS_MENU = fixture('claude-hooks-2.1.322');
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
