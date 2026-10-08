import { CONTROL_CHARS_RE, FORMAT_CHARS_RE, globalOf } from '../chat/tab-question-payload.js';
import type { LessonMeta } from '../db/repositories/memory-items.js';

/** One agent-written block already parsed out of a project note (spec 2026-09-27 failure lessons D7).
 *  `start`/`end` are the block's own offsets in the note it was parsed from (the OPEN line through the
 *  CLOSE line, no surrounding blank lines) — enough for a caller to slice it back out verbatim. */
export interface NoteLesson {
  id: string;
  at: string;
  tab: string | null;
  body: string;
  start: number;
  end: number;
}

/** One heading-delimited piece of the person's own note text (never an agent block). */
export interface NoteSection {
  index: number;
  heading: string;
  text: string;
}

/** The fence a lesson block opens with: `id`/`tab` are already validated by the shape of the marker
 *  itself (spec D7) — a stray line that merely looks like one but breaks the shape is left as text. */
const OPEN = /^<!-- termhub:lesson id=([a-z0-9_]{1,40}) at=(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z) tab=([a-z0-9]{1,64}|-) -->$/;
const CLOSE = '<!-- /termhub:lesson -->';

/**
 * `OPEN`, plus the one check its regex cannot make: `at` must be a real instant that round-trips
 * through `Date` unchanged (final review fix). `2026-99-99T99:…` or `2026-02-30T…` has the right shape
 * but is no date at all — as a lesson it would become an `Invalid Date` `source_at` and fail the whole
 * note's index on every pass. Such a line is the person's text, exactly like a shape-invalid marker.
 */
function matchOpen(line: string): RegExpExecArray | null {
  const m = OPEN.exec(line);
  if (!m) return null;
  const t = Date.parse(m[2]!);
  return Number.isFinite(t) && new Date(t).toISOString() === m[2] ? m : null;
}
const EVIDENCE_PT = { observed: 'observada', fixed: 'corrigida', confirmed: 'confirmada' } as const;

const LESSONS_HEADING = '## Lições';
const LESSONS_HEADING_RE = /^## Lições\s*$/m;

/**
 * Neutralises `<!--`/`-->` in agent-written text (spec D7/§9): a lesson field can never open or close
 * a fence, whether by accident or by prompt injection reading its own text back. Control and bidi
 * characters are cleaned the same way `cleanMemoryText` does, so a note lesson can never smuggle a
 * direction override or a hidden control byte either.
 */
export function neutralise(s: string): string {
  return s
    .replace(/<!--/g, '<!‐‐')
    .replace(/-->/g, '‐‐>')
    .replace(globalOf(CONTROL_CHARS_RE), ' ')
    .replace(globalOf(FORMAT_CHARS_RE), ' ');
}

export interface LessonInput {
  symptom: string;
  cause: string;
  fix: string;
  evidence: LessonMeta['evidence'];
  card?: string;
  pr?: string;
}

/**
 * Renders one fenced lesson block (spec D7): every field is neutralised and flattened to one line, so
 * the block is always exactly six lines regardless of what the agent wrote.
 */
export function renderLessonBlock(id: string, at: Date, tab: string | null, l: LessonInput): string {
  const line = (s: string) => neutralise(s).replace(/\n+/g, ' ');
  const evidence = [EVIDENCE_PT[l.evidence], l.card, l.pr].filter(Boolean).map((s) => line(s!)).join(' · ');
  return [
    `<!-- termhub:lesson id=${id} at=${at.toISOString()} tab=${tab ?? '-'} -->`,
    `### ${line(l.symptom)}`,
    `- **Causa:** ${line(l.cause)}`,
    `- **Correção:** ${line(l.fix)}`,
    `- **Evidência:** ${evidence}`,
    CLOSE,
  ].join('\n');
}

const HEADING_RE = /^#{1,3}\s+(.+)$/;

/** A section with nothing but headings (`## Lições` once its blocks are taken out, an empty `### Ideias`):
 *  a title alone is nothing to find, and every query about notes would match it (TER-1006). */
export const headingOnly = (section: Pick<NoteSection, 'text'>): boolean => section.text.split('\n').every((line) => line.trim() === '' || HEADING_RE.test(line.trim()));

/**
 * Splits the person's own note text (blocks already removed) by heading, like `chunkMarkdown` does
 * for a doc — but, unlike it, never drops a heading that has no body: a note is free-form, and a
 * stray `### something` the person typed (or the remains of an unclosed lesson fence, see the
 * `splitNote` test for exactly that) is still their text and must still show up in `sections`, not
 * vanish from what gets indexed.
 */
