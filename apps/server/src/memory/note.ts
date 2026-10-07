import { createHash } from 'node:crypto';
import { memoryCode } from '../chat/embeddings.js';
import type { Repositories } from '../db/repositories/index.js';
import type { LessonMeta, NewMemoryItem } from '../db/repositories/memory-items.js';
import { headingOnly, lessonIndexText, splitNote } from '../lessons/note.js';
import { embedInserted, type MemoryDeps } from './index-items.js';
import { cleanMemoryText, ITEM_TEXT_MAX } from './text.js';

/** pt-BR `- **Evidência:**` values (see `lessons/note.ts`'s `EVIDENCE_PT`) back to the column's own
 *  enum. An evidence word the parser does not recognise (a hand-edited note, a future format) falls
 *  back to `fixed` — the most common case and never a value that reads as unfounded. */
const EVIDENCE_FROM_PT: Record<string, LessonMeta['evidence']> = { observada: 'observed', corrigida: 'fixed', confirmada: 'confirmed' };

/** A PR segment always looks like a URL (`renderLessonBlock` writes it verbatim); a card never does
 *  (`TER-57`, `PROJ-12`, …) — telling the two apart by shape, not position, is what makes a block with
 *  a PR but no card parse correctly (review fix round 1: `renderLessonBlock`'s `filter(Boolean)` drops
 *  a missing card, so that block's line has only two segments — evidence, then the PR alone — and a
 *  purely positional read would misfile the PR as the card). */
const PR_RE = /^https?:\/\//;
/** Same cap `lessons/file.ts` puts on a file lesson's `card`/`pr` (`META_STRING_MAX`) — a note is
 *  hand-editable, so nothing stops a person from typing something absurdly long into it. */
const META_STRING_MAX = 300;

/**
 * Reads the `- **Evidência:** <evidência> · <card> · <pr>` line `renderLessonBlock` writes (card and/or
 * pr omitted when the person did not give them) back into `{ evidence, card, pr }`. Segments after the
 * evidence word are classified by shape (`PR_RE`), not by position, so a block with only one of
 * card/pr is read correctly either way; two non-URL segments (a hand-edited note with an odd card) fall
 * back to keeping the last one as `card` — a narrow, accepted ambiguity. Card/pr are capped at
 * `META_STRING_MAX`.
 */
function parseEvidenceLine(body: string): { evidence: LessonMeta['evidence']; card: string | null; pr: string | null } {
  let raw = '';
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (t.startsWith('- **Evidência:**')) raw = t.slice('- **Evidência:**'.length).trim();
  }
  const parts = raw
    .split('·')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const evidence = EVIDENCE_FROM_PT[parts[0] ?? ''] ?? 'fixed';
  let card: string | null = null;
  let pr: string | null = null;
  for (const seg of parts.slice(1)) {
    if (PR_RE.test(seg)) pr = seg.slice(0, META_STRING_MAX);
    else card = seg.slice(0, META_STRING_MAX);
  }
  return { evidence, card, pr };
}

/** A note lesson's `source_hash`, `sha256(body)` (mirroring a file lesson's sha256): what "Verificar"
 *  and "Esquecer" pin (`markHash` in the memory-items repository, so an edited block loses both), and
 *  what lets `listSourceHashes('lesson', 'note:<pid>:')` enumerate the ones already indexed, so this
 *  function can tell which one a person removed since the last run — never used to skip a re-upsert
 *  (a note has too few lessons for that to matter, and always re-writing keeps this simple). */
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/**
 * Indexes one project's note (spec 2026-09-27 failure lessons §4): the person's own text
 * (`splitNote`'s `sections`, minus the ones that are only a heading) as `project_note` chunks, trust
 * `person`, one `source_id` (`note:<pid>`)
 * with a **running** `chunk_index` across every section — a section longer than `ITEM_TEXT_MAX`
 * becomes several consecutive chunks, never truncated. `upsertMany` writes the current sections, then
 * `deleteChunksFrom` trims whatever tail is left over from a note that used to have more sections (or
 * none at all, dropping every chunk).
 *
 * The agent-written blocks (`splitNote`'s `lessons`) become one `kind: 'lesson'` item each, trust
 * `derived`, chunk 0, `source_id` `note:<pid>:<lesson id>` — keyed by the block's own id so
 * verification and hiding survive a re-index. `title`/`text` come from `lessonIndexText`, `meta` from
 * `parseEvidenceLine` plus the fixed `note` shape (`tags: []`, `agent: null`, `path: null`). A block
 * removed since the last run (the person edited it out, or "Esquecer") is the one this function itself
 * detects, via `listSourceHashes('lesson', 'note:<pid>:')` before the upsert: any id no longer among the
 * current blocks is `deleteBySource`d.
 *
 * Fired after every note save and every `record_lesson` (both `void`, best effort), and by the sweeper
 * for a note whose `updated_at` moved past its newest stored item (covers a crash between save and
 * index). Never throws: any failure — the project gone, a repository hiccup — is caught here and logs
 * only `{ projectId, code }`, resolving with zero counts; a project deleted between the save and this
 * call is treated the same as nothing to index. Returns how many section chunks and how many lesson
 * items were (re-)written.
 */
