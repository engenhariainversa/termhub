import { Marked, marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({ gfm: true, breaks: true });

/**
 * Exactly the elements `marked` emits from Markdown with `gfm` and `breaks` on, and nothing else.
 * Subtracting the tags that can fetch was the wrong shape for the threat: with `img` forbidden, this
 * DOMPurify version still lets `<video poster>`, `<input type="image" src>`, `<svg><image href>` and
 * `<video src preload="auto">` through, each one a GET of an address the model chose, with no click
 * and no CSP behind it. The set of tags that can fetch keeps growing; Markdown's own output does not,
 * so that is the allowlist.
 *
 * `input` is deliberately absent — it is the tag whose `type="image"` fetches — and it is also how a
 * GFM task list renders its checkbox, so on this path `- [ ] tarefa` reads as a plain bullet. That is
 * the price, and it is paid on the chat path only.
 */
/* Exported for one assertion in markdown.test.ts: `code-blocks.ts` re-parses this output, which is
 * only safe while nothing here parses by foreign-content or raw-text rules. See its header comment. */
export const MARKDOWN_TAGS = ['p', 'br', 'strong', 'em', 'del', 'code', 'pre', 'a', 'ul', 'ol', 'li', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td'];

/**
 * What `marked` gives those elements: `href`/`title` on a link, `align` on a GFM table cell, `class`
 * on a fence's `code` (`language-bash`), `start` on an ordered list that does not begin at 1. None of them can make the browser fetch anything, and
 * DOMPurify still sanitises `href`'s scheme. `.prose-termhub` styles by element and relies on neither
 * `class` nor `align` today — its `th`/`td` rule already overrides the `align` hint — so those two are
 * here to keep Markdown's own output intact, not because a style needs them.
 */
const MARKDOWN_ATTR = ['href', 'title', 'align', 'class', 'start'];

export interface RenderMarkdownOptions {
  /**
   * Keep only what Markdown itself produces. The chat passes `true`: its text comes from an agent
   * that reads real terminal screens, so anything in it that can make the browser fetch a URL is an
   * exfiltration beacon whose address the model writes. The notes editor leaves this off and keeps
   * DOMPurify's defaults — it renders the user's own text, images included.
   */
  markdownOnly?: boolean;
}

// The concierge's answers come from a headless agent that reads real terminal
// screens, so its text can carry anything a prompt injected into a terminal
// produced. This is the one place in apps/web where that untrusted model text
// is turned into HTML, so it is the security boundary for both the chat and
// the notes preview.
export function renderMarkdown(text: string, options: RenderMarkdownOptions = {}): string {
  const html = marked.parse(text, { async: false }) as string;
  return options.markdownOnly ? DOMPurify.sanitize(html, { ALLOWED_TAGS: MARKDOWN_TAGS, ALLOWED_ATTR: MARKDOWN_ATTR }) : DOMPurify.sanitize(html);
}

// --- A previewed file (spec 2026-10-04 file preview D12) ---------------------------------------------

/**
 * Files are documents, not chat lines: GFM without `breaks`, and an image becomes a link that says so
 * ("imagem: alt") — nothing is fetched until the reader clicks it, which is the consent the card asks for.
 * A separate instance, so the chat's `marked` keeps its own options.
 */
const fileMarked = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    image({ href, text }) {
      const label = `imagem: ${text || href}`;
      const a = document.createElement('a');
      a.setAttribute('href', href);
      a.textContent = label;
      return a.outerHTML;
    },
  },
});

/** Where a link inside a previewed file goes: another preview for a relative Markdown path, the browser
 *  (new tab) for http(s), nowhere for anything else. `dir` is the file's own folder as it was asked. */
export function fileLinkTarget(href: string, dir: string): { kind: 'file'; path: string } | { kind: 'web'; url: string } | null {
  if (/^https?:\/\//i.test(href)) return { kind: 'web', url: href };
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//') || href.startsWith('#')) return null;
  const clean = href.split(/[?#]/)[0];
  if (!/\.(?:md|markdown|txt)$/i.test(clean)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(clean);
  } catch {
    return null;
  }
  if (decoded.startsWith('/') || decoded.startsWith('~/')) return { kind: 'file', path: decoded };
  const parts = (dir ? dir.split('/') : []).concat(decoded.split('/'));
  const out: string[] = [];
  for (const p of parts) {
    if (p === '' && out.length > 0) continue;
    if (p === '.') continue;
    if (p === '..' && out.length > 0 && out[out.length - 1] !== '..' && out[out.length - 1] !== '' && out[out.length - 1] !== '~') out.pop();
    else out.push(p);
  }
  return { kind: 'file', path: out.join('/') };
}

/**
 * A previewed Markdown file to sanitised HTML: the chat's allowlist (`markdownOnly`), so the file can no
 * more fetch, script or style anything than an answer can. Then every link is rewritten through DOM APIs:
 * http(s) opens a new tab without opener or referrer, a relative Markdown path carries `data-file-link`
 * (the view opens it as another preview), anything else loses its `href`.
 */
export function renderFileMarkdown(text: string, dir: string): string {
  const html = DOMPurify.sanitize(fileMarked.parse(text, { async: false }) as string, { ALLOWED_TAGS: MARKDOWN_TAGS, ALLOWED_ATTR: MARKDOWN_ATTR });
  if (!html.includes('<a')) return html;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const a of Array.from(doc.body.querySelectorAll('a'))) {
    const target = fileLinkTarget(a.getAttribute('href') ?? '', dir);
    if (!target) {
      a.removeAttribute('href');
    } else if (target.kind === 'web') {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer nofollow');
    } else {
      a.setAttribute('data-file-link', target.path);
    }
  }
  return doc.body.innerHTML;
}
