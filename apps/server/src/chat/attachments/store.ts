/** Both path segments of `<dir>/<user_id>/<id>` are `newId()` values; anything else never reaches the disk. */
export const ATTACHMENT_ID_RE = /^[a-z0-9]+$/;

export interface StoredFile {
  userId: string;
  id: string;
  modifiedAt: Date;
  /** A `<id>.tmp` left behind by a write that never finished. */
  temp: boolean;
}

/** Where the bytes live (spec 2026-09-26 §3): one directory per user on the chat-files volume. */
export interface AttachmentStore {
  /** Temp file then rename: a real id never names a half-written file. */
  write(userId: string, id: string, data: Buffer): Promise<void>;
  /** Rejects with an `ENOENT`-coded error when the file is gone. */
  read(userId: string, id: string): Promise<Buffer>;
  /** Idempotent. */
  remove(userId: string, id: string): Promise<void>;
  listAll(): AsyncIterable<StoredFile>;
}
