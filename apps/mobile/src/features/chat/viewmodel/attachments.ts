// The chips of the composer (spec 2026-09-26 §5.6): pure state over the contract's limits table, plus
// the hook the composer drives it with. React only, never react-native: the reducer and the checks run
// under the `logic` jest project.
import { useCallback, useEffect, useReducer, useRef } from 'react';
import { ATTACHMENT_LIMITS, MAX_ATTACHMENTS_PER_MESSAGE, kindFromNameAndMime, type AttachmentKind } from '@termhub/mobile-api';
import { t, tk } from '@/i18n';
import { formatNumber } from '@/i18n/format';
import type { TChatAttachment } from '@/services/api/contract';
import { ApiError } from '@/services/api/errors';
import type { UploadFile } from '@/services/api/types';
import { attachmentTooLargeText, CHAT_MSG } from '../model/messages';

// The contract package keeps a pt-BR copy of these two (`formatBytes`, `attachmentStatusText`) for the
// server and the web; the app has its own, the same words in the language it shows.

/** `512 B`, `1,2 KB` / `1.2 KB`, `10 MB`: the decimal separator of the language the app shows. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  const text = value >= 100 || Number.isInteger(value) ? String(Math.round(value)) : formatNumber(value, { minimumFractionDigits: 1, maximumFractionDigits: 1, useGrouping: false });
  return `${text} ${units[i]}`;
}

/** Why an extraction gave up, by the server's error code (`ExtractError`): translation keys. */
const ATTACHMENT_FAILURE_REASON: Record<string, string> = {
  ATTACHMENT_INVALID: tk('arquivo inválido'),
  TRANSCRIPTION_UNAVAILABLE: tk('transcrição indisponível'),
  TRANSCRIPTION_FAILED: tk('transcrição falhou'),
};

/** TRANSCRIPTION_UNAVAILABLE by the server's `meta.reason` (TER-1035): what went wrong with whisper. */
const TRANSCRIPTION_REASON: Record<string, string> = {
  not_configured: tk('transcrição desligada neste servidor'),
  refused: tk('o serviço de transcrição recusou o acesso'),
  unreachable: tk('serviço de transcrição fora do ar'),
  error: tk('o serviço de transcrição deu erro'),
};

/** The line under a chip or a bubble's attachment while the server works on it, or after it gave up. */
export function attachmentStatusText(a: Pick<TChatAttachment, 'kind' | 'status' | 'error_code'> & { meta?: TChatAttachment['meta'] }): string | null {
  if (a.status === 'pending') return a.kind === 'audio' || a.kind === 'video' ? t('transcrevendo…') : t('processando…');
  if (a.status === 'failed') {
    const why = a.error_code === 'TRANSCRIPTION_UNAVAILABLE' && typeof a.meta?.reason === 'string' ? TRANSCRIPTION_REASON[a.meta.reason] : undefined;
    const reason = why ?? (a.error_code ? ATTACHMENT_FAILURE_REASON[a.error_code] : undefined);
    return t('falhou: {{reason}}', { reason: t(reason ?? tk('erro')) });
  }
  return null;
}

/** A transcription whisper could not do can be asked again; a file it could not decode cannot (the web's `canRetryAttachment`). */
export function canRetryAttachment(a: Pick<TChatAttachment, 'kind' | 'status' | 'error_code'>): boolean {
  return a.status === 'failed' && a.error_code === 'TRANSCRIPTION_UNAVAILABLE' && (a.kind === 'audio' || a.kind === 'video');
}

/** A file as a picker handed it over; the size is unknown for some (a fresh recording). */
export interface PickedFile extends UploadFile {
  bytes: number | null;
}

export interface DraftAttachment {
  key: string;
  file: PickedFile;
  kind: AttachmentKind | null;
  phase: 'uploading' | 'uploaded' | 'failed';
  /** 0..1 while uploading. */
  progress: number;
  attachment: TChatAttachment | null;
  error: string | null;
  /** Refused here before any upload (type, size): nothing to retry. */
  refused: boolean;
}

export type DraftAction =
  | { type: 'add'; drafts: DraftAttachment[] }
  | { type: 'progress'; key: string; fraction: number }
  | { type: 'uploaded'; key: string; attachment: TChatAttachment }
  | { type: 'failed'; key: string; error: string }
  | { type: 'retry'; key: string }
  | { type: 'remove'; key: string }
  /** The chips a send carried: gone without a server-side delete (the message owns them now). */
  | { type: 'drop'; keys: string[] }
  | { type: 'clear' }
  /** What the socket heard (`attachment_status`), by id: an uploaded chip moves to it (the web's `useAttachmentDrafts`). */
  | { type: 'statuses'; statuses: Readonly<Record<string, TChatAttachment>> };

