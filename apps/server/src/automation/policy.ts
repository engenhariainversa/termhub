import { AUTONOMY_LEVELS, type AutonomyLevel, type ProjectAutomation } from '../setup/schema.js';

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

/** pt-BR policy text for the tab's agent (`get_automation_policy`). */
export function policyText(a: ProjectAutomation, deployWorkflow: string | null): string {
  const lines = [`Autonomia do projeto: ${a.autonomy}. ${LEVEL_TEXT[a.autonomy]}`];
  if (deployWorkflow) lines.push(`Um merge na branch principal dispara o workflow de deploy "${deployWorkflow}".`);
  if (a.release_paths.length > 0) lines.push(`Mudanças nestes caminhos pedem o nível release: ${a.release_paths.join(', ')}.`);
  if (a.store_paths.length > 0) lines.push(`Mudanças nestes caminhos nunca são mescladas pelo termhub (build de loja): ${a.store_paths.join(', ')}.`);
  else lines.push('Builds de loja nunca são mesclados pelo termhub, em nenhum nível.');
  lines.push('O merge é feito pelo termhub quando o CI fica verde e a política permite; abra o PR e avise com report_card.');
  return lines.join('\n');
}
