import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getAccountUsage, linkClaudeSession, sendKeyToSession, sendTextToSession, isOnline, applyState } = vi.hoisted(() => ({
  getAccountUsage: vi.fn(),
  linkClaudeSession: vi.fn(),
  sendKeyToSession: vi.fn(),
  sendTextToSession: vi.fn(),
  isOnline: vi.fn(() => true),
  applyState: vi.fn(),
}));
vi.mock('../ai/index.js', () => ({ getAccountUsage }));
vi.mock('../ai/claude-session.js', () => ({ linkClaudeSession }));
vi.mock('../terminal/session-ops.js', () => ({ sendKeyToSession, sendTextToSession }));
vi.mock('../agent/registry.js', () => ({ agents: { isOnline } }));
vi.mock('../monitor/ingest.js', () => ({ applyState }));

import type { FastifyBaseLogger } from 'fastify';
import type { AiAccountUsage } from '../ai/index.js';
import type { Repositories } from '../db/repositories/index.js';
import type { AiAccount, Machine, Tab } from '../db/repositories/types.js';
import { monitorBus } from '../monitor/bus.js';
import { RESUME_PROMPT, resumeLine } from './agents.js';
import {
  AUTO_SWAP_COOLDOWN_MS,
  AUTO_SWAP_DELAY_MS,
  ESCAPE_PAUSE_MS,
  EXIT_FORCE_WAIT_MS,
  EXIT_WAIT_MS,
  RESUME_SETTLE_MS,
  autoSwapOnLimit,
  rankCandidates,
  peakUtilization,
  swapAccount,
  SWAP_MAX_UTILIZATION,
} from './account-swap.js';

const SID = '6d127d73-4bd0-42d6-b4a6-d96899507e62';
const TRANSCRIPT = `/home/p/.claude_a/projects/-src-app/${SID}.jsonl`;

const machine = (over: Partial<Machine> = {}): Machine =>
  ({ id: 'm1', name: 'jarvis', type: 'agent', os: 'linux', capabilities: ['tmux', 'claude'], owner_id: 'u1', claude_auto_swap: false, ...over }) as Machine;
const account = (over: Partial<AiAccount> & { id: string; machine_id: string }): AiAccount => ({ provider: 'claude', label: over.id, config_dir: null, created_at: '', ...over });
const accounts = [
  account({ id: 'a1', machine_id: 'm1', config_dir: '~/.claude_a' }),
  account({ id: 'a2', machine_id: 'm1', config_dir: '~/.claude_b' }),
  account({ id: 'a3', machine_id: 'm1', config_dir: null }),
  account({ id: 'c1', machine_id: 'm1', provider: 'chatgpt' }),
  account({ id: 'x1', machine_id: 'm2' }),
];
const baseTab = (over: Partial<Tab> = {}): Tab =>
  ({
    id: 't1', project_id: 'p1', machine_id: 'm1', name: 'claude', kind: 'terminal', tmux_session: 'th-t1', state: 'waiting_input',
    agent_session_id: SID, agent_transcript_path: TRANSCRIPT, ai_account_id: 'a1', rate_limited_at: '2026-09-26T10:00:00.000Z', ...over,
  }) as Tab;

const usage = (id: string, windows: number[] | null): AiAccountUsage => ({
  account_id: id, fetched_at: '', ok: windows !== null, plan: null, error: null, hint: null,
  windows: (windows ?? []).map((w, i) => ({ key: `k${i}`, label: '', utilization: w, resets_at: null })),
});
const USAGE: Record<string, number[] | null> = { a1: [100, 50], a2: [10, 60], a3: [5, 20] };

const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } as unknown as FastifyBaseLogger;

/** The tab as the repository sees it (the swap re-reads it). */
let stored: Tab;
function makeRepos() {
  const repos = {
    tabs: {
      findById: vi.fn(async (id: string) => (id === stored.id ? stored : undefined)),
      setAgentFields: vi.fn(async (_id: string, patch: Partial<Tab>) => {
        stored = { ...stored, ...patch } as Tab;
        return stored;
      }),
    },
    aiAccounts: { list: vi.fn(async () => accounts) },
    machines: { findById: vi.fn(async () => machine()) },
  };
  return { repos, r: repos as unknown as Repositories };
}

