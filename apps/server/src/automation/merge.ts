import { z } from 'zod';
import { AGENT_EXITED_TEXT } from '../chat/agent-exited.js';
import { chatBus } from '../chat/bus.js';
import { isAccountSwapState } from '../control/account-swap.js';
import { controlContextFor, type ControlContext } from '../control/context.js';
import { askForAutomation } from '../chat/gate-runtime.js';
import { FAILED, latestPerWorkflow, matchesWorkflow, type WorkflowRun } from '../ci/rules.js';
import { setCiError } from '../ci/status.js';
import type { AutomationEvent, Repositories } from '../db/repositories/index.js';
import { ACTIVE_RUN_STATUSES } from '../db/repositories/automation-runs.js';
import type { ChatAction } from '../db/repositories/chat-actions.js';
import type { TaskPullRequest } from '../db/repositories/task-pull-requests.js';
import type { Project, Tab, Task } from '../db/repositories/types.js';
import { t } from '../i18n/index.js';
import { GithubCiError, type GithubCiClient } from '../integrations/github-ci.js';
import { writesDegraded, type GithubHealthReader } from '../integrations/github-status.js';
import type { GithubWriteClient } from '../integrations/github-write.js';
import { RATE_LIMIT_TEXT } from '../monitor/state.js';
import type { ProjectSetupData } from '../setup/schema.js';
import { epicBranchName, targetOf } from './branches.js';
import type { TriggeredRun, TriggeredStart } from './dispatcher.js';
import { REASON_TEXT } from './eligibility.js';
import { cleanupRuns, type CleanupDeps } from './cleanup.js';
import { CI_CAP, CONFLICT_CAP, FIXER_NO_PUSH, MERGE_PERSON_CARD, RUN_DONE_NO_PUSH } from './escalation-text.js';
import { postAutomationLine } from './chat-line.js';
import { claimEvent, publishEvent, recordEvent, settleEvent } from './events.js';
import { defaultType, endRunsOfMergedCard, escalateDelivery } from './follower.js';
import { clearMergeWait, noteMergeWait, type MergeWait } from './merge-wait.js';
import { isPaused } from './pause.js';
import { allows, requiredLevel, type NeededLevel } from './policy.js';
import { fixerPrompt, serverMessage } from './prompts.js';

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
  /** githubstatus.com (TER-1025): a red-CI fix that ended without a push while GitHub reports trouble is
   *  held, then asked once more when GitHub works again. Left out: escalated at once, as before. */
  githubHealth?: GithubHealthReader;
  /** Starts a fixer (a conflict or a red CI): the dispatcher's `startTriggered`. */
  startFixer(i: TriggeredRun): Promise<TriggeredStart>;
  /** Types a line into the tab of the run that owns a red PR, as the project's owner. Default: the follower's `defaultType`. */
  type?: (ctx: ControlContext, tabId: string, text: string) => Promise<void>;
  /** Worktree removal and tab closing after a merge (spec §7); defaults: the real ones. */
  removeWorkspace?: CleanupDeps['removeWorkspace'];
  closeTab?: CleanupDeps['closeTab'];
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
  /** the PR's rows (one per card it cites) */
  rows: TaskPullRequest[];
  /** the cards the merge acts on: the primary alone (TER-1004: a card the PR only cites is not part of it) */
  tasks: Task[];
  /** the card whose automatic run worked on the PR's head branch */
  primary: Task;
  /** the primary card's epic branch, when its epic is automatic */
  epicBranch: string | null;
  baseBranch: string;
}

const now = (deps: MergeDeps) => deps.now?.() ?? new Date();
const waitOn = (c: PullCtx, wait: MergeWait, sha: string | null = null) => noteMergeWait(c.tasks.map((t) => t.id), wait, now(c.deps), sha);

/** A PR of an automatic card that termhub leaves to a person (TER-1004): it also cites a person's card that is not done. */
interface HeldPull {
  held: { primary: Task; people: Task[]; row: TaskPullRequest };
}

