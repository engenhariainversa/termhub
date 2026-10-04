import { z } from 'zod';
import { isClaudeSessionId, isClaudeTranscriptPath } from '@termhub/machine-ops';
import { QUESTION_MAX, parseAskUserQuestion, parseCodexUserInput, parsePermissionTool, sliceUnits, toolUseIdOf, type TabQuestionInput } from '../chat/tab-question-payload.js';
import type { Tab, TabActivity, TabState } from '../db/repositories/types.js';
import { activityOf } from './activity.js';

/** Tools whose hooks we understand (the hook script names itself). */
export const HOOK_TOOLS = ['claude', 'codex', 'cursor'] as const;
export type HookTool = (typeof HOOK_TOOLS)[number];

/** The tool's own message (question, permission prompt, last answer) is kept, capped; nothing else. */
export const STATE_TEXT_MAX = 2000;

export interface Interpreted {
  kind: TabState;
  text: string | null;
  meta: Record<string, unknown>;
  /** only for events that say which tool the agent is about to call */
  activity?: TabActivity;
  /** Claude Code's spinner verb ("Moonwalking"), with `activity`; null when none was sent or it was not a plain word */
  verb?: string | null;
  /**
   * The event is a late echo of the wait already open, not a new one: a person who saw that wait
   * must not be alerted again, and one with no text of its own keeps the wait's text. Only the
   * tool's interpreter can tell — Claude's idle_prompt follows its own Stop, Cursor's stop follows
   * its answer, while every Codex turn ends the same way with no working state in between.
   */
  continuesWait?: true;
  /**
   * Only for an event that `continuesWait`: this one's own text is not the answer, it is the same
   * generic reminder every time (Claude's idle_prompt) — so the wait's current text (the Stop's
   * `last_assistant_message`) is kept over it. Absent (or false) for a continuation that brings a
   * fresh answer of its own (Cursor's `afterAgentResponse`), which must replace a stale one.
   */
  keepsWaitText?: true;
  /**
   * Only on a Claude `Stop`, only when > 0: how many of its `background_tasks` still run (a `Monitor`, a
   * `run_in_background` shell). The tab is not blocked — the next task notification wakes it — so no suggestion
   * card opens for this Stop (spec 2026-09-26 TER-203 §3). The count is all that leaves the payload.
   */
  backgroundTasks?: number;
  /**
   * A question the tab put to the person (spec 2026-09-25 §4.2): an `AskUserQuestion` card or a
   * permission prompt. For the tab-question service only — never stored on the tab nor its events.
   */
  question?: TabQuestionInput;
  /**
   * The final message of the agent's last turn, whole (cut at LAST_ANSWER_MAX), when the event
   * carries one. Stored apart from `text`, which stays capped for the UI (spec 2026-09-30 last answer).
   */
  answer?: string;
  /**
   * The event says nothing about the tab's state: it only runs the card bookkeeping (Claude's
   * `SubagentStop`, which closes that subagent's card; spec 2026-09-30 tab questions per subagent).
   * The ingest records nothing for it.
   */
  closeOnly?: true;
}

/**
 * The spinner verb the hook script extracts from the pane: one word of 2 to 24 ASCII letters —
 * the same pattern the script (@termhub/machine-ops HOOK_SCRIPT) applies, checked again here
 * because the endpoint is reachable by anything holding a machine's hook token.
 */
export const SPINNER_VERB = z.string().regex(/^[A-Za-z]{2,24}$/);
const verbOf = (v: unknown): string | null => {
  const r = SPINNER_VERB.safeParse(v);
  return r.success ? r.data : null;
};

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
/**
 * A payload string, trimmed, or null when blank. Null characters are dropped first: Postgres rejects
 * them in `text` and `jsonb`, and one in an answer, a text or a meta value would fail the whole event
 * (the tab would stay `working`). Every string read from a payload goes through here, so the whole
 * answer, the capped text and meta are all clean.
 */
const str = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const s = v.replaceAll('\u0000', '').trim();
  return s ? s : null;
};
const cap = (v: string | null): string | null => (v && v.length > STATE_TEXT_MAX ? `${v.slice(0, STATE_TEXT_MAX - 1)}…` : v);

/** The most of an agent's answer that is kept whole (spec 2026-09-30 last answer): the hook body is
 *  capped at 256 KB, and a hundred thousand characters is a long answer. */
