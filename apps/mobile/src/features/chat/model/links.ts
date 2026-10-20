/**
 * Bare http(s) URLs in a chat message's plain text (TER-1089): the person's own words and a quote's
 * excerpt, which are never parsed as Markdown. The answers go through markdown-it with `linkify`
 * (`chatMarkdownIt`). The same rules and the same table of cases as the web (`apps/web/src/lib/links.ts`).
 */

// From the scheme to the first whitespace, quote, angle bracket or backtick.
const URL_RE = /https?:\/\/[^\s<>"'`]+/gi;
// What a sentence puts after a URL and the URL itself almost never ends with.
const TRAILING = /[.,;:!?*_~]$/;
const PAIRS: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

export interface UrlMatch {
  start: number;
  end: number;
  url: string;
}

const count = (s: string, c: string) => s.split(c).length - 1;

/** The URL without what the sentence around it added: a final full stop, or a `)` that closes a parenthesis opened before the URL. */
function trimEnd(url: string): string {
  for (;;) {
    const last = url.slice(-1);
    if (TRAILING.test(last)) url = url.slice(0, -1);
    else if (PAIRS[last] && count(url, last) > count(url, PAIRS[last])) url = url.slice(0, -1);
    else return url;
  }
}

/** Every http(s) URL in `text`, in order. A scheme glued to a word (`xhttp://`) or with no host is not one. */
export function findUrls(text: string): UrlMatch[] {
  const out: UrlMatch[] = [];
  for (const m of text.matchAll(URL_RE)) {
    const start = m.index ?? 0;
    if (start > 0 && /[\p{L}\p{N}_]/u.test(text[start - 1]!)) continue;
    const url = trimEnd(m[0]);
    if (!/^https?:\/\/[^/?#]/i.test(url)) continue;
    out.push({ start, end: start + url.length, url });
  }
  return out;
}

export type TextPiece = { text: string; url?: undefined } | { text: string; url: string };

/** `text` cut at its URLs: plain pieces and link pieces, in order, together exactly `text`. */
export function splitUrls(text: string): TextPiece[] {
  const pieces: TextPiece[] = [];
  let at = 0;
  for (const m of findUrls(text)) {
    if (m.start > at) pieces.push({ text: text.slice(at, m.start) });
    pieces.push({ text: m.url, url: m.url });
    at = m.end;
  }
  if (at < text.length) pieces.push({ text: text.slice(at) });
  return pieces;
}

/** Whether a link may leave the app: only http(s), never `javascript:`, `file:`, `intent:` or another app's scheme. */
export const isWebUrl = (url: string) => /^https?:\/\//i.test(url);
