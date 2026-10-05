import { z } from 'zod';
import { chatBus } from '../chat/bus.js';
import { askForAutomation } from '../chat/gate-runtime.js';
import { FAILED, latestPerWorkflow, matchesWorkflow, type WorkflowRun } from '../ci/rules.js';
import { setCiError } from '../ci/status.js';
import type { Repositories } from '../db/repositories/index.js';
import { ACTIVE_RUN_STATUSES } from '../db/repositories/automation-runs.js';
import type { ChatAction } from '../db/repositories/chat-actions.js';
import type { TaskPullRequest } from '../db/repositories/task-pull-requests.js';
import type { Project, Task } from '../db/repositories/types.js';
import { localeOf, t } from '../i18n/index.js';
import { GithubCiError, type GithubCiClient } from '../integrations/github-ci.js';
import type { GithubWriteClient } from '../integrations/github-write.js';
import type { ProjectSetupData } from '../setup/schema.js';
import { epicBranchName, targetOf } from './branches.js';
import type { TriggeredRun, TriggeredStart } from './dispatcher.js';
import { REASON_TEXT } from './eligibility.js';
import { CONFLICT_CAP } from './escalation-text.js';
import { recordEvent } from './events.js';
import { escalateRun } from './follower.js';
import { clearMergeWait, noteMergeWait, type MergeWait } from './merge-wait.js';
import { isPaused } from './pause.js';
import { allows, requiredLevel, type NeededLevel } from './policy.js';
import { fixerPrompt } from './prompts.js';

/** The chat card's tool: a merge above the project's level waits for the person (spec D7). */
export const MERGE_TOOL = 'automation_merge';

type Log = { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };
const noopLog: Log = { info: () => {}, warn: () => {} };

export interface MergeDeps {
  repos: Repositories;
  gh: GithubWriteClient;
  ci: Pick<GithubCiClient, 'listRuns'>;
  lifecycle: { readonly draining: boolean };
  /** This process's instance id: the cap marker run is written under it. */
  instance: string;
  /** Starts the conflict fixer: the dispatcher's `startTriggered`. */
  startFixer(i: TriggeredRun): Promise<TriggeredStart>;
  now?: () => Date;
  log?: Log;
  /** Green readings per PR (`<project>:<repo>#<n>` → head sha): with no `required_checks`, a merge needs two
   *  in a row (spike R1). Per process; a restart costs one more sync. */
  seen?: Map<string, string>;
}

const defaultSeen = new Map<string, string>();

/** One card per PR head and base (spec §10.1): a push or a retarget makes a new question. */
export const mergeKey = (repo: string, n: number, sha: string, base: string) => `${MERGE_TOOL}:${repo}#${n}@${sha}->${base}`;

/** How much a merge may do, to tell whether a fresh reading needs more than what the person approved. */
const NEED_RANK: Record<string, number> = { pr: 0, merge: 1, deploy: 2, release: 3, store: 4, files_incomplete: 4, other_base: 5 };
const needRank = (needed: string) => NEED_RANK[needed] ?? Number.MAX_SAFE_INTEGER;

/** What the approval card carries: ids, the PR and why it asks — never file names or content. */
const mergeArgs = z.object({
  project_id: z.string().min(1),
  repo: z.string().min(1),
  number: z.number().int().positive(),
  head_sha: z.string().min(1),
  title: z.string(),
  url: z.string(),
  base: z.string(),
  needed: z.string(),
});
type MergeArgs = z.infer<typeof mergeArgs>;

/** GitHub write paths, normalized before the globs: `./apps/x` and `apps/x` are the same file. */
export const normalizePath = (p: string): string => p.trim().replace(/^(\.\/)+/, '');

const codeOf = (e: unknown): string => {
  const o = e as { code?: unknown; kind?: unknown };
  const code = typeof o?.code === 'string' ? o.code : typeof o?.kind === 'string' ? `GITHUB_${o.kind.toUpperCase()}` : 'INTERNAL';
  return code.slice(0, 64);
};

