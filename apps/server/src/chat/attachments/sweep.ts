import type { ChatAttachmentsRepo } from '../../db/repositories/chat-attachments.js';
import type { AttachmentStore, StoredFile } from './store.js';

/** An upload nobody sent within a day is forgotten (spec 2026-09-26 §3). */
export const UNSENT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** A file with no row is only an orphan once it is older than this: an upload writes the file first and the row right after. */
export const ORPHAN_MIN_AGE_MS = 60 * 60 * 1000;
const BATCH = 500;

export interface SweepDeps {
  repo: Pick<ChatAttachmentsRepo, 'existingIds' | 'listStaleUnsent' | 'deleteUnsent'>;
  store: Pick<AttachmentStore, 'listAll' | 'remove'>;
  log: { warn(obj: object, msg: string): void; info(obj: object, msg: string): void };
}

const label = (err: unknown): string => (err instanceof Error ? err.name : typeof err);

/**
 * The hourly sweep (spec §5.1): stale unsent rows go with their files, and a file on the volume
 * with no row (a crashed upload, a row deleted while its file was open) goes too. Each removal
 * fails on its own; the log carries ids only.
 */
export async function sweepAttachments(deps: SweepDeps, now = new Date()): Promise<{ stale: number; orphans: number }> {
  let stale = 0;
  for (const row of await deps.repo.listStaleUnsent(new Date(now.getTime() - UNSENT_MAX_AGE_MS))) {
    try {
      // The conditional row delete is the claim: a send that bound the row since the listing wins, and
      // its file stays. Only a row this sweep removed loses its file; a file removal that fails here
      // leaves an orphan the next pass picks up.
      if (!(await deps.repo.deleteUnsent(row.id, row.user_id))) continue;
      await deps.store.remove(row.user_id, row.id);
      stale++;
    } catch (err) {
      deps.log.warn({ attachmentId: row.id, err: label(err) }, 'attachment sweep: could not remove');
    }
  }

  let orphans = 0;
  const cutoff = now.getTime() - ORPHAN_MIN_AGE_MS;
  const candidates: StoredFile[] = [];
  const removeFile = async (f: StoredFile) => {
    try {
      await deps.store.remove(f.userId, f.id);
      orphans++;
    } catch (err) {
      deps.log.warn({ attachmentId: f.id, err: label(err) }, 'attachment sweep: could not remove');
    }
  };
  const flush = async () => {
    const existing = await deps.repo.existingIds(candidates.map((f) => f.id));
    for (const f of candidates) if (!existing.has(f.id)) await removeFile(f);
    candidates.length = 0;
  };
  for await (const f of deps.store.listAll()) {
    if (f.modifiedAt.getTime() > cutoff) continue;
    if (f.temp) {
      await removeFile(f);
      continue;
    }
    candidates.push(f);
    if (candidates.length >= BATCH) await flush();
  }
  if (candidates.length > 0) await flush();

  if (stale > 0 || orphans > 0) deps.log.info({ stale, orphans }, 'attachment sweep');
  return { stale, orphans };
}
