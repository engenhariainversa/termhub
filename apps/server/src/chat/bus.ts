import { EventEmitter } from 'node:events';
import type { ChatMessage } from '../db/repositories/chat.js';
import type { ChatActionClass } from '../db/repositories/chat-actions.js';
import type { ChatActionCard } from '../db/repositories/chat-actions-view.js';

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
  /** A run ended, whichever way: after the final `message` event of its answer, or — for a run that
   * could not even be attempted (the concierge refused it) — with no message at all, its empty
   * assistant row already deleted. `error_code` is the stored answer's code, or `SETUP_FAILED`.
   * Metadata only: never the answer's text. Browsers ignore it; the push service listens for it. */
  | { type: 'run_finished'; user_id: string; conversation_id: string; message_id: string | null; ok: boolean; error_code: string | null }
  /** A call the concierge made under a tab grant, already executed or failed: the trail's row for
   * it (spec 2026-09-25 §5). Nobody was asked, so without this the trail would only show it on reload. */
  | { type: 'granted_action'; user_id: string; conversation_id: string; action: ChatActionCard };

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