/** The project's GitHub token, under the CI sync's rule: a GitHub integration of the project's owner. */
export async function githubAccess(repos: Repositories, project: Project, setup: ProjectSetupData): Promise<{ token: string; repo: string } | null> {
  const repo = setup.repo;
  if (!repo?.integration_id || !repo.full_name) return null;
  const integration = await repos.integrations.findById(repo.integration_id);
  if (!integration || integration.provider !== 'github' || project.owner_id === null || integration.owner_id !== project.owner_id) return null;
  const token = await repos.integrations.getSecret(integration.id);
  return token ? { token, repo: repo.full_name } : null;
}

interface PullCtx {
  deps: MergeDeps;
  project: Project & { owner_id: string };
  setup: ProjectSetupData;
  token: string;
  repo: string;
  /** the PR's rows (one per card it names), all of automatic cards */
  rows: TaskPullRequest[];
  tasks: Task[];
  /** the card whose automatic run worked on the PR's head branch */
  primary: Task;
  /** the primary card's epic branch, when its epic is automatic */
  epicBranch: string | null;
  baseBranch: string;
}

const now = (deps: MergeDeps) => deps.now?.() ?? new Date();
const waitOn = (c: PullCtx, wait: MergeWait) => noteMergeWait(c.tasks.map((t) => t.id), wait, now(c.deps));

/**
 * Whether termhub may merge this PR at all, from its rows: every card it names is automatic, its head branch
 * is the branch an automatic run of one of them worked on (that card is the primary), and its base is that
 * card's epic branch or the project's base branch. A PR anyone else opened that only mentions a card, or one
 * into another branch, is ignored: no merge and no card. The epic PR, linked to its automatic epic alone, is
 * the one PR whose head may be an epic branch (`epicCandidate`). Null when it is not a candidate.
 */
async function candidateOf(
  deps: MergeDeps,
  base: Omit<PullCtx, 'rows' | 'tasks' | 'primary' | 'epicBranch' | 'baseBranch'>,
  rows: TaskPullRequest[],
): Promise<PullCtx | null> {
  const { repos } = deps;
  const row = rows[0];
  if (!row?.base_ref) return null;
  const found = await Promise.all(rows.map((r) => repos.tasks.findById(r.task_id)));
  // a PR that names a card a person works on is merged by a person
  if (found.some((task) => !task || !task.auto)) return null;
  const tasks = found as Task[];
  let primary: Task | undefined;
  for (const task of tasks) {
    if ((await repos.automationRuns.branchesOfTask(task.id)).includes(row.head_ref)) {
      primary = task;
      break;
    }
  }
  if (!primary) return null;
  const baseBranch = base.setup.repo?.base_branch ?? 'main';
  if (primary.type === 'epic') return epicCandidate(deps, base, rows, tasks, primary, baseBranch);
  const epic = primary.epic_id ? await repos.tasks.findById(primary.epic_id) : undefined;
  const { epicBranch } = targetOf({ epic: epic ? { auto: epic.auto, ref: epic.ref, title: epic.title } : null }, base.setup);
  if (row.base_ref !== baseBranch && row.base_ref !== epicBranch) return null;
  // a head named like the base or the epic branch is never a card's own branch
  if (row.head_ref === baseBranch || row.head_ref === epicBranch) return null;
  return { ...base, rows, tasks, primary, epicBranch, baseBranch };
}

/**
 * The epic PR (spec §10.2, D20): the epic's own branch, which its integrator run worked on, into the project's
 * base branch, and naming the epic alone. Only the epic card may have its epic branch as a PR head; a card's
 * PR from that branch is still refused by `candidateOf`. The server merges (or updates) it only after the
 * integrator finished (D20: the integrator merges the base in and pushes, then the server merges): an
 * integrator run ended `done` and none is active. Until then it is not a candidate — no update-branch, no merge.
 */
async function epicCandidate(
  deps: MergeDeps,
  base: Omit<PullCtx, 'rows' | 'tasks' | 'primary' | 'epicBranch' | 'baseBranch'>,
  rows: TaskPullRequest[],
  tasks: Task[],
  epic: Task,
  baseBranch: string,
): Promise<PullCtx | null> {
  const row = rows[0]!;
  if (tasks.length !== 1) return null;
  let own: string;
  try {
    own = epicBranchName(base.setup.automation.epic_branch_pattern, epic);
  } catch {
    return null;
  }
  if (own === baseBranch || row.head_ref !== own || row.base_ref !== baseBranch) return null;
  const integrators = await deps.repos.automationRuns.triggeredStatuses(epic.id, 'integrator');
  if (!integrators.includes('done') || integrators.some((s) => (ACTIVE_RUN_STATUSES as readonly string[]).includes(s))) return null;
  return { ...base, rows, tasks, primary: epic, epicBranch: own, baseBranch };
}

