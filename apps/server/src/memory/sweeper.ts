import type { FastifyBaseLogger } from 'fastify';
import { defaultEmbedder, memoryCode, type Embedder } from '../chat/embeddings.js';
import type { Repositories } from '../db/repositories/index.js';
import { indexAiMemoryForLink, removeAiMemoryLessonsForLink, type AiMemoryExec } from './ai-memory.js';
import { indexDocsForLink, type DocsExec } from './docs.js';
import { embedPendingItems, indexTasks } from './index-items.js';
import { indexProjectNote } from './note.js';

/** How often the sweeper ticks (spec 2026-09-26 concierge memory §4): the same cadence as TER-57's
 *  decision sweeper. */
export const MEMORY_SWEEP_INTERVAL_MS = 10 * 60 * 1000;

/** One embed request's size (`embedPendingItems`). */
export const EMBED_BATCH = 32;
/** How many embed batches one tick drains at most: a full batch means more is waiting, but a backlog
 *  (a first docs pass, an embedder back after an outage) must not hold the tick for ever. */
export const EMBED_MAX_BATCHES_PER_TICK = 20;

/** The docs pass (spec D15: every 30 min) runs on the first tick and then on every this-many ticks. */
export const DOCS_EVERY_TICKS = 3;

/**
 * Keeps the concierge's free-text memory complete without holding up anything else (spec §4): re-
 * indexes every owner's changed cards (`indexTasks`, one pass per owner with at least one task), then
 * embeds whatever that pass or a live writer (`indexMessage`/`indexActions`/`indexNote`) left without a
 * vector (`embedPendingItems`, batches of `EMBED_BATCH`, repeated while each comes back full, at most
 * `EMBED_MAX_BATCHES_PER_TICK` per tick). `indexTasks` is always run with no embedder of its own —
 * embedding every card it just wrote is this function's own next step, in one batched request, rather
 * than one request per owner. Runs once right away and then every `intervalMs`; the timer is `unref`'d
 * so it never keeps the process (or a test run) alive, and the caller must not `await` this function —
 * its first run must not block app startup. `embedder` left out entirely resolves `defaultEmbedder()`
 * (the configured service, if any); passing `null` explicitly (as opposed to leaving it out) turns
 * embedding off on purpose — indexing still runs (cards stay searchable by full text even without a
 * vector). A `running` guard skips a tick that overlaps the previous one still in flight. A failure
 * indexing one owner does not stop the next owner, and a failure indexing every owner still lets the
 * embed step run. Never throws out of a tick: each step logs its own outcome, counts and codes only —
 * never a title, a text or a query.
 *
 * On the first tick and every `DOCS_EVERY_TICKS`th tick after (30 min at the default interval, spec
 * D15), a docs pass runs between the card pass and the embed step: `indexDocsForLink` for every project
 * link, one after the other (a machine is never asked for two links' docs at once), through `docsExec`
 * (`machineDocsExec` by default), right after deleting the doc items — and the file-origin lesson items
 * (review fix round 1) — of every link that no longer exists (`deleteDocsNotInLinks` — only when the
 * listing succeeded; a note-origin lesson is never touched by it). A link whose machine is off is skipped by `indexDocsForLink` itself; a
 * repository failure on one link is logged `{ linkId, code }` and the next link still runs. The docs
 * pass shares the tick's `running` guard, so a slow pass (many ssh machines timing out) delays the next
 * tick instead of overlapping it.
 *
 * In the same docs pass, a link whose project opted in to ai-memory lessons (TER-1021,
 * `ai_memory_lessons`) also has its deliberate ai-memory pages imported (`indexAiMemoryForLink`, through
 * `aiMemoryExec`, `machineAiMemoryExec` by default); a link whose project has the option off has any
 * ai-memory lesson it still holds removed (`removeAiMemoryLessonsForLink`).
 *
 * On the same turn as the docs pass, a notes pass (spec 2026-09-27 failure lessons §4) covers a crash
 * between a note save and its own `indexProjectNote` call: every project whose note's `updated_at` moved
 * past the newest `project_note` item already stored for it (`latestSourceAt`, grouped one query per
 * owner) is re-indexed. Cheap and rare in the common case (the route and `record_lesson` already index
 * on the spot), so it shares the docs pass's slower cadence rather than running every tick. A failure
 * for one owner is logged `{ code }` and the next owner still runs.
 */
