import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import type { Machine, Tab } from '../db/repositories/types.js';

const publish = vi.fn();
vi.mock('./bus.js', () => ({ monitorBus: { publish: (...a: unknown[]) => publish(...a) } }));
vi.mock('../chat/agent-exited.js', () => ({ AGENT_EXITED_TEXT: 'Agente encerrado sem terminar o turno', notifyAgentExited: vi.fn() }));

const { BACKGROUND_TIMEOUT_MINUTES, STALE_WORKING_MS, UNREPORTED_AFTER_MS, UNREPORTED_RECHECK_MS, sweepStaleWorking, sweepUnreported } = await import('./stale-working.js');

const AT = '2026-09-30T05:16:45.106Z';
const tab = (over: Partial<Tab> = {}): Tab => ({ id: 't1', project_id: 'p1', name: 't', kind: 'terminal', tmux_session: 'th-t1', state: 'working', state_tool: 'claude', state_at: AT, ...over }) as Tab;
const machine = (over: Partial<Machine> = {}): Machine => ({ id: 'm1', owner_id: 'u1', type: 'agent', ...over }) as Machine;
const log = () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn() });

const PROMPT = '● Pronto.\n\n✻ Brewed for 3s\n\n────────────\n❯ \n────────────';
const BUSY = '● Rodando\n\n✢ Catapulting… (14s · ↓ 145 tokens)\n\n────────────\n❯ \n────────────';
const QUESTION = ' ☐ Pet\nDo you prefer cats or dogs?\n❯ 1. Cats\n  2. Dogs\n\nEnter to select · ↑/↓ to navigate · Esc to cancel';

function setup(tabs: Tab[], screen: string, opts: { online?: boolean; machine?: Machine; pane?: 'shell' | 'busy' | 'dead' | null; answer?: { text: string; stale: boolean } | null } = {}) {
  const recordEvent = vi.fn(async (_id: string, ev: { kind: Tab['state'] }) => ({ tab: tab({ state: ev.kind }), event: {}, rearm: null }));
  const readLastAnswer = vi.fn(async () => (opts.answer === undefined ? { text: 'Pronto.', at: AT, tool: 'claude', stale: false } : opts.answer && { at: AT, tool: 'claude', ...opts.answer }));
  const repos = {
    tabs: { listStaleWorking: vi.fn(async () => tabs), listUnreported: vi.fn(async () => tabs), recordEvent, readLastAnswer },
    machines: { findById: vi.fn(async () => opts.machine ?? machine()) },
  } as unknown as Repositories;
  const capture = vi.fn(async () => screen);
  // null by default: an agent older than 0.14.0 cannot tell, and the screen decides alone (TER-615)
  const foreground = vi.fn(async () => (opts.pane === undefined ? null : opts.pane));
  const exited = vi.fn(async () => {});
  const deps = {
    capture,
    foreground,
    exited,
    isOnline: () => opts.online ?? true,
    checked: new Map<string, { stateAt: string; at: number }>(),
    backgroundTimeoutMs: BACKGROUND_TIMEOUT_MINUTES * 60_000,
    screens: new Map<string, string>(),
  };
  return { repos, recordEvent, readLastAnswer, capture, foreground, exited, deps };
}

