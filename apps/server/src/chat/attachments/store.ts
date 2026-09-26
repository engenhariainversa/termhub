import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

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

const TEMP_SUFFIX = '.tmp';

/** The chat-files volume. Every path is built from two checked ids; the original name never is. */
export function diskStore(dir: string): AttachmentStore {
  const pathFor = (userId: string, id: string, suffix = ''): string => {
    if (!ATTACHMENT_ID_RE.test(userId) || !ATTACHMENT_ID_RE.test(id)) throw new Error('attachment store: invalid id');
    return path.join(dir, userId, id + suffix);
  };
  return {
    async write(userId, id, data) {
      const final = pathFor(userId, id);
      const temp = pathFor(userId, id, TEMP_SUFFIX);
      await mkdir(path.dirname(final), { recursive: true });
      try {
        await writeFile(temp, data);
        await rename(temp, final);
      } catch (err) {
        await rm(temp, { force: true });
        throw err;
      }
    },
    // `async` so a bad id rejects like a missing file does, instead of throwing before the promise exists.
    async read(userId, id) {
      return readFile(pathFor(userId, id));
    },
    async remove(userId, id) {
      await rm(pathFor(userId, id), { force: true });
      await rm(pathFor(userId, id, TEMP_SUFFIX), { force: true });
    },
    async *listAll() {
      let users: string[];
      try {
        users = await readdir(dir);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw err;
      }
      for (const userId of users) {
        if (!ATTACHMENT_ID_RE.test(userId)) continue;
        let names: string[];
        try {
          names = await readdir(path.join(dir, userId));
        } catch {
          continue;
        }
        for (const name of names) {
          const temp = name.endsWith(TEMP_SUFFIX);
          const id = temp ? name.slice(0, -TEMP_SUFFIX.length) : name;
          if (!ATTACHMENT_ID_RE.test(id)) continue;
          const s = await stat(path.join(dir, userId, name)).catch(() => null);
          if (!s || !s.isFile()) continue;
          yield { userId, id, modifiedAt: s.mtime, temp };
        }
      }
    },
  };
}
