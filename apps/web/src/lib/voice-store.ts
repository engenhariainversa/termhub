import { i18n } from '../i18n';
/**
 * Browser-side safety net for dictation: every second of audio the recorder produces is written to
 * IndexedDB, so a page refresh (or a crashed tab) mid-recording or mid-transcription does not lose
 * the clip. One clip per terminal tab; cleared once its text has been pasted.
 */

const DB_NAME = 'termhub-voice';
const DB_VERSION = 1;
const CLIPS = 'clips';
const CHUNKS = 'chunks';

export interface StoredClip {
  tabId: string;
  mime: string;
  /** recorder start, ms since epoch */
  startedAt: number;
  /** seconds recorded (updated as chunks land) */
  seconds: number;
  /** server job id once the upload was accepted — the page can resume polling instead of re-uploading */
  jobId?: string;
  /** set when the recorder stopped normally (false = the page died while still recording) */
  finished: boolean;
}

interface StoredChunk {
  tabId: string;
  seq: number;
  data: Blob;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error(i18n.t('IndexedDB indisponível')));
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(CLIPS)) db.createObjectStore(CLIPS, { keyPath: 'tabId' });
      if (!db.objectStoreNames.contains(CHUNKS)) db.createObjectStore(CHUNKS, { keyPath: ['tabId', 'seq'] });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error(i18n.t('IndexedDB falhou')));
    req.onblocked = () => reject(new Error(i18n.t('IndexedDB bloqueado')));
  });
  dbPromise.catch(() => (dbPromise = null));
  return dbPromise;
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error(i18n.t('IndexedDB falhou')));
    tx.onabort = () => reject(tx.error ?? new Error(i18n.t('IndexedDB abortou')));
  });
}

function result<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error(i18n.t('IndexedDB falhou')));
  });
}

/** Whole-tab key range for the chunks store ([tabId, 0] .. [tabId, ∞)). */
const chunkRange = (tabId: string) => IDBKeyRange.bound([tabId, 0], [tabId, Number.MAX_SAFE_INTEGER]);

/** All writes are best effort: dictation must keep working when storage is unavailable (private mode, quota). */
async function attempt<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch {
    return undefined;
  }
}

export const voiceStore = {
  /** Starts a fresh clip for the tab (drops any leftover). */
  begin: (clip: StoredClip) =>
    attempt(async () => {
      const db = await open();
      const tx = db.transaction([CLIPS, CHUNKS], 'readwrite');
      tx.objectStore(CHUNKS).delete(chunkRange(clip.tabId));
      tx.objectStore(CLIPS).put(clip);
      await done(tx);
    }),

  /** Appends one recorder chunk and bumps the recorded length. */
  append: (tabId: string, seq: number, data: Blob, seconds: number) =>
    attempt(async () => {
      const db = await open();
      const tx = db.transaction([CLIPS, CHUNKS], 'readwrite');
      tx.objectStore(CHUNKS).put({ tabId, seq, data } satisfies StoredChunk);
      const clips = tx.objectStore(CLIPS);
      const clip = (await result(clips.get(tabId))) as StoredClip | undefined;
      if (clip) clips.put({ ...clip, seconds });
      await done(tx);
    }),

  /** Updates the clip's metadata (finished flag, job id). */
  update: (tabId: string, patch: Partial<StoredClip>) =>
    attempt(async () => {
      const db = await open();
      const tx = db.transaction(CLIPS, 'readwrite');
      const clips = tx.objectStore(CLIPS);
      const clip = (await result(clips.get(tabId))) as StoredClip | undefined;
      if (clip) clips.put({ ...clip, ...patch });
      await done(tx);
    }),

  /** The clip left behind for this tab, if any, with its audio reassembled. */
  load: (tabId: string) =>
    attempt(async (): Promise<{ clip: StoredClip; audio: Blob } | null> => {
      const db = await open();
      const tx = db.transaction([CLIPS, CHUNKS], 'readonly');
      const clip = (await result(tx.objectStore(CLIPS).get(tabId))) as StoredClip | undefined;
      if (!clip) return null;
      const chunks = (await result(tx.objectStore(CHUNKS).getAll(chunkRange(clip.tabId)))) as StoredChunk[];
      chunks.sort((a, b) => a.seq - b.seq);
      return { clip, audio: new Blob(chunks.map((c) => c.data), { type: clip.mime }) };
    }),

  clear: (tabId: string) =>
    attempt(async () => {
      const db = await open();
      const tx = db.transaction([CLIPS, CHUNKS], 'readwrite');
      tx.objectStore(CHUNKS).delete(chunkRange(tabId));
      tx.objectStore(CLIPS).delete(tabId);
      await done(tx);
    }),
};
