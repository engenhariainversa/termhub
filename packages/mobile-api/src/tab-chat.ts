import { z } from 'zod';
import { tabQuestionSchema, tabSuggestionSchema } from './events.js';
import { progressTabState } from './progress.js';

/**
 * A terminal tab that runs Claude Code, read on the phone as a conversation (spec 2026-10-01 tab chat
 * §5.4, §5.5). The server reads the session's transcript on the machine and relays it; nothing is stored.
 */

/** Why a tab can or cannot be opened as a conversation. On the way in it is read as a plain string
 *  (`tabSummary.availability`, the frames): a value a newer server adds must not break an installed app. */
export const tabChatAvailability = z.enum(['ready', 'no_session', 'unsupported_tool', 'unsupported_machine', 'agent_outdated', 'offline']);
export type TTabChatAvailability = z.infer<typeof tabChatAvailability>;

const itemBase = { id: z.string(), at: z.string() };

export const tabChatItem = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user'), ...itemBase, text: z.string(), images: z.number().int().nonnegative() }),
  z.object({ kind: z.literal('assistant'), ...itemBase, text: z.string() }),
  z.object({ kind: z.literal('tool'), ...itemBase, name: z.string(), summary: z.string().nullable() }),
  z.object({ kind: z.literal('tool_result'), ...itemBase, tool_id: z.string(), error: z.boolean(), preview: z.string().nullable() }),
  z.object({ kind: z.literal('command'), ...itemBase, name: z.string(), args: z.string().nullable() }),
  z.object({ kind: z.literal('command_output'), ...itemBase, text: z.string() }),
  z.object({ kind: z.literal('notice'), ...itemBase, notice: z.enum(['compacted', 'interrupted', 'truncated']) }),
]);
export type TTabChatItem = z.infer<typeof tabChatItem>;

/** Items as the app reads them: an item of a kind this build does not know is dropped, not an error. */
export const tabChatItems = z.array(z.unknown()).transform((rows) =>
  rows.flatMap((r) => {
    const p = tabChatItem.safeParse(r);
    return p.success ? [p.data] : [];
  }),
);

export const tabSummary = z.object({
  id: z.string(),
  name: z.string(),
  project: z.object({ id: z.string(), key: z.string(), name: z.string() }),
  machine: z.object({ id: z.string(), name: z.string() }),
  /**
   * `waiting_background` travels as `working` with `background: true`, `finished` as `idle` with
   * `finished: true`, and the TER-1046 states with their own flags, as in `agentOnCard` (progress.ts).
   */
  state: progressTabState.nullable(),
  background: z.boolean().default(false),
  finished: z.boolean().default(false),
  blocked: z.boolean().default(false),
  auth_required: z.boolean().default(false),
  trust_prompt: z.boolean().default(false),
  state_at: z.string().nullable(),
  needs_you: z.boolean(),
  activity: z.string().nullable(),
  activity_verb: z.string().nullable(),
  /** One of `tabChatAvailability`, read as a plain string (see there). */
  availability: z.string(),
  /** the card ref ("TER-123") of the automatic run working in this tab; null = none (TER-1044, absent from an older server) */
  auto_ref: z.string().nullable().default(null),
});
export type TTabSummary = z.infer<typeof tabSummary>;

export const tabsResponse = z.object({ tabs: z.array(tabSummary) });
export type TTabsResponse = z.infer<typeof tabsResponse>;

export const TAB_MESSAGE_MAX_CHARS = 4000;

export const startSessionBody = z.object({
  project_id: z.string().min(1).max(64),
  machine_id: z.string().min(1).max(64).optional(),
  prompt: z.string().min(1).max(TAB_MESSAGE_MAX_CHARS),
});
export type TStartSessionBody = z.infer<typeof startSessionBody>;
export const startSessionResponse = z.object({ tab_id: z.string() });
export type TStartSessionResponse = z.infer<typeof startSessionResponse>;

export const tabChatQuery = z.object({ before: z.string().max(128).optional() });
export type TTabChatQuery = z.infer<typeof tabChatQuery>;

export const tabChatPage = z.object({
  tab: tabSummary,
  session_id: z.string().nullable(),
  items: tabChatItems,
  /** opaque cursor of the previous page; null at the start of the session */
  before: z.string().nullable(),
  /** opaque cursor the live socket follows from (`after`); null when there is no transcript to follow */
  live: z.string().nullable(),
  mode: z.string().nullable(),
  degraded: z.boolean(),
  questions: z.array(tabQuestionSchema),
  suggestions: z.array(tabSuggestionSchema),
  /** Why the conversation shows no history (TER-1091), one of `TAB_CHAT_EMPTY_REASONS`, read as a plain
   *  string like `availability`; null when there is history, or when `availability` already says why.
   *  Absent from an older server. */
  empty_reason: z.string().nullable().default(null),
});
export type TTabChatPage = z.infer<typeof tabChatPage>;