export const LAST_ANSWER_MAX = 100_000;
const whole = (v: string | null): string | undefined => (v === null ? undefined : v.length > LAST_ANSWER_MAX ? `${v.slice(0, LAST_ANSWER_MAX - 1)}…` : v);
/** `out` with the event's whole answer, when it has one (`asSubagent` takes it off a subagent's event). */
const withAnswer = (out: Interpreted, raw: string | null): Interpreted => {
  const a = whole(raw);
  return a === undefined ? out : { ...out, answer: a };
};

export const RATE_LIMIT_TEXT = 'Limite de uso da conta atingido';
/** Claude Code's StopFailure matcher values (hooks docs); anything else is reported as "unknown". */
const CLAUDE_API_ERRORS = new Set([
  'rate_limit',
  'overloaded',
  'authentication_failed',
  'oauth_org_not_allowed',
  'account_on_hold',
  'verification_required',
  'billing_error',
  'invalid_request',
  'model_not_found',
  'server_error',
  'max_output_tokens',
  'cloud_credential_error',
  'unknown',
]);

export const isRateLimit = (i: Interpreted | null): boolean => !!i && i.meta.event === 'StopFailure' && i.meta.error === 'rate_limit';

/** The Claude session a hook payload belongs to, when both ids are well-formed (never stored otherwise). */
export function claudeSessionOf(ev: unknown): { session_id: string; transcript_path: string } | null {
  if (!isObj(ev) || !isClaudeSessionId(ev.session_id)) return null;
  const sid = ev.session_id;
  return isClaudeTranscriptPath(ev.transcript_path, sid) ? { session_id: sid, transcript_path: ev.transcript_path } : null;
}

/**
 * How many entries of a Claude `Stop`'s `background_tasks` have `status: "running"` (Claude Code 2.1.283 sends
 * `[{ id, type, status, description, command }]`). Anything else counts as 0. Descriptions and commands are the
 * person's and are never read.
 */
export function runningBackgroundTasks(v: unknown): number {
  return Array.isArray(v) ? v.filter((t) => isObj(t) && t.status === 'running').length : 0;
}

/** Claude Code hook payloads (stdin JSON): https://docs.claude.com/en/docs/claude-code/hooks */
function interpretClaudeEvent(ev: Record<string, unknown>): Interpreted | null {
  const name = str(ev.hook_event_name);
  switch (name) {
    case 'SessionStart':
    case 'UserPromptSubmit':
    case 'PreCompact':
      // the prompt is the user's content: only the fact that it is busy is kept
      return { kind: 'working', text: null, meta: { event: name } };
    case 'PreToolUse': {
      // the script already reduced this event to the tool's name and the spinner's verb; whatever
      // else arrives is ignored, and a verb that is not a plain word is dropped, not the event.
      // The one exception is AskUserQuestion, forwarded whole: its input is the question, written to
      // be shown to the person — parsed into `question`, never into meta or text.
      const tool = str(ev.tool_name);
      const base: Interpreted = { kind: 'working', text: null, activity: activityOf(tool), verb: verbOf(ev.verb), meta: { event: name, tool } };
      if (tool !== 'AskUserQuestion') return base;
      const payload = parseAskUserQuestion(ev.tool_input);
      return payload ? { ...base, question: { kind: 'choice', payload, tool_use_id: toolUseIdOf(ev.tool_use_id) } } : base;
    }
    case 'PermissionRequest': {
      // Reduced to the tool's name on the machine; its state effect is the permission_prompt
      // notification's, which follows it. AskUserQuestion's own prompt opens nothing: its PreToolUse
      // already carried the question (the current script drops it; this covers anything else).
      // ExitPlanMode's dialog is not a yes/no prompt either (its "1" is "Yes, and use auto mode"),
      // so it opens nothing and stays in the tab.
      const tool = str(ev.tool_name);
      const base: Interpreted = { kind: 'waiting_permission', text: null, meta: { event: name, tool } };
      const payload = tool === 'AskUserQuestion' || tool === 'ExitPlanMode' ? null : parsePermissionTool(tool);
      return payload ? { ...base, question: { kind: 'permission', payload, tool_use_id: null } } : base;
    }
    case 'Notification': {
      const type = str(ev.notification_type);
      const message = cap(str(ev.message));
      if (type === 'permission_prompt') return { kind: 'waiting_permission', text: message, meta: { event: name, type } };
      // idle_prompt comes ~1 min after the Stop of the same turn: the same wait, still unanswered.
      // Its own message is a generic reminder, not an answer, so the wait's text is kept over it.
      if (type === 'idle_prompt') return { kind: 'waiting_input', text: message, meta: { event: name, type }, continuesWait: true, keepsWaitText: true };
      if (type === 'elicitation_dialog') return { kind: 'waiting_input', text: message, meta: { event: name, type } };
      return null; // auth_success and friends: nothing the user has to act on
    }
    case 'Stop': {
      // A finished turn is the tool waiting for the person (same as Codex); the idle_prompt
      // notification only comes about a minute later. The last answer, when sent, is the question.
      const raw = str(ev.last_assistant_message);
      const text = cap(raw);
      // A turn that ends with background work still running (a subagent, a `run_in_background` shell, a
      // Monitor) is not a wait for the person: the agent waits on that work, and its notification starts
      // the next turn (TER-644). The next Stop with nothing left running is the real end of the work.
      const background = runningBackgroundTasks(ev.background_tasks);
      if (background === 0) return withAnswer({ kind: 'waiting_input', text, meta: { event: name } }, raw);
      return withAnswer({ kind: 'waiting_background', text, meta: { event: name, background_tasks: background }, backgroundTasks: background }, raw);
    }
    case 'StopFailure': {
      // An API error ended the turn (spec 2026-09-26 account swap). On a usage limit Claude Code does
      // not exit: it waits for the reset, so the tab waits for the person (or the automatic swap).
      const raw = str(ev.error);
      const error = raw && CLAUDE_API_ERRORS.has(raw) ? raw : 'unknown';
      if (error === 'rate_limit') {
        const line = str(ev.last_assistant_message);
        return { kind: 'waiting_input', text: cap(line ? `${RATE_LIMIT_TEXT} — ${line}` : RATE_LIMIT_TEXT), meta: { event: name, error } };
      }
      return { kind: 'error', text: `Erro da API do Claude (${error})`, meta: { event: name, error } };
    }
    case 'SessionEnd':
      return { kind: 'idle', text: null, meta: { event: name, reason: str(ev.reason) } };
    case 'SubagentStop':
      // Reduced to the subagent's id on the machine. No state: the tab is wherever its main thread is.
      return agentIdOf(ev) === null ? null : { kind: 'working', text: null, meta: { event: name }, closeOnly: true };
    default:
      return null;
  }
}

