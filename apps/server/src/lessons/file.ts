import type { LessonMeta } from '../db/repositories/memory-items.js';
import { chunkMarkdown, type Chunk } from '../memory/chunk.js';

/** Where lessons live in a project's repository (spec 2026-09-27 failure lessons D1/D4). */
export const LESSONS_DIR = 'docs/lessons/';

/** `docs/lessons/<name>.md`, one level deep only, and never the format's own `README.md`. */
const LESSON_PATH_RE = /^docs\/lessons\/(?!README\.md$)[^/]+\.md$/;

export function isLessonPath(path: string): boolean {
  return LESSON_PATH_RE.test(path);
}

export interface ParsedLesson {
  title: string;
  chunks: Chunk[];
  meta: LessonMeta;
}

const TITLE_MAX = 300;
const META_STRING_MAX = 300;
const TAGS_MAX = 10;
const TAG_MAX = 40;
const EVIDENCE_VALUES = new Set<LessonMeta['evidence']>(['observed', 'fixed', 'confirmed']);

const cap = (s: string, max: number): string => s.slice(0, max);

/** Unquotes a front-matter scalar: `"a: b"` → `a: b`; anything else passes through untouched. */
function unquote(raw: string): string {
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1);
  return raw;
}

/**
 * A small `key: value` / `key: [a, b]` line parser for a lesson's YAML front matter (spec §4): no
 * nesting, no multi-line scalars, no comments — good enough for the fixed shape D4 asks agents to
 * write, and anything it cannot make sense of is just ignored rather than thrown on.
 */
function parseFrontMatter(text: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const line of text.split('\n')) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    const key = m[1]!;
    const rawValue = m[2]!.trim();
    if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
      out[key] = rawValue
        .slice(1, -1)
        .split(',')
        .map((s) => unquote(s.trim()))
        .filter((s) => s.length > 0);
    } else {
      out[key] = unquote(rawValue);
    }
  }
  return out;
}

/**
 * Splits `---\n<front matter>\n---\n<body>`. A file without a front matter, or one whose `---` never
 * closes, is treated as having none — the whole file is the body, never thrown on.
 */
export function splitFrontMatter(md: string): { frontMatter: Record<string, string | string[]>; body: string } {
  const lines = md.split('\n');
  if (lines[0]?.trim() !== '---') return { frontMatter: {}, body: md };
  const closeIdx = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (closeIdx < 0) return { frontMatter: {}, body: md };
  return { frontMatter: parseFrontMatter(lines.slice(1, closeIdx).join('\n')), body: lines.slice(closeIdx + 1).join('\n') };
}

/** A file lesson's `pr` must look like this (final review fix); anything else is dropped to null. */
const HTTP_URL_RE = /^https?:\/\//i;

/**
 * Parses one `docs/lessons/*.md` file (spec 2026-09-27 failure lessons §4): front matter into `meta`,
 * `symptom` into `title` (falls back to the path when there is none), and the body — front matter
 * stripped — chunked like any other doc (`chunkMarkdown`). Every meta value is capped here, before it
 * ever reaches the database: tags at 10 entries of 40 chars, every other string at 300. `pr` is kept
 * only when it is an http(s) URL (`HTTP_URL_RE`).
 */
export function parseLessonFile(path: string, md: string): ParsedLesson {
  const { frontMatter, body } = splitFrontMatter(md);

  const symptom = typeof frontMatter.symptom === 'string' ? frontMatter.symptom : null;
  const title = symptom ? cap(symptom, TITLE_MAX) : path;

  const rawEvidence = typeof frontMatter.evidence === 'string' ? frontMatter.evidence : '';
  const evidence = (EVIDENCE_VALUES.has(rawEvidence as LessonMeta['evidence']) ? rawEvidence : 'observed') as LessonMeta['evidence'];

  const rawTags = Array.isArray(frontMatter.tags) ? frontMatter.tags : [];
  const tags = rawTags.slice(0, TAGS_MAX).map((t) => cap(t, TAG_MAX));

  const str = (key: string): string | null => (typeof frontMatter[key] === 'string' ? cap(frontMatter[key] as string, META_STRING_MAX) : null);
  // `pr` is linked by the web list and handed to `Linking.openURL` on mobile: only ever an http(s)
  // URL, never `javascript:`/`data:` or a bare host a client would resolve some other way.
  const pr = str('pr');

  return {
    title,
    chunks: chunkMarkdown(path, body),
    meta: { evidence, card: str('card'), pr: pr !== null && HTTP_URL_RE.test(pr) ? pr : null, tags, agent: str('agent'), tab_id: null, origin: 'file', path },
  };
}
