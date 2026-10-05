/**
 * Paths of Markdown files in an answer's text, turned into preview links (spec 2026-10-04 file preview
 * D11). A path counts when it ends in `.md` or `.markdown`, is absolute, `~/…` or relative, and is not
 * part of a URL. The app has the same rules and the same table of cases (`apps/mobile`, `md-paths.ts`).
 */

// Characters a path segment may hold here: letters (accents too), digits and `._@+-`. No spaces, quotes or
// brackets, so a path in prose or in backticks ends where a reader sees it end.
const SEG = "[\\p{L}\\p{N}._@+-]+";
const PATH_RE = new RegExp(`(?:~/|\\.{1,2}/|/)?(?:${SEG}/)*${SEG}\\.(?:md|markdown)(?![\\p{L}\\p{N}_-])`, 'giu');

const DOMAIN_RE = /^(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|io|dev|app|co|br|ai|sh)\//i;

export interface MdPathMatch {
  start: number;
  end: number;
  path: string;
}

/** Every Markdown path in `text`, in order. */
export function findMdPaths(text: string): MdPathMatch[] {
  const out: MdPathMatch[] = [];
  for (const m of text.matchAll(PATH_RE)) {
    const start = m.index ?? 0;
    let path = m[0];
    const before = text.slice(0, start);
    // Part of a URL (`https://x/a.md`, `github.com/o/r/blob/main/a.md`) or of a longer word (`foo:bar.md`).
    if (/[\p{L}\p{N}_:/\\.~-]$/u.test(before) || /:\/\/\S*$/.test(before)) continue;
    // A URL written without its scheme (`github.com/o/r/blob/main/a.md`).
    if (DOMAIN_RE.test(path)) continue;
    // A sentence's own full stop is not part of the name (`Veja docs/a.md.`): the regex already stops there.
    if (path.startsWith('./')) path = path.slice(2);
    out.push({ start, end: start + m[0].length, path });
  }
  return out;
}

/** The attribute a preview link carries; click handlers look for it. */
export const MD_PATH_ATTR = 'data-md-path';

/**
 * Wraps every Markdown path in sanitised HTML in an `<a data-md-path>` whose `href` is `hrefFor(path)`. Runs
 * after the sanitiser and builds every node with DOM APIs, never string concatenation, like
 * `code-blocks.ts` (whose header explains why re-parsing that output is safe). Text inside `pre` (a code
 * block) and inside an existing link is left alone; inline `code` is linked, as agents write paths in
 * backticks.
 */
export function linkifyMdPaths(html: string, hrefFor: (path: string) => string): string {
  if (!/\.(?:md|markdown)/i.test(html)) return html;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement;
    if (el?.closest('pre, a')) continue;
    texts.push(n as Text);
  }
  let changed = false;
  for (const node of texts) {
    const text = node.data;
    const matches = findMdPaths(text);
    if (matches.length === 0) continue;
    changed = true;
    const frag = doc.createDocumentFragment();
    let at = 0;
    for (const m of matches) {
      if (m.start > at) frag.append(doc.createTextNode(text.slice(at, m.start)));
      const a = doc.createElement('a');
      a.setAttribute('href', hrefFor(m.path));
      a.setAttribute(MD_PATH_ATTR, m.path);
      a.setAttribute('title', 'Abrir prévia do arquivo');
      a.className = 'md-path';
      a.textContent = text.slice(m.start, m.end);
      frag.append(a);
      at = m.end;
    }
    if (at < text.length) frag.append(doc.createTextNode(text.slice(at)));
    node.replaceWith(frag);
  }
  return changed ? doc.body.innerHTML : html;
}

/** Where a path opens: the project's terminal area (a file tab), or the file page outside a project. */
export function filePreviewHref(projectId: string | null, path: string, machineId?: string): string {
  const q = new URLSearchParams({ file: path });
  if (machineId) q.set('machine', machineId);
  return projectId ? `/projects/${encodeURIComponent(projectId)}?${q}` : `/files?${q}`;
}