/** GitHub's own view of the PR still matches the candidate: same head branch, from this repository (no fork), same base. */
const sameTarget = (c: PullCtx, row: TaskPullRequest, pull: { head_ref: string; head_repo: string | null; base_ref: string }) =>
  pull.head_repo === c.repo && pull.head_ref === row.head_ref && pull.base_ref === row.base_ref;

/**
 * The merge executor (spec §10.1, D5–D7, spike R1/R2), run after each CI sync of a project with automation on.
 * For each open PR of an automatic card's own branch (`candidateOf`) whose CI is green: merges it (squash,
 * the PR's own title) when the project's level allows what its files need, or asks the owner once per PR head
 * with an irreversible card. Store paths, and a file list GitHub could not give whole, always ask. A PR in
 * conflict gets one fixer run per head, up to `fix_attempts`. Red CI is not handled here. Nothing happens
 * while the instance drains, the project is paused, or its automation is off.
 */
export async function runMergeExecutor(deps: MergeDeps, projectId: string): Promise<void> {
  const { repos } = deps;
  const log = deps.log ?? noopLog;
  if (deps.lifecycle.draining) return;
  const setup = (await repos.projectSetup.get(projectId)).data;
  if (!setup.automation.enabled) return;
  const project = await repos.projects.findById(projectId);
  if (!project?.owner_id) return;
  const owned = project as Project & { owner_id: string };
  if (await isPaused(repos, owned.owner_id, projectId)) return;
  const access = await githubAccess(repos, owned, setup);
  if (!access) return;

  const watched = await repos.taskPullRequests.listWatched(projectId, { repo: access.repo, includeMerged: false }, now(deps));
  const byNumber = new Map<number, TaskPullRequest[]>();
  for (const r of watched) if (r.state === 'open' && !r.draft) byNumber.set(r.number, [...(byNumber.get(r.number) ?? []), r]);

  for (const rows of byNumber.values()) {
    if (deps.lifecycle.draining) return;
    const c = await candidateOf(deps, { deps, project: owned, setup, ...access }, rows);
    if (!c) continue;
    try {
      await handlePull(c);
    } catch (e) {
      if (e instanceof GithubCiError && e.kind === 'forbidden') {
        noWrite(c);
        continue;
      }
      log.warn({ projectId, pr: rows[0]!.number, code: codeOf(e) }, 'automation: merge pass failed for a PR');
    }
  }
}

/** Draining, paused, or automation turned off since the pass began: read fresh, right before a merge (D24). */
async function stopped(c: PullCtx): Promise<boolean> {
  const { repos } = c.deps;
  if (c.deps.lifecycle.draining) return true;
  if (!(await repos.projectSetup.get(c.project.id)).data.automation.enabled) return true;
  return isPaused(repos, c.project.owner_id, c.project.id);
}

/** A write the token may not do (F-26): the card says so, and the CI panel too. */
function noWrite(c: PullCtx): void {
  waitOn(c, 'merge_no_write');
  setCiError(c.project.id, REASON_TEXT.merge_no_write);
}