describe('sweepStaleWorking — a tab the hooks left working (TER-615)', () => {
  const now = new Date(Date.parse(AT) + STALE_WORKING_MS + 1);

  it('asks for Claude and Codex tabs working with no event for STALE_WORKING_MS', async () => {
    const { repos, deps } = setup([], PROMPT);
    await sweepStaleWorking(repos, log() as never, now, deps);
    expect(repos.tabs.listStaleWorking).toHaveBeenCalledWith(new Date(now.getTime() - STALE_WORKING_MS));
  });

  it('back at its prompt after a turn whose Stop never came: waiting for input, only if nothing moved since the read, and it alerts', async () => {
    publish.mockClear();
    const { repos, recordEvent, capture, deps } = setup([tab()], PROMPT, { answer: { text: 'Pronto.', stale: true } });
    const l = log();
    await sweepStaleWorking(repos, l as never, now, deps);
    expect(capture).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1' }), 'th-t1', expect.any(Number));
    expect(recordEvent).toHaveBeenCalledWith('t1', { kind: 'waiting_input', tool: 'claude', text: null, meta: { event: 'ScreenCheck', screen: 'prompt' }, ifStateAt: AT });
    expect(publish).toHaveBeenCalledTimes(1);
    // metadata only: the screen is never logged
    expect(l.info).toHaveBeenCalledWith({ tabId: 't1', machineId: 'm1', screen: 'prompt', recorded: true }, 'monitor: stale working tab read from the screen');
    expect(JSON.stringify(l.info.mock.calls)).not.toContain('Pronto');
  });

  it('a question or a permission dialog on screen: waiting for permission, as the hooks would have said', async () => {
    const { repos, recordEvent, deps } = setup([tab()], QUESTION);
    await sweepStaleWorking(repos, log() as never, now, deps);
    expect(recordEvent).toHaveBeenCalledWith('t1', expect.objectContaining({ kind: 'waiting_permission', meta: { event: 'ScreenCheck', screen: 'dialog' } }));
  });

  it('a turn still running (a long build) or an unknown screen changes nothing', async () => {
    for (const screen of [BUSY, 'pedro@jarvis:~$ ']) {
      const { repos, recordEvent, deps } = setup([tab()], screen);
      await sweepStaleWorking(repos, log() as never, now, deps);
      expect(recordEvent).not.toHaveBeenCalled();
    }
  });

  it('reads a busy tab again only once STALE_WORKING_MS passed, or as soon as its state moved', async () => {
    const { repos, capture, deps } = setup([tab()], BUSY);
    await sweepStaleWorking(repos, log() as never, now, deps);
    await sweepStaleWorking(repos, log() as never, new Date(now.getTime() + 60_000), deps);
    expect(capture).toHaveBeenCalledTimes(1);
    await sweepStaleWorking(repos, log() as never, new Date(now.getTime() + STALE_WORKING_MS), deps);
    expect(capture).toHaveBeenCalledTimes(2);
    (repos.tabs.listStaleWorking as ReturnType<typeof vi.fn>).mockResolvedValueOnce([tab({ state_at: '2026-09-30T05:20:00.000Z' })]);
    await sweepStaleWorking(repos, log() as never, new Date(now.getTime() + STALE_WORKING_MS + 60_000), deps);
    expect(capture).toHaveBeenCalledTimes(3);
  });

  it('skips a machine whose agent is offline, and one capture failing does not stop the others', async () => {
    const offline = setup([tab()], PROMPT, { online: false });
    await sweepStaleWorking(offline.repos, log() as never, now, offline.deps);
    expect(offline.capture).not.toHaveBeenCalled();

    const { repos, recordEvent, capture, deps } = setup([tab({ id: 't1' }), tab({ id: 't2', tmux_session: 'th-t2' })], PROMPT);
    capture.mockRejectedValueOnce(new Error('rpc timeout'));
    const l = log();
    await sweepStaleWorking(repos, l as never, now, deps);
    expect(recordEvent).toHaveBeenCalledTimes(1);
    expect(recordEvent).toHaveBeenCalledWith('t2', expect.anything());
    expect(l.warn).toHaveBeenCalledWith(expect.objectContaining({ tabId: 't1' }), 'monitor: stale working check failed');
  });

  it('a hook that landed meanwhile wins: nothing is published', async () => {
    publish.mockClear();
    const { repos, recordEvent, deps } = setup([tab()], PROMPT);
    recordEvent.mockResolvedValueOnce({ tab: tab(), event: null, rearm: null } as never);
    await sweepStaleWorking(repos, log() as never, now, deps);
    expect(publish).not.toHaveBeenCalled();
  });
});

