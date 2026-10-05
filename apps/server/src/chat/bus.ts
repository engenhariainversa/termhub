import { EventEmitter } from 'node:events';
import type { TabLimitView } from './tab-limits.js';
import type { ChatMessage } from '../db/repositories/chat.js';
import type { ChatActionClass } from '../db/repositories/chat-actions.js';
import type { ChatActionCard, ChatGrantView, ChatProjectGrantView, ChatStandingGrantView } from '../db/repositories/chat-actions-view.js';
import type { TabQuestionView } from '../db/repositories/tab-questions-view.js';
import type { SubagentView } from './subagent-view.js';
import type { ChatAttachment } from '@termhub/mobile-api';

/** What the browser is told while an answer is being written. Terminal content never travels here:
 * an action carries the tool and its arguments, never a captured screen (spec §7.1). Every event names
 * its conversation: one user has an account-wide chat and one per project, all open at once, and a
 * screen must drop the events of the ones it is not showing (spec 2026-09-23 §4). */
export type ChatEvent =
  | { type: 'message'; user_id: string; conversation_id: string; message: ChatMessage }
  | { type: 'delta'; user_id: string; conversation_id: string; message_id: string; delta: string }
  | { type: 'action'; user_id: string; conversation_id: string; message_id: string; tool: string; tool_use_id: string; args: unknown }
  | { type: 'action_result'; user_id: string; conversation_id: string; message_id: string; tool_use_id: string; ok: boolean }
  /** A retried run restarts the answer from scratch (a resumed session the CLI no longer has):
   * whatever deltas the browser already appended for this message must be dropped. */
  | { type: 'reset'; user_id: string; conversation_id: string; message_id: string }
  /** A write the concierge proposed on a gated token and may not make until the user confirms it in
   * the chat. It carries the proposal only — the tool, what it targets and the arguments as proposed
   * — never a tool's result: nothing typed back, no screen, no command output. `summary` is the same
   * server-composed sentence `GET /api/chat`'s trail carries for this row (see
   * `db/repositories/chat-actions-view.ts`), so the browser never resolves a name itself. */
  | {
      type: 'confirmation';
      user_id: string;
      conversation_id: string;
      action_id: string;
      tool: string;
      args: unknown;
      class: ChatActionClass;
      machine_id: string | null;
      project_id: string | null;
      tab_id: string | null;
      summary: string;
      /** The subagent (spec 2026-09-26 §4) whose turn proposed this action, when the live run's stream
       * told us before the gate did — `describeActions`' resolution of `ChatAction.subagent_id`, scoped
       * to this same conversation. Null for an action proposed by the top-level run. */
      subagent: { id: string; description: string } | null;
      created_at: string;
      /** Set only on the re-publish of a card whose subagent origin was learned after the gate had
       * already published it: screens merge it by `action_id` like any other, but it is the same
       * question, so the push service must not notify (or write a history row for) it again. Never
       * part of the mobile contract — its schema strips it. */
      origin_update?: true;
      /** When the card was last brought back to the end of the chat (TER-477): screens order by it. */
      surfaced_at?: string | null;
      /** Set on the re-publish that brought a still-pending card back to the end of the chat (TER-477):
       * screens move it, the push service stays quiet — the person was already told. */
      resurfaced?: true;
    }
  /** The user answered a pending action. Every open tab gets this, not only the one that clicked —
   * the confirmation card in each of them must update the same way. */
  | { type: 'decision'; user_id: string; conversation_id: string; action_id: string; status: 'approved' | 'denied' }
  /** A gated action ended — ran, failed (a stale approval: `TAB_GONE`, `WAITING_PERMISSION`…) or aged out
   * (TER-477): every open screen updates the card at once instead of on the next reload. */
  | { type: 'action_status'; user_id: string; conversation_id: string; action_id: string; status: 'executed' | 'failed' | 'expired'; error_code: string | null }
  /** "Permitir sempre nesta aba" was clicked: every open screen shows the strip. */
  | { type: 'grant'; user_id: string; conversation_id: string; grant: ChatGrantView }
  /** "Revogar": every open screen drops it. */
  | { type: 'grant_revoked'; user_id: string; conversation_id: string; grant_id: string }
  /** "Permitir sempre neste projeto" was clicked: every open screen shows the strip. */
  | { type: 'project_grant'; user_id: string; conversation_id: string; grant: ChatProjectGrantView }
  /** "Revogar", for a project grant: every open screen drops it. */
  | { type: 'project_grant_revoked'; user_id: string; conversation_id: string; grant_id: string }
  /** "Liberar sem prazo" was clicked (TER-386): every open screen shows it. `conversation_id` is the
   * granting conversation's, but the grant is not conversation-bound. */
  | { type: 'standing_grant'; user_id: string; conversation_id: string; grant: ChatStandingGrantView }
  /** "Revogar", for a standing grant: screens drop it by id whatever the conversation. Never published
   * for a grant whose granting conversation is gone (spec §5). */
  | { type: 'standing_grant_revoked'; user_id: string; conversation_id: string; grant_id: string }
  /** A run ended, whichever way: after the final `message` event of its answer, or — for a run that
   * could not even be attempted (the concierge refused it) — with no message at all, its empty
   * assistant row already deleted. `error_code` is the stored answer's code, or `SETUP_FAILED`.
   * Metadata only: never the answer's text. Screens close the row; with no message id they re-read
   * and say the run could not start; the push service listens for it. */
  | { type: 'run_finished'; user_id: string; conversation_id: string; message_id: string | null; ok: boolean; error_code: string | null }
  /** An answer row is open: a process has its turn, or the queue holds it for the next one. Published
   * after the row's own `message` event, and again when a queued row is taken by a process: screens
   * keep a set. Metadata only. */
  | { type: 'run_started'; user_id: string; conversation_id: string; message_id: string }
  /** An answer row was deleted: nothing will ever be written into it. Screens drop the row. */
  | { type: 'message_removed'; user_id: string; conversation_id: string; message_id: string }
  /** A call the concierge made under a tab grant, already executed or failed: the trail's row for
   * it (spec 2026-09-25 §5). Nobody was asked, so without this the trail would only show it on reload. */
  | { type: 'granted_action'; user_id: string; conversation_id: string; action: ChatActionCard }
  /** A tab asked something (spec 2026-09-25 §5.2): the whole card. Pushed to the project's most
   * recently active conversation; its text is the question itself, never a screen. */
  | {
      type: 'tab_question';
      user_id: string;
      conversation_id: string;
      question: TabQuestionView;
      resurfaced?: true;
      /** The same open card again, changed (a countdown, a suggestion, a cancel, a failed send): every
       * screen redraws it, but the person was already told about it (TER-919). */
      update?: true;
    }
  /** The chat answered it — or the answer could not be typed (`status: 'failed'`). */
  | { type: 'tab_question_answered'; user_id: string; conversation_id: string; question: TabQuestionView }
  /** It left the tab's screen: answered there, replaced, or the tab is gone. An answered card stays answered. */
  | { type: 'tab_question_closed'; user_id: string; conversation_id: string; question: TabQuestionView }
  /** A tab stopped with Claude Code's dimmed next prompt in its input (spec 2026-09-25 tab suggestions
   * §6): the card. Never pushed to the phone (noise). Its own events: older apps parse `tab_question`. */
  | { type: 'tab_suggestion'; user_id: string; conversation_id: string; suggestion: TabQuestionView }
  /** It was sent (`answered`, or `failed`), dismissed, or left the tab's screen. */
  | { type: 'tab_suggestion_closed'; user_id: string; conversation_id: string; suggestion: TabQuestionView }
  /** A project tab is stuck on a usage limit and its machine does not swap by itself (TER-589): the card
   * offering the project's other accounts. Its own events and list: older apps parse `tab_question*`. */
  | { type: 'tab_limit'; user_id: string; conversation_id: string; notice: TabLimitView }
  /** It was answered (swapped or dismissed), or the limit ended / the tab went away (expired). */
  | { type: 'tab_limit_closed'; user_id: string; conversation_id: string; notice: TabLimitView }
  /** An attachment's extraction finished or failed (spec 2026-09-26 §5.5): the public row, never its text. */
  | { type: 'attachment_status'; user_id: string; conversation_id: string; attachment: ChatAttachment }
  /** A subagent of the conversation started, changed status or was interrupted (spec 2026-09-26 panel
   * §5.3): the panel's row. Its description and type only, never its prompt nor its work. */
  | { type: 'subagent'; user_id: string; conversation_id: string; subagent: SubagentView }
  /** A cancel the person asked for did not happen (the CLI refused it, or never answered): the row is
   * running again, and every open screen says "Não foi possível cancelar". */
  | { type: 'subagent_cancel_failed'; user_id: string; conversation_id: string; subagent_id: string }
  /** How full the conversation's CLI session is after a turn or a compaction (TER-315): numbers only.
   *  `window` is the model's context window, null when the CLI never reported it. */
  | { type: 'context'; user_id: string; conversation_id: string; tokens: number; window: number | null }
  /** "Compactar" (TER-315): started, done (with the sizes before and after, when the CLI said) or
   *  failed (with the code a failed answer would carry). */
  | { type: 'compact'; user_id: string; conversation_id: string; state: 'started' | 'done' | 'failed'; tokens_before: number | null; tokens: number | null; error_code: string | null };

class ChatBus {
  private emitter = new EventEmitter();
  constructor() {
    this.emitter.setMaxListeners(0);
  }
  /**
   * `emit` runs listeners synchronously and in-process: a WebSocket listener that throws (a
   * closed socket, a `JSON.stringify` failure on a circular `args`) would otherwise propagate
   * back into `ChatService.send`'s stream loop and mark a perfectly healthy answer as failed.
   * Each listener gets its own try/catch so one bad subscriber never breaks the others or the run.
   */
  publish(event: ChatEvent): void {
    for (const listener of this.emitter.listeners('chat') as ((event: ChatEvent) => void)[]) {
      try {
        listener(event);
      } catch (err) {
        console.error('chatBus: subscriber threw while handling an event', err);
      }
    }
  }
  subscribe(listener: (event: ChatEvent) => void): () => void {
    this.emitter.on('chat', listener);
    return () => this.emitter.off('chat', listener);
  }
}

export const chatBus = new ChatBus();