/**
 * Why a tab's conversation is empty (TER-1091). The history is the Claude Code transcript of the tab's
 * current session, found through the session id its hooks report: `no_hooks` (the machine never had the
 * termhub hooks installed, so no session is ever reported), `not_reported` (hooks installed, but no
 * session reported yet: Claude not started in the tab, or started before the hooks were), `transcript_missing`
 * (the session's file is no longer on the machine), `new_session` (the current session has nothing yet:
 * a new tab, or a `/clear` or a restart of Claude, which starts a new session), `no_agent` (TER-1094: the
 * tab is a plain terminal, its shell at the prompt with no AI CLI in front, so there is no session to show;
 * `tabs/:id/agent` starts one).
 */
export const TAB_CHAT_EMPTY_REASONS = ['no_hooks', 'not_reported', 'transcript_missing', 'new_session', 'no_agent'] as const;
export type TTabChatEmptyReason = (typeof TAB_CHAT_EMPTY_REASONS)[number];

/** One account "Iniciar sessão" can start the tab's agent with (TER-1094): `provider` is `claude` (Claude Code)
 *  or `chatgpt` (Codex), read as a plain string. */
export const tabAgentChoice = z.object({
  account_id: z.string(),
  label: z.string(),
  provider: z.string(),
  /** the project's model for that CLI; null = the CLI's own default */
  model: z.string().nullable(),
});
export type TTabAgentChoice = z.infer<typeof tabAgentChoice>;

/**
 * `GET tabs/:id/agent` (TER-1094): the accounts of the tab's machine an agent can start with, the project's
 * own first, and the one the server picks without asking (`suggested`: the project's first account with
 * room; without a project list, the machine's only account or its only default login). null = more than
 * one fits and no rule decides: the person chooses.
 */
export const tabAgentOptions = z.object({
  choices: z.array(tabAgentChoice),
  suggested: z.string().nullable(),
});
export type TTabAgentOptions = z.infer<typeof tabAgentOptions>;

/** `POST tabs/:id/agent` (TER-1094): no account = the suggested one (409 `ACCOUNT_CHOICE_REQUIRED` when there is none). */
export const startTabAgentBody = z.object({ account_id: z.string().min(1).max(64).optional() });
export type TStartTabAgentBody = z.infer<typeof startTabAgentBody>;

/** Where the agent started: this tab (its shell was free) or a new tab of the same project and machine. */
export const startTabAgentResponse = z.object({
  tab_id: z.string(),
  new_tab: z.boolean(),
  account: z.object({ id: z.string(), label: z.string() }),
  provider: z.string(),
});
export type TStartTabAgentResponse = z.infer<typeof startTabAgentResponse>;

/** `POST machines/:id/hooks` (TER-1091): when the hooks were installed. */
export const installHooksResponse = z.object({ installed_at: z.string() });
export type TInstallHooksResponse = z.infer<typeof installHooksResponse>;

export const tabMessageBody = z.object({ text: z.string().min(1).max(TAB_MESSAGE_MAX_CHARS) });
export type TTabMessageBody = z.infer<typeof tabMessageBody>;

export const TAB_CHAT_ACTIONS = ['interrupt', 'cycle_mode', 'clear', 'compact'] as const;
export type TTabChatAction = (typeof TAB_CHAT_ACTIONS)[number];
export const tabActionBody = z.object({ action: z.enum(TAB_CHAT_ACTIONS) });
export type TTabActionBody = z.infer<typeof tabActionBody>;
/** `mode`: what the footer shows after `cycle_mode` (`default`, `acceptEdits`, `plan`, `bypassPermissions`,
 *  `unknown`, or a value a newer server adds); null for the other actions. */
export const tabActionResponse = z.object({ done: z.literal(true), mode: z.string().nullable() });
export type TTabActionResponse = z.infer<typeof tabActionResponse>;

export const TAB_FILE_MAX_BYTES = 20 * 1024 * 1024;
export const tabFileQuery = z.object({ name: z.string().min(1).max(255) });
export const tabFileResponse = z.object({ path: z.string(), name: z.string() });
export type TTabFileResponse = z.infer<typeof tabFileResponse>;

export const tabScreenQuery = z.object({ lines: z.coerce.number().int().min(1).max(200).default(60) });
export const tabScreenResponse = z.object({ text: z.string() });
export type TTabScreenResponse = z.infer<typeof tabScreenResponse>;

/** Server to phone on `/ws/m/tabs/:id`. `reset`: drop the items and fetch the first page again. */
export const tabChatFrame = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), protocol: z.number(), server_time: z.string(), availability: z.string() }),
  z.object({ type: z.literal('items'), items: tabChatItems, live: z.string(), mode: z.string().nullable() }),
  z.object({ type: z.literal('state'), tab: tabSummary }),
  z.object({ type: z.literal('reset'), session_id: z.string().nullable() }),
  z.object({ type: z.literal('unavailable'), availability: z.string() }),
]);
export type TTabChatFrame = z.infer<typeof tabChatFrame>;
