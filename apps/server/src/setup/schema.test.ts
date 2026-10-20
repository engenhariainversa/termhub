import { describe, expect, it } from 'vitest';
import { automationInputSchema, DUPLICATE_REPO, INVALID_REPO_GLOB, normalizeSetup, REPO_AUTONOMY_ABOVE_PROJECT, setupInputSchema, UNSAFE_ALLOWED_TOOL, withLegacyMirror, SETUP_VERSION } from './schema.js';

const legacy = { provider: 'linear', integration_id: 'i1', scope: 'EI', filter: null, include_done: true, sync_minutes: 15 };

describe('setup ticket sources', () => {
  it('rebuilds sources when only tickets is present (saved by the previous release)', () => {
    const d = normalizeSetup({ tickets: legacy }, 1);
    expect(d.ticket_sources).toEqual([{ provider: 'linear', integration_id: 'i1', scope: 'EI', filter: null, sync_minutes: 15 }]);
    expect(d.tickets).toEqual({ provider: 'linear', integration_id: 'i1', scope: 'EI', filter: null, include_done: false, sync_minutes: 15 });
  });

  it('keeps explicit sources and mirrors the first into tickets', () => {
    const d = normalizeSetup({ tickets: null, ticket_sources: [
      { provider: 'github', integration_id: 'g', scope: 'acme/api', filter: null, sync_minutes: 0 },
      { provider: 'github', integration_id: 'g', scope: 'acme/web', filter: null, sync_minutes: 0 },
    ] }, 2);
    expect(d.ticket_sources).toHaveLength(2);
    expect(d.tickets?.scope).toBe('acme/api');
  });

  it('an explicit empty list stays empty even with a stale tickets', () => {
    expect(normalizeSetup({ tickets: legacy, ticket_sources: [] }, 2).ticket_sources).toEqual([]);
  });

  it('withLegacyMirror writes null when there is no source', () => {
    expect(withLegacyMirror(normalizeSetup({}, 2)).tickets).toBeNull();
  });

  it('refuses the same integration and scope twice', () => {
    const src = { provider: 'github', integration_id: 'g', scope: 'acme/api' };
    const r = setupInputSchema.safeParse({ ticket_sources: [src, { ...src, scope: ' acme/api ' }] });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0].message).toBe('Fonte de tickets repetida');
  });
});

describe('setup repo.deploy_workflow', () => {
  it('defaults to null for a setup saved before the field existed', () => {
    const data = normalizeSetup({ repo: { integration_id: 'i1', full_name: 'acme/app' } }, SETUP_VERSION);
    expect(data.repo?.deploy_workflow).toBeNull();
  });
  it('keeps a trimmed workflow name', () => {
    const data = normalizeSetup({ repo: { integration_id: 'i1', full_name: 'acme/app', deploy_workflow: '  deploy.yml ' } }, SETUP_VERSION);
    expect(data.repo?.deploy_workflow).toBe('deploy.yml');
  });
});