/** Whether `heard` says something new about `current`: an extraction ended, or gave up. */
export const newsFor = (current: TChatAttachment, heard: TChatAttachment | undefined): heard is TChatAttachment =>
  heard !== undefined && (heard.status !== current.status || heard.error_code !== current.error_code);

/** The refusal before any upload, or the kind it will upload as. An unknown size is let through: the server measures it. */
export function checkPick(file: PickedFile): { kind: AttachmentKind } | { refused: string } {
  const ext = (/\.[a-z0-9]+$/i.exec(file.name)?.[0] ?? '').toLowerCase();
  if (ext === '.doc' || ext === '.xls') return { refused: CHAT_MSG.attachmentLegacyOffice };
  const kind = kindFromNameAndMime(file.name, file.mime);
  if (!kind) return { refused: CHAT_MSG.attachmentType };
  if (file.bytes !== null && file.bytes > ATTACHMENT_LIMITS[kind]) return { refused: attachmentTooLargeText(formatBytes(ATTACHMENT_LIMITS[kind])) };
  return { kind };
}

/** The drafts after adding `picked`: refusals become failed chips, and past five the rest is dropped with a notice. */
export function planAdd(existing: DraftAttachment[], picked: PickedFile[], nextKey: () => string): { drafts: DraftAttachment[]; notice: string | null } {
  const room = Math.max(0, MAX_ATTACHMENTS_PER_MESSAGE - existing.length);
  const added = picked.slice(0, room).map((file): DraftAttachment => {
    const check = checkPick(file);
    const refused = 'refused' in check;
    return { key: nextKey(), file, kind: refused ? null : check.kind, phase: refused ? 'failed' : 'uploading', progress: 0, attachment: null, error: refused ? check.refused : null, refused };
  });
  return { drafts: [...existing, ...added], notice: picked.length > room ? CHAT_MSG.attachmentTooMany : null };
}

export function draftsReducer(drafts: DraftAttachment[], action: DraftAction): DraftAttachment[] {
  const patch = (key: string, p: Partial<DraftAttachment>) => (drafts.some((d) => d.key === key) ? drafts.map((d) => (d.key === key ? { ...d, ...p } : d)) : drafts);
  switch (action.type) {
    case 'add':
      return action.drafts;
    case 'progress':
      return patch(action.key, { progress: action.fraction });
    case 'uploaded':
      return patch(action.key, { phase: 'uploaded', progress: 1, attachment: action.attachment, error: null });
    case 'failed':
      return patch(action.key, { phase: 'failed', error: action.error, refused: false });
    case 'retry':
      return patch(action.key, { phase: 'uploading', progress: 0, error: null, attachment: null });
    case 'remove':
      return drafts.some((d) => d.key === action.key) ? drafts.filter((d) => d.key !== action.key) : drafts;
    case 'drop':
      return drafts.some((d) => action.keys.includes(d.key)) ? drafts.filter((d) => !action.keys.includes(d.key)) : drafts;
    case 'clear':
      return drafts.length === 0 ? drafts : [];
    case 'statuses': {
      let changed = false;
      const next = drafts.map((d) => {
        if (d.phase !== 'uploaded' || !d.attachment) return d;
        const heard = action.statuses[d.attachment.id];
        if (!newsFor(d.attachment, heard)) return d;
        changed = true;
        return { ...d, attachment: heard };
      });
      return changed ? next : drafts;
    }
  }
}

const isDimension = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;

/**
 * The size a thumbnail takes before its file loads (TER-197): the image's own proportion, scaled down
 * to fit `box`, each side at least `min` (the rest is cropped by object-cover). Null when the server has
 * not (or could not) read the dimensions; the caller then keeps its unsized layout. The web keeps a copy.
 */
export function thumbSize(meta: Record<string, unknown> | null, box: number, min: number): { width: number; height: number } | null {
  const width = meta?.width;
  const height = meta?.height;
  if (!isDimension(width) || !isDimension(height)) return null;
  const scale = Math.min(1, box / width, box / height);
  const fit = (v: number) => Math.min(box, Math.max(min, Math.round(v * scale)));
  return { width: fit(width), height: fit(height) };
}

