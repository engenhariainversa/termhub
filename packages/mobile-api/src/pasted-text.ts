// A long text pasted into a message box goes as a `.txt` attachment (TER-1139): the server refuses a
// chat message past `CHAT_MESSAGE_MAX_CHARS` (and a tab's past `TAB_MESSAGE_MAX_CHARS`), and a wall of
// text in a bubble reads worse than a file anyway. Kept free of zod on purpose: the web imports this
// module alone (`@termhub/mobile-api/pasted-text`), like `models`.

/** The longest text of a chat message (`mobileMessageBody`, the web's `messageBody`), after trimming. */
export const CHAT_MESSAGE_MAX_CHARS = 8000;

/** A paste this long becomes a file even when the message would still fit: it can go back as text (undo). */
export const PASTE_AS_FILE_CHARS = 4000;

/** Shorter than this, a run that pushes the box past its limit is typing (a phone's input reports every
 * key, and a suggestion as a word), not a paste: the send deals with the box then. */
const PASTE_MIN_CHARS = 100;

/**
 * Whether a paste goes into the box as a file: it is long (`PASTE_AS_FILE_CHARS`, or half the box's own
 * limit when that is lower, so a tab's 4000 still leaves room to take it back as text), or it is what
 * makes the box no longer fit in `max` (a box already past it is the send's to deal with too). `box` is
 * the whole text the box would hold with the paste in it.
 */
export function pasteGoesAsFile(pasted: string, box: string, max: number): boolean {
  if (pasted.trim().length === 0) return false;
  if (pasted.length >= Math.min(PASTE_AS_FILE_CHARS, Math.floor(max / 2))) return true;
  return pasted.length >= PASTE_MIN_CHARS && box.trim().length > max && box.length - pasted.length <= max;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** `colado-2026-10-28-0915.txt`: when it was pasted, in the device's local time. */
export function pastedTextName(at: Date = new Date()): string {
  return `colado-${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}.txt`;
}

/**
 * What changed from `before` to `after` as one inserted run: the text kept on each side and what went
 * in between. A phone's text input reports only the new value, so a paste is the run that grew it (a
 * paste over a selection replaced part of `before`, which is in neither side).
 */
export function insertedRun(before: string, after: string): { head: string; inserted: string; tail: string } {
  let start = 0;
  const limit = Math.min(before.length, after.length);
  while (start < limit && before[start] === after[start]) start += 1;
  let end = 0;
  while (end < limit - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end += 1;
  return { head: after.slice(0, start), inserted: after.slice(start, after.length - end), tail: after.slice(after.length - end) };
}

/** The UTF-8 size of a text, as the server will count the file. */
export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}