/** Claude answers /exit with its SessionEnd hook a moment later: the tab goes idle on the bus. */
function exitGoesIdle() {
  sendTextToSession.mockImplementation(async (_m: Machine, _s: string, text: string) => {
    if (text === '/exit') {
      setTimeout(() => {
        stored = { ...stored, state: 'idle' } as Tab;
        monitorBus.publish({ tab: stored, project_id: 'p1', machine_id: 'm1', owner_id: 'u1' });
      }, 5);
    }
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  stored = baseTab();
  isOnline.mockReturnValue(true);
  getAccountUsage.mockImplementation(async (a: AiAccount) => usage(a.id, USAGE[a.id] ?? null));
  linkClaudeSession.mockResolvedValue('linked');
  sendKeyToSession.mockResolvedValue(undefined);
  exitGoesIdle();
  applyState.mockImplementation(async (_r, _l, tab: Tab) => tab);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('peakUtilization', () => {
  it('is the fullest window, null when unknown', () => {
    expect(peakUtilization(usage('a', [10, 60]))).toBe(60);
    expect(peakUtilization(usage('a', null))).toBeNull();
    expect(peakUtilization({ ...usage('a', []), ok: true })).toBeNull();
    expect(peakUtilization(undefined)).toBeNull();
  });
});

describe('rankCandidates', () => {
  it('ranks by peak utilization, drops ≥ 90 %, unknown last', () => {
    expect(SWAP_MAX_UTILIZATION).toBe(90);
    const u = (id: string, windows: number[] | null) => [id, usage(id, windows)] as const;
    const map = new Map([u('a2', [10, 60]), u('a3', [5, 20]), u('a4', [95, 1]), u('a5', null)]);
    const accs = ['a2', 'a3', 'a4', 'a5'].map((id) => account({ id, machine_id: 'm1' }));
    expect(rankCandidates(accs, map, { explicit: false }).map((a) => a.id)).toEqual(['a3', 'a2', 'a5']);
    expect(rankCandidates(accs, map, { explicit: true }).map((a) => a.id)).toEqual(['a3', 'a2', 'a4', 'a5']);
  });

  it('keeps list order on ties and drops exactly 90', () => {
    const map = new Map([['b', usage('b', [30])], ['a', usage('a', [30])], ['c', usage('c', [90])]]);
    const accs = ['b', 'a', 'c'].map((id) => account({ id, machine_id: 'm1' }));
    expect(rankCandidates(accs, map, { explicit: false }).map((a) => a.id)).toEqual(['b', 'a']);
  });
});

/** Runs every pending timer (the swap's pauses and waits) and then the swap's outcome. */
async function drive<T>(p: Promise<T>): Promise<T> {
  p.catch(() => undefined);
  await vi.runAllTimersAsync();
  return p;
}

describe('swapAccount', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('swaps to the best account: link, Escape, /exit, wait idle, record, waiting state, resume', async () => {
    const { repos, r } = makeRepos();
    const order: string[] = [];
    linkClaudeSession.mockImplementation(async (_m, input: { configDir: string | null }) => {
      order.push(`link:${input.configDir}`);
      return 'linked';
    });
    sendKeyToSession.mockImplementation(async (_m, _s, key: string) => void order.push(`key:${key}`));
    const typed = sendTextToSession.getMockImplementation()!;
    sendTextToSession.mockImplementation(async (m, s, text: string, enter: boolean) => {
      order.push(`text:${text}`);
      return typed(m, s, text, enter);
    });
    const record = repos.tabs.setAgentFields.getMockImplementation()!;
    repos.tabs.setAgentFields.mockImplementation(async (id: string, patch: Partial<Tab>) => {
      order.push('record');
      return record(id, patch);
    });
    applyState.mockImplementation(async (_r, _l, tab: Tab) => {
      order.push('state');
      return tab;
    });

    const m = machine();
    const result = await drive(swapAccount(r, log, baseTab(), m, { auto: false }));

    expect(result).toEqual({ from: { id: 'a1', label: 'a1' }, to: { id: 'a3', label: 'a3' } });
    // only the other Claude accounts of m1 were read, with a fresh reading
    expect(getAccountUsage.mock.calls.map((c) => [c[0].id, c[2]]).sort()).toEqual([['a2', true], ['a3', true]]);
    expect(linkClaudeSession).toHaveBeenCalledTimes(1);
    expect(linkClaudeSession).toHaveBeenCalledWith(m, { transcriptPath: TRANSCRIPT, sessionId: SID, configDir: null });
    const line = resumeLine(null, SID, RESUME_PROMPT);
    expect(order).toEqual(['link:null', 'key:Escape', 'text:/exit', 'record', 'state', `text:${line}`]);
    expect(sendKeyToSession).toHaveBeenCalledWith(m, 'th-t1', 'Escape');
    expect(sendTextToSession).toHaveBeenCalledWith(m, 'th-t1', '/exit', true);
    expect(sendTextToSession).toHaveBeenCalledWith(m, 'th-t1', line, true);
    expect(repos.tabs.setAgentFields).toHaveBeenCalledWith('t1', { ai_account_id: 'a3', rate_limited_at: null });
    expect(applyState).toHaveBeenCalledWith(r, log, expect.objectContaining({ id: 't1', ai_account_id: 'a3', rate_limited_at: null }), 'claude', {
      kind: 'waiting_input',
      text: 'Conta trocada: a1 → a3. Se o Claude pedir para confiar na pasta, confirme na aba.',
      meta: { event: 'AccountSwap', from: 'a1', to: 'a3', auto: false },
    });
    expect(monitorBus.listenerCount()).toBe(0);
  });

  it('pauses after Escape before /exit, and lets the shell settle after idle before the resume line', async () => {
    const { repos, r } = makeRepos();
    const line = resumeLine(null, SID, RESUME_PROMPT);
    const texts = () => sendTextToSession.mock.calls.map((c) => c[2]);
    const p = swapAccount(r, log, baseTab(), machine(), { auto: false });

    await vi.advanceTimersByTimeAsync(0);
    expect(sendKeyToSession).toHaveBeenCalledWith(expect.anything(), 'th-t1', 'Escape');
    expect(texts()).toEqual([]);
    await vi.advanceTimersByTimeAsync(ESCAPE_PAUSE_MS - 1);
    expect(texts()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(texts()).toEqual(['/exit']);

    // the SessionEnd lands 5 ms later: the tab is idle, but the line waits for RESUME_SETTLE_MS
    await vi.advanceTimersByTimeAsync(5);
    expect(stored.state).toBe('idle');
    await vi.advanceTimersByTimeAsync(RESUME_SETTLE_MS - 1);
    expect(texts()).toEqual(['/exit']);
    expect(repos.tabs.setAgentFields).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(p).resolves.toMatchObject({ to: { id: 'a3' } });
    expect(texts()).toEqual(['/exit', line]);
    expect(repos.tabs.setAgentFields.mock.invocationCallOrder[0]).toBeLessThan(applyState.mock.invocationCallOrder[0]);
    expect(applyState.mock.invocationCallOrder[0]).toBeLessThan(sendTextToSession.mock.invocationCallOrder[1]);
  });

  it('a failure typing the resume line is rethrown, with the tab already on the new account and the lock released', async () => {
    const { repos, r } = makeRepos();
    stored = baseTab({ state: 'idle' });
    sendTextToSession.mockRejectedValueOnce(new Error('tmux gone'));
    await expect(drive(swapAccount(r, log, baseTab(), machine(), { auto: false }))).rejects.toThrow('tmux gone');
    expect(repos.tabs.setAgentFields).toHaveBeenCalledWith('t1', { ai_account_id: 'a3', rate_limited_at: null });
    expect(applyState).toHaveBeenCalledWith(r, log, expect.anything(), 'claude', expect.objectContaining({ kind: 'waiting_input' }));
    stored = baseTab({ state: 'idle' });
    await expect(drive(swapAccount(r, log, baseTab(), machine(), { auto: false }))).resolves.toMatchObject({ to: { id: 'a3' } });
  });

  it('same_account or conflict moves on to the next candidate', async () => {
    const { r } = makeRepos();
    linkClaudeSession.mockImplementation(async (_m, input: { configDir: string | null }) => (input.configDir === null ? 'same_account' : 'linked'));
    const result = await drive(swapAccount(r, log, baseTab(), machine(), { auto: false }));
    expect(linkClaudeSession.mock.calls.map((c) => c[1].configDir)).toEqual([null, '~/.claude_b']);
    expect(result.to).toEqual({ id: 'a2', label: 'a2' });
    expect(sendTextToSession).toHaveBeenLastCalledWith(expect.anything(), 'th-t1', resumeLine('~/.claude_b', SID, RESUME_PROMPT), true);

    linkClaudeSession.mockReset();
    linkClaudeSession.mockImplementation(async (_m, input: { configDir: string | null }) => (input.configDir === null ? 'conflict' : 'linked'));
    stored = baseTab();
    await expect(drive(swapAccount(r, log, baseTab(), machine(), { auto: false }))).resolves.toMatchObject({ to: { id: 'a2' } });
  });

  it('NO_CANDIDATE when nothing links, and nothing was typed', async () => {
    const { repos, r } = makeRepos();
    linkClaudeSession.mockResolvedValue('same_account');
    await expect(swapAccount(r, log, baseTab(), machine(), { auto: false })).rejects.toMatchObject({
      code: 'NO_CANDIDATE',
      message: 'Nenhuma outra conta do Claude desta máquina pôde assumir a sessão (mesma conta, pasta ausente ou conflito)',
    });
    expect(linkClaudeSession).toHaveBeenCalledTimes(2);
    expect(sendKeyToSession).not.toHaveBeenCalled();
    expect(sendTextToSession).not.toHaveBeenCalled();
    expect(repos.tabs.setAgentFields).not.toHaveBeenCalled();
    expect(applyState).not.toHaveBeenCalled();
  });

  it('NO_CANDIDATE when every other account is at the limit', async () => {
    const { r } = makeRepos();
    getAccountUsage.mockImplementation(async (a: AiAccount) => usage(a.id, [95]));
    await expect(swapAccount(r, log, baseTab(), machine(), { auto: true })).rejects.toMatchObject({
      code: 'NO_CANDIDATE',
      message: 'Nenhuma outra conta do Claude desta máquina tem limite disponível',
    });
    expect(linkClaudeSession).not.toHaveBeenCalled();
  });

  it('NO_TRANSCRIPT stops at the first candidate, nothing typed', async () => {
    const { repos, r } = makeRepos();
    linkClaudeSession.mockResolvedValue('no_transcript');
    await expect(swapAccount(r, log, baseTab(), machine(), { auto: false })).rejects.toMatchObject({
      code: 'NO_TRANSCRIPT',
      message: 'O arquivo da sessão do Claude desta aba não foi encontrado na máquina',
    });
    expect(linkClaudeSession).toHaveBeenCalledTimes(1);
    expect(sendKeyToSession).not.toHaveBeenCalled();
    expect(sendTextToSession).not.toHaveBeenCalled();
    expect(repos.tabs.setAgentFields).not.toHaveBeenCalled();
  });

  it('no_config_dir moves on to the next candidate', async () => {
    const { r } = makeRepos();
    linkClaudeSession.mockImplementation(async (_m, input: { configDir: string | null }) => (input.configDir === null ? 'no_config_dir' : 'linked'));
    await expect(drive(swapAccount(r, log, baseTab(), machine(), { auto: false }))).resolves.toMatchObject({ to: { id: 'a2' } });
  });

  it('does not type into the shell when the Claude already exited (idle)', async () => {
    const { r } = makeRepos();
    stored = baseTab({ state: 'idle' });
    const p = swapAccount(r, log, baseTab(), machine(), { auto: false });
    // Claude had exited earlier: no settle pause, the line is typed right away
    await vi.advanceTimersByTimeAsync(0);
    await expect(p).resolves.toMatchObject({ to: { id: 'a3' } });
    expect(sendKeyToSession).not.toHaveBeenCalled();
    expect(sendTextToSession).toHaveBeenCalledTimes(1);
    expect(sendTextToSession).toHaveBeenCalledWith(expect.anything(), 'th-t1', resumeLine(null, SID, RESUME_PROMPT), true);
  });

  it('sees an idle that landed before it subscribed (re-reads the tab)', async () => {
    const { r } = makeRepos();
    sendTextToSession.mockImplementation(async (_m, _s, text: string) => {
      if (text === '/exit') stored = { ...stored, state: 'idle' } as Tab;
    });
    await expect(drive(swapAccount(r, log, baseTab(), machine(), { auto: false }))).resolves.toMatchObject({ to: { id: 'a3' } });
    expect(sendKeyToSession).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), 'C-c');
  });

  it('forces with C-c twice after EXIT_WAIT_MS, EXIT_TIMEOUT after EXIT_FORCE_WAIT_MS', async () => {
    const { repos, r } = makeRepos();
    sendTextToSession.mockResolvedValue(undefined); // Claude never exits
    const p = swapAccount(r, log, baseTab(), machine(), { auto: false });
    const settled = expect(p).rejects.toMatchObject({ code: 'EXIT_TIMEOUT' });

    await vi.advanceTimersByTimeAsync(ESCAPE_PAUSE_MS);
    await vi.advanceTimersByTimeAsync(EXIT_WAIT_MS - 1);
    expect(sendKeyToSession).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), 'C-c');
    await vi.advanceTimersByTimeAsync(1);
    expect(sendKeyToSession.mock.calls.filter((c) => c[2] === 'C-c')).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(EXIT_FORCE_WAIT_MS);
    await settled;

    expect(sendTextToSession).toHaveBeenCalledTimes(1); // only /exit, never the resume line
    expect(repos.tabs.setAgentFields).not.toHaveBeenCalled();
    expect(monitorBus.listenerCount()).toBe(0);
  });

  it('C-c that ends the Claude lets the swap go on, after the settle pause', async () => {
    const { r } = makeRepos();
    sendTextToSession.mockImplementation(async () => undefined);
    // the tab goes idle while the keys are sent, before the second wait subscribes: the re-read catches it
    sendKeyToSession.mockImplementation(async (_m, _s, key: string) => {
      if (key === 'C-c') stored = { ...stored, state: 'idle' } as Tab;
    });
    const p = swapAccount(r, log, baseTab(), machine(), { auto: false });
    await vi.advanceTimersByTimeAsync(ESCAPE_PAUSE_MS + EXIT_WAIT_MS);
    expect(sendTextToSession).toHaveBeenCalledTimes(1); // /exit only: the shell is still settling
    await vi.advanceTimersByTimeAsync(RESUME_SETTLE_MS);
    await expect(p).resolves.toMatchObject({ to: { id: 'a3' } });
    expect(sendTextToSession).toHaveBeenLastCalledWith(expect.anything(), 'th-t1', resumeLine(null, SID, RESUME_PROMPT), true);
  });

  it('an explicit account must be a Claude account of the tab machine', async () => {
    const { r } = makeRepos();
    await expect(swapAccount(r, log, baseTab(), machine(), { accountId: 'c1', auto: false })).rejects.toMatchObject({ code: 'PROVIDER_UNSUPPORTED' });
    await expect(swapAccount(r, log, baseTab(), machine(), { accountId: 'x1', auto: false })).rejects.toMatchObject({ code: 'ACCOUNT_OTHER_MACHINE' });
    await expect(swapAccount(r, log, baseTab(), machine(), { accountId: 'a1', auto: false })).rejects.toMatchObject({ code: 'SAME_ACCOUNT' });
    await expect(swapAccount(r, log, baseTab(), machine(), { accountId: 'nope', auto: false })).rejects.toMatchObject({ code: 'ACCOUNT_NOT_FOUND' });
    expect(linkClaudeSession).not.toHaveBeenCalled();
    expect(sendTextToSession).not.toHaveBeenCalled();
  });

  it('an explicit account is used even above the threshold', async () => {
    const { r } = makeRepos();
    getAccountUsage.mockImplementation(async (a: AiAccount) => usage(a.id, [99]));
    await expect(drive(swapAccount(r, log, baseTab(), machine(), { accountId: 'a2', auto: false }))).resolves.toEqual({ from: { id: 'a1', label: 'a1' }, to: { id: 'a2', label: 'a2' } });
    expect(linkClaudeSession).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ configDir: '~/.claude_b' }));
  });

  it('NO_SESSION without a known session; SWAP_IN_PROGRESS on a concurrent call; MACHINE_OFFLINE; TOOL_MISSING', async () => {
    const { r } = makeRepos();
    await expect(swapAccount(r, log, baseTab({ agent_session_id: null }), machine(), { auto: false })).rejects.toMatchObject({ code: 'NO_SESSION' });
    await expect(swapAccount(r, log, baseTab({ agent_transcript_path: null }), machine(), { auto: false })).rejects.toMatchObject({ code: 'NO_SESSION' });
    await expect(swapAccount(r, log, baseTab(), machine({ capabilities: ['tmux'] }), { auto: false })).rejects.toMatchObject({ code: 'TOOL_MISSING' });
    isOnline.mockReturnValue(false);
    await expect(swapAccount(r, log, baseTab(), machine(), { auto: false })).rejects.toMatchObject({ code: 'MACHINE_OFFLINE' });
    isOnline.mockReturnValue(true);
    expect(linkClaudeSession).not.toHaveBeenCalled();

    // the first swap waits for the Claude to exit; a second one on the same tab is refused meanwhile
    sendTextToSession.mockResolvedValue(undefined);
    const first = swapAccount(r, log, baseTab(), machine(), { auto: false });
    await expect(swapAccount(r, log, baseTab(), machine(), { auto: false })).rejects.toMatchObject({ code: 'SWAP_IN_PROGRESS' });
    await vi.advanceTimersByTimeAsync(ESCAPE_PAUSE_MS);
    expect(monitorBus.listenerCount()).toBe(1);
    monitorBus.publish({ tab: { ...stored, state: 'idle' }, project_id: 'p1', machine_id: 'm1', owner_id: 'u1' });
    await expect(drive(first)).resolves.toMatchObject({ to: { id: 'a3' } });
    // and the lock is released afterwards
    stored = baseTab({ state: 'idle' });
    await expect(drive(swapAccount(r, log, baseTab(), machine(), { auto: false }))).resolves.toMatchObject({ to: { id: 'a3' } });
  });

  it('auto text says so', async () => {
    const { r } = makeRepos();
    await drive(swapAccount(r, log, baseTab(), machine(), { auto: true }));
    expect(applyState).toHaveBeenCalledWith(r, log, expect.anything(), 'claude', {
      kind: 'waiting_input',
      text: 'Conta trocada automaticamente: a1 → a3. Se o Claude pedir para confiar na pasta, confirme na aba.',
      meta: { event: 'AccountSwap', from: 'a1', to: 'a3', auto: true },
    });
  });

  it('from is null when the tab account is unknown', async () => {
    const { r } = makeRepos();
    const result = await drive(swapAccount(r, log, baseTab({ ai_account_id: null }), machine(), { auto: false }));
    expect(result.from).toBeNull();
    expect(applyState).toHaveBeenCalledWith(r, log, expect.anything(), 'claude', expect.objectContaining({ meta: { event: 'AccountSwap', from: null, to: 'a3', auto: false } }));
  });
});

