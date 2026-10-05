import { createHash } from 'node:crypto';
import { blocklistParts, scheduleAutoAnswer } from '../chat/auto-answer.js';
import { publishTabQuestions } from '../chat/tab-questions.js';
import { answerTabQuestion } from '../chat/tab-question-answer.js';
import { checkChoiceAnswer, type ChoiceAnswer, type ChoicePayload, type PermissionPayload } from '../chat/tab-question-payload.js';
import type { Waker } from '../chat/wake.js';
import { AUTOMATION_DENIED_TOOLS, runBranchRules, safeAllowedTools } from '../control/automation-tools.js';
import { controlContextFor } from '../control/context.js';
import type { AutomationRun } from '../db/repositories/automation-runs.js';
import type { Repositories } from '../db/repositories/index.js';
import type { TabQuestion as TabQuestionRow } from '../db/repositories/tab-questions.js';
import { tk } from '../i18n/index.js';
import { autoAnswerBlocked } from '../memory/blocklist.js';
import { recordEvent } from './events.js';
import { ANSWER_CAP, ANSWER_CYCLE, PERMISSION_NEEDED, QUESTION_UNANSWERED, wakeOrEscalate } from './follower.js';
import { automaticRunOfTab } from './pause.js';
import { runPermission } from './permission.js';

type Log = { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };
const noopLog: Log = { info: () => {}, warn: () => {} };

/** The countdown's reason when the agent's own recommended option is picked (stored as is, like
 *  `REPEAT_REASON`; screens show it translated for `by: 'automation'`). */
export const RECOMMENDED_REASON = tk('Opção recomendada pelo agente');

/**
 * At most this many questions of one run answered automatically (a memory repeat or the recommended
 * option, `question_answered` events) in a rolling hour; the next one goes to the person instead (review
 * Focus 3: every loop stops at a cap and escalates). An agent re-asking the same "(Recomendado)" question
 * would otherwise be answered every 60 s for ever. The cycle detector (TER-970) is the finer answer.
 */
export const AUTOMATION_ANSWERS_MAX_PER_HOUR = 20;

/**
 * TER-970 (R7): the same question answered the same way this many times in a rolling hour is a cycle; the
 * next ask is not answered and the run is escalated (`answer_cycle`). Per run, hashes only.
 */
export const ANSWER_CYCLE_MAX = 2;

/**
 * A short hash of a question and the way it is about to be answered (its texts, option labels and the
 * picked options or typed text). Stored in the `question_answered` event (`cycle`): the question's text is
 * terminal content and is never kept, the hash cannot be turned back into it.
 */
export function questionCycleHash(payload: ChoicePayload, answer: ChoiceAnswer): string {
  const body = JSON.stringify([payload.questions.map((q) => [q.header, q.question, q.multi_select, q.options.map((o) => o.label)]), answer.answers.map((a) => [[...a.selected].sort(), a.text ?? null])]);
  return createHash('sha256').update(body).digest('hex').slice(0, 16);
}

/**
 * How long an allowed permission waits before it is sent: the hook that opened the card may land before
 * Claude Code has drawn its dialog, and the answer path's live screen check would then take the card for a
 * stale one and close it. The pause, the project and the tag are read again after it.
 */
export const PERMISSION_SETTLE_MS = 3_000;
const HOUR_MS = 60 * 60_000;

