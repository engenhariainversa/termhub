import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../agent/screen.js', () => ({ captureScreen: vi.fn(), captureStyledScreen: vi.fn() }));

import { captureScreen, captureStyledScreen } from '../agent/screen.js';
import { AgentOfflineError, agents } from '../agent/registry.js';
import { toHttpError } from '../agent/errors.js';
import { AgentTimeoutError } from '../agent/connection.js';
import type { Repositories } from '../db/repositories/index.js';
import type { LastAnswer } from '../db/repositories/tabs.js';
import type { Machine, Project, Tab } from '../db/repositories/types.js';
import { monitorBus } from '../monitor/bus.js';
import { Scoped } from '../auth/scope.js';
import type { ControlContext } from './context.js';
import { FULL_SCREEN_NOTE, NO_ANSWER_NOTE, readLastAnswer, readScreen, waitForState } from './screen.js';

const m1 = { id: 'm1', owner_id: 'u1', type: 'agent' } as Machine;
const p1 = { id: 'p1', owner_id: 'u1' } as Project;
const baseTab = (over: Partial<Tab> = {}): Tab =>
  ({ id: 't1', project_id: 'p1', machine_id: 'm1', name: 't1', kind: 'terminal', tmux_session: 'th-t1', simulator_udid: null, position: 0, state: 'working', state_text: null, state_tool: 'claude', state_at: '2026-09-19T10:00:00.000Z', state_seen_at: null, created_at: '', ...over }) as Tab;

function ctx(tab: Tab | undefined = baseTab(), answer: LastAnswer | null = null): ControlContext {
  const repos = {
    tabs: { findById: vi.fn(async (id: string) => (tab && id === tab.id ? tab : undefined)), readLastAnswer: vi.fn(async () => answer) },
    projects: { findById: vi.fn(async (id: string) => (id === 'p1' ? p1 : undefined)) },
    projectMachines: { find: vi.fn(async () => ({ id: 'l1', project_id: 'p1', machine_id: 'm1', cwd: '/p1', position: 0, created_at: '' })) },
    machines: { findById: vi.fn(async (id: string) => (id === 'm1' ? m1 : undefined)) },
  } as unknown as Repositories;
  const scope = { user: { id: 'u1' } as never, viewAs: { kind: 'self' } as const, ownerId: 'u1', createAs: 'u1' };
  return { repos, scope, scoped: new Scoped(repos, scope), can: async () => true };
}

