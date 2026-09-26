import { EventEmitter } from 'node:events';
import type { ChatMessage } from '../db/repositories/chat.js';
import type { ChatActionClass } from '../db/repositories/chat-actions.js';
import type { ChatActionCard, ChatGrantView } from '../db/repositories/chat-actions-view.js';
import type { TabQuestionView } from '../db/repositories/tab-questions-view.js';
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
  | { type: 'confirmation'; user_id: string; conversation_id: string; action_id: string; tool: string; args: unknown; class: ChatActionClass; machine_id: string | null; project_id: string | null; tab_id: string | null; summary: string; created_at: string }
  /** The user answered a pending action. Every open tab gets this, not only the one that clicked —
   * the confirmation card in each of them must update the same way. */
  | { type: 'decision'; user_id: string; conversation_id: string; action_id: string; status: 'approved' | 'denied' }
  /** "Permitir sempre nesta aba" was clicked: every open screen shows the strip. */
  | { type: 'grant'; user_id: string; conversation_id: string; grant: ChatGrantView }
  /** "Revogar": every open screen drops it. */
  | { type: 'grant_revoked'; user_id: string; conversation_id: string; grant_id: string }
  /** A run ended, whichever way: after the final `message` event of its answer, or — for a run that
   * could not even be attempted (the concierge refused it) — with no message at all, its empty
   * assistant row already deleted. `error_code` is the stored answer's code, or `SETUP_FAILED`.
   * Metadata only: never the answer's text. Browsers ignore it; the push service listens for it. */
  | { type: 'run_finished'; user_id: string; conversation_id: string; message_id: string | null; ok: boolean; error_code: string | null }
  /** A call the concierge made under a tab grant, already executed or failed: the trail's row for
   * it (spec 2026-09-25 §5). Nobody was asked, so without this the trail would only show it on reload. */
  | { type: 'granted_action'; user_id: string; conversation_id: string; action: ChatActionCard }
  /** A tab asked something (spec 2026-09-25 §5.2): the whole card. Pushed to the project's most
   * recently active conversation; its text is the question itself, never a screen. */
  | { type: 'tab_question'; user_id: string; conversation_id: string; question: TabQuestionView }
  /** The chat answered it — or the answer could not be typed (`status: 'failed'`). */
  | { type: 'tab_question_answered'; user_id: string; conversation_id: string; question: TabQuestionView }
  /** It left the tab's screen: answered there, replaced, or the tab is gone. An answered card stays answered. */
  | { type: 'tab_question_closed'; user_id: string; conversation_id: string; question: TabQuestionView }
  /** A tab stopped with Claude Code's dimmed next prompt in its input (spec 2026-09-25 tab suggestions
   * §6): the card. Never pushed to the phone (noise). Its own events: older apps parse `tab_question`. */
  | { type: 'tab_suggestion'; user_id: string; conversation_id: string; suggestion: TabQuestionView }
  /** It was sent (`answered`, or `failed`), dismissed, or left the tab's screen. */
  | { type: 'tab_suggestion_closed'; user_id: string; conversation_id: string; suggestion: TabQuestionView }
  /** An attachment's extraction finished or failed (spec 2026-09-26 §5.5): the public row, never its text. */
  | { type: 'attachment_status'; user_id: string; conversation_id: string; attachment: ChatAttachment };

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
