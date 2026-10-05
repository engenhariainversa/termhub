import { afterEach, describe, expect, it, vi } from 'vitest';
import { agents } from '../agent/registry.js';
import * as errors from '../agent/errors.js';
import type { Machine } from '../db/repositories/types.js';
import type { GithubWriteClient } from '../integrations/github-write.js';
import { normalizeSetup, SETUP_VERSION } from '../setup/schema.js';
import { cardBranchName, ensureEpicBranch, ensureWorkspace, epicBranchName, slugOf, targetOf } from './branches.js';

afterEach(() => vi.restoreAllMocks());

const TITLE = 'termhub agêntico: trabalho automático!';
const setup = normalizeSetup({ repo: { base_branch: 'develop' } }, SETUP_VERSION);

describe('names', () => {
  it('slugOf is ascii, lower, dashed', () => {
    expect(slugOf(TITLE)).toBe('termhub-agentico-trabalho-automatico');
  });
  it('slugOf stops at 40 characters without a trailing dash', () => {
    const s = slugOf('a'.repeat(39) + ' bbbbbb');
    expect(s.length).toBeLessThanOrEqual(40);
    expect(s.endsWith('-')).toBe(false);
  });
  it('epicBranchName fills {ref} and {slug}', () => {
    expect(epicBranchName('epic/{ref}-{slug}', { ref: 'TER-852', title: TITLE })).toBe('epic/TER-852-termhub-agentico-trabalho-automatico');
  });
  it('cardBranchName uses {ticket} as the ref', () => {
    expect(cardBranchName('{ticket}-{slug}', { ref: 'TER-9', title: 'Corrigir login' })).toBe('TER-9-corrigir-login');
  });
});

describe('targetOf', () => {
  it('a card in a non-automatic epic, or none, targets the base branch', () => {
    expect(targetOf({ epic: { auto: false, ref: 'TER-1', title: 'x' } }, setup)).toEqual({ base: 'develop', epicBranch: null });
    expect(targetOf({ epic: null }, setup)).toEqual({ base: 'develop', epicBranch: null });
  });
  it('a card in an automatic epic targets the epic branch', () => {
    expect(targetOf({ epic: { auto: true, ref: 'TER-1', title: 'Painel' } }, setup)).toEqual({ base: 'epic/TER-1-painel', epicBranch: 'epic/TER-1-painel' });
  });
});

describe('ensureEpicBranch', () => {
  const gh = (create: 'created' | 'exists', sha: string | null = 'abc') =>
    ({ branchSha: vi.fn(async () => sha), createBranch: vi.fn(async () => create) }) as unknown as GithubWriteClient;
  it('creates the branch from the base head', async () => {
    const g = gh('created');
    await ensureEpicBranch({ gh: g, token: 't', repo: 'a/b' }, 'main', 'epic/x');
    expect(g.createBranch).toHaveBeenCalledWith('t', 'a/b', 'epic/x', 'abc');
  });
  it('treats an existing branch as success', async () => {
    await expect(ensureEpicBranch({ gh: gh('exists'), token: 't', repo: 'a/b' }, 'main', 'epic/x')).resolves.toBeUndefined();
  });
  it('fails when the base branch is missing', async () => {
    await expect(ensureEpicBranch({ gh: gh('created', null), token: 't', repo: 'a/b' }, 'main', 'epic/x')).rejects.toMatchObject({ code: 'BASE_BRANCH_MISSING' });
  });
});

describe('ensureWorkspace', () => {
  const machine = { id: 'm1', type: 'agent' } as Machine;
  const input = { repoDir: '/r', root: '/w', projectId: 'p1', ref: 'TER-9', branch: 'TER-9-x', base: 'main' };
  it('refuses an agent without the worktree capability', async () => {
    vi.spyOn(agents, 'capabilities').mockReturnValue(['sim']);
    vi.spyOn(agents, 'isOnline').mockReturnValue(true);
    await expect(ensureWorkspace(machine, input)).rejects.toMatchObject({ code: 'AGENT_OUTDATED' });
  });
  it('asks the agent for <root>/<projectId>/<ref>', async () => {
    vi.spyOn(agents, 'capabilities').mockReturnValue(['worktree']);
    const rpc = vi.spyOn(errors, 'agentRpc').mockResolvedValue({ path: '/w/p1/TER-9', head: 'a'.repeat(40), created: true });
    expect(await ensureWorkspace(machine, input)).toEqual({ path: '/w/p1/TER-9', created: true });
    expect(rpc).toHaveBeenCalledWith(machine, 'git.worktree.ensure', { repo_dir: '/r', root: '/w', path: '/w/p1/TER-9', branch: 'TER-9-x', base: 'main' });
  });
});
