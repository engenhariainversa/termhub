import type { AttachmentRow, ChatAttachmentsRepo } from '../../db/repositories/chat-attachments.js';
import { ExtractError, type ExtractErrorCode, type extract as extractFn } from './extract.js';
import type { AttachmentStore } from './store.js';

/**
 * How many times a row is handed to a parser. Each run is marked on the row *before* the parse
 * (`markAttempt`), so a file that kills the process (OOM, a parser bug) is found already attempted
 * on the next boot. Two, not one: a deploy stops the old colour mid-parse of a perfectly good file,
 * and the new colour's boot re-queue deserves that one retry. A poison file crashes the process at
 * most twice, then fails as ATTACHMENT_INVALID without a parse.
 */
export const MAX_PARSE_ATTEMPTS = 2;
/**
 * Transcription is retried by the hourly re-queue while whisper answers 503 (model loading) — for
 * about a day, then TRANSCRIPTION_UNAVAILABLE for good.
 */
export const MAX_TRANSCRIPTION_ATTEMPTS = 24;
/** A row still pending this long after its upload was left behind by a deploy or a 503: the hourly pass re-queues it. */
export const REQUEUE_MIN_AGE_MS = 15 * 60 * 1000;

const isTranscription = (kind: AttachmentRow['kind']) => kind === 'audio' || kind === 'video';
const maxAttempts = (kind: AttachmentRow['kind']) => (isTranscription(kind) ? MAX_TRANSCRIPTION_ATTEMPTS : MAX_PARSE_ATTEMPTS);
const exhaustedCode = (kind: AttachmentRow['kind']): ExtractErrorCode => (isTranscription(kind) ? 'TRANSCRIPTION_UNAVAILABLE' : 'ATTACHMENT_INVALID');

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
  /** The job in flight: a re-queue of it (the hourly pass, a second colour) must not line it up again. */
  let running: string | null = null;
  let chain: Promise<void> = Promise.resolve();

  const runOne = async (id: string): Promise<void> => {
    waiting.delete(id);
    running = id;
    try {
      const row = await deps.repo.findById(id);
      if (!row || row.status !== 'pending') return;
      const attempt = await deps.repo.markAttempt(row.id);
      if (attempt === null) return;
      const started = Date.now();
      let outcome: AttachmentRow | null;
      if (attempt > maxAttempts(row.kind)) {
        // Already tried its share: a parser that never came back, or whisper down for a day.
        outcome = await deps.repo.setFailed(row.id, exhaustedCode(row.kind));
      } else {
        try {
          const file = await deps.store.read(row.user_id, row.id);
          const result = await deps.extract(row.kind, file, row.mime, deps.whisper);
          outcome = await deps.repo.setExtracted(row.id, result.text, result.meta);
        } catch (err) {
          if (err instanceof ExtractError && err.retryable && attempt < maxAttempts(row.kind)) {
            // Left pending on purpose: the hourly pass brings it back.
            deps.log.info({ attachmentId: row.id, kind: row.kind, attempt, code: err.code }, 'attachment extraction deferred');
            return;
          }
          const code = err instanceof ExtractError ? err.code : 'ATTACHMENT_INVALID';
          if (!(err instanceof ExtractError)) deps.log.warn({ attachmentId: row.id, kind: row.kind, err: label(err) }, 'attachment extraction threw');
          outcome = await deps.repo.setFailed(row.id, code);
        }
      }
      deps.log.info({ attachmentId: row.id, kind: row.kind, bytes: row.bytes, attempt, ms: Date.now() - started, status: outcome?.status ?? 'gone', code: outcome?.error_code ?? null }, 'attachment extraction finished');
      if (outcome) deps.onDone(outcome);
    } finally {
      running = null;
    }
  };

  return {
    enqueue(id) {
      if (waiting.has(id) || running === id) return;
      waiting.add(id);
      chain = chain.then(() => runOne(id)).catch((err) => deps.log.warn({ attachmentId: id, err: label(err) }, 'attachment extraction job crashed'));
    },
    idle: () => chain,
  };
}

/**
 * Whatever is still `pending` goes back in line: on boot, everything (the previous process died on
 * it); from the hourly pass, only rows older than `olderThan` (uploads a deploy left behind on the
 * retired colour, a transcription whisper deferred). The queue itself caps the attempts.
 */
export async function requeuePending(queue: ExtractionQueue, repo: Pick<ChatAttachmentsRepo, 'listPending'>, olderThan?: Date): Promise<number> {
  const rows = await repo.listPending(olderThan);
  for (const r of rows) queue.enqueue(r.id);
  return rows.length;
}
