import type { Repositories } from '../db/repositories/index.js';
import type { Task } from '../db/repositories/types.js';
import { t, type Locale } from '../i18n/index.js';
import type { GithubWriteClient } from '../integrations/github-write.js';
import { ticketBranchPart, ticketKeyOf } from './branches.js';

/**
 * Work on a card's ticket that termhub did not start for this card (TER-1110): a tab whose name or folder
 * names it, an open pull request whose branch or title names it, or a branch on GitHub that names it.
 */
export type ExistingWork = { kind: 'tab'; tab_id: string; name: string } | { kind: 'pull'; number: number; url: string; branch: string } | { kind: 'branch'; branch: string };

/**
 * The names a card's work goes by, lower case: its ref and, when it came from one, its ticket's key and that key
 * as a branch part. A GitHub issue's bare number is left out: it would match any branch with that number.
 */
export function workKeysOf(card: Pick<Task, 'ref' | 'external_ref'>): string[] {
  const keys = [card.ref];
  const ticket = ticketKeyOf(card);
  if (ticket) {
    keys.push(ticket);
    const part = ticketBranchPart(ticket);
    if (/[^0-9]/.test(part)) keys.push(part);
  }
  return [...new Set(keys.map((k) => k.toLowerCase()))];
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whether `text` names `key` as a whole word: `apps-337` is in `feature/apps-337-x`, not in `apps-3370`. */
export function names(text: string | null | undefined, key: string): boolean {
  return !!text && new RegExp(`(?<![a-z0-9])${escape(key)}(?![a-z0-9])`, 'i').test(text);
}

export interface ExistingWorkDeps {
  repos: Repositories;
  /** null: GitHub is not reachable for this project; only the tabs are looked at */
  github: { gh: GithubWriteClient; token: string; repo: string } | null;
  log?: { warn: (o: object, m: string) => void };
}

/**
 * The first work already going on for a card's ticket, or null (TER-1110). What the card's own runs did is not
 * "other" work: their tabs and branches, its linked tab and the branch it is about to use (`ownBranch`) are left
 * out. A GitHub error is logged and only skips the GitHub part: the tabs were already looked at.
 */
export async function findExistingWork(deps: ExistingWorkDeps, card: Task, ownBranch: string | null, baseBranch: string): Promise<ExistingWork | null> {
  const { repos } = deps;
  const keys = workKeysOf(card);
  const matches = (...texts: Array<string | null | undefined>) => keys.some((k) => texts.some((text) => names(text, k)));
  const runs = await repos.automationRuns.listByTask(card.id);
  const ownTabs = new Set([card.tab_id, ...runs.map((r) => r.tab_id)].filter((id): id is string => !!id));
  const ownBranches = new Set([ownBranch, baseBranch, ...runs.map((r) => r.branch)].filter((b): b is string => !!b));

  for (const tab of await repos.tabs.listByProject(card.project_id)) {
    if (!ownTabs.has(tab.id) && matches(tab.name, tab.cwd)) return { kind: 'tab', tab_id: tab.id, name: tab.name };
  }
  if (!deps.github) return null;
  const { gh, token, repo } = deps.github;
  try {
    for (const pull of await gh.openPulls(token, repo)) {
      if (!ownBranches.has(pull.head_ref) && matches(pull.head_ref, pull.title)) return { kind: 'pull', number: pull.number, url: pull.url, branch: pull.head_ref };
    }
    for (const branch of await gh.branchNames(token, repo)) {
      if (!ownBranches.has(branch) && matches(branch)) return { kind: 'branch', branch };
    }
  } catch (e) {
    deps.log?.warn({ taskId: card.id, code: (e as { kind?: string }).kind ?? 'INTERNAL' }, 'automation: existing work on GitHub not checked');
  }
  return null;
}

/** What the feed says about it, in `locale`. */
export function existingWorkText(locale: Locale, w: ExistingWork): string {
  const what =
    w.kind === 'tab'
      ? t(locale, 'a aba {{name}}', { name: w.name })
      : w.kind === 'pull'
        ? t(locale, 'o PR #{{number}} ({{branch}})', { number: w.number, branch: w.branch })
        : t(locale, 'a branch {{branch}} no GitHub', { branch: w.branch });
  return t(locale, 'Já há trabalho em andamento neste ticket: {{what}}', { what });
}
