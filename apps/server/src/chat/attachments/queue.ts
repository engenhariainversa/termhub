import type { AttachmentRow, ChatAttachmentsRepo } from '../../db/repositories/chat-attachments.js';
import { ExtractError, type extract as extractFn } from './extract.js';
import type { AttachmentStore } from './store.js';

export interface ExtractionQueue {
  /** Schedules one row; an id already waiting is not queued twice. Never throws, never awaits the job. */
  enqueue(id: string): void;
  /** Resolves once every job queued so far has finished (tests and shutdown). */
  idle(): Promise<void>;
}

export interface QueueDeps {
  repo: ChatAttachmentsRepo;
  store: Pick<AttachmentStore, 'read'>;
  extract: typeof extractFn;
  whisper: { whisperUrl: string | null; language: string | null };
  /** The updated row, to publish `attachment_status`. Not called for a row deleted meanwhile. */
  onDone(row: AttachmentRow): void;
  log: { warn(obj: object, msg: string): void; info(obj: object, msg: string): void };
}

const label = (err: unknown): string => (err instanceof Error ? err.name : typeof err);

/**
 * In-process, one job at a time (spec 2026-09-26 §5.4): whisper serialises anyway, and two PDF
 * parses at once only trade latency for memory. A job never fails the upload that queued it and
 * never stops the queue; a failure lands on the row as a code. Logs carry ids, kinds, sizes and
 * durations — never a byte of the file or a character of its text.
 */
export function createExtractionQueue(deps: QueueDeps): ExtractionQueue {
  const waiting = new Set<string>();
  let chain: Promise<void> = Promise.resolve();

  const runOne = async (id: string): Promise<void> => {
    waiting.delete(id);
    const row = await deps.repo.findById(id);
    if (!row || row.status !== 'pending') return;
    const started = Date.now();
    let outcome: AttachmentRow | null;
    try {
      const file = await deps.store.read(row.user_id, row.id);
      const result = await deps.extract(row.kind, file, row.mime, deps.whisper);
      outcome = await deps.repo.setExtracted(row.id, result.text, result.meta);
    } catch (err) {
      const code = err instanceof ExtractError ? err.code : 'ATTACHMENT_INVALID';
      if (!(err instanceof ExtractError)) deps.log.warn({ attachmentId: row.id, kind: row.kind, err: label(err) }, 'attachment extraction threw');
      outcome = await deps.repo.setFailed(row.id, code);
    }
    deps.log.info({ attachmentId: row.id, kind: row.kind, bytes: row.bytes, ms: Date.now() - started, status: outcome?.status ?? 'gone', code: outcome?.error_code ?? null }, 'attachment extraction finished');
    if (outcome) deps.onDone(outcome);
  };

  return {
    enqueue(id) {
      if (waiting.has(id)) return;
      waiting.add(id);
      chain = chain.then(() => runOne(id)).catch((err) => deps.log.warn({ attachmentId: id, err: label(err) }, 'attachment extraction job crashed'));
    },
    idle: () => chain,
  };
}

/** On boot: whatever was still `pending` when the previous process died goes back in line. */
export async function requeuePending(queue: ExtractionQueue, repo: Pick<ChatAttachmentsRepo, 'listPending'>): Promise<number> {
  const rows = await repo.listPending();
  for (const r of rows) queue.enqueue(r.id);
  return rows.length;
}
