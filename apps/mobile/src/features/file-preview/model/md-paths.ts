/**
 * Paths of Markdown files in an answer, turned into preview links (spec 2026-10-04 file preview D11).
 * The same rules and the same table of cases as the web (`apps/web/src/lib/md-paths.ts`).
 */

// Characters a path segment may hold: letters (accents too), digits and `._@+-`.
const SEG = '[\\p{L}\\p{N}._@+-]+';
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
    const before = text.slice(0, start);
    // Part of a URL or of a longer word.
    if (/[\p{L}\p{N}_:/\\.~-]$/u.test(before) || /:\/\/\S*$/.test(before)) continue;
    if (DOMAIN_RE.test(m[0])) continue;
    out.push({ start, end: start + m[0].length, path: m[0].startsWith('./') ? m[0].slice(2) : m[0] });
  }
  return out;
}

/** The scheme a preview link carries inside the Markdown; `onLinkPress` opens it in the app. */
export const FILE_LINK_SCHEME = 'termhub-file:';
export const fileLink = (path: string) => `${FILE_LINK_SCHEME}${encodeURIComponent(path)}`;

/** The path of a preview link, or null for any other URL. */
export function filePathOfLink(url: string): string | null {
  if (!url.startsWith(FILE_LINK_SCHEME)) return null;
  try {
    return decodeURIComponent(url.slice(FILE_LINK_SCHEME.length));
  } catch {
    return null;
  }
}

/** Text outside code: every path becomes `[path](termhub-file:…)`. Existing links and autolinks are kept. */
function linkProse(text: string): string {
  let out = '';
  let at = 0;
  // `[text](target)` and `<url>`: copied as they are.
  const keep = /\[[^\]\n]*\]\([^)\n]*\)|<[^>\n]+>/g;
  for (const k of text.matchAll(keep)) {
    out += linkPlain(text.slice(at, k.index));
    out += k[0];
    at = (k.index ?? 0) + k[0].length;
  }
  return out + linkPlain(text.slice(at));
}

function linkPlain(text: string): string {
  let out = '';
  let at = 0;
  for (const m of findMdPaths(text)) {
    out += text.slice(at, m.start) + `[${text.slice(m.start, m.end)}](${fileLink(m.path)})`;
    at = m.end;
  }
  return out + text.slice(at);
}

/**
 * The answer's Markdown with its Markdown paths as preview links. Fenced code is left alone; an inline
 * code span that is exactly one path becomes a link around the span (agents write paths in backticks).
 */
export function linkifyMarkdown(md: string): string {
  if (!/\.(?:md|markdown)/i.test(md)) return md;
  const lines = md.split('\n');
  let fence: string | null = null;
  const out: string[] = [];
  let prose: string[] = [];
  const flush = () => {
    if (prose.length) out.push(linkInline(prose.join('\n')));
    prose = [];
  };
  for (const line of lines) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1] ?? null;
    if (fence) {
      out.push(line);
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      continue;
    }
    if (marker) {
      flush();
      fence = marker;
      out.push(line);
      continue;
    }
    prose.push(line);
  }
  flush();
  return out.join('\n');
}

function linkInline(text: string): string {
  let out = '';
  let at = 0;
  for (const c of text.matchAll(/`([^`\n]+)`/g)) {
    out += linkProse(text.slice(at, c.index));
    const inner = c[1] ?? '';
    const found = findMdPaths(inner);
    const only = found.length === 1 ? found[0] : undefined;
    out += only && only.start === 0 && only.end === inner.length ? `[${c[0]}](${fileLink(only.path)})` : c[0];
    at = (c.index ?? 0) + c[0].length;
  }
  return out + linkProse(text.slice(at));
}

/** The route's params as a preview link builds them. */
export type FilePreviewParams = { path: string; project_id?: string; tab_id?: string; machine_id?: string };

/** The `/file-preview` route for a path: from the chat (its project), from Sessões (its tab), or from
 *  Arquivos (its project and the machine that listed it). */
export function filePreviewRoute(path: string, ctx: { projectId?: string | null; tabId?: string | null; machineId?: string | null }) {
  const params: FilePreviewParams = { path };
  if (ctx.tabId) params.tab_id = ctx.tabId;
  else if (ctx.projectId) params.project_id = ctx.projectId;
  if (ctx.machineId) params.machine_id = ctx.machineId;
  return { pathname: '/file-preview' as const, params };
}