async function handlePull(c: PullCtx): Promise<void> {
  const { deps, setup, token, repo } = c;
  const { repos } = deps;
  const row = c.rows[0]!;
  const seen = deps.seen ?? defaultSeen;
  const seenKey = `${c.project.id}:${repo}#${row.number}`;
  // `none` is never green; red CI belongs to the fixer of the red-CI task
  if (row.ci_state === 'failed' || row.ci_state === 'none') {
    seen.delete(seenKey);
    return;
  }
  if (!(await checksGreen(c, row, seen, seenKey))) return;

  // a card already asked for this head: act on an approval a missed hook left behind, else wait for the person
  // (a conflict that appears while the card waits is left to the person, who sees it on GitHub)
  const asked = await repos.chatActions.findLatestByKeyInProject(c.project.owner_id, c.project.id, mergeKey(repo, row.number, row.head_sha, row.base_ref!));
  if (asked) {
    if (asked.status === 'approved') await mergeApproved(deps, asked.id);
    else if (asked.status === 'pending') waitOn(c, (asked.args as { needed?: unknown })?.needed === 'store' ? 'merge_store' : 'merge_needs_approval');
    return;
  }

  const pull = await deps.gh.pull(token, repo, row.number);
  if (pull.head_sha !== row.head_sha) return; // the head moved since CI: the next sync reads the new one
  if (!sameTarget(c, row, pull)) return;
  if (pull.mergeable === null) return; // GitHub is still computing it
  if (pull.mergeable === false || pull.mergeable_state === 'dirty') return void (await onConflict(c, row, pull.base_ref));

  const delivery = await deliveryGate(c, row, pull);
  if (delivery !== 'ok') {
    if (delivery === 'merge_updating') seen.delete(seenKey);
    return waitOn(c, delivery);
  }

  const { needed, complete } = await readNeeded(c, row, pull.base_ref);

  if (complete && allows(setup.automation.autonomy, needed)) {
    // D24 / Review Focus 4: the last check before the merge
    if (await stopped(c)) return;
    const outcome = await mergePull(c, row, needed, 'policy');
    if (outcome === 'no_write') noWrite(c);
    return;
  }
  await askApproval(c, row, pull.base_ref, complete ? needed : 'files_incomplete');
}

/** The level the PR's files need now (D6), stored on its rows. An empty or cut list cannot prove the PR stays
 *  within any level: `complete` false, stored as `files_incomplete`, and a person decides. */
async function readNeeded(c: PullCtx, row: TaskPullRequest, base: string): Promise<{ needed: NeededLevel; complete: boolean }> {
  const files = await c.deps.gh.files(c.token, c.repo, row.number);
  const paths = files.paths.map(normalizePath).filter((p) => p.length > 0);
  const complete = files.complete && paths.length > 0;
  const needed = requiredLevel({
    base,
    epicBranch: c.epicBranch,
    baseBranch: c.baseBranch,
    deployWorkflow: c.setup.repo?.deploy_workflow ?? null,
    files: paths,
    releasePaths: c.setup.automation.release_paths,
    storePaths: c.setup.automation.store_paths,
  });
  await c.deps.repos.taskPullRequests.setChangedLevel(c.project.id, c.repo, row.number, complete ? needed : 'files_incomplete');
  return { needed, complete };
}

/**
 * R1 for a PR into the base branch, on both paths: the head contains the base's current head (compared
 * explicitly: GitHub's `behind` state only shows under strict branch protection), else the branch is updated
 * and the PR waits for CI on the new head; and the base head is green with nothing being delivered.
 * `ok` for a PR into the epic branch (epic branches deploy nothing).
 */
async function deliveryGate(c: PullCtx, row: TaskPullRequest, pull: { head_sha: string; base_ref: string; mergeable_state: string }): Promise<'ok' | MergeWait> {
  if (pull.base_ref !== c.baseBranch) return 'ok';
  const { behind_by } = await c.deps.gh.compare(c.token, c.repo, c.baseBranch, pull.head_sha);
  if (behind_by > 0 || pull.mergeable_state === 'behind') {
    const updated = await c.deps.gh.updateBranch(c.token, c.repo, row.number, pull.head_sha);
    if (!updated) (c.deps.log ?? noopLog).warn({ projectId: c.project.id, pr: row.number }, 'automation: update-branch refused (head moved or nothing to do)');
    return 'merge_updating';
  }
  const base = await baseState(c, c.baseBranch);
  return base === 'green' ? 'ok' : base === 'red' ? 'merge_base_red' : 'merge_base_pending';
}

/**
 * Whether the PR's checks are green enough to merge (spike R1). With `required_checks`, every listed
 * workflow has a successful run on the head. Without, every run passed (`ci_state`, which needs at least one)
 * on two consecutive passes, so a workflow GitHub had not queued yet on the first one gets its chance.
 * `seen` null: one reading is enough (an approved card, whose head was already read green when it was asked).
 */
