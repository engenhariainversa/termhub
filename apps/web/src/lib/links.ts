/**
 * Bare http(s) URLs in a chat message's plain text (TER-1089): the person's own words and the excerpt of
 * a quote, which are never parsed as Markdown. The concierge's answers go through `marked`, whose GFM
 * autolinks already follow the same rules; `openLinksInNewTab` then sends those links to a new tab. The
 * app has the same detector and the same table of cases (`apps/mobile`, `chat/model/links.ts`).
 */

// From the scheme to the first whitespace, quote, angle bracket or backtick: everything else a URL may
// carry (an IP and port, a long query string, a fragment, parentheses) stays in.
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
    if (start > 0 && /[\p{L}\p{N}_]/u.test(text[start - 1])) continue;
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

/**
 * Every http(s) link in sanitised HTML opens in a new tab, without opener or referrer: a link in an
 * answer used to replace the app itself. Runs after the sanitiser (which drops `target` and `rel`) and
 * only touches attributes through DOM APIs, like `linkifyMdPaths`. Any other link is left as it was.
 */
export function openLinksInNewTab(html: string): string {
  if (!html.includes('<a')) return html;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  let changed = false;
  for (const a of Array.from(doc.body.querySelectorAll('a[href]'))) {
    if (!/^https?:\/\//i.test(a.getAttribute('href') ?? '')) continue;
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
    changed = true;
  }
  return changed ? doc.body.innerHTML : html;
}
