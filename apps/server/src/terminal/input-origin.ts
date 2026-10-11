/**
 * Who wrote each text termhub types into a tab (TER-851, spec 2026-10-04-relayed-input-provenance
 * §5.1). The server records the origin right before typing; the monitor hook posts Claude Code's
 * `UserPromptSubmit` with the prompt, and the server takes the matching record to answer with an
 * origin note.
 *
 * In memory only, bound to the exact text, single use (D3). A record that is never taken (the person
 * edited the text, a deploy moved the tab to the other color, the hook is old) simply expires: the
 * session sees an unmarked message, as before (D4). The text is held only for the TTL and is never
 * logged or stored (terminal content rule).
 */

export type InputOrigin =
  | { level: 'person_typed'; userId: string; surface: 'app' | 'web' }
  | { level: 'person_approved'; userId: string; actionId: string | null; approvedAt: Date }
  | { level: 'person_requested'; userId: string; messageIds: string[] }
  | { level: 'assistant'; userId: string }
  | { level: 'mcp_client'; userId: string; tokenId: string };

export type InputOriginLevel = InputOrigin['level'];

/** How long a record waits for its prompt: covers a message queued while the tab works (decision 10.4). */
export const ORIGIN_TTL_MS = 15 * 60_000;
/** Pending records per tab; the oldest is dropped beyond this. */
export const ORIGIN_MAX_PER_TAB = 5;

interface PendingOrigin {
  text: string;
  origin: InputOrigin;
  expiresAt: number;
}

const pending = new Map<string, PendingOrigin[]>();

// What Claude Code's `UserPromptSubmit.prompt` holds for a paste (spike T1, spec §11): the text in a
// `<pasted_content>` block, with two leading newlines unless the message was queued.
const PASTE_BLOCK = /^\s*<pasted_content id="([0-9a-f]+)">\n([\s\S]*)\n<\/pasted_content id="\1">\n?$/;

/** The text a prompt carries: the inside of a single paste block, else the prompt itself; CRLF folded
 *  and surrounding whitespace dropped, so the typed text and the submitted prompt compare equal. */
export function normalizePrompt(prompt: string): string {
  const text = prompt.replace(/\r\n/g, '\n');
  const block = PASTE_BLOCK.exec(text);
  return (block ? block[2] : text).trim();
}

function sweep(tabId: string, now: number): PendingOrigin[] {
  const list = (pending.get(tabId) ?? []).filter((r) => r.expiresAt > now);
  if (list.length === 0) pending.delete(tabId);
  else pending.set(tabId, list);
  return list;
}

/** Records the origin of a text about to be typed into a tab. Empty texts are not prompts. */
export function recordInputOrigin(tabId: string, text: string, origin: InputOrigin): void {
  const normalized = normalizePrompt(text);
  if (!normalized) return;
  const now = Date.now();
  const list = sweep(tabId, now);
  list.push({ text: normalized, origin, expiresAt: now + ORIGIN_TTL_MS });
  while (list.length > ORIGIN_MAX_PER_TAB) list.shift();
  pending.set(tabId, list);
}

/** The origin of the prompt the tab just submitted, consumed; null when no pending record matches. */
export function takeInputOrigin(tabId: string, prompt: string): InputOrigin | null {
  const list = sweep(tabId, Date.now());
  if (list.length === 0) return null;
  const normalized = normalizePrompt(prompt);
  // Oldest first: two sends of the same text are taken in the order they were typed.
  const index = list.findIndex((r) => r.text === normalized);
  if (index < 0) return null;
  const [record] = list.splice(index, 1);
  if (list.length === 0) pending.delete(tabId);
  return record.origin;
}

/** Tests only. */
export function resetInputOrigins(): void {
  pending.clear();
}
