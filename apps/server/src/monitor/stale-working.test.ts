import { describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import type { Machine, Tab } from '../db/repositories/types.js';

const publish = vi.fn();
vi.mock('./bus.js', () => ({ monitorBus: { publish: (...a: unknown[]) => publish(...a) } }));
vi.mock('../chat/agent-exited.js', () => ({ AGENT_EXITED_TEXT: 'Agente encerrado sem terminar o turno', notifyAgentExited: vi.fn() }));

const { BACKGROUND_TIMEOUT_MINUTES, STALE_WORKING_MS, sweepStaleWorking } = await import('./stale-working.js');

const AT = '2026-09-30T05:16:45.106Z';
const tab = (over: Partial<Tab> = {}): Tab => ({ id: 't1', project_id: 'p1', name: 't', kind: 'terminal', tmux_session: 'th-t1', state: 'working', state_tool: 'claude', state_at: AT, ...over }) as Tab;
const machine = (over: Partial<Machine> = {}): Machine => ({ id: 'm1', owner_id: 'u1', type: 'agent', ...over }) as Machine;
const log = () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn() });

const PROMPT = '● Pronto.\n\n✻ Brewed for 3s\n\n────────────\n❯ \n────────────';
const BUSY = '● Rodando\n\n✢ Catapulting… (14s · ↓ 145 tokens)\n\n────────────\n❯ \n────────────';
const QUESTION = ' ☐ Pet\nDo you prefer cats or dogs?\n❯ 1. Cats\n  2. Dogs\n\nEnter to select · ↑/↓ to navigate · Esc to cancel';

function setup(tabs: Tab[], screen: string, opts: { online?: boolean; machine?: Machine; pane?: 'shell' | 'busy' | 'dead' | null; answer?: { text: string; stale: boolean } | null } = {}) {
  const recordEvent = vi.fn(async (_id: string, ev: { kind: Tab['state'] }) => ({ tab: tab({ state: ev.kind }), event: {}, rearm: null }));
  const readLastAnswer = vi.fn(async () => (opts.answer === undefined ? { text: 'Pronto.', at: AT, tool: 'claude', stale: false } : opts.answer));
  const repos = {
    tabs: { listStaleWorking: vi.fn(async () => tabs), recordEvent, readLastAnswer },
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

  it('back at its prompt: waiting for input, only if nothing moved since the read, and it alerts', async () => {
    publish.mockClear();
    const { repos, recordEvent, capture, deps } = setup([tab()], PROMPT);
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

    const claude = setup([tab()], PROMPT, { pane: null });
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
    const s = setup([waiting()], DONE, { answer: { text: 'Posso criar o link se ele quiser.', stale: false } });
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