/**
 * A subagent's event (spec 2026-09-26 §4.5): the hook script flags the reduced PreToolUse / PermissionRequest
 * bodies (`subagent: true`), and an AskUserQuestion, which travels whole, carries its own `agent_id` (so does
 * a Codex PermissionRequest, also whole; Codex's reduced tool events carry the flag the same way). Only
 * the boolean true and a non-blank string count: an old script sends neither and keeps today's behaviour.
 * Claude's events also carry the subagent's id in `meta.agent_id` when it passes `AGENT_ID` (spec
 * 2026-09-30 tab questions per subagent); Codex's never do.
 */
const isSubagent = (ev: Record<string, unknown>): boolean => ev.subagent === true || str(ev.agent_id) !== null;

/** A subagent's event, flagged in meta and without an answer: a subagent's `Stop` never writes the turn's answer. */
const asSubagent = (out: Interpreted): Interpreted => {
  const { answer: _answer, ...rest } = out;
  return { ...rest, meta: { ...out.meta, subagent: true } };
};

/** A subagent's id as the hook script forwards it, checked again here, as it came (never trimmed). */
const AGENT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const agentIdOf = (ev: Record<string, unknown>): string | null => (typeof ev.agent_id === 'string' && AGENT_ID.test(ev.agent_id) ? ev.agent_id : null);

function interpretClaude(ev: Record<string, unknown>): Interpreted | null {
  const out = interpretClaudeEvent(ev);
  if (!out || !isSubagent(ev)) return out;
  const sub = asSubagent(out);
  const id = agentIdOf(ev);
  return id === null ? sub : { ...sub, meta: { ...sub.meta, agent_id: id } };
}

/** How Codex's own naming prompt begins; the person's request is appended after it. */
const CODEX_TITLE_PROMPT = 'Generate a concise, single-line task title';

/**
 * On a conversation's first turn the Codex TUI runs a second turn on a side thread to name it, and
 * `notify` fires for that one too, in the same second: its only input is Codex's naming prompt and
 * its answer is `{"title": "…"}`. Recording it would alert twice for one turn and replace the real
 * answer with the title. Both signals are required: a person can ask for a title-shaped JSON, and
 * dropping that answer would hide that Codex finished; if Codex ever rewords the prompt, the title
 * turn gets through again — a duplicate alert, never a missed one.
 */
