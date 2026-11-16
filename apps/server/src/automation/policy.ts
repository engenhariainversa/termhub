import { AUTONOMY_LEVELS, sameRepo, type AutonomyLevel, type ProjectAutomation } from '../setup/schema.js';
import type { Repositories } from '../db/repositories/index.js';
import type { ProjectSetupData } from '../setup/schema.js';
import { activeEntries, isMultiRepo, loadRepoEntries, runEntry, type RepoEntry } from './repo-entry.js';

export { AUTONOMY_LEVELS, type AutonomyLevel };

/**
 * What a pull request needs to be merged by termhub alone. `store` (app store builds) and `other_base` (a
 * base that is neither the epic branch nor the project's base branch) are never allowed.
 */
export type NeededLevel = AutonomyLevel | 'store' | 'other_base';

/** Levels are cumulative: a project at `deploy` may also merge, and one at `merge` may also open PRs. */
export function allows(level: AutonomyLevel, needed: NeededLevel): boolean {
  if (needed === 'store' || needed === 'other_base') return false;
  return AUTONOMY_LEVELS.indexOf(level) >= AUTONOMY_LEVELS.indexOf(needed);
}

/** Small glob matcher for repo-relative paths: `**` crosses directories, `*` stays in one segment, the rest is literal. */
export function globMatches(pattern: string, path: string): boolean {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 2;
      } else {
        re += '.*';
        i += 1;
      }
    } else if (c === '*') re += '[^/]*';
    else re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`).test(path);
}

const matchesAny = (patterns: string[], files: string[]) => files.some((f) => patterns.some((p) => globMatches(p, f)));

/**
 * The lowest autonomy level at which a PR may be merged by termhub. A store path wins over everything;
 * a release path needs `release`; main with a deploy workflow needs `deploy`; the epic branch, or main with
 * nothing deploying, needs `merge`. Any other base is `other_base`: never merged by termhub, since what it
 * deploys is unknown.
 */
export function requiredLevel(i: {
  base: string;
  epicBranch: string | null;
  baseBranch: string;
  deployWorkflow: string | null;
  files: string[];
  releasePaths: string[];
  storePaths: string[];
}): NeededLevel {
  if (matchesAny(i.storePaths, i.files)) return 'store';
  const toEpic = i.epicBranch !== null && i.base === i.epicBranch;
  if (!toEpic && i.base !== i.baseBranch) return 'other_base';
  if (matchesAny(i.releasePaths, i.files)) return 'release';
  if (toEpic) return 'merge';
  if (i.deployWorkflow) return 'deploy';
  return 'merge';
}

const LEVEL_TEXT: Record<AutonomyLevel, string> = {
  pr: 'Você abre o PR e para: o termhub não mescla nada sozinho.',
  merge: 'O termhub mescla o PR quando o CI fica verde, mas só em branches que não publicam (por exemplo a branch do épico).',
  deploy: 'O termhub mescla o PR quando o CI fica verde, inclusive na branch principal, e isso dispara o deploy.',
  release: 'O termhub mescla o PR quando o CI fica verde, inclusive na branch principal, e também publica versões (release).',
};

/** What the policy text says of one repository of a project with several (multi-repo §9). */
export type PolicyRepo = Pick<RepoEntry, 'key' | 'full_name' | 'autonomy' | 'deploy_workflow' | 'release_paths' | 'store_paths'>;

/** One line per repository: key, owner/repo, its level, its deploy and its globs. */
function repoLine(r: PolicyRepo): string {
  const parts = [`${r.autonomy}`];
  if (r.deploy_workflow) parts.push(`deploy "${r.deploy_workflow}"`);
  if (r.release_paths.length > 0) parts.push(`release em ${r.release_paths.join(', ')}`);
  if (r.store_paths.length > 0) parts.push(`loja (nunca mesclado) em ${r.store_paths.join(', ')}`);
  return `- ${r.key ? `${r.key} (${r.full_name})` : r.full_name}: ${parts.join('; ')}`;
}

/**
 * pt-BR policy text for the tab's agent (`get_automation_policy`). `repos`, for a project with several
 * repositories (multi-repo §9): each one's level (never above the project's), deploy and globs, right after
 * the level line, in the order given (the run's first), so the prompt's clip keeps them. A single-repo
 * project leaves it out and reads the text as before.
 */
export function policyText(a: ProjectAutomation, deployWorkflow: string | null, repos?: PolicyRepo[]): string {
  const lines = [`Autonomia do projeto: ${a.autonomy}. ${LEVEL_TEXT[a.autonomy]}`];
  if (repos && repos.length > 0) {
    lines.push('Repositórios (o nível de cada um nunca passa o do projeto):', ...repos.map(repoLine));
    lines.push('Builds de loja nunca são mesclados pelo termhub, em nenhum nível.');
  } else {
    if (deployWorkflow) lines.push(`Um merge na branch principal dispara o workflow de deploy "${deployWorkflow}".`);
    if (a.release_paths.length > 0) lines.push(`Mudanças nestes caminhos pedem o nível release: ${a.release_paths.join(', ')}.`);
    if (a.store_paths.length > 0) lines.push(`Mudanças nestes caminhos nunca são mescladas pelo termhub (build de loja): ${a.store_paths.join(', ')}.`);
    else lines.push('Builds de loja nunca são mesclados pelo termhub, em nenhum nível.');
  }
  // TER-1188: what a PR with no CI gets
  if (a.autonomy !== 'pr') {
    lines.push(
      a.no_ci_merge === 'merge'
        ? 'PR sem CI: quando o repositório não roda nenhum workflow em pull_request, o head não tem nenhum check e a branch base não tem proteção nem ruleset exigindo checks ou revisão, o termhub mescla o PR 2 minutos depois do último push, como se o CI estivesse verde.'
        : 'PR sem CI: o termhub não mescla sozinho; quando a branch base não tem regra de proteção, um card no chat pede a confirmação da pessoa para mesclar.',
    );
  }
  lines.push('O merge é feito pelo termhub quando o CI fica verde e a política permite; abra o PR e avise com report_card.');
  return lines.join('\n');
}

/**
 * The repositories `policyText` lists for `get_automation_policy`: every active one, the run's (`first`)
 * first. Undefined for a single-repo project.
 */
export function policyRepos(entries: RepoEntry[], first: Array<string | null | undefined> = []): PolicyRepo[] | undefined {
  if (!isMultiRepo(entries)) return undefined;
  const active = activeEntries(entries);
  const lead = active.filter((e) => first.some((f) => sameRepo(f, e.full_name)));
  return [...lead, ...active.filter((e) => !lead.includes(e))];
}

/** What a run's prompt lists: the run's repositories only, so the 660-character clip never drops them (multi-repo §9). */
export function runPolicyRepos(entries: RepoEntry[], run: RepoEntry | null): PolicyRepo[] | undefined {
  return isMultiRepo(entries) && run ? [run] : undefined;
}

/** `runPolicyRepos` for the repository the project's runs work on (the implementer's prompt). */
export async function runPromptRepos(repos: Repositories, projectId: string, setup: ProjectSetupData): Promise<PolicyRepo[] | undefined> {
  const entries = await loadRepoEntries(repos, projectId, setup);
  return runPolicyRepos(entries, runEntry(entries, setup));
}