describe('sweepStaleWorking — back to the turn end a compaction left (TER-1133)', () => {
  const now = new Date(Date.parse(AT) + STALE_WORKING_MS + 1);
  const COMPACTED = readFileSync(new URL('./fixtures/claude-screens/compacted-idle-2.1.txt', import.meta.url), 'utf8');

  it('reads the screen Claude Code leaves after "Compacted while idle" as its prompt', async () => {
    const { claudeScreenState } = await import('./screen-state.js');
    expect(claudeScreenState(COMPACTED)).toBe('prompt');
  });

  it('a report with nothing after it: finished again, with the answer as its text, not a new alert', async () => {
    publish.mockClear();
    const answer = { text: 'Abri o PR #527 e reportei o card como feito.', stale: false };
    const { repos, recordEvent, deps } = setup([tab()], COMPACTED, { answer });
    const l = log();
    await sweepStaleWorking(repos, l as never, now, deps);
    expect(recordEvent).toHaveBeenCalledWith('t1', {
      kind: 'finished',
      tool: 'claude',
      text: answer.text,
      meta: { event: 'ScreenCheck', screen: 'prompt', restored: true },
      continuesWait: true,
      keepsWaitText: true,
      ifStateAt: AT,
    });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(l.info).toHaveBeenCalledWith({ tabId: 't1', machineId: 'm1', kind: 'finished', recorded: true }, 'monitor: stale working tab back to its turn end');
    expect(JSON.stringify(l.info.mock.calls)).not.toContain('PR #527');
  });

  it('an answer that asks something: a wait for input again', async () => {
    const { repos, recordEvent, deps } = setup([tab()], COMPACTED, { answer: { text: 'Posso mesclar o PR?', stale: false } });
    await sweepStaleWorking(repos, log() as never, now, deps);
    expect(recordEvent).toHaveBeenCalledWith('t1', expect.objectContaining({ kind: 'waiting_input', text: 'Posso mesclar o PR?', meta: expect.objectContaining({ restored: true }) }));
  });

  it("another tool's answer is not this Claude's turn: the plain screen reading", async () => {
    const { repos, recordEvent, deps } = setup([tab()], COMPACTED, { answer: { text: 'Pronto.', stale: false, tool: 'codex' } as never });
    await sweepStaleWorking(repos, log() as never, now, deps);
    expect(recordEvent).toHaveBeenCalledWith('t1', expect.objectContaining({ kind: 'waiting_input', text: null, meta: { event: 'ScreenCheck', screen: 'prompt' } }));
  });

  it('warns when the list is full: the newest stuck tabs would be left out', async () => {
    const { STALE_WORKING_LIMIT } = await import('../db/repositories/tabs.js');
    const many = Array.from({ length: STALE_WORKING_LIMIT }, (_, i) => tab({ id: `t${i}`, tmux_session: null }));
    const { repos, deps } = setup(many, PROMPT);
    const l = log();
    await sweepStaleWorking(repos, l as never, now, deps);
    expect(l.warn).toHaveBeenCalledWith({ count: STALE_WORKING_LIMIT }, 'monitor: stale working list is full');
  });
});