describe('autoSwapOnLimit', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('does nothing when the machine has not opted in', async () => {
    const { repos, r } = makeRepos();
    repos.machines.findById.mockResolvedValue(machine({ claude_auto_swap: false }));
    autoSwapOnLimit(r, log, baseTab({ id: 'auto1', state: 'idle' }));
    await vi.advanceTimersByTimeAsync(AUTO_SWAP_DELAY_MS);
    expect(repos.machines.findById).toHaveBeenCalledWith('m1');
    expect(linkClaudeSession).not.toHaveBeenCalled();
  });

  it('swaps with auto: true after AUTO_SWAP_DELAY_MS when the machine opted in', async () => {
    const { repos, r } = makeRepos();
    repos.machines.findById.mockResolvedValue(machine({ claude_auto_swap: true }));
    stored = baseTab({ id: 'auto2', state: 'idle' });
    autoSwapOnLimit(r, log, stored);

    await vi.advanceTimersByTimeAsync(AUTO_SWAP_DELAY_MS - 1);
    expect(linkClaudeSession).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(linkClaudeSession).toHaveBeenCalledTimes(1);
  });

  it('skips a second call for the same tab inside AUTO_SWAP_COOLDOWN_MS, then swaps again after it', async () => {
    const { repos, r } = makeRepos();
    repos.machines.findById.mockResolvedValue(machine({ claude_auto_swap: true }));
    const tab = baseTab({ id: 'auto3', state: 'idle' });
    stored = tab;

    autoSwapOnLimit(r, log, tab);
    await vi.advanceTimersByTimeAsync(AUTO_SWAP_DELAY_MS);
    expect(linkClaudeSession).toHaveBeenCalledTimes(1);

    // a second hit on the same tab, still well inside the cooldown: no new swap
    stored = baseTab({ id: 'auto3', state: 'idle' });
    autoSwapOnLimit(r, log, tab);
    await vi.advanceTimersByTimeAsync(AUTO_SWAP_DELAY_MS);
    expect(linkClaudeSession).toHaveBeenCalledTimes(1);

    // once the cooldown (counted from the first call) has passed, it swaps again
    await vi.advanceTimersByTimeAsync(AUTO_SWAP_COOLDOWN_MS);
    autoSwapOnLimit(r, log, tab);
    await vi.advanceTimersByTimeAsync(AUTO_SWAP_DELAY_MS);
    expect(linkClaudeSession).toHaveBeenCalledTimes(2);
  });

  it('records a failed automatic swap on the tab and never throws', async () => {
    const { repos, r } = makeRepos();
    repos.machines.findById.mockResolvedValue(machine({ claude_auto_swap: true }));
    stored = baseTab({ id: 'auto4', state: 'idle' });
    getAccountUsage.mockImplementation(async (a: AiAccount) => usage(a.id, [95]));

    autoSwapOnLimit(r, log, stored);
    await vi.advanceTimersByTimeAsync(AUTO_SWAP_DELAY_MS);

    expect(applyState).toHaveBeenCalledWith(r, log, expect.objectContaining({ id: 'auto4' }), 'claude', {
      kind: 'waiting_input',
      text: 'Troca automática falhou: Nenhuma outra conta do Claude desta máquina tem limite disponível',
      meta: { event: 'AccountSwapFailed', error: 'NO_CANDIDATE' },
    });
  });

  it('does not swap when a manual swap cleared the limit during the delay', async () => {
    const { repos, r } = makeRepos();
    repos.machines.findById.mockResolvedValue(machine({ claude_auto_swap: true }));
    stored = baseTab({ id: 'auto5', state: 'idle' });
    autoSwapOnLimit(r, log, stored);
    stored = { ...stored, ai_account_id: 'a3', rate_limited_at: null } as Tab;
    await vi.advanceTimersByTimeAsync(AUTO_SWAP_DELAY_MS);
    expect(linkClaudeSession).not.toHaveBeenCalled();
    expect(sendKeyToSession).not.toHaveBeenCalled();
    expect(sendTextToSession).not.toHaveBeenCalled();
    expect(applyState).not.toHaveBeenCalled();
  });

  it('does not swap when the tab hit a newer limit during the delay (its own call handles it)', async () => {
    const { repos, r } = makeRepos();
    repos.machines.findById.mockResolvedValue(machine({ claude_auto_swap: true }));
    stored = baseTab({ id: 'auto6', state: 'idle' });
    autoSwapOnLimit(r, log, stored);
    stored = { ...stored, rate_limited_at: '2026-09-26T10:00:02.000Z' } as Tab;
    await vi.advanceTimersByTimeAsync(AUTO_SWAP_DELAY_MS);
    expect(linkClaudeSession).not.toHaveBeenCalled();
    expect(applyState).not.toHaveBeenCalled();
  });

  it('a swap already running on the tab is a silent skip, not a recorded failure', async () => {
    const { repos, r } = makeRepos();
    repos.machines.findById.mockResolvedValue(machine({ claude_auto_swap: true }));
    stored = baseTab({ id: 'auto7' });
    sendTextToSession.mockResolvedValue(undefined); // the manual swap waits for a Claude that has not exited yet
    const manual = swapAccount(r, log, stored, machine(), { auto: false });
    manual.catch(() => undefined);
    autoSwapOnLimit(r, log, stored);
    await vi.advanceTimersByTimeAsync(AUTO_SWAP_DELAY_MS);
    expect(linkClaudeSession).toHaveBeenCalledTimes(1); // the manual swap only
    expect(applyState).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith({ tabId: 'auto7', machineId: 'm1' }, 'account swap: auto skipped (swap in progress)');
    // let the manual swap finish so its lock and subscription go away
    monitorBus.publish({ tab: { ...stored, state: 'idle' }, project_id: 'p1', machine_id: 'm1', owner_id: 'u1' });
    await expect(drive(manual)).resolves.toMatchObject({ to: { id: 'a3' } });
  });
});
