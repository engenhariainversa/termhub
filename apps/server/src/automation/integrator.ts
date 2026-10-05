import { cardUrl } from '../control/tasks.js';
import { ACTIVE_RUN_STATUSES } from '../db/repositories/automation-runs.js';
import type { PrState, TaskPullRequest } from '../db/repositories/task-pull-requests.js';
import type { Task, TaskStatus, TaskType } from '../db/repositories/types.js';
import type { PullInfo } from '../integrations/github-write.js';
import type { ProjectSetupData } from '../setup/schema.js';
import { epicBranchName } from './branches.js';
import type { DispatcherDeps, TriggeredRun, TriggeredStart } from './dispatcher.js';
import { recordEvent } from './events.js';
import { githubAccess } from './merge.js';
import { isPaused } from './pause.js';
import { policyText } from './policy.js';
import { integratorPrompt } from './prompts.js';

/** Spike R2: an epic gets at most this many integrator runs until a person acts. */
export const INTEGRATOR_CAP = 2;

type Log = { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };
const noopLog: Log = { info: () => {}, warn: () => {} };

/** What `integrateEpic` needs: the dispatcher's collaborators and its server-started run. */
export type IntegratorDeps = Pick<DispatcherDeps, 'repos' | 'gh' | 'lifecycle' | 'log'> & {
  startTriggered(i: TriggeredRun): Promise<TriggeredStart>;
};

/**
 * Whether an automatic epic is ready for integration (spec §10.2, D20): it has at least one non-epic
 * top-level card, every one of them is `done`, and every PR of those cards that was not closed unmerged is
 * merged into the epic branch (an open PR, or one merged elsewhere, keeps the epic waiting).
 */
export function epicReady(i: { cards: Array<{ type: TaskType; status: TaskStatus }>; prs: Array<{ task_id: string; state: PrState; base_ref: string | null }>; epicBranch: string }): boolean {
  const cards = i.cards.filter((c) => c.type !== 'epic');
  if (cards.length === 0 || cards.some((c) => c.status !== 'done')) return false;
  return i.prs.every((p) => p.state === 'closed' || (p.state === 'merged' && p.base_ref === i.epicBranch));
}

/** The epic PR's title (preflight F-14: git artifacts are in English). */
export const epicPullTitle = (epic: { ref: string }, epicBranch: string) => `${epic.ref}: integrate ${epicBranch}`;

/** The epic PR's body (F-14): English, "Part of" (never a closing keyword), the cards and their PRs, the impact line. */
export function epicPullBody(epic: { ref: string; title: string }, epicBranch: string, base: string, cards: Task[], prs: TaskPullRequest[]): string {
  const lines = cards.map((c) => {
    const numbers = prs.filter((p) => p.task_id === c.id && p.state === 'merged').map((p) => `#${p.number}`);
    return `- ${c.ref} ${c.title}${numbers.length > 0 ? ` (${numbers.join(', ')})` : ''}`;
  });
  return [
    `Part of ${epic.ref}: ${epic.title}`,
    `Integrates the epic branch \`${epicBranch}\` into \`${base}\`. Cards:`,
    lines.join('\n'),
    'Impact on other users: see each card PR.',
    'Opened by termhub (automatic).',
  ].join('\n\n');
}

const codeOf = (e: unknown): string => {
  const o = e as { code?: unknown; kind?: unknown };
  const code = typeof o?.code === 'string' ? o.code : typeof o?.kind === 'string' ? `GITHUB_${o.kind.toUpperCase()}` : 'INTERNAL';
  return code.slice(0, 64);
};

/**
 * Integration of an automatic epic (spec §10.2, D20). When the epic is ready (`epicReady`), opens the epic PR
 * (epic branch → base branch, not draft) or finds the one already open, records `pr_opened`, and starts an
 * `integrator` run on the epic in the epic worktree, keyed by the epic branch head (spike R2: never two
 * integrator runs for the same head, at most `INTEGRATOR_CAP` per epic, none after one finished `done` —
 * from then on the merge executor follows the PR). Nothing happens while draining, paused, or with
 * automation off. `board` is the project's cards when the caller already read them.
 */