const publish = (tab: Tab) => monitorBus.publish({ tab, project_id: 'p1', machine_id: 'm1', owner_id: 'u1' });
/** lets the scoped tab lookup (several awaits) finish so the wait has subscribed */
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.mocked(captureScreen).mockReset();
  vi.mocked(captureStyledScreen).mockReset();
  vi.spyOn(agents, 'awaitAgent').mockResolvedValue(true);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('readScreen', () => {
  it('captures the default 200 lines, styled, and clamps to 2000', async () => {
    vi.mocked(captureStyledScreen).mockResolvedValue({ text: '$ ls\nREADME.md\n', styled: true });
    const r = await readScreen(ctx(), { tab_id: 't1' });
    expect(r).toEqual({ tab_id: 't1', lines: 200, text: '$ ls\nREADME.md\n', styled: true, note: FULL_SCREEN_NOTE });
    expect(captureStyledScreen).toHaveBeenCalledWith(m1, 'th-t1', 200);
    await readScreen(ctx(), { tab_id: 't1', lines: 99999 });
    expect(vi.mocked(captureStyledScreen).mock.calls[1]![2]).toBe(2000);
  });

  it('marks dimmed text ⟦…⟧: Claude Code\'s suggestion is not typed text', async () => {
    vi.mocked(captureStyledScreen).mockResolvedValue({ text: '\x1b[39m❯ \x1b[2mcommit it\x1b[0m\n', styled: true });
    const r = await readScreen(ctx(), { tab_id: 't1' });
    expect(r.text).toBe('❯ ⟦commit it⟧\n');
    expect(r.styled).toBe(true);
  });

  it('an older agent answers plain text: passed through as it is, styled false', async () => {
    vi.mocked(captureStyledScreen).mockResolvedValue({ text: '❯ commit it\n', styled: false });
    expect(await readScreen(ctx(), { tab_id: 't1' })).toMatchObject({ text: '❯ commit it\n', styled: false });
  });

  it('plain: true reads the plain capture (TER-56\'s own checks)', async () => {
    vi.mocked(captureScreen).mockResolvedValue('❯ commit it\n');
    expect(await readScreen(ctx(), { tab_id: 't1', lines: 60 }, { plain: true })).toEqual({ tab_id: 't1', lines: 60, text: '❯ commit it\n', styled: false });
    expect(captureStyledScreen).not.toHaveBeenCalled();
  });

  it('refuses simulator tabs and foreign tabs', async () => {
    await expect(readScreen(ctx(baseTab({ kind: 'simulator', tmux_session: null })), { tab_id: 't1' })).rejects.toThrow('Esta aba não é um terminal');
    await expect(readScreen(ctx(), { tab_id: 'nope' })).rejects.toThrow('Tab não encontrada');
  });

  it('reports an offline agent machine as MACHINE_OFFLINE without trying to capture', async () => {
    vi.mocked(agents.awaitAgent).mockResolvedValue(false);
    await expect(readScreen(ctx(), { tab_id: 't1' })).rejects.toMatchObject({ code: 'MACHINE_OFFLINE', message: 'A máquina está offline: o termhub-agent dela não está conectado' });
    expect(captureStyledScreen).not.toHaveBeenCalled();
  });

  it('proceeds once a moving agent (a deploy) attaches within the wait, instead of answering offline at once', async () => {
    let release!: (v: boolean) => void;
    vi.mocked(agents.awaitAgent).mockReturnValue(new Promise<boolean>((r) => (release = r)));
    vi.mocked(captureStyledScreen).mockResolvedValue({ text: '$ ls\n', styled: true });
    const reading = readScreen(ctx(), { tab_id: 't1' });
    await Promise.resolve();
    expect(captureStyledScreen).not.toHaveBeenCalled();
    release(true);
    await expect(reading).resolves.toMatchObject({ text: '$ ls\n' });
    expect(agents.awaitAgent).toHaveBeenCalledWith(m1);
  });

  it('reports an agent that dropped mid-capture as MACHINE_OFFLINE', async () => {
    // exactly what captureStyledScreen -> agentRpc -> toHttpError throws when the connection is gone
    const dropped = toHttpError(new AgentOfflineError('agent offline: m1'));
    expect(dropped).toMatchObject({ statusCode: 503, message: 'Agente desconectado' });
    // mockRejectedValueOnce: with the beforeEach mockReset, vitest 3.2.7's persistent mockRejectedValue
    // spuriously reports an awaited rejection as unhandled (same pattern as terminal/ws.test.ts).
    vi.mocked(captureStyledScreen).mockRejectedValueOnce(dropped);
    await expect(readScreen(ctx(), { tab_id: 't1' })).rejects.toMatchObject({ code: 'MACHINE_OFFLINE' });
  });

  it('keeps other machine failures as they are', async () => {
    const timeout = toHttpError(new AgentTimeoutError('agent rpc timeout: tmux.capture'));
    vi.mocked(captureStyledScreen).mockRejectedValueOnce(timeout);
    await expect(readScreen(ctx(), { tab_id: 't1' })).rejects.toBe(timeout);
  });
});