describe('setup repositories (TER-1076)', () => {
  const legacyRepo = { integration_id: 'i1', full_name: 'acme/app', base_branch: 'develop', branch_pattern: '{ticket}', draft_pr: false, deploy_workflow: 'deploy.yml' };

  it('a v2 setup with only repo gets the defaults and keeps repo as it was', () => {
    const d = normalizeSetup({ repo: legacyRepo }, 2);
    expect(d.repo).toEqual(legacyRepo);
    expect(d.repo_defaults).toEqual({ integration_id: null, scan_depth: 1 });
    expect(d.repos).toEqual([]);
  });

  it('an override with only the name gets every default', () => {
    expect(setupInputSchema.parse({ repos: [{ full_name: ' acme/bff ' }] }).repos).toEqual([{
      full_name: 'acme/bff', enabled: true, integration_id: null, description: null, base_branch: null, branch_pattern: null,
      deploy_workflow: null, autonomy: 'pr', required_checks: [], release_workflows: [], release_paths: [], store_paths: [], merge_order: 0,
    }]);
  });

  it('refuses the same repository twice, whatever the case', () => {
    const r = setupInputSchema.safeParse({ repos: [{ full_name: 'acme/api' }, { full_name: 'Acme/API' }] });
    expect(r.error?.issues).toEqual([expect.objectContaining({ path: ['repos', 1, 'full_name'], message: DUPLICATE_REPO })]);
  });

  it('the project autonomy is the ceiling of a repository', () => {
    const above = setupInputSchema.safeParse({ repos: [{ full_name: 'acme/api', autonomy: 'merge' }] });
    expect(above.error?.issues).toEqual([expect.objectContaining({ path: ['repos', 0, 'autonomy'], message: REPO_AUTONOMY_ABOVE_PROJECT })]);
    expect(setupInputSchema.safeParse({ automation: { autonomy: 'deploy' }, repos: [{ full_name: 'acme/api', autonomy: 'merge' }] }).success).toBe(true);
    expect(setupInputSchema.safeParse({ automation: { autonomy: 'merge' }, repos: [{ full_name: 'acme/api', autonomy: 'merge' }] }).success).toBe(true);
  });

  it('refuses globs that leave the repository', () => {
    for (const bad of ['/abs', '../x', 'a/../b', 'a\\b']) {
      const r = setupInputSchema.safeParse({ repos: [{ full_name: 'acme/api', store_paths: ['ok/**', bad] }] });
      expect(r.error?.issues, bad).toEqual([expect.objectContaining({ path: ['repos', 0, 'store_paths', 1], message: INVALID_REPO_GLOB })]);
    }
    expect(setupInputSchema.safeParse({ repos: [{ full_name: 'acme/api', release_paths: ['apps/**/package.json', '..hidden'] }] }).success).toBe(true);
  });

  it('refuses a name that is not owner/repo, more than 50 overrides and a scan depth outside 1..3', () => {
    expect(setupInputSchema.safeParse({ repos: [{ full_name: 'api' }] }).success).toBe(false);
    expect(setupInputSchema.safeParse({ repos: Array.from({ length: 51 }, (_, i) => ({ full_name: `acme/r${i}` })) }).success).toBe(false);
    expect(setupInputSchema.safeParse({ repos: Array.from({ length: 50 }, (_, i) => ({ full_name: `acme/r${i}` })) }).success).toBe(true);
    for (const depth of [0, 4, 1.5]) expect(setupInputSchema.safeParse({ repo_defaults: { scan_depth: depth } }).success, String(depth)).toBe(false);
    expect(setupInputSchema.parse({ repo_defaults: { scan_depth: 3, integration_id: 'g' } }).repo_defaults).toEqual({ integration_id: 'g', scan_depth: 3 });
  });

  it('a stored override above the project level is read as stored, never reset', () => {
    const d = normalizeSetup({ automation: { autonomy: 'pr' }, repos: [{ full_name: 'acme/api', autonomy: 'release' }] }, SETUP_VERSION);
    expect(d.repos[0].autonomy).toBe('release');
  });

  it('a corrupt repos value falls back to none without losing the other blocks', () => {
    const d = normalizeSetup({ repos: [{ full_name: 'nope' }], repo: legacyRepo, runner: { worktree: false } }, SETUP_VERSION);
    expect(d.repos).toEqual([]);
    expect(d.repo).toEqual(legacyRepo);
    expect(d.runner.worktree).toBe(false);
  });
});

describe('setup ai block (TER-589)', () => {
  it('defaults to no accounts and no models, also for a setup saved before the block existed', () => {
    expect(normalizeSetup({}, 2).ai).toEqual({ accounts: [], models: { claude: null, chatgpt: null } });
    expect(normalizeSetup({ agent: { command: 'claude' } }, 2).ai.accounts).toEqual([]);
  });

  it('keeps the account order and the models as typed', () => {
    const d = setupInputSchema.parse({ ai: { accounts: ['b', 'a'], models: { claude: 'sonnet[1m]', chatgpt: 'gpt-5-codex' } } });
    expect(d.ai).toEqual({ accounts: ['b', 'a'], models: { claude: 'sonnet[1m]', chatgpt: 'gpt-5-codex' } });
    expect(setupInputSchema.parse({ ai: { accounts: [], models: { claude: 'claude-opus-5-5' } } }).ai.models).toEqual({ claude: 'claude-opus-5-5', chatgpt: null });
  });

  it('refuses the same account twice and more than 20 accounts', () => {
    expect(setupInputSchema.safeParse({ ai: { accounts: ['a', 'a'] } }).success).toBe(false);
    expect(setupInputSchema.safeParse({ ai: { accounts: Array.from({ length: 21 }, (_, i) => `a${i}`) } }).success).toBe(false);
  });

  it('refuses a model with anything the shell could read', () => {
    for (const bad of ['opus; rm -rf ~', 'opus $(id)', "o'pus", 'a b', '', '-p']) {
      expect(setupInputSchema.safeParse({ ai: { models: { claude: bad } } }).success, bad).toBe(false);
    }
  });

  it('a corrupt ai block falls back to the default without losing the other blocks', () => {
    const d = normalizeSetup({ ai: { accounts: 'x' }, runner: { worktree: false } }, 2);
    expect(d.ai.accounts).toEqual([]);
    expect(d.runner.worktree).toBe(false);
  });
});

