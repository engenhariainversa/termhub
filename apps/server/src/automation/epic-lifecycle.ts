import type { Repositories } from '../db/repositories/index.js';
import type { Project, Task } from '../db/repositories/types.js';
import type { GithubWriteClient } from '../integrations/github-write.js';
import type { ProjectSetupData } from '../setup/schema.js';
import { epicBranchName } from './branches.js';
import { epicMayDie, epicPullsOf } from './epic-phase.js';
import { recordEvent } from './events.js';
import { endRunsOfMergedCard } from './follower.js';
import { githubAccess } from './merge.js';
import { runBranchOf } from './release.js';

/* TER-1150: what termhub does at an automatic epic's birth and death (where it is: `epic-phase.ts`), and the
 * card PRs a person merged on GitHub. */

type Log = { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };
const noopLog: Log = { info: () => {}, warn: () => {} };

export interface LifecycleDeps {
  repos: Repositories;
  gh: Pick<GithubWriteClient, 'deleteBranch'>;
  log?: Log;
}

/** The epic branch the setup's pattern gives, or null when it gives no valid name. */
function branchOf(setup: ProjectSetupData, epic: Task): string | null {
  try {
    return epicBranchName(setup.automation.epic_branch_pattern, epic);
  } catch {
    return null;
  }
}

/**
 * Birth (TER-1150): the first card of an automatic epic starts, its epic branch exists. The epic leaves the
 * backlog (or A fazer) for Fazendo and `epic_started` says when, on which branch and by which card. Once:
 * an epic already in Fazendo or Feito is left where it is. Never fails the card's start.
 */
export async function epicBorn(deps: Pick<LifecycleDeps, 'repos' | 'log'>, epic: Task, card: Task, branch: string): Promise<boolean> {
  const { repos } = deps;
  const log = deps.log ?? noopLog;
  if (epic.type !== 'epic' || !epic.auto || epic.status === 'doing' || epic.status === 'done') return false;
  try {
    const fresh = await repos.tasks.findById(epic.id);
    if (!fresh || fresh.status === 'doing' || fresh.status === 'done') return false;
    if (!(await repos.tasks.startWork(epic.id))) return false;
    await recordEvent(repos, { project_id: epic.project_id, task_id: epic.id, kind: 'epic_started', payload: { branch, by: card.ref, card_id: card.id } });
    log.info({ projectId: epic.project_id, taskId: epic.id, cardId: card.id }, 'automation: epic started');
    return true;
  } catch (e) {
    log.warn({ taskId: epic.id, code: (e as { code?: string }).code ?? 'INTERNAL' }, 'automation: epic not moved to doing');
    return false;
  }
}

/**
 * Death (TER-1150), looked at on every dispatcher pass: an automatic epic not yet in Feito whose PR is merged
 * and delivered (`epicMayDie`) goes to Feito, its branch is deleted on GitHub (a branch already gone is
 * fine), its cards' and its own runs are marked for cleanup (the dispatcher removes the worktrees and closes
 * the idle tabs) and `epic_done` is recorded. True when the epic died on this call.
 */
export async function settleEpic(deps: LifecycleDeps, project: Project, setup: ProjectSetupData, epic: Task, board: Task[]): Promise<boolean> {
  const { repos } = deps;
  const log = deps.log ?? noopLog;
  if (epic.type !== 'epic' || !epic.auto || epic.status === 'done') return false;
  const branch = branchOf(setup, epic);
  const cards = board.filter((t) => t.epic_id === epic.id && t.parent_id === null && t.type !== 'epic');
  const [cardPrs, ownPrs] = await Promise.all([repos.taskPullRequests.listByTasks(cards.map((c) => c.id)), repos.taskPullRequests.listByTasks([epic.id])]);
  const epicPrs = epicPullsOf(ownPrs, branch);
  if (!epicMayDie({ cards, cardPrs, epicPrs, setup })) return false;

  const fresh = await repos.tasks.findById(epic.id);
  if (!fresh || fresh.status === 'done') return false;
  if (!(await repos.tasks.move(epic.id, { status: 'done' }, 0))) return false;

  try {
    await repos.automationRuns.markCleanupDue([epic.id, ...cards.map((c) => c.id)]);
  } catch (e) {
    log.warn({ taskId: epic.id, code: (e as { code?: string }).code ?? 'INTERNAL' }, 'automation: epic cleanup not marked');
  }
  const pr = [...epicPrs].sort((a, b) => b.number - a.number)[0];
  await epicDied(deps, project, setup, epic, pr ?? null);
  return true;
}