export async function indexProjectNote(repos: Repositories, projectId: string, deps: MemoryDeps): Promise<{ sections: number; lessons: number }> {
  try {
    const project = await repos.projects.findById(projectId);
    if (!project) return { sections: 0, lessons: 0 };
    const ownerId = project.owner_id;
    if (!ownerId) return { sections: 0, lessons: 0 };

    const note = await repos.notes.getByProject(projectId);
    const { sections, lessons } = splitNote(note.content);
    const sourceAt = new Date(note.updated_at);

    const noteSourceId = `note:${projectId}`;
    const sectionItems: NewMemoryItem[] = [];
    // A section that is only a heading is left out of the index (TER-1006); the trim below drops its old chunk.
    for (const s of sections.filter((section) => !headingOnly(section))) {
      const cleaned = cleanMemoryText(s.text);
      for (let i = 0; i < cleaned.length; i += ITEM_TEXT_MAX) {
        sectionItems.push({
          owner_id: ownerId,
          project_id: projectId,
          kind: 'project_note',
          source_id: noteSourceId,
          chunk_index: sectionItems.length,
          title: cleanMemoryText(s.heading),
          text: cleaned.slice(i, i + ITEM_TEXT_MAX),
          trust: 'person',
          source_at: sourceAt,
        });
      }
    }
    const insertedSections = await repos.memoryItems.upsertMany(sectionItems);
    if (deps.embedder) void embedInserted(repos, deps.embedder, insertedSections, deps.log);
    await repos.memoryItems.deleteChunksFrom('project_note', noteSourceId, sectionItems.length);

    const lessonPrefix = `note:${projectId}:`;
    const known = await repos.memoryItems.listSourceHashes('lesson', lessonPrefix);
    const lessonItems: NewMemoryItem[] = lessons.map((l) => {
      const { title, text } = lessonIndexText(l.body);
      const { evidence, card, pr } = parseEvidenceLine(l.body);
      const meta: LessonMeta = { evidence, card, pr, tags: [], agent: null, tab_id: l.tab, origin: 'note', path: null };
      return {
        owner_id: ownerId,
        project_id: projectId,
        kind: 'lesson',
        source_id: lessonPrefix + l.id,
        chunk_index: 0,
        title: cleanMemoryText(title),
        text: cleanMemoryText(text).slice(0, ITEM_TEXT_MAX),
        trust: 'derived',
        source_at: new Date(l.at),
        source_hash: sha256(l.body),
        meta,
      };
    });
    const insertedLessons = await repos.memoryItems.upsertMany(lessonItems);
    if (deps.embedder) void embedInserted(repos, deps.embedder, insertedLessons, deps.log);

    const currentIds = new Set(lessonItems.map((it) => it.source_id));
    const gone = [...known.keys()].filter((id) => !currentIds.has(id));
    if (gone.length > 0) await repos.memoryItems.deleteBySource('lesson', gone);

    return { sections: sectionItems.length, lessons: lessonItems.length };
  } catch (err) {
    deps.log.warn({ projectId, code: memoryCode(err) }, 'memory project note indexing failed');
    return { sections: 0, lessons: 0 };
  }
}
