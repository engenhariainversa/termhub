import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getAccountUsage, linkClaudeSession } = vi.hoisted(() => ({ getAccountUsage: vi.fn(), linkClaudeSession: vi.fn() }));
vi.mock('../ai/index.js', () => ({ getAccountUsage }));
vi.mock('../ai/claude-session.js', () => ({ linkClaudeSession }));

import type { AiAccountUsage } from '../ai/index.js';
import type { Repositories } from '../db/repositories/index.js';
import type { AiAccount, Machine } from '../db/repositories/types.js';
import { fallbackCandidates, linkChatSession, pickFallback } from './account-fallback.js';
import { normalizeSetup } from '../setup/schema.js';

const SID = '6d127d73-4bd0-42d6-b4a6-d96899507e62';
const DIR = '/home/u/.claude/projects/-srv';
const machine = { id: 'm1', name: 'jarvis', type: 'agent', owner_id: 'u1', capabilities: ['claude'] } as unknown as Machine;
const account = (over: Partial<AiAccount> & { id: string }): AiAccount => ({ provider: 'claude', label: over.id, machine_id: 'm1', config_dir: `~/.claude_${over.id}`, created_at: '', ...over });
const usage = (id: string, peak: number | null): AiAccountUsage => ({
  account_id: id, fetched_at: '', ok: peak !== null, plan: null, error: null, hint: null,
  windows: peak === null ? [] : [{ key: 'five_hour', label: '', utilization: peak, resets_at: null }],
});

let owned: AiAccount[];
let peaks: Record<string, number | null>;
const repos = { aiAccounts: { list: vi.fn(async (ownerId: string) => (ownerId === 'u1' ? owned : [])) } } as unknown as Repositories;

beforeEach(() => {
  vi.clearAllMocks();
  owned = [account({ id: 'a' }), account({ id: 'b' }), account({ id: 'c' }), account({ id: 'g', provider: 'chatgpt' }), account({ id: 'x', machine_id: 'm2' })];
  peaks = { a: 100, b: 40, c: 10 };
  getAccountUsage.mockImplementation(async (a: AiAccount) => usage(a.id, peaks[a.id] ?? null));
  linkClaudeSession.mockResolvedValue('linked');
});

describe('fallbackCandidates in a project chat (TER-589)', () => {
  const withProject = (ai: unknown, linked = true) =>
    ({ ...repos, projectSetup: { get: vi.fn(async () => ({ data: normalizeSetup({ ai }, 2) })) }, projectMachines: { find: vi.fn(async () => (linked ? { machine_id: 'm1' } : undefined)) } }) as unknown as Repositories;

  it("follows the project's order over room, and never leaves its list", async () => {
    // c has more room than b, but the project lists b first; the machine's other accounts are not the project's
    expect((await fallbackCandidates(withProject({ accounts: ['a', 'b', 'c', 'x', 'g'] }), machine, 'a', new Set(), 'p1')).map((a) => a.id)).toEqual(['b', 'c']);
    expect((await fallbackCandidates(withProject({ accounts: ['a', 'c'] }), machine, 'a', new Set(), 'p1')).map((a) => a.id)).toEqual(['c']);
  });

  it('still skips accounts already tried and those at their limit', async () => {
    peaks.b = 95;
    expect((await fallbackCandidates(withProject({ accounts: ['a', 'b', 'c'] }), machine, 'a', new Set(['c']), 'p1')).map((a) => a.id)).toEqual([]);
  });

  it('ranks by room as before when the machine is no longer linked to the project', async () => {
    expect((await fallbackCandidates(withProject({ accounts: ['a', 'b'] }, false), machine, 'a', new Set(), 'p1')).map((a) => a.id)).toEqual(['c', 'b']);
  });

  it('ranks by room as before for a project without Claude accounts on this machine', async () => {
    expect((await fallbackCandidates(withProject({ accounts: ['x', 'g'] }), machine, 'a', new Set(), 'p1')).map((a) => a.id)).toEqual(['c', 'b']);
  });
});

describe('fallbackCandidates', () => {
  it('ranks the other Claude accounts of the host machine by room left, owner-scoped', async () => {
    const got = await fallbackCandidates(repos, machine, 'a', new Set(), null);
    expect(got.map((a) => a.id)).toEqual(['c', 'b']);
    expect(repos.aiAccounts.list).toHaveBeenCalledWith('u1');
    // a fresh reading: the cached one may be from before the limit
    expect(getAccountUsage).toHaveBeenCalledWith(expect.objectContaining({ id: 'c' }), machine, true);
  });

  it('leaves out the accounts this run already tried and those at 90% or more', async () => {
    peaks.c = 95;
    expect((await fallbackCandidates(repos, machine, null, new Set(['b']), null)).map((a) => a.id)).toEqual([]);
    peaks.c = 10;
    // the default login (null) runs the chat: every account of the machine is a candidate
    expect((await fallbackCandidates(repos, machine, null, new Set(['b']), null)).map((a) => a.id)).toEqual(['c']);
  });
});

