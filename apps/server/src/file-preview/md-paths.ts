/**
 * Paths of Markdown files in an agent's text (spec 2026-10-04 file preview D11), for the recent files list
 * (spec 2026-10-04 recent Markdown files D3). A port of the web's `apps/web/src/lib/md-paths.ts`
 * `findMdPaths`, with the same regex, rules and table of cases (keep the three in step). A path counts
 * when it ends in `.md` or `.markdown`, is absolute, `~/…` or relative, and is not part of a URL.
 */

// Characters a path segment may hold here: letters (accents too), digits and `._@+-`. No spaces, quotes or
// brackets, so a path in prose or in backticks ends where a reader sees it end.
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

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * The text with its fenced code blocks (``` or ~~~) blanked, as the chat leaves paths in a code block
 * unlinked. Each fenced line becomes empty, so the rest keeps its lines. An unclosed fence runs to the end,
 * as Markdown renders it.
 */
export function stripFencedBlocks(text: string): string {
  if (!text.includes('```') && !text.includes('~~~')) return text;
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of text.split('\n')) {
    const m = FENCE_RE.exec(line);
    if (fence === null) {
      if (m) {
        fence = m[1];
        out.push('');
      } else out.push(line);
    } else {
      // A closing fence: the same character, at least as long, nothing after it but spaces.
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && line.slice(m[0].length).trim() === '') fence = null;
      out.push('');
    }
  }
  return out.join('\n');
}

/** The distinct Markdown paths an agent's text names outside code blocks, in order. */
export function mdPathsIn(text: string): string[] {
  if (!/\.(?:md|markdown)/i.test(text)) return [];
  return [...new Set(findMdPaths(stripFencedBlocks(text)).map((m) => m.path))];
}
