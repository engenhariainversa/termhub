import { afterEach, describe, expect, it, vi } from 'vitest';
import { agents } from '../agent/registry.js';
import * as errors from '../agent/errors.js';
import type { Machine } from '../db/repositories/types.js';
import type { GithubWriteClient } from '../integrations/github-write.js';
import { normalizeSetup, SETUP_VERSION } from '../setup/schema.js';
import {
  cardBranchName,
  ensureEpicBranch,
  ensureWorkspace,
  epicBranchName,
  explicitBranchOf,
  hasTicketOrBranch,
  implementerBranchOf,
  isValidBranchName,
  namingRule,
  slugOf,
  targetOf,
  ticketBranchPart,
  ticketKeyOf,
} from './branches.js';

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

describe('branch name validation', () => {
  const card = (pattern: string, title = 'Corrigir login') => () => cardBranchName(pattern, { ref: 'TER-12', title });
  it('falls back to the bare ref when the slug is empty', () => {
    expect(card('{ticket}-{slug}', '!!! ???')()).toBe('TER-12');
    expect(card('{ticket}/{slug}', '')()).toBe('TER-12');
    expect(epicBranchName('epic/{ref}-{slug}', { ref: 'TER-1', title: '***' })).toBe('epic/TER-1');
  });
  it.each(['-{slug}', 'a..{slug}', '/{ticket}', '{ticket}.lock', 'x//{slug}', 'a@{{slug}', 'a b-{slug}', 'a~{slug}', 'a:{slug}', 'a\\{slug}', '.{slug}', 'x/.{slug}', '', '{slug}-'.padEnd(250, 'x')])('refuses pattern %j', (pattern) => {
    expect(card(pattern)).toThrow(expect.objectContaining({ code: 'INVALID_BRANCH_PATTERN' }));
  });
  it('refuses a pattern whose only content is {slug} when the slug is empty', () => {
    expect(card('{slug}', '???')).toThrow(expect.objectContaining({ code: 'INVALID_BRANCH_PATTERN' }));
  });
  it('isValidBranchName accepts plain names and slashes', () => {
    expect(isValidBranchName('epic/TER-1-x')).toBe(true);
    expect(isValidBranchName('a.lock/b')).toBe(false);
    expect(isValidBranchName('a.')).toBe(false);
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

describe('ticket keys and explicit branches (TER-1110)', () => {
  const jira = { provider: 'jira', key: 'APPS-337', provider_id: 'APPS-337' };
  const repo = (over: Record<string, unknown> = {}) => ({ branch_pattern: '{ticket}-{slug}', base_branch: 'main', require_ticket: false, ...over });
  const task = (over: Record<string, unknown> = {}) => ({ ref: 'DRH-21', title: 'More tab list', description: 'faça isto', external_ref: jira, ...over });

  it('{ticket} is the external ticket key, {ticket_lower} the same in lower case, {ref} always the card ref', () => {
    expect(cardBranchName('{ticket}-{slug}', { ref: 'DRH-21', title: 'More tab', ticket: 'APPS-337' })).toBe('APPS-337-more-tab');
    expect(cardBranchName('feature/{ticket_lower}-{slug}', { ref: 'DRH-21', title: 'More tab', ticket: 'APPS-337' })).toBe('feature/apps-337-more-tab');
    expect(cardBranchName('{ref}/{ticket}', { ref: 'DRH-21', title: 'x', ticket: 'APPS-337' })).toBe('DRH-21/APPS-337');
  });
  it('without a ticket, {ticket} falls back to the ref; a GitHub issue gives its number', () => {
    expect(cardBranchName('feature/{ticket_lower}-{slug}', { ref: 'TER-9', title: 'x', ticket: null })).toBe('feature/ter-9-x');
    expect(cardBranchName('{ticket}-{slug}', { ref: 'TER-9', title: 'x', ticket: 'acme/app#12' })).toBe('12-x');
  });
  it('a "branch:" line of the description wins over the pattern', () => {
    expect(explicitBranchOf('Contexto\n\n**Branch:** `feature/apps-337-more-tab-list`\n')).toBe('feature/apps-337-more-tab-list');
    expect(explicitBranchOf('- branch: feature/apps-337-x.')).toBe('feature/apps-337-x');
    expect(implementerBranchOf(task({ description: 'branch: feature/apps-337-more-tab-list' }), repo())).toBe('feature/apps-337-more-tab-list');
  });
  it('a sentence or a mention in the middle of a line is not an explicit branch, nor is the base branch', () => {
    expect(explicitBranchOf('Branch: o automático usa essa')).toBeNull();
    expect(explicitBranchOf('a descrição pedia ("branch: feature/apps-337-x")')).toBeNull();
    expect(explicitBranchOf(null)).toBeNull();
    expect(implementerBranchOf(task({ description: 'branch: release-1' }), repo({ base_branch: 'release-1' }))).toBe('APPS-337-more-tab-list');
  });
  it('a project that requires a ticket refuses a card without one, instead of using the termhub ref', () => {
    expect(() => implementerBranchOf(task({ external_ref: null }), repo({ require_ticket: true }))).toThrow(expect.objectContaining({ code: 'TICKET_REQUIRED' }));
    expect(implementerBranchOf(task(), repo({ require_ticket: true, branch_pattern: 'feature/{ticket_lower}-{slug}' }))).toBe('feature/apps-337-more-tab-list');
    expect(hasTicketOrBranch({ external_ref: null, description: 'branch: feature/apps-337-x' })).toBe(true);
    expect(hasTicketOrBranch({ external_ref: null, description: 'x' })).toBe(false);
  });
  it('namingRule cites the ticket and, when a ticket is required, forbids the termhub ref', () => {
    expect(namingRule({ ref: 'TER-9', external_ref: null }, repo())).toBeNull();
    expect(namingRule({ ref: 'DRH-21', external_ref: jira }, repo())).toBe('Este card vem do ticket APPS-337: cite APPS-337 nos commits e no título do PR.');
    expect(namingRule({ ref: 'DRH-21', external_ref: jira }, repo({ require_ticket: true }))).toContain('Nunca use a ref DRH-21 do termhub');
    expect(ticketKeyOf({ external_ref: jira })).toBe('APPS-337');
    expect(ticketBranchPart('acme/app#12')).toBe('12');
  });
});