describe('setup automation block (TER-879)', () => {
  it('a setup saved before the block reads automation as off with the spec defaults', () => {
    const s = normalizeSetup({ repo: null }, 2);
    expect(s.automation).toEqual({
      enabled: false, types: ['story', 'task', 'bug'], autonomy: 'pr', release_paths: [], store_paths: [],
      release_workflows: [], required_checks: [], epic_branch_pattern: 'epic/{ref}-{slug}', worktrees_dir: '~/.termhub/worktrees',
      allowed_tools: null, max_parallel: null, resume_max: 3, stop_on_decisions: false, fix_attempts: 3, deploy_retries: 3, github_retries: 3, daily_budget_usd: null, card_budget_usd: null,
      summary_hour: null, prompts: { implementer: null, integrator: null, fixer: null },
    });
  });

  it('refuses an epic branch pattern without {ref}', () => {
    expect(setupInputSchema.safeParse({ automation: { epic_branch_pattern: 'epic/{slug}' } }).success).toBe(false);
    expect(setupInputSchema.safeParse({ automation: { epic_branch_pattern: 'e/{ref}' } }).success).toBe(true);
  });

  it('refuses epic and subtask in types', () => {
    expect(setupInputSchema.safeParse({ automation: { types: ['epic'] } }).success).toBe(false);
    expect(setupInputSchema.safeParse({ automation: { types: ['subtask'] } }).success).toBe(false);
    expect(setupInputSchema.safeParse({ automation: { types: ['spike', 'bug'] } }).success).toBe(true);
    expect(setupInputSchema.safeParse({ automation: { types: [] } }).success).toBe(false);
  });

  it('caps custom prompts at 1200 characters', () => {
    expect(setupInputSchema.safeParse({ automation: { prompts: { fixer: 'x'.repeat(1200) } } }).success).toBe(true);
    expect(setupInputSchema.safeParse({ automation: { prompts: { fixer: 'x'.repeat(1201) } } }).success).toBe(false);
  });

  it('keeps the other blocks when automation is invalid', () => {
    const d = normalizeSetup({ automation: { enabled: 'yes' }, runner: { worktree: false } }, 2);
    expect(d.automation.enabled).toBe(false);
    expect(d.runner.worktree).toBe(false);
  });
});

describe('automation allow rules too broad for an automatic tab (TER-968)', () => {
  it('saving refuses them on the field, with the reason', () => {
    const r = automationInputSchema.safeParse({ allowed_tools: ['Bash(npm test:*)', 'Bash(git:*)'] });
    expect(r.success).toBe(false);
    expect(r.error!.issues).toEqual([expect.objectContaining({ path: ['allowed_tools', 1], message: UNSAFE_ALLOWED_TOOL })]);
    const s = setupInputSchema.safeParse({ automation: { allowed_tools: ['Bash'] } });
    expect(s.success).toBe(false);
    expect(s.error!.issues[0]).toMatchObject({ path: ['automation', 'allowed_tools', 0], message: UNSAFE_ALLOWED_TOOL });
  });

  it('specific rules and the default (null) save', () => {
    expect(automationInputSchema.safeParse({ allowed_tools: ['Bash(npm test:*)', 'WebFetch'] }).success).toBe(true);
    expect(automationInputSchema.safeParse({}).success).toBe(true);
  });

  it('a stored setup holding one is still read as is (filtered at launch), never reset to the defaults', () => {
    const data = normalizeSetup({ automation: { enabled: true, allowed_tools: ['Bash'] } }, SETUP_VERSION);
    expect(data.automation.enabled).toBe(true);
    expect(data.automation.allowed_tools).toEqual(['Bash']);
  });
});

describe('setup ai_memory (TER-1019)', () => {
  it('defaults publish_rules to false for a setup saved before the block existed', () => {
    expect(normalizeSetup({ automation: { enabled: true } }, 2).ai_memory).toEqual({ publish_rules: false, use_in_runs: false });
    expect(normalizeSetup(undefined, 2).ai_memory).toEqual({ publish_rules: false, use_in_runs: false });
  });
  it('keeps a saved publish_rules, and a broken block alone falls back without losing the rest', () => {
    expect(normalizeSetup({ ai_memory: { publish_rules: true } }, 2).ai_memory.publish_rules).toBe(true);
    expect(normalizeSetup({ ai_memory: { publish_rules: false, use_in_runs: true } }, 2).ai_memory.use_in_runs).toBe(true);
    const broken = normalizeSetup({ ai_memory: { publish_rules: 'yes' }, automation: { enabled: true } }, 2);
    expect(broken.ai_memory.publish_rules).toBe(false);
    expect(broken.automation.enabled).toBe(true);
  });
});