describe('readLastAnswer', () => {
  const stored = { text: 'a'.repeat(30_000), at: '2026-09-30T03:00:00.000Z', tool: 'claude', stale: false };

  it('answers the first page of the stored answer with its fields, and does not need the machine', async () => {
    vi.spyOn(agents, 'awaitAgent').mockResolvedValue(false);
    const r = await readLastAnswer(ctx(baseTab({ state: 'waiting_input' }), stored), { tab_id: 't1' });
    expect(r).toEqual({ tab_id: 't1', source: 'hook', tool: 'claude', at: stored.at, text: 'a'.repeat(20_000), offset: 0, next_offset: 20_000, chars: 30_000, cut: false, stale: false, state: 'waiting_input', state_at: '2026-09-19T10:00:00.000Z' });
  });

  it('pages with offset and max_chars, clamps max_chars, and answers empty past the end', async () => {
    const c = ctx(baseTab(), stored);
    expect(await readLastAnswer(c, { tab_id: 't1', offset: 20_000 })).toMatchObject({ text: 'a'.repeat(10_000), offset: 20_000, next_offset: null });
    expect(await readLastAnswer(c, { tab_id: 't1', offset: 0, max_chars: 100 })).toMatchObject({ text: 'a'.repeat(100), next_offset: 100 });
    // longer than ANSWER_MAX_CHARS, so an unclamped max_chars would answer it whole
    expect(await readLastAnswer(ctx(baseTab(), { ...stored, text: 'a'.repeat(70_000) }), { tab_id: 't1', max_chars: 999_999 })).toMatchObject({ text: 'a'.repeat(60_000), next_offset: 60_000, chars: 70_000 });
    expect(await readLastAnswer(c, { tab_id: 't1', offset: 40_000 })).toMatchObject({ text: '', offset: 40_000, next_offset: null, chars: 30_000 });
  });

  it('never splits a surrogate pair at a page boundary: the page ends before it and the next one starts on it', async () => {
    const c = ctx(baseTab(), { ...stored, text: `${'a'.repeat(19_999)}😀${'b'.repeat(100)}` });
    const first = await readLastAnswer(c, { tab_id: 't1' });
    expect(first).toMatchObject({ text: 'a'.repeat(19_999), offset: 0, next_offset: 19_999, chars: 20_101 });
    expect(await readLastAnswer(c, { tab_id: 't1', offset: 19_999 })).toMatchObject({ text: `😀${'b'.repeat(100)}`, next_offset: null });
    // a page of one unit on a pair would end empty and never move: it takes the whole pair instead
    expect(await readLastAnswer(c, { tab_id: 't1', offset: 19_999, max_chars: 1 })).toMatchObject({ text: '😀', next_offset: 20_001 });
  });

  it('pages an answer with an emoji at a page boundary and one at the very end: no lone surrogate, and the pages joined are the answer', async () => {
    // 99 + 2 + 97 + 2 units: with pages of 100 the first emoji straddles 99/100 and the last one 198/199
    const text = `${'a'.repeat(99)}😀${'b'.repeat(97)}🎉`;
    const c = ctx(baseTab(), { ...stored, text });
    const isHigh = (u: number) => u >= 0xd800 && u <= 0xdbff;
    const isLow = (u: number) => u >= 0xdc00 && u <= 0xdfff;
    const pages: string[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const r = await readLastAnswer(c, { tab_id: 't1', offset, max_chars: 100 });
      if (r.text === null) throw new Error('no answer');
      expect(r.text.length).toBeGreaterThan(0);
      expect(isLow(r.text.charCodeAt(0))).toBe(false);
      expect(isHigh(r.text.charCodeAt(r.text.length - 1))).toBe(false);
      pages.push(r.text);
      offset = r.next_offset;
    }
    expect(pages).toEqual(['a'.repeat(99), `😀${'b'.repeat(97)}`, '🎉']);
    expect(pages.join('')).toBe(text);
  });

  it('says when the stored answer was cut, and passes stale through', async () => {
    const r = await readLastAnswer(ctx(baseTab(), { ...stored, text: `${'b'.repeat(99_999)}…`, stale: true }), { tab_id: 't1' });
    expect(r).toMatchObject({ chars: 100_000, cut: true, stale: true });
  });

  it('a tab with no answer gets the note', async () => {
    expect(await readLastAnswer(ctx(baseTab(), null), { tab_id: 't1' })).toEqual({ tab_id: 't1', text: null, note: NO_ANSWER_NOTE });
  });

  it('404 for a missing tab and for a tab outside the scope', async () => {
    // ctx(undefined, …) would fall back to the default tab: an unknown id is the missing tab
    await expect(readLastAnswer(ctx(baseTab(), stored), { tab_id: 'nope' })).rejects.toMatchObject({ statusCode: 404 });
    const c = ctx(baseTab(), stored);
    (c.repos.projectMachines.find as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    await expect(readLastAnswer(c, { tab_id: 't1' })).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('readScreen and full-screen agents', () => {
  beforeEach(() => vi.mocked(captureStyledScreen).mockResolvedValue({ text: 'x\n', styled: true }));

  it.each(['claude', 'codex', 'cursor'])('adds the note when the last tool is %s', async (tool) => {
    expect((await readScreen(ctx(baseTab({ state_tool: tool })), { tab_id: 't1' })).note).toBe(FULL_SCREEN_NOTE);
  });

  it('adds the note for a tab with no monitor state at all', async () => {
    expect((await readScreen(ctx(baseTab({ state: null, state_tool: null })), { tab_id: 't1' })).note).toBe(FULL_SCREEN_NOTE);
  });

  it('adds no note for a shell with a state, nor on the plain path', async () => {
    // 'termhub' is the tool a web reply writes on a tab with a state and no tool (routes/tabs.ts); nothing else but the hook tools is ever written
    expect(await readScreen(ctx(baseTab({ state: 'idle', state_tool: 'termhub' })), { tab_id: 't1' })).not.toHaveProperty('note');
    vi.mocked(captureScreen).mockResolvedValue('x\n');
    expect(await readScreen(ctx(baseTab({ state_tool: 'claude' })), { tab_id: 't1' }, { plain: true })).not.toHaveProperty('note');
  });
});

describe('waitForState', () => {
  it('returns at once when the tab is not working', async () => {
    const r = await waitForState(ctx(baseTab({ state: 'waiting_input', state_text: 'Posso seguir?' })), { tab_id: 't1' });
    expect(r).toMatchObject({ tab_id: 't1', state: 'waiting_input', state_text: 'Posso seguir?', timed_out: false });
  });

  it('says there is no monitor for a tab without hook state', async () => {
    const r = await waitForState(ctx(baseTab({ state: null, state_at: null })), { tab_id: 't1' });
    expect(r).toMatchObject({ state: null, timed_out: false });
    expect(r.note).toBe('Esta aba não tem estado do monitor (hooks não instalados na máquina ou nenhuma ferramenta rodou nela). Use read_screen para ver o terminal.');
  });

  it('resolves on the first change of that tab out of working, ignoring other tabs', async () => {
    const p = waitForState(ctx(), { tab_id: 't1', timeout_seconds: 5 });
    await tick();
    publish(baseTab({ id: 'other', state: 'waiting_input' }));
    publish(baseTab({ state: 'working' }));
    publish(baseTab({ state: 'waiting_permission', state_text: 'Rodar npm test?' }));
    await expect(p).resolves.toMatchObject({ state: 'waiting_permission', state_text: 'Rodar npm test?', timed_out: false });
  });

  it('finishes at once when the tab left working between the first read and the subscription', async () => {
    const c = ctx();
    const before = monitorBus.listenerCount();
    vi.mocked(c.repos.tabs.findById)
      .mockResolvedValueOnce(baseTab())
      .mockResolvedValueOnce(baseTab({ state: 'waiting_input', state_text: 'Posso seguir?' }));
    await expect(waitForState(c, { tab_id: 't1', timeout_seconds: 5 })).resolves.toMatchObject({ state: 'waiting_input', state_text: 'Posso seguir?', timed_out: false });
    expect(c.repos.tabs.findById).toHaveBeenCalledTimes(2);
    expect(monitorBus.listenerCount()).toBe(before);
  });

  it('keeps waiting when the re-read after subscribing fails', async () => {
    const c = ctx();
    vi.mocked(c.repos.tabs.findById).mockResolvedValueOnce(baseTab()).mockRejectedValueOnce(new Error('pg down'));
    const p = waitForState(c, { tab_id: 't1', timeout_seconds: 5 });
    await tick();
    await tick();
    publish(baseTab({ state: 'idle' }));
    await expect(p).resolves.toMatchObject({ state: 'idle', timed_out: false });
  });

  it('keeps waiting through waiting_background: the agent waits on its own work, not on the person (TER-644)', async () => {
    const p = waitForState(ctx(), { tab_id: 't1', timeout_seconds: 5 });
    await tick();
    publish(baseTab({ state: 'waiting_background', state_text: 'Aguardando o subagente.' }));
    let done = false;
    void p.then(() => (done = true));
    await tick();
    expect(done).toBe(false);
    publish(baseTab({ state: 'waiting_input', state_text: 'Revisão pronta.' }));
    await expect(p).resolves.toMatchObject({ state: 'waiting_input', state_text: 'Revisão pronta.', timed_out: false });
  });

  it('waits from waiting_background too, and returns on it only when asked (return_on_background)', async () => {
    const p = waitForState(ctx(baseTab({ state: 'waiting_background' })), { tab_id: 't1', timeout_seconds: 5 });
    await tick();
    publish(baseTab({ state: 'working' }));
    publish(baseTab({ state: 'idle' }));
    await expect(p).resolves.toMatchObject({ state: 'idle', timed_out: false });

    await expect(waitForState(ctx(baseTab({ state: 'waiting_background' })), { tab_id: 't1', return_on_background: true })).resolves.toMatchObject({ state: 'waiting_background', timed_out: false });
    const q = waitForState(ctx(), { tab_id: 't1', timeout_seconds: 5, return_on_background: true });
    await tick();
    publish(baseTab({ state: 'waiting_background' }));
    await expect(q).resolves.toMatchObject({ state: 'waiting_background', timed_out: false });
  });

  it('times out without error and clamps the timeout to 90 s', async () => {
    vi.useFakeTimers();
    const p = waitForState(ctx(), { tab_id: 't1', timeout_seconds: 500 });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(89_000);
    let done = false;
    void p.then(() => (done = true));
    await Promise.resolve();
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(p).resolves.toMatchObject({ state: 'working', timed_out: true });
  });

  it('stops listening when the caller aborts', async () => {
    const before = monitorBus.listenerCount();
    const ac = new AbortController();
    const p = waitForState(ctx(), { tab_id: 't1', timeout_seconds: 60 }, ac.signal);
    await tick();
    expect(monitorBus.listenerCount()).toBe(before + 1);
    ac.abort();
    await expect(p).resolves.toMatchObject({ timed_out: true });
    expect(monitorBus.listenerCount()).toBe(before);
  });
});