async function checksGreen(c: PullCtx, row: TaskPullRequest, seen: Map<string, string> | null, seenKey: string): Promise<boolean> {
  if (row.ci_state === 'failed' || row.ci_state === 'none') return false;
  const required = c.setup.automation.required_checks;
  if (required.length > 0) {
    const runs = latestPerWorkflow(await c.deps.ci.listRuns(c.token, c.repo, row.head_sha));
    const ok = required.every((w) => runs.some((r) => matchesWorkflow(r, w) && r.status === 'completed' && r.conclusion === 'success'));
    if (!ok) waitOn(c, 'merge_checks_pending');
    return ok;
  }
  if (row.ci_state !== 'passed') {
    seen?.delete(seenKey);
    return false;
  }
  if (!seen || seen.get(seenKey) === row.head_sha) return true;
  seen.set(seenKey, row.head_sha);
  waitOn(c, 'merge_checks_pending');
  return false;
}

/**
 * The base branch's head (spike R1): `green` when it has runs and all of them passed; `pending` while any
 * of them — its CI, the previous merge's deploy or a release workflow — is queued or running, or none was
 * queued yet (one delivery at a time); `red` otherwise. A cancelled deploy or release was superseded, not failed.
 */
async function baseState(c: PullCtx, baseBranch: string): Promise<'green' | 'red' | 'pending'> {
  const sha = await c.deps.gh.branchSha(c.token, c.repo, baseBranch);
  if (!sha) return 'red';
  const runs = latestPerWorkflow(await c.deps.ci.listRuns(c.token, c.repo, sha));
  const delivery = [c.setup.repo?.deploy_workflow ?? null, ...c.setup.automation.release_workflows].filter((w): w is string => !!w);
  const isDelivery = (r: WorkflowRun) => delivery.some((w) => matchesWorkflow(r, w));
  if (runs.length === 0 || runs.some((r) => r.status !== 'completed')) return 'pending';
  if (runs.some((r) => FAILED.has(r.conclusion ?? '') && !(isDelivery(r) && r.conclusion === 'cancelled'))) return 'red';
  return 'green';
}

/** A PR GitHub cannot merge cleanly: one fixer run per head (R2), up to `fix_attempts`, then the person. */
async function onConflict(c: PullCtx, row: TaskPullRequest, base: string): Promise<void> {
  const { deps } = c;
  const { repos } = deps;
  const log = deps.log ?? noopLog;
  const task = c.primary;
  const used = await repos.automationRuns.countTriggered(task.id, 'fixer', CONFLICT_CAP);
  if (used >= c.setup.automation.fix_attempts) {
    // the marker takes this head's trigger: the escalation happens once per head, on whichever colour
    const marker = await repos.automationRuns.claim({ project_id: c.project.id, task_id: task.id, role: 'fixer', instance: deps.instance, trigger_sha: row.head_sha });
    waitOn(c, 'merge_conflict_cap');
    if (!marker) return;
    await repos.automationRuns.update(marker.id, deps.instance, { status: 'blocked', waiting_reason: CONFLICT_CAP, ended_at: now(deps) });
    await escalateRun(repos, { ...marker, status: 'blocked', waiting_reason: CONFLICT_CAP }, CONFLICT_CAP, log, { extra: { pr: row.number, url: row.url, sha: row.head_sha, attempts: used } });
    return;
  }
  const prompt = fixerPrompt({ ref: task.ref, branch: row.head_ref, base, reason: 'conflict', detail: `PR ${row.url}`, custom: c.setup.automation.prompts.fixer });
  const started = await deps.startFixer({ projectId: c.project.id, taskId: task.id, role: 'fixer', triggerSha: row.head_sha, branch: row.head_ref, base, prompt });
  if (started === 'started') log.info({ projectId: c.project.id, taskId: task.id, pr: row.number }, 'automation: fixer started for a conflict');
}

/** Above the level (D7): one irreversible card per PR head in the owner's project chat, and its event. */
async function askApproval(c: PullCtx, row: TaskPullRequest, base: string, needed: NeededLevel | 'files_incomplete'): Promise<void> {
  const { repos } = c.deps;
  const args: MergeArgs = { project_id: c.project.id, repo: c.repo, number: row.number, head_sha: row.head_sha, title: row.title, url: row.url, base, needed };
  const card = await askForAutomation(repos, c.project.owner_id, c.project.id, { tool: MERGE_TOOL, args, key: mergeKey(c.repo, row.number, row.head_sha, base) });
  waitOn(c, needed === 'store' ? 'merge_store' : 'merge_needs_approval');
  if (!card) return;
  for (const task of c.tasks) {
    await recordEvent(repos, {
      project_id: c.project.id,
      task_id: task.id,
      kind: 'merge_needs_approval',
      payload: { pr: row.number, url: row.url, sha: row.head_sha, needed, action_id: card.id, ...(needed === 'store' ? { text: REASON_TEXT.merge_store } : {}) },
    });
  }
}

