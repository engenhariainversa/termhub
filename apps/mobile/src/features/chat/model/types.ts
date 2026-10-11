// Re-exports the contract's inferred types under the names `apps/web/src/lib/types.ts` uses (design
// spec §6): the pure chat logic ported into this folder (`timeline.ts`, `live.ts`, `filter.ts`,
// `copy.ts`) is a line-for-line copy of the web's own modules, and matching its type names is what
// keeps that copy readable side by side with the source it was copied from. Delete this file once
// `@termhub/mobile-api` exports these types directly (design spec §6).
import type { TChatAction, TChatConversation, TChatDecision, TChatEvent, TChatGrant, TChatHostState, TChatMemory, TChatMessage, TChatProjectGrant, TChatStandingGrant, TSubagentView, TTabLimit, TTabQuestion, TTabQuestionSuggestion, TTabSuggestion } from '@/services/api/contract';

/**
 * A message row, plus what only this device knows about a row it inserted before the server echoed
 * it (chat redesign spec §4.2 "Optimistic user bubble"): `local: 'sending'` until the `202` renames
 * it to the server's id, `'failed'` when the send failed — the row stays, with its reason and
 * "Tentar de novo". Never present on a row that came from the server.
 */
export type ChatMessage = TChatMessage & {
  local?: 'sending' | 'failed';
  /** pt-BR, with `local: 'failed'`: why. */
  local_error?: string;
  /** The list key of a row this device sent: its `local:` id, kept once the `202` renames it, so the
   * row is not remounted (a flash) when it becomes the server's (TER-1001). */
  row_key?: string;
};
export type ChatAction = TChatAction;
export type ChatConversation = TChatConversation;
export type ChatHostState = TChatHostState;
export type ChatEvent = TChatEvent;
/** A tab trusted for `send_input` in this conversation ("Permitir sempre nesta aba"). */
export type ChatGrant = TChatGrant;
/** A project's board trusted in this conversation ("Permitir sempre neste projeto", design spec
 * 2026-09-26 §7): the four board tools, up to 24 h, at most 30 calls/hour (server-enforced). */
export type ChatProjectGrant = TChatProjectGrant;
/** A standing grant ("Liberar sem prazo", spec 2026-09-28 TER-386): one kind of action on one project,
 * with no expiry and not bound to a conversation; it lasts until revoked. */
export type ChatStandingGrant = TChatStandingGrant;
/** A question an agent in a tab asked (spec 2026-09-25). */
export type TabQuestion = TTabQuestion;
/** A pre-selected answer from a similar past decision (chat decision memory spec 2026-09-26 §4.2),
 * carried on an `open` question — suggest only, never sent on its own. */
export type TabQuestionSuggestion = TTabQuestionSuggestion;
export type TabQuestionSuggestionItem = TabQuestionSuggestion['items'][number];
/** A countdown that sends `answer` by itself at `due_at` unless the person cancels it (concierge
 * memory spec 2026-09-26 §6). `by`/`status` are plain strings on the wire (a newer server may add a
 * value this app does not know), copied from `apps/web/src/lib/types.ts`'s `TabQuestionAutoAnswer`. */
export type TabQuestionAutoAnswer = NonNullable<TabQuestion['auto_answer']>;
/** One question of a choice card, as `payload.questions` holds it. */
export type TabQuestionItem = Extract<TabQuestion, { kind: 'choice' }>['payload']['questions'][number];
/** Claude Code's dimmed next prompt in a tab (spec 2026-09-25 tab suggestions). */
export type TabSuggestion = TTabSuggestion;
/** A project tab stuck on its account's usage limit, on a machine that does not swap by itself (spec
 * 2026-09-30 project AI accounts §7.2). */
export type TabLimit = TTabLimit;

/** One row of the subagents panel (spec 2026-09-26 panel §4): its description and type, never its
 * prompt nor its work. */
export type SubagentView = TSubagentView;
export type SubagentStatus = SubagentView['status'];

/** "Memória do chat" (spec 2026-09-26 §4.6/§5.2): one remembered decision, and the suggestion
 * switch, as the list and the "Memória do chat" screen show them. */
export type ChatDecision = TChatDecision;
export type ChatMemory = TChatMemory;

/**
 * Why an answer stopped, transcribed verbatim from `apps/web/src/lib/types.ts` (~lines 611-632):
 * every label a runner can end a run with becomes one of these server-side, each with its own
 * sentence in `errorSentence` (`copy.ts`).
 */
export type ChatErrorCode =
  /** the stream ended with nothing said about why */
  | 'RUNNER_FAILED'
  /** the server could not even mint the concierge's credential */
  | 'TOKEN_FAILED'
  /** no `claude` on the host machine */
  | 'CLI_MISSING'
  /** the CLI refused our own flags */
  | 'CLI_REJECTED'
  /** the CLI session this conversation was resuming is gone from that machine */
  | 'MISSING_SESSION'
  /** the run started and died */
  | 'RUN_FAILED'
  /** the process was killed (a deadline, an abandoned request, an agent shutting down) */
  | 'KILLED'
  /** the host machine went away mid-run — a laptop that closed, most often */
  | 'HOST_GONE'
  /** the host's agent does not know how to run a chat */
  | 'AGENT_TOO_OLD'
  /** the host machine is up and healthy, with every channel taken: the run could not start */
  | 'HOST_BUSY'
  /** the Claude account hit its usage limit (the message's `notice` says when it resets) */
  | 'USAGE_LIMIT'
  /** the CLI does not know the model the chat asked for */
  | 'MODEL_UNAVAILABLE'
  /** the Claude account is not logged in on the host machine */
  | 'AUTH_FAILED';

export type { ChatEntry } from './timeline';