export const isUploading = (drafts: DraftAttachment[]): boolean => drafts.some((d) => d.phase === 'uploading');
export const uploadedAttachments = (drafts: DraftAttachment[]): TChatAttachment[] => drafts.flatMap((d) => (d.phase === 'uploaded' && d.attachment ? [d.attachment] : []));
/** The uploaded chips the server will refuse to send (`isAttachable`): a file it could not read. A failed transcription is still sendable. */
export const invalidAttachments = (drafts: DraftAttachment[]): TChatAttachment[] => uploadedAttachments(drafts).filter((a) => a.status === 'failed' && a.error_code === 'ATTACHMENT_INVALID');

export interface AttachmentDeps {
  upload(file: PickedFile, onProgress: (fraction: number) => void): Promise<TChatAttachment>;
  remove(id: string): Promise<void>;
  /** The statuses the store heard over the socket, by id (`attachmentStatuses`). */
  statuses?: Readonly<Record<string, TChatAttachment>>;
}

/**
 * The composer's chips: each pick uploads at once; ✕ drops a chip (an upload task cannot be cancelled,
 * so one still on the wire is deleted server-side the moment it lands); `clear(keys)` after a send that
 * was accepted — only the chips it carried, one picked while the send was in flight stays. Same rules
 * as the web's `useAttachmentDrafts`.
 */
export function useAttachmentDrafts(deps: AttachmentDeps) {
  const [drafts, dispatch] = useReducer(draftsReducer, []);
  const noticeRef = useRef<string | null>(null);
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const seq = useRef(0);
  const latest = useRef(drafts);
  latest.current = drafts;
  /** Chips removed while their upload was still running: delete what lands. */
  const dropped = useRef(new Set<string>());
  const depsRef = useRef(deps);
  depsRef.current = deps;

  const setNotice = (notice: string | null) => {
    noticeRef.current = notice;
    bump();
  };

  const upload = useCallback(async (draft: DraftAttachment) => {
    try {
      const stored = await depsRef.current.upload(draft.file, (fraction) => dispatch({ type: 'progress', key: draft.key, fraction }));
      if (dropped.current.delete(draft.key)) {
        void depsRef.current.remove(stored.id).catch(() => undefined);
        return;
      }
      // A small file can be extracted before this answer is read: a status heard meanwhile is the newer word.
      const heard = depsRef.current.statuses?.[stored.id];
      dispatch({ type: 'uploaded', key: draft.key, attachment: newsFor(stored, heard) ? heard : stored });
    } catch (e) {
      if (dropped.current.delete(draft.key)) return;
      dispatch({ type: 'failed', key: draft.key, error: e instanceof ApiError ? e.message : CHAT_MSG.attachmentUploadFailed });
    }
  }, []);

  /** Answers the keys of the chips it added (none past the limit), so a caller can follow its own. */
  const add = useCallback(
    (files: PickedFile[]): string[] => {
      const before = latest.current;
      const { drafts: next, notice } = planAdd(before, files, () => `d${++seq.current}`);
      setNotice(notice);
      if (next.length === before.length) return [];
      dispatch({ type: 'add', drafts: next });
      const added = next.slice(before.length);
      for (const draft of added) if (!draft.refused) void upload(draft);
      return added.map((d) => d.key);
    },
    [upload],
  );

  const remove = useCallback((key: string) => {
    const draft = latest.current.find((d) => d.key === key);
    if (!draft) return;
    dispatch({ type: 'remove', key });
    if (draft.phase === 'uploading') dropped.current.add(key);
    else if (draft.phase === 'uploaded' && draft.attachment) void depsRef.current.remove(draft.attachment.id).catch(() => undefined);
  }, []);

  const retry = useCallback(
    (key: string) => {
      const draft = latest.current.find((d) => d.key === key);
      if (!draft || draft.phase !== 'failed' || draft.refused) return;
      dispatch({ type: 'retry', key });
      void upload({ ...draft, phase: 'uploading', progress: 0, error: null, attachment: null });
    },
    [upload],
  );

  // The statuses the store hears over the socket, applied to the chips that have landed.
  const statuses = deps.statuses;
  useEffect(() => {
    if (statuses) dispatch({ type: 'statuses', statuses });
  }, [statuses]);

  const clear = useCallback((keys?: string[]) => {
    dispatch(keys ? { type: 'drop', keys } : { type: 'clear' });
    setNotice(null);
  }, []);

  // Unmounted mid-upload (the screen closed): whatever lands is deleted; the server sweeps the rest.
  useEffect(
    () => () => {
      for (const d of latest.current) if (d.phase === 'uploading') dropped.current.add(d.key);
    },
    [],
  );

  return { drafts, notice: noticeRef.current, uploading: isUploading(drafts), uploaded: uploadedAttachments(drafts), invalid: invalidAttachments(drafts), add, remove, retry, clear };
}