function splitPersonText(text: string): NoteSection[] {
  const sections: NoteSection[] = [];
  let index = 0;
  let heading = '';
  let buf: string[] = [];

  const flush = () => {
    const raw = buf.join('\n').trim();
    if (raw) sections.push({ index: index++, heading: heading ? `Notas do projeto › ${heading}` : 'Notas do projeto', text: raw });
    buf = [];
  };

  for (const line of text.split('\n')) {
    const m = line.match(HEADING_RE);
    if (m) {
      flush();
      heading = m[1]!.trim();
    }
    buf.push(line);
  }
  flush();
  return sections;
}

/** Byte offset (well, JS string index) each line of `content` starts at — used to recover a block's
 *  exact `start`/`end` in the original string. The last entry may overrun `content.length` by one
 *  (there is no trailing `\n` after the final line); harmless, since `slice` clamps it. */
function lineStarts(lines: string[]): number[] {
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }
  return starts;
}

/**
 * Splits a project note into the person's own text and the agent-written lesson blocks (spec D7/D6).
 * A line matching `OPEN` starts a block only when a `CLOSE` line follows it before any other `OPEN`
 * line — otherwise it is left in the person's text, exactly like any other line (never a lesson, never
 * dropped). So is an `OPEN`-shaped line whose `at` is not a real instant (`matchOpen`). The person's text, blocks removed, is chunked like any other doc for `sections`.
 */
export function splitNote(content: string): { sections: NoteSection[]; lessons: NoteLesson[] } {
  const lines = content.split('\n');
  const starts = lineStarts(lines);
  const lessons: NoteLesson[] = [];
  const personLines: string[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const m = matchOpen(line.trim());
    if (m) {
      let closeIdx = -1;
      for (let j = i + 1; j < lines.length; j++) {
        const t = lines[j]!.trim();
        if (t === CLOSE) {
          closeIdx = j;
          break;
        }
        if (matchOpen(t)) break;
      }
      if (closeIdx >= 0) {
        const [, id, atIso, tab] = m as unknown as [string, string, string, string];
        lessons.push({
          id,
          at: atIso,
          tab: tab === '-' ? null : tab,
          body: lines.slice(i + 1, closeIdx).join('\n'),
          start: starts[i]!,
          end: starts[closeIdx]! + lines[closeIdx]!.length,
        });
        i = closeIdx + 1;
        continue;
      }
    }
    personLines.push(line);
    i += 1;
  }

  const sections = splitPersonText(personLines.join('\n'));
  return { sections, lessons };
}

/**
 * Appends `block` under `## Lições`, creating the heading at the end when the note does not have one
 * yet (spec D7) — every later block lands after the ones already there, in order.
 */
export function appendLessonBlock(content: string, block: string): string {
  const hasHeading = LESSONS_HEADING_RE.test(content);
  const trimmed = content.replace(/\n+$/, '');
  if (hasHeading) {
    const sep = trimmed.length > 0 ? '\n' : '';
    return `${trimmed}${sep}${block}\n`;
  }
  const sep = trimmed.length > 0 ? '\n\n' : '';
  return `${trimmed}${sep}${LESSONS_HEADING}\n${block}\n`;
}

/**
 * Removes one lesson block by id ("Esquecer" for a note lesson, spec §6). A no-op when the id is not
 * found (already gone).
 */
export function removeLessonBlock(content: string, id: string): string {
  const target = splitNote(content).lessons.find((l) => l.id === id);
  if (!target) return content;
  return content.slice(0, target.start) + content.slice(target.end);
}

/**
 * Merges a note save with blocks an agent appended concurrently (spec D9): a block newer than
 * `baseUpdatedAt` that the submitted content does not already have (the person did not just delete
 * it — it simply postdates what they had loaded) is kept, appended back onto the submission. A block
 * older than the base that is missing from the submission was there when the person loaded the note,
 * so its absence means they deleted it on purpose, and it stays gone.
 */
export function mergeNoteSave(current: string, submitted: string, baseUpdatedAt: Date): string {
  const keep = splitNote(current).lessons.filter((l) => new Date(l.at) > baseUpdatedAt && !submitted.includes(`id=${l.id} `));
  return keep.reduce((c, l) => appendLessonBlock(c, current.slice(l.start, l.end)), submitted);
}

/**
 * Turns a rendered lesson block's body (a `NoteLesson.body`, or the same lines from a `docs/lessons`
 * chunk) into what the indexer stores: `title` is the symptom (the `### ` line), `text` is the
 * "Sintoma/Causa/Correção" triple the person and the model both read — the evidence line is metadata
 * already captured in `LessonMeta`, not repeated here.
 */
export function lessonIndexText(body: string): { title: string; text: string } {
  let title = '';
  let cause = '';
  let fix = '';
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (t.startsWith('### ')) title = t.slice(4).trim();
    else if (t.startsWith('- **Causa:**')) cause = t.slice('- **Causa:**'.length).trim();
    else if (t.startsWith('- **Correção:**')) fix = t.slice('- **Correção:**'.length).trim();
  }
  return { title, text: `Sintoma: ${title}\nCausa: ${cause}\nCorreção: ${fix}` };
}