export interface AnswerDeps {
  repos: Repositories;
  /** The chat's waker (app.ts); left out, step 3 is skipped and an unanswered question escalates. */
  waker?: Waker;
  log?: Log;
  /** The clock (tests). */
  now?: () => Date;
  /** How an allowed permission is sent (tests). Default: the chat's own answer path, `answerTabQuestion`. */
  sendAnswer?: typeof answerTabQuestion;
  /** The pause before an allowed permission is sent (tests). */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Hands the run to the person (spec §9.3, TER-888): the run waits with `reason` (its `max_parallel` slot is
 * free, `SLOT_FREE_REASONS`), the `escalated` event is recorded (the feed, and the push), and the project
 * chat gets the line — on the question card when there is one. Answering the card, or acting in the tab,
 * sets the run back to `running` (the follower). A run another instance took over or that already ended is
 * left alone. Never throws.
 */
export async function escalate(deps: AnswerDeps, run: AutomationRun, reason: string): Promise<boolean> {
  return wakeOrEscalate(deps.repos, run, reason, deps.log ?? noopLog);
}

/**
 * What became of a question of an automatic tab (spec D18): a memory repeat already counting down, the
 * recommended option scheduled, the chat woken, or the run escalated to the person. `closed`: the card
 * moved on meanwhile (answered in the tab, a newer question) and nothing was done.
 */
export type AnswerOutcome = 'repeat' | 'recommended' | 'woken' | 'escalated' | 'closed' | 'left';

/**
 * The option the agent marked "(Recomendado)" / "(Recommended)" (parsed into `option.recommended`), as its
 * label — only on a card with a single question and exactly one marked option. Null otherwise.
 */
export function recommendedOption(payload: ChoicePayload): string | null {
  if (payload.questions.length !== 1) return null;
  const marked = payload.questions[0]!.options.filter((o) => o.recommended === true);
  return marked.length === 1 ? marked[0]!.label : null;
}

/** Whether the run used up its automatic answers of the last hour (AUTOMATION_ANSWERS_MAX_PER_HOUR). */
async function capReached(deps: AnswerDeps, run: AutomationRun): Promise<boolean> {
  const since = new Date((deps.now?.() ?? new Date()).getTime() - HOUR_MS);
  return (await deps.repos.automationEvents.countForRun(run.id, 'question_answered', since)) >= AUTOMATION_ANSWERS_MAX_PER_HOUR;
}

/** Whether this question was already answered this way `ANSWER_CYCLE_MAX` times by the run in the last hour. */
async function cycleReached(deps: AnswerDeps, run: AutomationRun, hash: string): Promise<boolean> {
  const since = new Date((deps.now?.() ?? new Date()).getTime() - HOUR_MS);
  const payloads = await deps.repos.automationEvents.payloadsForRun(run.id, 'question_answered', since);
  return payloads.filter((p) => p.cycle === hash).length >= ANSWER_CYCLE_MAX;
}

/** The card as the database has it now: closed, counting down (someone scheduled first), or still waiting. */
async function cardNow(repos: Repositories, q: TabQuestionRow): Promise<'closed' | 'counting' | 'open'> {
  const open = await repos.tabQuestions.findOpenForTab(q.tab_id);
  if (open?.id !== q.id) return 'closed';
  const status = open.auto_answer?.status;
  return status === 'scheduled' || status === 'sent' ? 'counting' : 'open';
}

/**
 * A `choice` card opened in a tab with a live automatic run (spec §9.1, D18), in order:
 *
 * 1. a countdown the memory repeat already scheduled (`maybeScheduleRepeat`) → `'repeat'`;
 * 2. a single-question card with exactly one option the agent marked recommended, when the keyword block
 *    (`memory/blocklist.ts`) does not fire on the card or that option → a countdown with `by:
 *    'automation'` and the usual delay (the person can still cancel it) → `'recommended'`;
 * 3. the chat woken for it (`automatic: true`: no "Responder sozinho", the automation's own budget) →
 *    `'woken'` — an answer it schedules goes through the same countdown; a card it leaves alone is
 *    escalated by the follower after QUESTION_WAIT_MS;
 * 4. otherwise (no budget, no host, the wake failed) the run waits for the person → `'escalated'` (`'left'`
 *    when the run was already parked for this reason, or another instance holds it: no new escalation).
 *
 * Past AUTOMATION_ANSWERS_MAX_PER_HOUR answers of the run in the last hour, paths 1 and 2 are skipped (a
 * running repeat countdown is cancelled) and the run is escalated (`answer_cap`).
 *
 * Paths 1 and 2 record `question_answered`, path 4 `escalated`. The caller checked the run is live
 * (`automaticRunOfTab`); the sender checks again before anything is typed (D24). Logs ids only.
 */
export async function automationAnswer(deps: AnswerDeps, q: TabQuestionRow, run: AutomationRun): Promise<AnswerOutcome> {
  const { repos } = deps;
  const log = deps.log ?? noopLog;
  if (q.kind !== 'choice' || q.status !== 'open') return 'closed';
  const answered = async (via: 'repeat' | 'recommended', cycle: string | null = null) => {
    await recordEvent(repos, { project_id: run.project_id, task_id: run.task_id, run_id: run.id, kind: 'question_answered', payload: { via, tab_id: q.tab_id, question_id: q.id, ...(cycle ? { cycle } : {}) } }).catch(() =>
      log.warn({ runId: run.id, tabQuestionId: q.id }, 'automation: question_answered not recorded'),
    );
    log.info({ runId: run.id, tabQuestionId: q.id, via }, 'automation: question answered');
  };

  // past a cap, a countdown already running is stopped and the person answers
  const stop = async (reason: string, why: string): Promise<AnswerOutcome> => {
    if (q.auto_answer?.status === 'scheduled') {
      const cancelled = await repos.tabQuestions.cancelAutoAnswer(q.id, q.user_id);
      if (cancelled) await publishTabQuestions(repos, 'tab_question', [cancelled], { update: true });
    }
    log.info({ runId: run.id, tabQuestionId: q.id }, why);
    return (await escalate(deps, run, reason)) ? 'escalated' : 'left';
  };
  if (await capReached(deps, run)) return stop(ANSWER_CAP, 'automation: answer cap reached');

  const payload = q.payload as ChoicePayload;
  // what would be sent (a memory repeat's answer, or else the recommendation), for the cycle detector
  const label = recommendedOption(payload);
  const recommendedAnswer: ChoiceAnswer | null = label === null ? null : { answers: [{ selected: [payload.questions[0]!.options.findIndex((o) => o.recommended === true)] }] };
  const planned = q.auto_answer?.status === 'scheduled' || q.auto_answer?.status === 'sent' ? q.auto_answer.answer : recommendedAnswer;
  const cycle = planned ? questionCycleHash(payload, planned) : null;
  if (cycle && (await cycleReached(deps, run, cycle))) return stop(ANSWER_CYCLE, 'automation: answer cycle');

  // 1. memory first
  const counting = q.auto_answer?.status;
  if (counting === 'scheduled' || counting === 'sent') {
    await answered('repeat', cycle);
    return 'repeat';
  }

  // 2. the agent's own recommendation, never past the keyword block
  if (label !== null && recommendedAnswer) {
    const answer = recommendedAnswer;
    if (checkChoiceAnswer(payload, answer) === null && !autoAnswerBlocked(blocklistParts(payload, answer))) {
      if (await scheduleAutoAnswer(repos, { row: q, answer, by: 'automation', reason: RECOMMENDED_REASON, sources: [] })) {
        await answered('recommended', cycle);
        return 'recommended';
      }
      const now = await cardNow(repos, q);
      if (now === 'closed') return 'closed';
      if (now === 'counting') {
        await answered('repeat');
        return 'repeat';
      }
    }
  }

  // 3. wake the chat
  const tab = await repos.tabs.findById(q.tab_id);
  // the waker never throws by contract; a failure is the same as no wake
  const woken = deps.waker ? await deps.waker.wake(q, tab?.name ?? null, { automatic: true }).catch(() => false) : false;
  if (woken) {
    log.info({ runId: run.id, tabQuestionId: q.id }, 'automation: chat woken for a question');
    return 'woken';
  }

  // 4. the person — unless the card moved on, or something scheduled an answer meanwhile
  const now = await cardNow(repos, q);
  if (now === 'closed') return 'closed';
  if (now === 'counting') {
    await answered('repeat');
    return 'repeat';
  }
  return (await escalate(deps, run, QUESTION_UNANSWERED)) ? 'escalated' : 'left';
}

/**
 * A question (choice or permission) in a tab with a live automatic run that got no card (the owner has no active chat
 * conversation for the project — never created, or archived): nothing can answer it and the person cannot
 * see it, so the run waits for them and is escalated. The follower then never types into the tab — a
 * resume typed into Claude's picker would answer the question blindly, past the keyword block (review I1). A
 * permission parks as `permission_needed`, a choice as `question_unanswered`.
 */
export async function questionWithoutCard(repos: Repositories, run: AutomationRun, log: Log = noopLog, kind: 'choice' | 'permission' = 'choice'): Promise<void> {
  log.info({ runId: run.id, tabId: run.tab_id, kind }, 'automation: question with no card');
  await escalate({ repos, log }, run, kind === 'permission' ? PERMISSION_NEEDED : QUESTION_UNANSWERED);
}

// ---------------------------------------------------------------------------------------------------------
// Permission requests (spec D19, §9.2, preflight F-6)
// ---------------------------------------------------------------------------------------------------------

/** What a permission request asks for: the tool, and for `Bash` the command when it is known. */
export interface PermissionRequest {
  tool: string;
  command: string | null;
}

/**
 * Shell operators that chain, substitute or redirect: a command holding any of them is never matched
 * against a rule (`Bash(npm test:*)` must not allow `npm test && curl … | sh`). Crude on purpose: a quoted
 * `|` in a commit message escalates too, which is the safe direction.
 */
const SHELL_OPERATORS = /[;&|`<>\n\r]|\$\(/;

/** A token without the quotes around it, and a path reduced to its last part (`/bin/rm` → `rm`). */
const bare = (token: string) => token.replace(/^['"]+|['"]+$/g, '');
const base = (token: string) => bare(token).split('/').pop() ?? '';

/** git's global options that take their value in the next token (`git -C <path> push`). */
const GIT_OPTION_WITH_VALUE = new Set(['-C', '--git-dir', '--work-tree', '--namespace', '--super-prefix']);
/** `git push` options that are never sent automatically: force, delete, every ref at once, a remote program. */
const PUSH_REFUSED_OPTION = /^--(force|mirror|all|tags|delete|prune|receive-pack|exec)(=|$)|^--force-/;

/**
 * Whether a `git … push …` is refused: any force flag (`-f` in a group too), a delete, every ref at once, a
 * remote program, or anything but one refspec to `origin` naming the run's own branch — `<branch>`,
 * `HEAD:<branch>` or `HEAD:refs/heads/<branch>` (TER-968, R5: an automatic tab pushes only its own branch;
 * a bare `HEAD` or no refspec depends on what is checked out, so it is refused too). git's config
 * injection (`-c`, `--config-env`, `--exec-path`) is refused whatever the subcommand: it can turn any git
 * line into a push.
 */
function refusedGit(tokens: string[], branch: string | null): boolean {
  let i = 1;
  for (; i < tokens.length; i++) {
    const t = bare(tokens[i]!);
    if (t === '-c' || t.startsWith('-c') || t.startsWith('--config-env') || t.startsWith('--exec-path')) return true;
    if (GIT_OPTION_WITH_VALUE.has(t)) {
      i++;
      continue;
    }
    if (!t.startsWith('-')) break;
  }
  if (bare(tokens[i] ?? '') !== 'push') return false;
  const positional: string[] = [];
  for (const raw of tokens.slice(i + 1)) {
    const t = bare(raw);
    if (t.startsWith('--')) {
      if (PUSH_REFUSED_OPTION.test(t)) return true;
    } else if (t.startsWith('-')) {
      // a group of short flags: -f (force) and -d (delete) anywhere in it
      if (/[fd]/.test(t.slice(1))) return true;
    } else positional.push(t);
  }
  // the first positional is the remote; the one other is the refspec
  const [remote, ...refs] = positional;
  if (!branch || remote !== 'origin' || refs.length !== 1) return true;
  return ![branch, `HEAD:${branch}`, `HEAD:refs/heads/${branch}`].includes(refs[0]!);
}

/**
 * Whether a shell command is refused at every autonomy level, whatever the allow list says (preflight F-6):
 * `gh pr merge` (merging is the server's job, D5), a force push or a push to anything but the run's own
 * branch, publishing (`npm publish`, `npm run release*`, `eas`), a recursive `rm`, and removing or stopping
 * containers (this host may be production). Read token by token, at any position, so a prefix (`env`,
 * `npx`, a path) does not hide it. Shell operators are checked by the caller before this.
 */
export function refusedCommand(command: string, branch: string | null): boolean {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    const t = base(tokens[i]!);
    const rest = tokens.slice(i + 1).map(bare);
    if (t === 'gh' && rest.some((r, j) => r === 'pr' && rest[j + 1] === 'merge')) return true;
    if (t === 'git' && refusedGit(tokens.slice(i), branch)) return true;
    if ((t === 'npm' || t === 'pnpm' || t === 'yarn') && rest.includes('publish')) return true;
    if ((t === 'npm' || t === 'pnpm' || t === 'yarn') && rest.some((r, j) => (r === 'run' || r === 'run-script') && (rest[j + 1] ?? '').startsWith('release'))) return true;
    if (t === 'eas' || t === 'eas-cli') return true;
    if (t === 'rm' && rest.some((r) => r === '--recursive' || (/^-[a-zA-Z]+$/.test(r) && /[rR]/.test(r)))) return true;
    if ((t === 'docker' || t === 'podman' || t === 'nerdctl') && rest.some((r) => ['rm', 'rmi', 'stop', 'kill', 'prune', 'down'].includes(r))) return true;
  }
  return false;
}

/** One rule of Claude Code's `--allowedTools` syntax: `Tool`, `Tool(exact)` or `Tool(prefix:*)`. */
function parseRule(rule: string): { tool: string; spec: string | null } | null {
  const m = /^([^()\s]+)(?:\(([\s\S]*)\))?$/.exec(rule.trim());
  return m ? { tool: m[1]!, spec: m[2] ?? null } : null;
}

const squashSpaces = (s: string) => s.trim().replace(/[ \t]+/g, ' ');

/** A Bash rule's specifier against a command: `prefix:*` on a word boundary, anything else exactly. */
function bashSpecMatches(spec: string, command: string): boolean {
  if (spec.endsWith(':*')) {
    const prefix = squashSpaces(spec.slice(0, -2));
    if (prefix === '' || prefix.includes('*')) return false;
    return command === prefix || command.startsWith(`${prefix} `);
  }
  const exact = squashSpaces(spec);
  return !exact.includes('*') && command === exact;
}

/** A deny rule's Bash pattern as a regex, with Claude Code's wildcard rules: `*` anywhere, `X:*` = `X *`, and a lone trailing ` *` also matching the bare `X`. */
function denyPattern(spec: string): RegExp {
  const glob = squashSpaces(spec.endsWith(':*') ? `${spec.slice(0, -2)} *` : spec);
  const escape = (t: string) => t.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  const lone = glob.endsWith(' *') && !glob.slice(0, -2).includes('*');
  return new RegExp(lone ? `^${escape(glob.slice(0, -2))}(?: .*)?$` : `^${escape(glob)}$`);
}

/** Tools whose input is a file path: Claude Code checks them against `Read`/`Edit` path rules (a Read deny also blocks Edit and Write). */
const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/**
 * Whether the fixed deny list (`AUTOMATION_DENIED_TOOLS`, TER-968 R5) covers a request. A Bash rule is
 * tried on the command from every token on (a prefix — `env X=1`, `npx`, a path — does not hide it, the
 * program's path reduced to its name). A path rule (`Read(~/.ssh/**)`) cannot be checked without the path,
 * which the request does not carry: every file tool request is then taken as covered, the safe direction.
 */
function deniedByList(tool: string, command: string | null): boolean {
  return AUTOMATION_DENIED_TOOLS.some((raw) => {
    const rule = parseRule(raw);
    if (!rule) return false;
    if (rule.tool === 'Read' || rule.tool === 'Edit') return FILE_TOOLS.has(tool);
    if (rule.tool !== tool) return false;
    if (rule.spec === null) return true;
    if (tool !== 'Bash' || command === null) return true;
    const re = denyPattern(rule.spec);
    const tokens = command.split(' ');
    return tokens.some((_, i) => re.test([base(tokens[i]!), ...tokens.slice(i + 1)].join(' ')));
  });
}

/**
 * Whether a permission request of an automatic tab may be answered "allow" (spec D19, §9.2), checked in
 * this order — anything not allowed is escalated to the person, never denied:
 *
 * 1. the keyword block (`memory/blocklist.ts`) on the tool's name and the command: never;
 * 2. for `Bash`: a command that is unknown, holds a shell operator (`; & | \` $( > <` or a line break), or
 *    is refused at every level (`refusedCommand`, the run's `branch` for pushes): never;
 * 3. the fixed deny list (`AUTOMATION_DENIED_TOOLS`, TER-968 R5), the same one the tab was started with as
 *    `--disallowedTools`: never, whatever `allowed` says;
 * 4. a rule of `allowed` (Claude Code's syntax; one too broad for an automatic tab, `unsafeAllowedTool`, is
 *    dropped, as on the tab's line) or of the run's own branch rules (`runBranchRules`: its pushes and its fetch) for
 *    this tool: a bare `Tool`, or for `Bash` a `Bash(prefix:*)` matching on a word boundary or a
 *    `Bash(exact)` matching exactly. A specifier on any other tool never matches: its input is not known here.
 *
 * The same at every autonomy level, on purpose: merging, deploying and publishing are the server's own
 * steps (D5), never a permission answered in a tab — so the level is not an input.
 */
export function permissionAllowed(req: PermissionRequest, allowed: string[], branch: string | null = null): boolean {
  if (autoAnswerBlocked([req.tool, req.command ?? ''])) return false;
  const isBash = req.tool === 'Bash';
  let command: string | null = null;
  if (isBash) {
    if (req.command === null || SHELL_OPERATORS.test(req.command)) return false;
    command = squashSpaces(req.command);
    if (command === '' || refusedCommand(command, branch)) return false;
  }
  if (deniedByList(req.tool, command)) return false;
  return [...safeAllowedTools(allowed).kept, ...runBranchRules(branch)].some((raw) => {
    const rule = parseRule(raw);
    if (!rule || rule.tool !== req.tool) return false;
    if (rule.spec === null) return true;
    return isBash && command !== null && bashSpecMatches(rule.spec, command);
  });
}

/** The answer path logs `(object, message)` only, the one form this module's logger has. */
type AnswerPathLog = Parameters<typeof answerTabQuestion>[3]['log'];

/** `left`: nothing was done and no new escalation was recorded — the card is the person's, pushed as any other. */
export type PermissionOutcome = 'allowed' | 'escalated' | 'closed' | 'left';

/** A tool name as Claude Code writes it (`Bash`, `WebFetch`, `mcp__server__tool`); anything else escalates. */
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;

/**
 * A `permission` card opened in a tab with a live automatic run (spec §9.2). The request is matched against
 * the allow list stored on the run (falling back to the project's setup, `runPermission`) by
 * `permissionAllowed`; a card whose tool name is not a plain tool name escalates at once. Not allowed, or past the hourly cap of automatic answers, the run
 * waits for the person (`permission_needed` / `answer_cap`) → `'escalated'`.
 *
 * Allowed: after PERMISSION_SETTLE_MS, right before sending, the tab's run is read again — still this run, its project on and not
 * paused (D24), its card still tagged — and when anything changed nothing is sent and the card is left to
 * the person (`'left'`, the run untouched: the follower deals with an untagged card or a pause; the card is
 * pushed as any other).
 * Then "allow" (once) goes through the chat's ordinary answer path as the project's owner with `via:
 * 'automation'`: every check of a click (live screen, claim), plus the dialog's tool positively identified
 * on that same screen read and equal to the card's (`permissionToolOnScreen`, review I1) → `'allowed'`,
 * stored as `answered_via: 'automation'` and recorded as `question_answered` (`via: 'permission'`). A
 * send that fails escalates, unless the card moved on meanwhile (`'closed'`). Only "allow" is ever sent.
 *
 * `command` is the Bash command when the caller knows it. The machine's hook script forwards the tool's
 * name only (spec 2026-09-25 tab questions §4.1), so today it is null and every Bash request escalates.
 * Logs ids only, never the command.
 */
export async function answerPermissionAutomatically(deps: AnswerDeps, q: TabQuestionRow, run: AutomationRun, command: string | null = null): Promise<PermissionOutcome> {
  const { repos } = deps;
  const log = deps.log ?? noopLog;
  if (q.kind !== 'permission' || q.status !== 'open') return 'closed';
  const handOver = async (reason: string): Promise<PermissionOutcome> => ((await escalate(deps, run, reason)) ? 'escalated' : 'left');

  if (await capReached(deps, run)) {
    log.info({ runId: run.id, tabQuestionId: q.id }, 'automation: answer cap reached');
    return handOver(ANSWER_CAP);
  }
  const tool: unknown = (q.payload as Partial<PermissionPayload> | null)?.tool_name;
  if (typeof tool !== 'string' || !TOOL_NAME.test(tool)) {
    log.info({ runId: run.id, tabQuestionId: q.id }, 'automation: permission with no plain tool name');
    return handOver(PERMISSION_NEEDED);
  }
  const { allowedTools } = await runPermission(repos, run);
  if (!permissionAllowed({ tool, command }, allowedTools, run.branch)) {
    log.info({ runId: run.id, tabQuestionId: q.id }, 'automation: permission outside the rules');
    return handOver(PERMISSION_NEEDED);
  }

  await (deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))))(PERMISSION_SETTLE_MS);
  // right before sending: the pause, the project's switch, the run and the card's tag, read again
  const live = await automaticRunOfTab(repos, q.tab_id).catch(() => null);
  const task = live?.id === run.id && run.task_id ? await repos.tasks.findById(run.task_id) : undefined;
  const owner = task?.auto ? await repos.projects.findById(run.project_id).then((p) => (p?.owner_id ? repos.users.findById(p.owner_id) : undefined)) : undefined;
  if (!owner) {
    log.info({ runId: run.id, tabQuestionId: q.id }, 'automation: permission left to the person (paused, untagged or run changed)');
    return 'left';
  }

  try {
    await (deps.sendAnswer ?? answerTabQuestion)(controlContextFor(repos, owner), q.id, { allow: true }, { log: log as unknown as AnswerPathLog, embedder: null, via: 'automation' });
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    log.warn({ runId: run.id, tabQuestionId: q.id, code: typeof code === 'string' ? code.slice(0, 64) : 'SEND_FAILED' }, 'automation: permission answer failed');
    if ((await cardNow(repos, q)) === 'closed') return 'closed';
    return handOver(PERMISSION_NEEDED);
  }
  await recordEvent(repos, { project_id: run.project_id, task_id: run.task_id, run_id: run.id, kind: 'question_answered', payload: { via: 'permission', tab_id: q.tab_id, question_id: q.id } }).catch(() =>
    log.warn({ runId: run.id, tabQuestionId: q.id }, 'automation: question_answered not recorded'),
  );
  log.info({ runId: run.id, tabQuestionId: q.id }, 'automation: permission allowed');
  return 'allowed';
}