describe('sweepStaleWorking — the agent exited without a hook (TER-643)', () => {
  const now = new Date(Date.parse(AT) + STALE_WORKING_MS + 1);
  const SHELL = 'pedrogoiania:~/termhub$ ';

  it('the pane is back at its shell with no Stop: idle, "agente encerrado", alerted and announced in the chat', async () => {
    publish.mockClear();
    const { repos, recordEvent, capture, foreground, exited, deps } = setup([tab()], SHELL, { pane: 'shell' });
    const l = log();
    await sweepStaleWorking(repos, l as never, now, deps);
    expect(foreground).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1' }), 'th-t1');
    expect(recordEvent).toHaveBeenCalledWith('t1', { kind: 'idle', tool: 'claude', text: 'Agente encerrado sem terminar o turno', meta: { event: 'AgentExited', pane: 'shell' }, ifStateAt: AT });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(exited).toHaveBeenCalledWith(repos, l, expect.objectContaining({ id: 't1', state: 'idle' }), expect.objectContaining({ id: 'm1' }), AT);
    // the pane settles it: the screen is not read
    expect(capture).not.toHaveBeenCalled();
    expect(l.info).toHaveBeenCalledWith({ tabId: 't1', machineId: 'm1', tool: 'claude', pane: 'shell', recorded: true }, 'monitor: agent exited without a hook');
  });

  it('a Codex tab is looked at too, and a dead pane counts as exited', async () => {
    const { repos, recordEvent, exited, deps } = setup([tab({ state_tool: 'codex' })], SHELL, { pane: 'dead' });
    await sweepStaleWorking(repos, log() as never, now, deps);
    expect(recordEvent).toHaveBeenCalledWith('t1', expect.objectContaining({ kind: 'idle', tool: 'codex', meta: { event: 'AgentExited', pane: 'dead' } }));
    expect(exited).toHaveBeenCalledTimes(1);
  });

  it('the agent still in front: a Claude tab goes on to its screen, a Codex tab is left alone', async () => {
    const claude = setup([tab()], BUSY, { pane: 'busy' });
    await sweepStaleWorking(claude.repos, log() as never, now, claude.deps);
    expect(claude.capture).toHaveBeenCalledTimes(1);
    expect(claude.recordEvent).not.toHaveBeenCalled();

    const codex = setup([tab({ state_tool: 'codex' })], PROMPT, { pane: 'busy' });
    await sweepStaleWorking(codex.repos, log() as never, now, codex.deps);
    expect(codex.capture).not.toHaveBeenCalled();
    expect(codex.recordEvent).not.toHaveBeenCalled();
    expect(codex.exited).not.toHaveBeenCalled();
  });

  it('a pane it cannot read (an older agent) leaves a Codex tab as it was and a Claude tab to its screen', async () => {
    const codex = setup([tab({ state_tool: 'codex' })], SHELL, { pane: null });
    await sweepStaleWorking(codex.repos, log() as never, now, codex.deps);
    expect(codex.recordEvent).not.toHaveBeenCalled();

    const claude = setup([tab()], PROMPT, { pane: null, answer: null });
    await sweepStaleWorking(claude.repos, log() as never, now, claude.deps);
    expect(claude.recordEvent).toHaveBeenCalledWith('t1', expect.objectContaining({ kind: 'waiting_input' }));
    expect(claude.exited).not.toHaveBeenCalled();
  });

  it('a hook that landed meanwhile wins: no card', async () => {
    publish.mockClear();
    const { repos, recordEvent, exited, deps } = setup([tab()], SHELL, { pane: 'shell' });
    recordEvent.mockResolvedValueOnce({ tab: tab(), event: null, rearm: null } as never);
    await sweepStaleWorking(repos, log() as never, now, deps);
    expect(publish).not.toHaveBeenCalled();
    expect(exited).not.toHaveBeenCalled();
  });
});

describe('sweepStaleWorking — background work (TER-644)', () => {
  const now = new Date(Date.parse(AT) + STALE_WORKING_MS + 1);
  const WAITING_BACKGROUND = '● Aguardando o subagente.\n\n✻ Waiting for 1 background agent to finish\n\n────────────\n❯ \n────────────';

  it('a working tab whose turn ended on background work is waiting on it, not on the person', async () => {
    const { repos, recordEvent, deps } = setup([tab()], WAITING_BACKGROUND);
    await sweepStaleWorking(repos, log() as never, now, deps);
    expect(recordEvent).toHaveBeenCalledWith('t1', { kind: 'waiting_background', tool: 'claude', text: null, meta: { event: 'ScreenCheck', screen: 'background' }, ifStateAt: AT });
  });

  it('a tab already waiting on its background work only gets the exit check: a quiet screen proves nothing', async () => {
    const quiet = setup([tab({ state: 'waiting_background' })], PROMPT, { pane: 'busy' });
    await sweepStaleWorking(quiet.repos, log() as never, now, quiet.deps);
    expect(quiet.foreground).toHaveBeenCalled();
    expect(quiet.capture).not.toHaveBeenCalled();
    expect(quiet.recordEvent).not.toHaveBeenCalled();

    const gone = setup([tab({ state: 'waiting_background' })], 'pedro@jarvis:~$ ', { pane: 'shell' });
    await sweepStaleWorking(gone.repos, log() as never, now, gone.deps);
    expect(gone.recordEvent).toHaveBeenCalledWith('t1', expect.objectContaining({ kind: 'idle', meta: { event: 'AgentExited', pane: 'shell' }, ifStateAt: AT }));
    expect(gone.exited).toHaveBeenCalled();
  });
});