describe('fallbackCandidates and the run model (TER-837)', () => {
  beforeEach(() => {
    // b has room on the account, but its Fable allowance is used up
    getAccountUsage.mockImplementation(async (a: AiAccount) =>
      a.id === 'b'
        ? { ...usage('b', 69), windows: [{ key: 'seven_day', label: '', utilization: 69, resets_at: null }, { key: 'limit:weekly_scoped:Fable', label: '', utilization: 100, resets_at: null, model: 'fable' }] }
        : usage(a.id, 100),
    );
  });

  it('takes an account whose only full window caps another model', async () => {
    expect((await fallbackCandidates(repos, machine, 'a', new Set(), null, 'claude-opus-5-5')).map((a) => a.id)).toEqual(['b']);
    const pick = await pickFallback(repos, { machine, currentAccountId: 'a', tried: new Set(), projectId: null, sessionDir: DIR, sessionId: SID, model: 'opus' });
    expect(pick?.account.id).toBe('b');
  });

  it('does not take it for that model, or when the model is unknown', async () => {
    expect(await fallbackCandidates(repos, machine, 'a', new Set(), null, 'fable')).toEqual([]);
    expect(await fallbackCandidates(repos, machine, 'a', new Set(), null)).toEqual([]);
  });
});

describe('linkChatSession', () => {
  it('resumes a linked session, starts over on a missing or conflicting one, skips an unusable account', async () => {
    expect(await linkChatSession(machine, { sessionDir: DIR, sessionId: SID, toConfigDir: '~/.claude_b' })).toBe('resume');
    expect(linkClaudeSession).toHaveBeenCalledWith(machine, { transcriptPath: `${DIR}/${SID}.jsonl`, sessionId: SID, configDir: '~/.claude_b' });
    linkClaudeSession.mockResolvedValueOnce('no_transcript');
    expect(await linkChatSession(machine, { sessionDir: DIR, sessionId: SID, toConfigDir: '~/.claude_b' })).toBe('fresh');
    linkClaudeSession.mockResolvedValueOnce('conflict');
    expect(await linkChatSession(machine, { sessionDir: DIR, sessionId: SID, toConfigDir: '~/.claude_b' })).toBe('fresh');
    linkClaudeSession.mockResolvedValueOnce('same_account');
    expect(await linkChatSession(machine, { sessionDir: DIR, sessionId: SID, toConfigDir: '~/.claude_b' })).toBe('skip');
    linkClaudeSession.mockResolvedValueOnce('no_config_dir');
    expect(await linkChatSession(machine, { sessionDir: DIR, sessionId: SID, toConfigDir: '~/.claude_b' })).toBe('skip');
  });

  it('tries to resume when the link itself cannot run (an older agent): a missing session is retried fresh', async () => {
    linkClaudeSession.mockRejectedValueOnce(new Error('agent too old'));
    expect(await linkChatSession(machine, { sessionDir: DIR, sessionId: SID, toConfigDir: null })).toBe('resume');
  });
});

describe('pickFallback', () => {
  it('takes the first candidate the session can move to, marking every one it looked at as tried', async () => {
    linkClaudeSession.mockResolvedValueOnce('same_account');
    const tried = new Set<string>();
    const pick = await pickFallback(repos, { machine, currentAccountId: 'a', tried, projectId: null, sessionDir: DIR, sessionId: SID });
    expect(pick).toEqual({ account: expect.objectContaining({ id: 'b' }), resume: true });
    expect([...tried].sort()).toEqual(['b', 'c']);
  });

  it('starts a fresh session when there is no session to move, and says why nothing was picked', async () => {
    expect(await pickFallback(repos, { machine, currentAccountId: 'a', tried: new Set(), projectId: null, sessionDir: null, sessionId: null })).toEqual({ account: expect.objectContaining({ id: 'c' }), resume: false });
    expect(linkClaudeSession).not.toHaveBeenCalled();
    // a session with no known dir (a CLI that does not report it): resumed, and retried fresh if missing
    expect(await pickFallback(repos, { machine, currentAccountId: 'a', tried: new Set(), projectId: null, sessionDir: null, sessionId: SID })).toMatchObject({ resume: true });
    peaks = { a: 100, b: 99, c: 99 };
    expect(await pickFallback(repos, { machine, currentAccountId: 'a', tried: new Set(), projectId: null, sessionDir: DIR, sessionId: SID })).toBeNull();
  });
});