/**
 * What follows an epic's move to Feito (TER-1150): its branch deleted on GitHub (a branch already gone is
 * fine; a failure is logged, never thrown) and `epic_done` recorded. The merge executor calls it when the
 * epic PR's merge has nothing to deliver; `settleEpic` once the delivery is through.
 */
export async function epicDied(deps: LifecycleDeps, project: Project, setup: ProjectSetupData, epic: Task, pr: { number: number; url: string } | null): Promise<void> {
  const { repos } = deps;
  const log = deps.log ?? noopLog;
  const branch = branchOf(setup, epic);
  let deleted = false;
  const base = setup.repo?.base_branch ?? 'main';
  if (branch && branch !== base) {
    try {
      const access = await githubAccess(repos, project, setup);
      if (access) {
        await deps.gh.deleteBranch(access.token, access.repo, branch);
        deleted = true;
      }
    } catch (e) {
      log.warn({ taskId: epic.id, code: (e as { kind?: string }).kind ?? 'INTERNAL' }, 'automation: epic branch not deleted');
    }
  }
  await recordEvent(repos, {
    project_id: project.id,
    task_id: epic.id,
    kind: 'epic_done',
    payload: { branch, branch_deleted: deleted, ...(pr ? { pr: pr.number, url: pr.url } : {}) },
  }).catch((e: unknown) => log.warn({ taskId: epic.id, code: (e as { code?: string }).code ?? 'INTERNAL' }, 'automation: epic_done not recorded'));
  log.info({ projectId: project.id, taskId: epic.id, branchDeleted: deleted }, 'automation: epic done');
}

/**
 * A PR merged outside the merge executor (TER-1150: a person merged it on GitHub): the automatic card whose
 * run worked on its head goes to Feito, its runs end and their cleanup is due, as the executor would have done.
 * Only a merge newer than the card's last change: a card a person moved back after its PR merged stays put.
 * Epics are left to `settleEpic` (their death waits for the delivery).
 */
export async function followExternalMerges(deps: Pick<LifecycleDeps, 'repos' | 'log'>, project: Project, setup: ProjectSetupData, board: Task[]): Promise<number> {
  const { repos } = deps;
  const log = deps.log ?? noopLog;
  const cards = board.filter((t) => t.auto && t.parent_id === null && t.type !== 'epic' && t.status !== 'done' && t.status !== 'backlog');
  if (cards.length === 0) return 0;
  const prs = await repos.taskPullRequests.listByTasks(cards.map((c) => c.id));
  let moved = 0;
  for (const card of cards) {
    const own = prs.filter((p) => p.task_id === card.id && !p.mention_only);
    if (own.some((p) => p.state === 'open')) continue;
    const merged = own.find((p) => p.state === 'merged' && p.merged_at && p.merged_at.getTime() > Date.parse(card.updated_at));
    if (!merged || !(await runBranchOf(repos, setup, card.id, merged))) continue;
    try {
      if (!(await repos.tasks.move(card.id, { status: 'done' }, 0))) continue;
    } catch (e) {
      log.warn({ taskId: card.id, code: (e as { code?: string }).code ?? 'INTERNAL' }, 'automation: externally merged card not moved');
      continue;
    }
    moved++;
    await endRunsOfMergedCard(repos, project.id, card.id, { url: merged.url, number: merged.number }, log);
    await repos.automationRuns.markCleanupDue([card.id]).catch(() => []);
    await recordEvent(repos, { project_id: project.id, task_id: card.id, kind: 'merged', payload: { pr: merged.number, url: merged.url, base: merged.base_ref, by: 'external', moved_to_done: true } }).catch(
      (e: unknown) => log.warn({ taskId: card.id, code: (e as { code?: string }).code ?? 'INTERNAL' }, 'automation: external merge not recorded'),
    );
    log.info({ projectId: project.id, taskId: card.id, pr: merged.number }, 'automation: externally merged card moved to done');
  }
  return moved;
}
