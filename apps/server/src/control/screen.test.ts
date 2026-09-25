import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../agent/screen.js', () => ({ captureScreen: vi.fn(), captureStyledScreen: vi.fn() }));

import { captureScreen, captureStyledScreen } from '../agent/screen.js';
import { AgentOfflineError, agents } from '../agent/registry.js';
import { toHttpError } from '../agent/errors.js';
import { AgentTimeoutError } from '../agent/connection.js';
import type { Repositories } from '../db/repositories/index.js';
import type { Machine, Project, Tab } from '../db/repositories/types.js';
import { monitorBus } from '../monitor/bus.js';
import { Scoped } from '../auth/scope.js';
import type { ControlContext } from './context.js';
import { readScreen, waitForState } from './screen.js';

const m1 = { id: 'm1', owner_id: 'u1', type: 'agent' } as Machine;
const p1 = { id: 'p1', owner_id: 'u1' } as Project;
const baseTab = (over: Partial<Tab> = {}): Tab =>
  ({ id: 't1', project_id: 'p1', machine_id: 'm1', name: 't1', kind: 'terminal', tmux_session: 'th-t1', simulator_udid: null, position: 0, state: 'working', state_text: null, state_tool: 'claude', state_at: '2026-09-19T10:00:00.000Z', state_seen_at: null, created_at: '', ...over }) as Tab;

function ctx(tab: Tab | undefined = baseTab()): ControlContext {
  const repos = {
    tabs: { findById: vi.fn(async (id: string) => (tab && id === tab.id ? tab : undefined)) },
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
  vi.spyOn(agents, 'isOnline').mockReturnValue(true);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('readScreen', () => {
  it('captures the default 200 lines, styled, and clamps to 2000', async () => {
    vi.mocked(captureStyledScreen).mockResolvedValue({ text: '$ ls\nREADME.md\n', styled: true });
    const r = await readScreen(ctx(), { tab_id: 't1' });
    expect(r).toEqual({ tab_id: 't1', lines: 200, text: '$ ls\nREADME.md\n', styled: true });
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
    vi.mocked(agents.isOnline).mockReturnValue(false);
    await expect(readScreen(ctx(), { tab_id: 't1' })).rejects.toMatchObject({ code: 'MACHINE_OFFLINE', message: 'A máquina está offline: o termhub-agent dela não está conectado' });
    expect(captureStyledScreen).not.toHaveBeenCalled();
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