/**
 * The merge itself (squash, `<PR title> (#n)` as the subject: F-14), then the record: the `merged` event and
 * a chat line, and each card to the project's first `done` column (F-5). `merged` is recorded only when
 * GitHub says so: a head that moved (409) or a PR it refuses (405) is `not_merged`, a read-only token `no_write`.
 */
async function mergePull(c: PullCtx, row: TaskPullRequest, needed: string, by: 'policy' | 'approval'): Promise<'merged' | 'not_merged' | 'no_write'> {
  const { repos } = c.deps;
  const log = c.deps.log ?? noopLog;
  let result: { merged: boolean; sha: string | null };
  try {
    result = await c.deps.gh.merge(c.token, c.repo, row.number, { sha: row.head_sha, title: `${row.title} (#${row.number})`, method: 'squash' });
  } catch (e) {
    if (e instanceof GithubCiError && e.kind === 'not_mergeable') return 'not_merged';
    if (e instanceof GithubCiError && e.kind === 'forbidden') return 'no_write';
    throw e;
  }
  if (!result.merged) return 'not_merged';
  clearMergeWait(c.tasks.map((t) => t.id));
  for (const task of c.tasks) {
    let moved = false;
    try {
      moved = (await repos.tasks.move(task.id, { status: 'done' }, 0)) !== undefined;
    } catch (e) {
      log.warn({ taskId: task.id, code: codeOf(e) }, 'automation: merged card not moved to done');
    }
    await recordEvent(repos, {
      project_id: c.project.id,
      task_id: task.id,
      kind: 'merged',
      payload: { pr: row.number, url: row.url, sha: result.sha, level: needed, by, moved_to_done: moved },
    });
  }
  log.info({ projectId: c.project.id, pr: row.number, by }, 'automation: PR merged');
  await postMergeLine(c, row).catch((e: unknown) => log.warn({ pr: row.number, code: codeOf(e) }, 'automation: merge line not posted'));
  return 'merged';
}

/** The chat hears of each merge (spec D25), in the owner's most recent project conversation. */
async function postMergeLine(c: PullCtx, row: TaskPullRequest): Promise<void> {
  const { repos } = c.deps;
  const owner = await repos.users.findById(c.project.owner_id);
  if (!owner) return;
  const locale = localeOf(owner.locale);
  const conversation = (await repos.chat.findLatestActiveForProject(c.project.id, owner.id)) ?? (await repos.chat.getOrCreateForProject(owner.id, c.project.id));
  const refs = c.tasks.map((t) => t.ref).join(', ');
  const message = await repos.chat.addMessage({
    conversation_id: conversation.id,
    role: 'assistant',
    text: t(locale, 'Automático mesclou o PR #{{n}} de {{ref}}: {{url}}', { n: row.number, ref: refs, url: row.url }),
  });
  chatBus.publish({ type: 'message', user_id: owner.id, conversation_id: conversation.id, message });
}

/** Closes the approval card with its outcome and tells every open screen. */
async function finish(repos: Repositories, action: ChatAction, ownerId: string, ok: boolean, code: string | null, started: number): Promise<void> {
  await repos.chatActions.markExecuted(action.id, ok, code, Date.now() - started);
  chatBus.publish({ type: 'action_status', user_id: ownerId, conversation_id: action.conversation_id, action_id: action.id, status: ok ? 'executed' : 'failed', error_code: code });
}

/**
 * The person approved an `automation_merge` card (spec D7, F-19): the decision hook of every decision path
 * calls this, and the executor too when it finds an approval a hook never acted on. The whole gate runs
 * again first — the PR is still a candidate on the same head, its checks are explicitly green, and (into
 * the base) it contains the base's head, the base is green and nothing is being delivered — then the pause
 * and the drain are checked once more and the row is claimed right before the merge (`claimApproved`), so
 * two approvals, two hooks or both colours merge once. A gate that only has to wait (checks running, base
 * pending, paused, draining) leaves the approval as it is, and the executor acts on it on a later pass.
 * Closed without a merge: `HEAD_MOVED` (the head the card was asked for is gone), `BASE_CHANGED` (the PR was
 * retargeted), `LEVEL_CHANGED` (its files now need more than what was approved), `CI_FAILED`, `BEHIND_BASE`
 * (the branch was updated: a new head and a new card), `NOT_CANDIDATE`, `GITHUB_NO_ACCESS`.
 */
