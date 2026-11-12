/**
 * TER-1168: the last text typed into each agent tab whose delivery `send_input` could not confirm — the tab
 * never started a turn for it. The watch engine reads it (chat/watches/evaluate.ts): a watch on such a tab
 * would wait for a stop that never comes, so it wakes the chat with the reason instead.
 *
 * In memory, ids and reasons only (never the text), and short-lived: `send_input`'s own answer already told
 * its caller; this is the backstop for a watch created right before or after the send. A deploy drops it,
 * like the input origins (terminal/input-origin.ts).
 */

/** Why a text typed into an agent tab did not start a turn. */
export type UndeliveredReason = 'agent_exited' | 'cli_dialog' | 'no_reaction';

export interface Undelivered {
  at: Date;
  reason: UndeliveredReason;
}

/** How long a failed delivery is remembered: a watch created later than this is about something else. */
export const UNDELIVERED_TTL_MS = 30 * 60_000;

const failed = new Map<string, Undelivered>();

export function recordUndelivered(tabId: string, reason: UndeliveredReason, at = new Date()): void {
  failed.set(tabId, { at, reason });
}

/** A later delivery that started a turn clears the record. */
export function clearUndelivered(tabId: string): void {
  failed.delete(tabId);
}

export function undeliveredOf(tabId: string, now = new Date()): Undelivered | null {
  const r = failed.get(tabId);
  if (!r) return null;
  if (now.getTime() - r.at.getTime() > UNDELIVERED_TTL_MS) {
    failed.delete(tabId);
    return null;
  }
  return r;
}

/** Tests only. */
export function resetUndelivered(): void {
  failed.clear();
}
