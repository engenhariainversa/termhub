/**
 * The attachment extraction errors (spec 2026-09-26 chat-redesign-attachments §5.4). Its own module
 * so the extraction worker (`extract-worker.ts`) can map errors without importing the whisper path.
 */
export type ExtractErrorCode = 'ATTACHMENT_INVALID' | 'TRANSCRIPTION_UNAVAILABLE' | 'TRANSCRIPTION_FAILED';
/**
 * Why TRANSCRIPTION_UNAVAILABLE (TER-1035), stored as `meta.reason` so the person reads the cause:
 * whisper not configured on this server, whisper refusing the shared secret, whisper out of reach,
 * or whisper answering an error.
 */
export type TranscriptionReason = 'not_configured' | 'refused' | 'unreachable' | 'error';
export class ExtractError extends Error {
  /** The failure is the moment's, not the file's (whisper loading its model): the queue may try again later. */
  readonly retryable: boolean;
  readonly reason: TranscriptionReason | null;
  constructor(
    public code: ExtractErrorCode,
    message: string = code,
    opts: { retryable?: boolean; reason?: TranscriptionReason } = {},
  ) {
    super(message);
    this.name = 'ExtractError';
    this.retryable = opts.retryable ?? false;
    this.reason = opts.reason ?? null;
  }
}