export async function integrateEpic(deps: IntegratorDeps, epic: Task, setup: ProjectSetupData, board?: Task[]): Promise<void> {
  const { repos } = deps;
  const log = deps.log ?? noopLog;
  if (deps.lifecycle.draining || !setup.automation.enabled || epic.type !== 'epic' || !epic.auto || epic.status === 'done') return;
  const project = await repos.projects.findById(epic.project_id);
  if (!project?.owner_id || (await isPaused(repos, project.owner_id, project.id))) return;

  // a run cancelled by a pause or a sweep did no integration: it does not count against the cap
  const runs = (await repos.automationRuns.triggeredStatuses(epic.id, 'integrator')).filter((s) => s !== 'cancelled');
  if (runs.includes('done') || runs.length >= INTEGRATOR_CAP || runs.some((s) => (ACTIVE_RUN_STATUSES as readonly string[]).includes(s))) return;

  let epicBranch: string;
  try {
    epicBranch = epicBranchName(setup.automation.epic_branch_pattern, epic);
  } catch {
    return; // a pattern that gives no valid name: no card of this epic could have started either
  }
  const baseBranch = setup.repo?.base_branch ?? 'main';
  if (epicBranch === baseBranch) return;
  const cards = (board ?? (await repos.tasks.listByProject(project.id))).filter((t) => t.epic_id === epic.id && t.parent_id === null && t.type !== 'epic');
  const prs = await repos.taskPullRequests.listByTasks(cards.map((c) => c.id));
  if (!epicReady({ cards, prs, epicBranch })) return;
  // a person closed or merged the epic PR: that is their decision, and termhub does not open another
  const epicPrs = await repos.taskPullRequests.listByTasks([epic.id]);
  if (epicPrs.some((p) => p.head_ref === epicBranch && p.base_ref === baseBranch && p.state !== 'open')) return;

  const access = await githubAccess(repos, project, setup);
  if (!access) return;
  const { token, repo } = access;
  let pull: PullInfo | null = await deps.gh.findOpenPull(token, repo, epicBranch, baseBranch);
  let opened = false;
  if (!pull) {
    try {
      pull = await deps.gh.openPull(token, repo, { head: epicBranch, base: baseBranch, title: epicPullTitle(epic, epicBranch), body: epicPullBody(epic, epicBranch, baseBranch, cards, prs), draft: false });
      opened = true;
    } catch (e) {
      // the other colour may have opened it a moment ago (GitHub refuses a second PR for the same head)
      pull = await deps.gh.findOpenPull(token, repo, epicBranch, baseBranch);
      if (!pull) throw e;
    }
  }
  if (opened) {
    await recordEvent(repos, { project_id: project.id, task_id: epic.id, kind: 'pr_opened', payload: { pr_url: pull.url, number: pull.number, branch: epicBranch } }).catch((e: unknown) =>
      log.warn({ taskId: epic.id, code: codeOf(e) }, 'automation: pr_opened not recorded'),
    );
    log.info({ projectId: project.id, taskId: epic.id, pr: pull.number }, 'automation: epic PR opened');
  }

  const head = await deps.gh.branchSha(token, repo, epicBranch);
  if (!head) return;
  const prompt = integratorPrompt({
    epic: { ref: epic.ref, url: cardUrl(epic.ref), title: epic.title },
    branch: epicBranch,
    base: baseBranch,
    prUrl: pull.url,
    policy: policyText(setup.automation, setup.repo?.deploy_workflow ?? null),
    custom: setup.automation.prompts.integrator,
  });
  const started = await deps.startTriggered({ projectId: project.id, taskId: epic.id, role: 'integrator', triggerSha: head, branch: epicBranch, base: baseBranch, prompt });
  if (started === 'started') log.info({ projectId: project.id, taskId: epic.id, pr: pull.number }, 'automation: integrator started');
}