describe('sweepStaleWorking / sweepUnreported — the trust dialog and the login error (TER-1046)', () => {
  const now = new Date(Date.parse(AT) + STALE_WORKING_MS + 1);
  const LOGIN = readFileSync(new URL('./fixtures/claude-screens/login-expired-2.1.289.txt', import.meta.url), 'utf8');
  const TRUST = readFileSync(new URL('./fixtures/claude-screens/trust-2.1.289.txt', import.meta.url), 'utf8');

  it('a working tab back at its prompt on the login error is auth_required', async () => {
    const { repos, recordEvent, deps } = setup([tab()], LOGIN);
    await sweepStaleWorking(repos, log() as never, now, deps);
    expect(recordEvent).toHaveBeenCalledWith('t1', { kind: 'auth_required', tool: 'claude', text: 'Login da conta expirou: rode /login nesta aba', meta: { event: 'ScreenCheck', screen: 'auth' }, ifStateAt: AT });
  });

  it('a tab that never reported, with Claude Code on the trust dialog, is trust_prompt; with the login error, auth_required', async () => {
    publish.mockClear();
    const unreported = tab({ state: null, state_at: null, state_tool: null });
    const trust = setup([unreported], TRUST, { pane: 'busy' });
    const l = log();
    await sweepUnreported(trust.repos, l as never, now, trust.deps);
    expect(trust.repos.tabs.listUnreported).toHaveBeenCalledWith(expect.any(Date), new Date(now.getTime() - UNREPORTED_AFTER_MS));
    expect(trust.recordEvent).toHaveBeenCalledWith('t1', expect.objectContaining({ kind: 'trust_prompt', tool: 'claude', meta: { event: 'ScreenCheck', screen: 'trust' }, ifStateAt: null, ifStateIn: [null] }));
    expect(publish).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(l.info.mock.calls)).not.toContain('trust this folder');

    const login = setup([unreported], LOGIN, { pane: 'busy' });
    await sweepUnreported(login.repos, log() as never, now, login.deps);
    expect(login.recordEvent).toHaveBeenCalledWith('t1', expect.objectContaining({ kind: 'auth_required', ifStateIn: [null] }));
  });

  it("TER-1117: a Claude Code started by hand in the project's own folder has the dialog answered, not reported", async () => {
    publish.mockClear();
    const unreported = tab({ state: null, state_at: null, state_tool: null, cwd: null });
    const s = setup([unreported], TRUST, { pane: 'busy' });
    (s.repos as unknown as { projectSetup: unknown }).projectSetup = { get: vi.fn(async () => ({ data: { agent: { trust_project_folder: true } } })) };
    const sendEnter = vi.fn(async () => {});
    await sweepUnreported(s.repos, log() as never, now, { ...s.deps, trust: { capture: s.capture, sendEnter, now: () => 0 } });
    expect(sendEnter).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1' }), 'th-t1');
    expect(s.recordEvent).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('a plain shell or an ordinary prompt stays unreported, and is read again only after the recheck delay', async () => {
    const unreported = tab({ state: null, state_at: null, state_tool: null });
    const shell = setup([unreported], 'pedro@jarvis:~$ ', { pane: 'shell' });
    await sweepUnreported(shell.repos, log() as never, now, shell.deps);
    expect(shell.capture).not.toHaveBeenCalled();
    expect(shell.recordEvent).not.toHaveBeenCalled();

    const prompt = setup([unreported], PROMPT, { pane: 'busy' });
    await sweepUnreported(prompt.repos, log() as never, now, prompt.deps);
    await sweepUnreported(prompt.repos, log() as never, new Date(now.getTime() + 60_000), prompt.deps);
    expect(prompt.capture).toHaveBeenCalledTimes(1);
    expect(prompt.recordEvent).not.toHaveBeenCalled();
    await sweepUnreported(prompt.repos, log() as never, new Date(now.getTime() + UNREPORTED_RECHECK_MS), prompt.deps);
    expect(prompt.capture).toHaveBeenCalledTimes(2);
  });
});

describe('sweepStaleWorking — a background wait that never reports (TER-1053)', () => {
  const TIMEOUT = BACKGROUND_TIMEOUT_MINUTES * 60_000;
  const start = Date.parse(AT) + TIMEOUT + 1;
  // what the hung tab showed: the turn done, a Monitor left running, the input box with the next suggestion
  const DONE = '  O CI do #940 ainda não foi verificado.\n\n✻ Crunched for 2m 3s · done 5:27 PM · 1 monitor still running\n────────────\n❯ cita o #940 no #849\n────────────\n  ⏵⏵ auto mode on · 1 monitor · ← for agents';
  const waiting = (over: Partial<Tab> = {}) => tab({ state: 'waiting_background', state_text: 'O PR está aberto, e parei aqui.', ...over });

  /** Two sweeps one STALE_WORKING_MS apart: the screen is compared across them. */
  async function twice(s: ReturnType<typeof setup>, l = log()) {
    await sweepStaleWorking(s.repos, l as never, new Date(start), s.deps);
    await sweepStaleWorking(s.repos, l as never, new Date(start + STALE_WORKING_MS), s.deps);
    return l;
  }

  it('past the timeout, back at its prompt on a screen that did not move: finished, keeping its text, and it alerts', async () => {
    publish.mockClear();
    const s = setup([waiting()], DONE, { pane: 'busy', answer: { text: 'O PR está aberto, e parei aqui como pedido.', stale: false } });
    await sweepStaleWorking(s.repos, log() as never, new Date(start), s.deps);
    // the first read only takes the screen's digest
    expect(s.recordEvent).not.toHaveBeenCalled();
    const l = log();
    await sweepStaleWorking(s.repos, l as never, new Date(start + STALE_WORKING_MS), s.deps);
    expect(s.capture).toHaveBeenCalledTimes(2);
    expect(s.recordEvent).toHaveBeenCalledWith('t1', { kind: 'finished', tool: 'claude', text: 'O PR está aberto, e parei aqui.', meta: { event: 'BackgroundTimeout', screen: 'prompt' }, ifStateAt: AT });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(l.info).toHaveBeenCalledWith({ tabId: 't1', machineId: 'm1', kind: 'finished', recorded: true }, 'monitor: background wait timed out');
    // metadata only: neither the screen nor the answer is logged
    expect(JSON.stringify(l.info.mock.calls)).not.toMatch(/PR|monitor still/);
  });

  it('a last answer that asks something becomes a wait for the person', async () => {
    const s = setup([waiting()], DONE, { answer: { text: 'Quer que eu crie o link?', stale: false } });
    await twice(s);
    expect(s.recordEvent).toHaveBeenCalledWith('t1', expect.objectContaining({ kind: 'waiting_input', meta: { event: 'BackgroundTimeout', screen: 'prompt' } }));
  });

  it('before the timeout, the screen is not even read', async () => {
    const s = setup([waiting()], DONE);
    await sweepStaleWorking(s.repos, log() as never, new Date(Date.parse(AT) + STALE_WORKING_MS + 1), s.deps);
    expect(s.capture).not.toHaveBeenCalled();
  });

  it('a screen that moved, a turn running, or Claude Code still waiting on its agents: nothing changes', async () => {
    const moving = setup([waiting()], DONE);
    moving.capture.mockResolvedValueOnce(DONE).mockResolvedValueOnce(`${DONE}\n● Monitor event`);
    await twice(moving);
    expect(moving.recordEvent).not.toHaveBeenCalled();

    for (const screen of ['● Rodando\n\n✢ Catapulting… (14s · ↓ 145 tokens)\n\n────────────\n❯ \n────────────', '● Aguardando.\n\n✻ Waiting for 1 background agent to finish\n\n────────────\n❯ \n────────────']) {
      const s = setup([waiting()], screen);
      await twice(s);
      expect(s.recordEvent).not.toHaveBeenCalled();
    }
  });

  it('no answer, or one older than a turn since: nothing changes', async () => {
    for (const answer of [null, { text: 'Pronto.', stale: true }]) {
      const s = setup([waiting()], DONE, { answer });
      await twice(s);
      expect(s.recordEvent).not.toHaveBeenCalled();
    }
  });

  it('a timeout of 0 turns it off, and a Codex tab is never read', async () => {
    const off = setup([waiting()], DONE);
    off.deps.backgroundTimeoutMs = 0;
    await twice(off);
    expect(off.capture).not.toHaveBeenCalled();

    const codex = setup([waiting({ state_tool: 'codex' })], DONE);
    await twice(codex);
    expect(codex.capture).not.toHaveBeenCalled();
  });

  it('a hook that landed meanwhile wins: nothing is published', async () => {
    publish.mockClear();
    const s = setup([waiting()], DONE);
    s.recordEvent.mockResolvedValueOnce({ tab: waiting(), event: null, rearm: null } as never);
    await twice(s);
    expect(publish).not.toHaveBeenCalled();
  });
});