function isTitleTurn(ev: Record<string, unknown>): boolean {
  const input = ev['input-messages'];
  if (!Array.isArray(input) || input.length !== 1 || typeof input[0] !== 'string' || !input[0].startsWith(CODEX_TITLE_PROMPT)) return false;
  const answer = str(ev['last-assistant-message']);
  if (!answer?.startsWith('{')) return false;
  try {
    const parsed: unknown = JSON.parse(answer);
    return isObj(parsed) && Object.keys(parsed).length === 1 && typeof parsed.title === 'string';
  } catch {
    return false;
  }
}

/**
 * Codex CLI hook payloads (stdin JSON, Claude-shaped, spec 2026-09-29 codex monitor hooks D3), from
 * `~/.codex/hooks.json`. They run only once the person trusted them in Codex, so a machine may send
 * nothing but `notify` — which keeps working as the end of every turn, as before.
 */
function interpretCodexHook(ev: Record<string, unknown>, name: string): Interpreted | null {
  switch (name) {
    case 'UserPromptSubmit':
      // the prompt is the person's content: only the fact that it is busy is kept
      return { kind: 'working', text: null, meta: { event: name } };
    case 'PreToolUse':
    case 'PostToolUse': {
      // Reduced to the tool's name on the machine. A PostToolUse says the tab works again after an
      // approval or an answered `request_user_input`; one that lands after an Esc is dropped by
      // recordEvent (monitor/wait-decision.ts).
      // The exception is the PreToolUse of `request_user_input` (Codex's AskUserQuestion), forwarded
      // whole: its input is the question and its options, parsed into `question`, never into meta.
      const tool = str(ev.tool_name);
      if (name === 'PreToolUse' && tool === 'request_user_input') {
        const payload = parseCodexUserInput(ev.tool_input);
        if (payload) {
          return {
            kind: 'waiting_input',
            text: cap(payload.questions[0]!.question),
            meta: { event: name, tool },
            question: { kind: 'choice', payload, tool_use_id: toolUseIdOf(ev.tool_use_id) },
          };
        }
      }
      return { kind: 'working', text: null, activity: activityOf(tool), verb: null, meta: { event: name, tool } };
    }
    case 'PermissionRequest': {
      // Travels whole: `tool_input.description` is the question Codex shows above its approval menu,
      // written for the person, so it is the text. Nothing else of `tool_input` is read — the command
      // is the person's and never leaves here. The card carries the description as `question`;
      // answering it types into Codex's own menu (agent: 'codex'), not Claude's dialog layout.
      const description = isObj(ev.tool_input) ? str(ev.tool_input.description) : null;
      // The whole payload is untrusted: only the validated name is kept, in the text and in meta.
      const valid = parsePermissionTool(str(ev.tool_name))?.tool_name ?? null;
      const text = cap(description) ?? (valid ? `O Codex precisa da sua permissão para usar ${valid}` : 'O Codex precisa da sua permissão');
      const base: Interpreted = { kind: 'waiting_permission', text, meta: { event: name, tool: valid } };
      if (!valid) return base;
      const question = description ? sliceUnits(description, QUESTION_MAX) : undefined;
      return { ...base, question: { kind: 'permission', payload: { tool_name: valid, agent: 'codex', ...(question ? { question } : {}) }, tool_use_id: null } };
    }
    case 'Stop': {
      // The same finished turn the `notify` that follows reports: decideWait pairs the two into one wait.
      const raw = str(ev.last_assistant_message);
      return withAnswer({ kind: 'waiting_input', text: cap(raw), meta: { event: name } }, raw);
    }
    case 'Interrupt':
      // An Esc, during a turn or on an approval menu: the turn is over and neither Stop nor notify follows.
      return { kind: 'waiting_input', text: null, meta: { event: name } };
    default:
      return null;
  }
}

/**
 * Codex CLI: its hooks (`hook_event_name`, see `interpretCodexHook`) and its `notify` payload (argv
 * JSON): `{ type: "agent-turn-complete", "last-assistant-message": ... }`. `notify` needs no trust and
 * fires at the end of every turn, so without trusted hooks a finished turn is the only "needs you"
 * signal: the last assistant message is the question the person has to answer. With them, the hooks
 * add working and waiting_permission, and a turn's `Stop` and `notify` count as one wait.
 */
