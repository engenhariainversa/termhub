import { describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import type { Task } from '../db/repositories/types.js';
import type { GithubWriteClient } from '../integrations/github-write.js';
import { existingWorkText, findExistingWork, names, workKeysOf } from './existing-work.js';

const jira = { provider: 'jira', key: 'APPS-337', provider_id: 'APPS-337', url: 'https://x.atlassian.net/browse/APPS-337' };
const card = (over: Partial<Task> = {}) => ({ id: 'c1', project_id: 'p1', ref: 'DRH-21', tab_id: null, external_ref: jira, ...over }) as Task;

function deps(o: { tabs?: Array<{ id: string; name: string; cwd?: string | null }>; runs?: Array<{ tab_id: string | null; branch: string | null }>; pulls?: Array<{ number: number; title: string; head_ref: string }>; branches?: string[]; ghError?: boolean } = {}) {
  const repos = {
    tabs: { listByProject: vi.fn(async () => (o.tabs ?? []).map((t) => ({ cwd: null, ...t }))) },
    automationRuns: { listByTask: vi.fn(async () => o.runs ?? []) },
  } as unknown as Repositories;
  const fail = async () => {
    throw Object.assign(new Error('x'), { kind: 'http' });
  };
  const gh = {
    openPulls: vi.fn(o.ghError ? fail : async () => (o.pulls ?? []).map((p) => ({ ...p, url: `https://github.com/a/b/pull/${p.number}` }))),
    branchNames: vi.fn(async () => o.branches ?? []),
  } as unknown as GithubWriteClient;
  const log = { warn: vi.fn() };
  return { repos, github: { gh, token: 't', repo: 'a/b' }, log };
}

describe('workKeysOf and names', () => {
  it('a card is known by its ref and its ticket key', () => {
    expect(workKeysOf(card())).toEqual(['drh-21', 'apps-337']);
    expect(workKeysOf(card({ external_ref: null }))).toEqual(['drh-21']);
  });
  it("a GitHub issue's bare number is not a key", () => {
    expect(workKeysOf(card({ external_ref: { provider: 'github', key: 'acme/app#12', provider_id: '12' } }))).toEqual(['drh-21', 'acme/app#12']);
  });
  it('matches whole words only, in any case', () => {
    expect(names('feature/APPS-337-more-tab-list', 'apps-337')).toBe(true);
    expect(names('feature/apps-3370-x', 'apps-337')).toBe(false);
    expect(names('xapps-337', 'apps-337')).toBe(false);
    expect(names(null, 'apps-337')).toBe(false);
  });
});

describe('findExistingWork (TER-1110)', () => {
  it('finds a tab whose name names the ticket', async () => {
    const d = deps({ tabs: [{ id: 't1', name: 'APPS-337 More tab' }] });
    expect(await findExistingWork(d, card(), 'feature/apps-337-x', 'main')).toEqual({ kind: 'tab', tab_id: 't1', name: 'APPS-337 More tab' });
  });
  it("finds a tab working in a folder named after the card's ref", async () => {
    const d = deps({ tabs: [{ id: 't1', name: 'claude', cwd: '/w/.claude/worktrees/DRH-21-x' }] });
    expect(await findExistingWork(d, card(), null, 'main')).toMatchObject({ kind: 'tab', tab_id: 't1' });
  });
  it("leaves out the card's own tab and its runs' tabs and branches", async () => {
    const d = deps({
      tabs: [{ id: 'own', name: 'DRH-21' }, { id: 'run', name: 'DRH-21 automático' }],
      runs: [{ tab_id: 'run', branch: 'feature/apps-337-old' }],
      pulls: [{ number: 5, title: 'APPS-337', head_ref: 'feature/apps-337-old' }],
      branches: ['main', 'feature/apps-337-new', 'feature/apps-337-old'],
    });
    expect(await findExistingWork(d, card({ tab_id: 'own' }), 'feature/apps-337-new', 'main')).toBeNull();
  });
  it('finds an open PR whose title or branch names the ticket', async () => {
    const d = deps({ pulls: [{ number: 9, title: 'Outra coisa', head_ref: 'x' }, { number: 1060, title: 'APPS-337: More tab list', head_ref: 'feature/more-tab' }] });
    expect(await findExistingWork(d, card(), 'feature/apps-337-more', 'main')).toEqual({ kind: 'pull', number: 1060, url: 'https://github.com/a/b/pull/1060', branch: 'feature/more-tab' });
  });
  it('finds a branch on GitHub that names the ticket', async () => {
    const d = deps({ branches: ['main', 'feature/apps-337-more-tab-list'] });
    expect(await findExistingWork(d, card(), 'feature/apps-337-more', 'main')).toEqual({ kind: 'branch', branch: 'feature/apps-337-more-tab-list' });
  });
  it('a GitHub error only skips the GitHub part', async () => {
    const d = deps({ ghError: true });
    expect(await findExistingWork(d, card(), null, 'main')).toBeNull();
    expect(d.log.warn).toHaveBeenCalledTimes(1);
  });
  it('without GitHub, only the tabs are looked at', async () => {
    const d = deps({ branches: ['feature/apps-337-x'] });
    expect(await findExistingWork({ ...d, github: null }, card(), null, 'main')).toBeNull();
  });
  it('says what it found in each language', () => {
    expect(existingWorkText('pt-BR', { kind: 'pull', number: 1060, url: 'u', branch: 'feature/x' })).toBe('Já há trabalho em andamento neste ticket: o PR #1060 (feature/x)');
    expect(existingWorkText('en', { kind: 'tab', tab_id: 't', name: 'APPS-337' })).toBe('This ticket already has work in progress: the tab APPS-337');
  });
});