export async function mergeApproved(deps: MergeDeps, actionId: string): Promise<void> {
  const { repos } = deps;
  const action = await repos.chatActions.findById(actionId);
  if (!action || action.tool !== MERGE_TOOL || action.status !== 'approved') return;
  const parsed = mergeArgs.safeParse(action.args);
  if (!parsed.success) return;
  const args = parsed.data;
  if (deps.lifecycle.draining) return;
  const project = await repos.projects.findById(args.project_id);
  if (!project?.owner_id) return;
  const owned = project as Project & { owner_id: string };
  const setup = (await repos.projectSetup.get(project.id)).data;
  if (!setup.automation.enabled || (await isPaused(repos, owned.owner_id, project.id))) return;
  // the card is the owner's: it was asked in one of the owner's conversations of this project
  const conversation = await repos.chat.findByIdForUser(action.conversation_id, owned.owner_id);
  if (!conversation || conversation.project_id !== project.id) return;

  /** Claims the approval and closes it with an outcome other than a merge. */
  const close = async (code: string) => {
    if (await repos.chatActions.claimApproved(action.id)) await finish(repos, action, owned.owner_id, false, code, Date.now());
  };
  const access = await githubAccess(repos, owned, setup);
  if (!access || access.repo !== args.repo) return void (await close('GITHUB_NO_ACCESS'));
  const rows = (await repos.taskPullRequests.listWatched(project.id, { repo: args.repo, includeMerged: false }, now(deps))).filter((r) => r.number === args.number && r.state === 'open');
  const row = rows[0];
  if (!row || row.head_sha !== args.head_sha) return void (await close('HEAD_MOVED'));
  const c = await candidateOf(deps, { deps, project: owned, setup, ...access }, rows);
  if (!c) return void (await close('NOT_CANDIDATE'));
  // the approval was for this base: a PR retargeted since (say from the epic branch to the deploying base) is a new question
  if (row.base_ref !== args.base) return void (await close('BASE_CHANGED'));

  // R1 again, on the head the card was asked for: the CI may have been re-run since
  if (row.ci_state === 'failed') return void (await close('CI_FAILED'));
  if (!(await checksGreen(c, row, null, ''))) return;
  const pull = await deps.gh.pull(access.token, args.repo, args.number);
  if (pull.head_sha !== args.head_sha) return void (await close('HEAD_MOVED'));
  if (pull.base_ref !== args.base) return void (await close('BASE_CHANGED'));
  if (!sameTarget(c, row, pull)) return void (await close('NOT_CANDIDATE'));
  let delivery: 'ok' | MergeWait;
  try {
    delivery = await deliveryGate(c, row, pull);
  } catch (e) {
    if (e instanceof GithubCiError && e.kind === 'forbidden') return noWrite(c);
    throw e;
  }
  if (delivery === 'merge_updating') return void (await close('BEHIND_BASE'));
  if (delivery !== 'ok') return waitOn(c, delivery);
  // the files read now may need more than what the person approved (the setup's globs changed, say)
  const fresh = await readNeeded(c, row, pull.base_ref);
  if (needRank(fresh.complete ? fresh.needed : 'files_incomplete') > needRank(args.needed)) return void (await close('LEVEL_CHANGED'));

  // D24 / Review Focus 4: the last check before the merge, after every GitHub read (setup read fresh)
  if (await stopped(c)) return;
  if (!(await repos.chatActions.claimApproved(action.id))) return;

  const started = Date.now();
  try {
    const outcome = await mergePull(c, row, args.needed, 'approval');
    if (outcome === 'no_write') noWrite(c);
    await finish(repos, action, owned.owner_id, outcome === 'merged', outcome === 'merged' ? null : outcome === 'no_write' ? 'GITHUB_FORBIDDEN' : 'NOT_MERGED', started);
  } catch (e) {
    await finish(repos, action, owned.owner_id, false, codeOf(e), started).catch(() => {});
    throw e;
  }
}