function interpretCodex(ev: Record<string, unknown>): Interpreted | null {
  const name = str(ev.hook_event_name);
  if (name !== null) {
    const out = interpretCodexHook(ev, name);
    return out && isSubagent(ev) ? asSubagent(out) : out;
  }
  const type = str(ev.type);
  if (type === 'agent-turn-complete' && !isTitleTurn(ev)) {
    const raw = str(ev['last-assistant-message']);
    return withAnswer({ kind: 'waiting_input', text: cap(raw), meta: { event: type } }, raw);
  }
  return null;
}

/**
 * Cursor CLI hook payloads (stdin JSON, `hook_event_name` in camelCase). A turn is
 * `beforeSubmitPrompt` → `afterAgentResponse` (the whole answer, once, at the end) → `stop`
 * (`completed`); an Esc sends `stop` with `error` and `aborted` and no answer. Cursor has no hook
 * for "waiting for your approval": the `before*` hooks fire for every command, approved or not,
 * so a permission prompt cannot be told apart and is left out. A session starts idle: only
 * `beforeSubmitPrompt` says a turn is running.
 */
function interpretCursor(ev: Record<string, unknown>): Interpreted | null {
  const name = str(ev.hook_event_name);
  switch (name) {
    case 'sessionStart':
      // Not busy yet: a session nobody prompted would otherwise read as working for ever (Cursor has
      // no idle notification to take it out), holding `wait_for_state` and the agent's own update.
      // One that arrives after its own prompt is dropped by recordEvent (monitor/wait-decision.ts).
      return { kind: 'idle', text: null, meta: { event: name } };
    case 'beforeSubmitPrompt':
      // the prompt is the user's content: only the fact that it is busy is kept
      return { kind: 'working', text: null, meta: { event: name } };
    case 'afterAgentResponse': {
      // Same wait as `stop`: when stop arrived first (inverted race) and the person already saw
      // the tab, this must carry the seen mark and only fill in the answer — not open a second alert.
      // From `working` it is still a new wait (`continuesWait` only continues an open waiting_input).
      const raw = str(ev.text);
      return withAnswer({ kind: 'waiting_input', text: cap(raw), meta: { event: name }, continuesWait: true }, raw);
    }
    case 'stop':
      // Whatever the status (completed, or the error then aborted an Esc sends), the turn ended, so the
      // tab is waiting — always as a continuation: when afterAgentResponse already opened this wait,
      // recordEvent keeps its answer as the text and the seen mark, so nothing alerts twice in one
      // turn; when that POST never arrived (a timed-out curl, a body over the route's limit), this is
      // what takes the tab out of working and tells the person the turn is over.
      return { kind: 'waiting_input', text: null, meta: { event: name, status: str(ev.status) }, continuesWait: true };
    case 'sessionEnd':
      return { kind: 'idle', text: null, meta: { event: name, reason: str(ev.reason) } };
    default:
      return null;
  }
}

const INTERPRETERS: Record<HookTool, (ev: Record<string, unknown>) => Interpreted | null> = {
  claude: interpretClaude,
  codex: interpretCodex,
  cursor: interpretCursor,
};

/**
 * Maps a raw hook payload to a tab state, or null when the event carries nothing worth showing.
 * Pure: the route validates the token and the tab; this only reads the payload.
 */
export function interpretHookEvent(tool: HookTool, raw: unknown): Interpreted | null {
  if (!isObj(raw)) return null;
  return INTERPRETERS[tool](raw);
}

/** States in which the tool is waiting for the person (the "needs you" list). `waiting_background` is not one. */
export const NEEDS_YOU: readonly TabState[] = ['waiting_input', 'waiting_permission'];

/** States in which the agent is still at its task: working, or waiting on background work of its own (TER-644). */
export const STILL_WORKING: readonly TabState[] = ['working', 'waiting_background'];

/**
 * A tab "needs you" when it is waiting and has not been seen since that state began: a new hook
 * event bumps `state_at`, so an already-seen tab needs you again automatically.
 */
export function needsYou(tab: Pick<Tab, 'state' | 'state_at' | 'state_seen_at'>): boolean {
  if (!tab.state || !NEEDS_YOU.includes(tab.state) || !tab.state_at) return false;
  return !tab.state_seen_at || tab.state_seen_at < tab.state_at;
}