/**
 * Whether termhub may merge this PR at all, from its rows (one per card it cites). The PR is the automatic
 * card whose run worked on its head branch (the primary); its base is that card's epic branch or the
 * project's base branch. A PR anyone else opened that only cites a card, or one into another branch, is
 * ignored: no merge and no card. The epic PR, linked to its automatic epic alone, is the one PR whose head
 * may be an epic branch (`epicCandidate`). Null when it is not a candidate.
 *
 * The other cards the PR cites are references, not part of it (TER-1004): they are not moved to done or
 * told of the merge. A person's card that is not done yet still holds the merge for a person (`held`); one
 * already done, or a card that no longer exists, does not.
 */
async function candidateOf(
  deps: MergeDeps,
  base: Omit<PullCtx, 'rows' | 'tasks' | 'primary' | 'epicBranch' | 'baseBranch'>,
  rows: TaskPullRequest[],
): Promise<PullCtx | HeldPull | null> {
  const { repos } = deps;
  const row = rows[0];
  if (!row?.base_ref) return null;
  const tasks = (await Promise.all(rows.map((r) => repos.tasks.findById(r.task_id)))).filter((t): t is Task => !!t);
  let primary: Task | undefined;
  for (const task of tasks) {
    if (task.auto && (await repos.automationRuns.branchesOfTask(task.id)).includes(row.head_ref)) {
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
  // a PR that cites a card a person still works on is merged by a person
  const people = tasks.filter((t) => !t.auto && t.status !== 'done');
  if (people.length > 0) return { held: { primary, people, row } };
  return { ...base, rows, tasks: [primary], primary, epicBranch, baseBranch };
}

/**
 * Tells why an automatic card's PR is not merged (TER-1004): the queue shows it on every pass, and once the
 * PR is green the feed (with a push and a chat line) says it once per PR head.
 */
async function onHeld(deps: MergeDeps, projectId: string, { primary, people, row }: HeldPull['held']): Promise<void> {
  const { repos } = deps;
  noteMergeWait([primary.id], 'merge_person_card', now(deps));
  if (row.ci_state !== 'passed') return;
  if (await repos.automationEvents.findOnce(primary.id, 'escalated', { reason: MERGE_PERSON_CARD, pr: row.number, sha: row.head_sha })) return;
  const cards = people.map((t) => t.ref).join(', ');
  await escalateDelivery(repos, { project_id: projectId, task_id: primary.id }, MERGE_PERSON_CARD, deps.log ?? noopLog, { pr: row.number, url: row.url, sha: row.head_sha, cards });
}

const isHeld = (c: PullCtx | HeldPull | null): c is HeldPull => !!c && 'held' in c;

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
 * conflict gets one fixer run per head, and a red CI one fix request per head (`onRedCi`), both up to
 * `fix_attempts` together. Nothing happens
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
    if (isHeld(c)) {
      await onHeld(deps, projectId, c.held).catch((e: unknown) => log.warn({ projectId, pr: rows[0]!.number, code: codeOf(e) }, 'automation: held PR not reported'));
      continue;
    }
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
  // `none` is never green
  if (row.ci_state === 'failed' || row.ci_state === 'none') {
    seen.delete(seenKey);
    if (row.ci_state === 'failed') await onRedCi(c, row);
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

/** A PR GitHub cannot merge cleanly: one fixer run per head (R2), up to `fix_attempts`, then the person. A
 *  fixer for this very head that ended while the head stayed the same (it never pushed) is not left to stall:
 *  the person is told once (final review I3). */
async function onConflict(c: PullCtx, row: TaskPullRequest, base: string): Promise<void> {
  const { deps } = c;
  const { repos } = deps;
  const log = deps.log ?? noopLog;
  const task = c.primary;
  const used = await fixesUsed(repos, task.id);
  if (used >= c.setup.automation.fix_attempts) return void (await conflictEscalation(c, row, { attempts: used }));
  const prompt = fixerPrompt({ ref: task.ref, branch: row.head_ref, base, reason: 'conflict', detail: `PR ${row.url}`, custom: c.setup.automation.prompts.fixer });
  const started = await deps.startFixer({ projectId: c.project.id, taskId: task.id, role: 'fixer', triggerSha: row.head_sha, branch: row.head_ref, base, prompt });
  if (started === 'started') log.info({ projectId: c.project.id, taskId: task.id, pr: row.number }, 'automation: fixer started for a conflict');
  if (started !== 'taken') return;
  // taken: a run of the card is still on (it may be the fixer itself), or this head's fixer already ended
  if ((await repos.automationRuns.activeByProject(c.project.id)).some((r) => r.task_id === task.id)) return;
  await conflictEscalation(c, row, { attempts: used, cause: FIXER_NO_PUSH });
}

/** The conflict marker's trigger: apart from the fixer's own (the head SHA), so both can exist for one head. */
const conflictMarker = (sha: string) => `${CONFLICT_CAP}:${sha}`;
/** TER-1016: the second marker of a head, for the one "a run ended and the conflict is still there" notice. */
const runDoneMarker = (sha: string) => `${CONFLICT_CAP}:${sha}:${RUN_DONE_NO_PUSH}`;

/**
 * Tells the person a conflict stays on this head (the cap, or a fixer that ended without pushing): once per
 * head, on whichever colour — a marker run (`blocked`, never active, so a card with a run still on gets it
 * too) holds the head's marker trigger. The board says why the PR waits on every pass, naming the head.
 *
 * The escalation is about this head only: a push makes a new head, which the executor reads afresh (a clean
 * one merges once its CI is green). A run of the card that ends after the escalation while the head stays
 * the same (it said it was done, but pushed nothing) leaves a PR that looks finished in the feed and is
 * still in conflict, so the person is told once more for that head (TER-1016).
 */
async function conflictEscalation(c: PullCtx, row: TaskPullRequest, extra: { attempts: number; cause?: string }): Promise<void> {
  const { repos } = c.deps;
  const log = c.deps.log ?? noopLog;
  const about = { project_id: c.project.id, task_id: c.primary.id };
  const payload = { pr: row.number, url: row.url, sha: row.head_sha };
  waitOn(c, 'merge_conflict_cap', row.head_sha);
  const marker = await repos.automationRuns.insertMarker({ ...about, role: 'fixer', instance: c.deps.instance, trigger_sha: conflictMarker(row.head_sha), waiting_reason: CONFLICT_CAP });
  if (marker) return void (await escalateDelivery(repos, about, CONFLICT_CAP, log, { ...payload, ...extra }));
  if (!(await runEndedSinceEscalation(c, row.head_sha))) return;
  const again = await repos.automationRuns.insertMarker({ ...about, role: 'fixer', instance: c.deps.instance, trigger_sha: runDoneMarker(row.head_sha), waiting_reason: CONFLICT_CAP });
  if (!again) return;
  await escalateDelivery(repos, about, CONFLICT_CAP, log, { ...payload, attempts: extra.attempts, cause: RUN_DONE_NO_PUSH });
}

/** A run of the card ended after this head's conflict escalation, none is on now, and the end is past the
 *  grace in which a push made right before it would have been synced. */
async function runEndedSinceEscalation(c: PullCtx, sha: string): Promise<boolean> {
  const { repos } = c.deps;
  const task = c.primary.id;
  const escalated = await repos.automationRuns.findTriggered(task, 'fixer', conflictMarker(sha));
  if (!escalated?.ended_at) return false;
  const ended = await repos.automationRuns.lastEndedAt(task);
  if (!ended || ended.getTime() <= escalated.ended_at.getTime()) return false;
  if (now(c.deps).getTime() - ended.getTime() < NO_PUSH_GRACE_MS) return false;
  return !(await repos.automationRuns.activeByProject(c.project.id)).some((r) => r.task_id === task);
}

/**
 * The fixes a card's PR already had (spec D21): its conflict and red-CI fixer runs (keyed by the PR head;
 * the conflict cap's marker run is not one) and the red-CI fixes typed into its own runs (`fix_count`).
 * One cap, `fix_attempts`, for both.
 */
async function fixesUsed(repos: Repositories, taskId: string): Promise<number> {
  const [runs, typed] = await Promise.all([repos.automationRuns.countTriggered(taskId, 'fixer', CONFLICT_CAP), repos.automationRuns.sumFixCount(taskId)]);
  return runs + typed;
}

/** What the red-CI message names: the failing workflows' names (never a log line), or a neutral word. */
const failingJobs = (row: TaskPullRequest) => {
  const names = row.ci_summary.failing.map((n) => n.trim()).filter((n) => n.length > 0);
  return names.length > 0 ? names.join(', ') : 'checks do PR';
};

/** A claim no colour settled within this long was left by a process that stopped mid-way: it may be taken again. */
export const CI_CLAIM_STALE_MS = 10 * 60_000;

/**
 * A red CI on the PR's head (spec D21, F-27): asked to fix once per head SHA. Pause, drain, `enabled` and
 * the card's tag are read fresh first; then the card's `ci_fix_requested` event for (PR, SHA) is claimed —
 * a unique index makes that insert the one claim across colours — before anything is typed, started or
 * escalated, and settled with the outcome (`via`). Under `fix_attempts` (shared with the conflict fixes):
 * typed into the run that owns the PR when its tab can take it (`[termhub automático] O CI falhou em
 * <jobs>…`, then `fix_count` bumped), else a fixer run keyed by the head when the card has no active run.
 * An active run whose tab cannot take a line now (a question, a limit, an exit), no place for the fixer, or
 * a stop found right before typing gives the claim back: the next sync asks again. At the cap: escalated,
 * once per head. Only job names are sent, never logs.
 */
async function onRedCi(c: PullCtx, row: TaskPullRequest): Promise<void> {
  const { deps } = c;
  const { repos } = deps;
  const log = deps.log ?? noopLog;
  const task = c.primary;
  const sha = row.head_sha;

  // D24 and the tag (spec §13), read fresh before anything is claimed, typed, started or escalated
  if (await stopped(c)) return;
  const fresh = await repos.tasks.findById(task.id);
  if (!fresh?.auto) return;

  const key = { pr: row.number, sha };
  const about = { project_id: c.project.id, task_id: task.id, kind: 'ci_fix_requested' as const };
  let claim = await claimEvent(repos, { ...about, payload: { ...key, url: row.url, via: 'pending' } });
  if (!claim) {
    // a claim nobody settled (the process stopped mid-way) is taken again once it is stale
    const stale = await repos.automationEvents.removeStale(task.id, 'ci_fix_requested', { ...key, via: 'pending' }, new Date(now(deps).getTime() - CI_CLAIM_STALE_MS));
    if (stale === 0) return void (await onFixedHeadStillRed(c, row));
    claim = await claimEvent(repos, { ...about, payload: { ...key, url: row.url, via: 'pending' } });
    if (!claim) return;
  }
  const held = claim;
  const settle = (via: 'typed' | 'fixer' | 'escalated', extra: Record<string, string | number> = {}) => settleEvent(repos, held, { ...key, url: row.url, via, ...extra });
  const giveBack = () => repos.automationEvents.remove(held.id);

  let acted = false;
  try {
    const used = await fixesUsed(repos, task.id);
    if (used >= c.setup.automation.fix_attempts) {
      waitOn(c, 'merge_ci_cap');
      acted = true;
      await settle('escalated', { attempts: used });
      await escalateDelivery(repos, { project_id: c.project.id, task_id: task.id }, CI_CAP, log, { pr: row.number, url: row.url, sha, attempts: used });
      return;
    }
    const jobs = failingJobs(row);

    const owner = (await repos.automationRuns.activeByProject(c.project.id)).find((r) => r.task_id === task.id);
    if (owner) {
      if (owner.status !== 'running' || !owner.tab_id || owner.branch !== row.head_ref) return void (await giveBack());
      const tab = await repos.tabs.findById(owner.tab_id);
      if (!tab || !takesLine(tab) || (await repos.tabQuestions.hasOpenQuestion(tab.id))) return void (await giveBack());
      const user = await repos.users.findById(c.project.owner_id);
      if (!user || (await stopped(c))) return void (await giveBack());
      await (deps.type ?? defaultType)(controlContextFor(repos, user), tab.id, serverMessage(`O CI falhou em ${jobs}. Corrija e faça push.`));
      acted = true;
      const count = await repos.automationRuns.bump(owner.id, 'fix_count');
      await repos.automationRuns.noteTyped(owner.id, now(deps));
      await settle('typed', { run_id: owner.id, count });
      log.info({ projectId: c.project.id, taskId: task.id, runId: owner.id, pr: row.number }, 'automation: red CI sent to the run that owns the PR');
      return;
    }

    const started = await startCiFixer(c, row, sha);
    // waiting for a place or halted: the next sync asks again. Taken: a fixer already holds this head's trigger.
    if (started === 'waiting' || started === 'halted') return void (await giveBack());
    acted = true;
    await settle('fixer');
    if (started === 'started') log.info({ projectId: c.project.id, taskId: task.id, pr: row.number }, 'automation: fixer started for a red CI');
  } catch (e) {
    // nothing reached the tab, the fixer or the person yet: the head is asked again at the next sync
    if (!acted) await giveBack().catch(() => {});
    throw e;
  }
}

/** A fixer for the red CI of the PR's head, keyed by `trigger` (the head SHA; its retry after GitHub came back has its own). */
function startCiFixer(c: PullCtx, row: TaskPullRequest, trigger: string): Promise<TriggeredStart> {
  const base = row.base_ref ?? c.baseBranch;
  const prompt = fixerPrompt({ ref: c.primary.ref, branch: row.head_ref, base, reason: 'ci', detail: `PR ${row.url}\nJobs com falha: ${failingJobs(row)}`, custom: c.setup.automation.prompts.fixer });
  return c.deps.startFixer({ projectId: c.project.id, taskId: c.primary.id, role: 'fixer', triggerSha: trigger, branch: row.head_ref, base, prompt });
}

/** How long after the card's last run ended a red head that did not move counts as "ended without a push":
 *  past a CI sync or two, so a push made right before the end has been read. */
export const NO_PUSH_GRACE_MS = 3 * 60_000;

/**
 * A red head whose fix was already asked (typed into the owning run, or a fixer) — final review I3: once no
 * run of the card is on and the last one ended NO_PUSH_GRACE_MS ago, the head did not move, so the fix ended
 * without a push. The person is told once per head: the head's claim goes from `typed`/`fixer` to
 * `escalated` in one conditional write, which only one colour wins. Already escalated: the board says so.
 */
async function onFixedHeadStillRed(c: PullCtx, row: TaskPullRequest): Promise<void> {
  const { repos } = c.deps;
  const task = c.primary;
  const key = { pr: row.number, sha: row.head_sha };
  const claim = await repos.automationEvents.findOnce(task.id, 'ci_fix_requested', key);
  const via = claim?.payload.via;
  if (via === 'escalated') return waitOn(c, 'merge_ci_cap');
  if (!claim || (via !== 'typed' && via !== 'fixer')) return;
  if ((await repos.automationRuns.activeByProject(c.project.id)).some((r) => r.task_id === task.id)) return;
  const ended = await repos.automationRuns.lastEndedAt(task.id);
  if (!ended || now(c.deps).getTime() - ended.getTime() < NO_PUSH_GRACE_MS) return;
  if (await retryAfterGithub(c, row, claim, via)) return;
  waitOn(c, 'merge_ci_cap');
  const won = await repos.automationEvents.replacePayloadIf(claim.id, { via }, { ...claim.payload, via: 'escalated', cause: FIXER_NO_PUSH });
  if (!won) return;
  await publishEvent(repos, won);
  await escalateDelivery(repos, { project_id: c.project.id, task_id: task.id }, CI_CAP, c.deps.log ?? noopLog, { ...key, url: row.url, cause: FIXER_NO_PUSH });
}

/**
 * A fix that ended without a push (TER-1025): when GitHub reports trouble with pushes, the API or pull
 * requests, the head is held (`github_hold` on its claim) instead of escalated; once GitHub works again, a
 * held head gets one more fixer (`<sha>:github`, so it is not the first fixer's trigger) — once, marked
 * `github_retry`. True while the head is held or retried: the caller escalates otherwise.
 */
async function retryAfterGithub(c: PullCtx, row: TaskPullRequest, claim: AutomationEvent, via: string): Promise<boolean> {
  const { repos } = c.deps;
  if (!c.deps.githubHealth || claim.payload.github_retry === true) return false;
  const health = await c.deps.githubHealth().catch(() => null);
  if (health && writesDegraded(health)) {
    waitOn(c, 'merge_github_down');
    if (claim.payload.github_hold !== true) await repos.automationEvents.replacePayloadIf(claim.id, { via }, { ...claim.payload, github_hold: true });
    return true;
  }
  if (claim.payload.github_hold !== true) return false;
  if (await stopped(c)) return true;
  const won = await repos.automationEvents.replacePayloadIf(claim.id, { via }, { ...claim.payload, via: 'fixer', github_retry: true });
  if (!won) return true;
  const started = await startCiFixer(c, row, `${row.head_sha}:github`);
  // no place for it now: the hold stays, the next sync asks again
  if (started === 'waiting' || started === 'halted') await repos.automationEvents.replacePayloadIf(claim.id, { via: 'fixer' }, { ...claim.payload, github_hold: true });
  else (c.deps.log ?? noopLog).info({ projectId: c.project.id, taskId: c.primary.id, pr: row.number, started }, 'automation: red CI asked again after GitHub came back');
  waitOn(c, 'merge_github_down');
  return true;
}

/** Whether a line typed into the tab reaches the agent now: it is on, and not on a limit, a swap or an exit. */
const takesLine = (tab: Tab) =>
  (tab.state === 'waiting_input' || tab.state === 'working' || tab.state === 'waiting_background') &&
  tab.rate_limited_at === null &&
  !(tab.state_text ?? '').startsWith(RATE_LIMIT_TEXT) &&
  !isAccountSwapState(tab.state_text) &&
  tab.state_text !== AGENT_EXITED_TEXT;

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
    // a run still on for the card (it never called report_card, or it is parked on a question) ends here:
    // nothing is resumed into a merged card's tab, and the cleanup below is not held by it (final review I2)
    await endRunsOfMergedCard(repos, c.project.id, task.id, { url: row.url, number: row.number }, log);
    const kept = await cleanupAfterMerge(c, task);
    await recordEvent(repos, {
      project_id: c.project.id,
      task_id: task.id,
      kind: 'merged',
      payload: { pr: row.number, url: row.url, sha: result.sha, base: row.base_ref, level: needed, by, moved_to_done: moved, ...(kept ? { worktree_kept: true } : {}) },
    });
  }
  log.info({ projectId: c.project.id, pr: row.number, by }, 'automation: PR merged');
  await postMergeLine(c, row).catch((e: unknown) => log.warn({ pr: row.number, code: codeOf(e) }, 'automation: merge line not posted'));
  return 'merged';
}

/**
 * Spec §7: the merged card's worktree goes (an epic's: its own and any card worktree of its cards that is
 * left) and its finished runs' idle tabs close. What cannot be done now stays due for the dispatcher's
 * retries. Never fails the merge. True when a worktree was kept for uncommitted changes.
 */
async function cleanupAfterMerge(c: PullCtx, task: Task): Promise<boolean> {
  const { repos } = c.deps;
  const log = c.deps.log ?? noopLog;
  try {
    const ids = [task.id];
    if (task.type === 'epic') for (const t of await repos.tasks.listByProject(c.project.id)) if (t.epic_id === task.id) ids.push(t.id);
    const runs = await repos.automationRuns.markCleanupDue(ids);
    const r = await cleanupRuns({ repos, removeWorkspace: c.deps.removeWorkspace, closeTab: c.deps.closeTab, log }, c.project, c.setup, runs);
    return r.kept > 0;
  } catch (e) {
    log.warn({ taskId: task.id, code: codeOf(e) }, 'automation: cleanup after a merge failed');
    return false;
  }
}

/** The chat hears of each merge (spec D25), in the owner's most recent project conversation. */
async function postMergeLine(c: PullCtx, row: TaskPullRequest): Promise<void> {
  const refs = c.tasks.map((t) => t.ref).join(', ');
  await postAutomationLine(c.deps.repos, c.project.id, (locale) => t(locale, 'Automático mesclou o PR #{{n}} de {{ref}}: {{url}}', { n: row.number, ref: refs, url: row.url }), c.deps.log);
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
  if (!c || isHeld(c)) return void (await close('NOT_CANDIDATE'));
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
