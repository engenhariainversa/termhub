// Re-exports the contract's inferred types under the names `apps/web/src/lib/types.ts` uses (design
// spec §6): the pure chat logic ported into this folder (`timeline.ts`, `live.ts`, `filter.ts`,
// `copy.ts`) is a line-for-line copy of the web's own modules, and matching its type names is what
// keeps that copy readable side by side with the source it was copied from. Delete this file once
// `@termhub/mobile-api` exports these types directly (design spec §6).
import type { TChatAction, TChatConversation, TChatEvent, TChatGrant, TChatHostState, TChatMessage, TTabQuestion, TTabSuggestion } from '@/services/api/contract';

export type ChatMessage = TChatMessage;
export type ChatAction = TChatAction;
export type ChatConversation = TChatConversation;
export type ChatHostState = TChatHostState;
export type ChatEvent = TChatEvent;
/** A tab trusted for `send_input` in this conversation ("Permitir sempre nesta aba"). */
export type ChatGrant = TChatGrant;
/** A question an agent in a tab asked (spec 2026-09-25). */
export type TabQuestion = TTabQuestion;
/** Claude Code's dimmed next prompt in a tab (spec 2026-09-25 tab suggestions). */
export type TabSuggestion = TTabSuggestion;

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
  | 'HOST_BUSY';

export type { ChatEntry } from './timeline';
