import { z } from 'zod';
import { isClaudeSessionId, isClaudeTranscriptPath } from '@termhub/machine-ops';
import { parseAskUserQuestion, parsePermissionTool, toolUseIdOf, type TabQuestionInput } from '../chat/tab-question-payload.js';
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
   * A question the tab put to the person (spec 2026-09-25 §4.2): an `AskUserQuestion` card or a
   * permission prompt. For the tab-question service only — never stored on the tab nor its events.
   */
  question?: TabQuestionInput;
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
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const cap = (v: string | null): string | null => (v && v.length > STATE_TEXT_MAX ? `${v.slice(0, STATE_TEXT_MAX - 1)}…` : v);

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
    case 'Stop':
      // A finished turn is the tool waiting for the person (same as Codex); the idle_prompt
      // notification only comes about a minute later. The last answer, when sent, is the question.
      return { kind: 'waiting_input', text: cap(str(ev.last_assistant_message)), meta: { event: name } };
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
    default:
      return null;
  }
}

/**
 * A subagent's event (spec 2026-09-26 §4.5): the hook script flags the reduced PreToolUse / PermissionRequest
 * bodies (`subagent: true`), and an AskUserQuestion, which travels whole, carries its own `agent_id`. Only
 * the boolean true and a non-blank string count: an old script sends neither and keeps today's behaviour.
 */
const isSubagent = (ev: Record<string, unknown>): boolean => ev.subagent === true || str(ev.agent_id) !== null;

function interpretClaude(ev: Record<string, unknown>): Interpreted | null {
  const out = interpretClaudeEvent(ev);
  return out && isSubagent(ev) ? { ...out, meta: { ...out.meta, subagent: true } } : out;
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
 * Codex CLI `notify` payload (argv JSON): `{ type: "agent-turn-complete", "last-assistant-message": ... }`.
 * Codex has no idle/permission notification, so a finished turn is its "needs you" signal:
 * the last assistant message is the question the person has to answer.
 */
function interpretCodex(ev: Record<string, unknown>): Interpreted | null {
  const type = str(ev.type);
  if (type === 'agent-turn-complete' && !isTitleTurn(ev)) {
    return { kind: 'waiting_input', text: cap(str(ev['last-assistant-message'])), meta: { event: type } };
  }
  return null;
}

/**
 * Cursor CLI hook payloads (stdin JSON, `hook_event_name` in camelCase). A turn is
 * `beforeSubmitPrompt` → `afterAgentResponse` (the whole answer, once, at the end) → `stop`
 * (`completed`); an Esc sends `stop` with `error` and `aborted` and no answer. Cursor has no hook
 * for "waiting for your approval": the `before*` hooks fire for every command, approved or not,
 * so a permission prompt cannot be told apart and is left out.
 */
function interpretCursor(ev: Record<string, unknown>): Interpreted | null {
  const name = str(ev.hook_event_name);
  switch (name) {
    case 'sessionStart':
    case 'beforeSubmitPrompt':
      // the prompt is the user's content: only the fact that it is busy is kept
      return { kind: 'working', text: null, meta: { event: name } };
    case 'afterAgentResponse':
      // Same wait as `stop`: when stop arrived first (inverted race) and the person already saw
      // the tab, this must carry the seen mark and only fill in the answer — not open a second alert.
      // From `working` it is still a new wait (`continuesWait` only continues an open waiting_input).
      return { kind: 'waiting_input', text: cap(str(ev.text)), meta: { event: name }, continuesWait: true };
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

/** States in which the tool is waiting for the person (the "needs you" list). */
export const NEEDS_YOU: readonly TabState[] = ['waiting_input', 'waiting_permission'];

/**
 * A tab "needs you" when it is waiting and has not been seen since that state began: a new hook
 * event bumps `state_at`, so an already-seen tab needs you again automatically.
 */
export function needsYou(tab: Pick<Tab, 'state' | 'state_at' | 'state_seen_at'>): boolean {
  if (!tab.state || !NEEDS_YOU.includes(tab.state) || !tab.state_at) return false;
  return !tab.state_seen_at || tab.state_seen_at < tab.state_at;
}