export function startMemorySweeper(
  repos: Repositories,
  log: Pick<FastifyBaseLogger, 'info' | 'warn'>,
  embedder?: Embedder | null,
  intervalMs = MEMORY_SWEEP_INTERVAL_MS,
  docsExec?: DocsExec,
  aiMemoryExec?: AiMemoryExec,
): () => void {
  const embed = embedder !== undefined ? embedder : defaultEmbedder();
  let running = false;
  let ticks = 0;

  const indexAllOwners = async (): Promise<void> => {
    const owners = await repos.tasks.listOwnersWithTasks();
    let indexed = 0;
    for (const ownerId of owners) {
      try {
        indexed += await indexTasks(repos, ownerId, { embedder: null, log });
      } catch (err) {
        log.warn({ code: memoryCode(err) }, 'memory card indexing failed for an owner');
      }
    }
    if (indexed > 0) log.info({ indexed }, 'memory cards indexed');
  };

  const indexAllDocs = async (): Promise<void> => {
    const links = await repos.projectMachines.listAllWithOwner();
    // Only after a successful listing (an empty one included: no link left means no doc stays).
    const stale = await repos.memoryItems.deleteDocsNotInLinks(links.map((l) => l.id));
    let read = 0;
    let removed = 0;
    for (const link of links) {
      try {
        const r = await indexDocsForLink(repos, link, { embedder: null, log, exec: docsExec });
        read += r.read;
        removed += r.removed;
      } catch (err) {
        log.warn({ linkId: link.id, code: memoryCode(err) }, 'memory docs indexing failed for a link');
      }
      try {
        if (link.ai_memory_lessons) {
          const r = await indexAiMemoryForLink(repos, link, { embedder: null, log, exec: aiMemoryExec });
          read += r.read;
          removed += r.removed;
        } else {
          removed += await removeAiMemoryLessonsForLink(repos, link.id);
        }
      } catch (err) {
        log.warn({ linkId: link.id, code: memoryCode(err) }, 'ai-memory lessons failed for a link');
      }
    }
    if (read > 0 || removed > 0 || stale > 0) log.info({ links: links.length, read, removed, stale }, 'memory docs indexed');
  };

  const indexAllNotes = async (): Promise<void> => {
    const projects = await repos.projects.list();
    const byOwner = new Map<string, string[]>();
    for (const p of projects) {
      if (!p.owner_id) continue;
      const ids = byOwner.get(p.owner_id) ?? [];
      ids.push(p.id);
      byOwner.set(p.owner_id, ids);
    }
    let indexed = 0;
    for (const [ownerId, projectIds] of byOwner) {
      try {
        const latest = await repos.memoryItems.latestSourceAt('project_note', ownerId);
        for (const projectId of projectIds) {
          const note = await repos.notes.getByProject(projectId);
          if (note.id === '') continue; // no note row for this project yet: nothing to index
          const known = latest.get(projectId);
          if (known !== undefined && Date.parse(note.updated_at) <= Date.parse(known)) continue;
          const r = await indexProjectNote(repos, projectId, { embedder: null, log });
          indexed += r.sections + r.lessons;
        }
      } catch (err) {
        log.warn({ code: memoryCode(err) }, 'memory notes indexing failed for an owner');
      }
    }
    if (indexed > 0) log.info({ indexed }, 'memory notes indexed');
  };

  const tick = async () => {
    if (running) return;
    running = true;
    const docsTurn = ticks++ % DOCS_EVERY_TICKS === 0;
    try {
      try {
        await indexAllOwners();
      } catch (err) {
        log.warn({ code: memoryCode(err) }, 'memory card indexing failed');
      }
      if (docsTurn) {
        try {
          await indexAllDocs();
        } catch (err) {
          log.warn({ code: memoryCode(err) }, 'memory docs indexing failed');
        }
        try {
          await indexAllNotes();
        } catch (err) {
          log.warn({ code: memoryCode(err) }, 'memory notes indexing failed');
        }
      }
      if (!embed) return;
      try {
        let embedded = 0;
        for (let batch = 0; batch < EMBED_MAX_BATCHES_PER_TICK; batch++) {
          const n = await embedPendingItems(repos, embed, EMBED_BATCH);
          embedded += n;
          if (n < EMBED_BATCH) break;
        }
        if (embedded > 0) log.info({ embedded }, 'memory items embedded');
      } catch (err) {
        log.warn({ code: memoryCode(err) }, 'memory embed sweep failed');
      }
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  void tick();
  return () => clearInterval(timer);
}
