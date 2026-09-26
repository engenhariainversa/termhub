// The chips of the composer (spec 2026-09-26 §5.6): pure state over the contract's limits table, plus
// the hook the composer drives it with. React only, never react-native: the reducer and the checks run
// under the `logic` jest project.
import { useCallback, useEffect, useReducer, useRef } from 'react';
import { ATTACHMENT_LIMITS, MAX_ATTACHMENTS_PER_MESSAGE, attachmentStatusText, formatBytes, kindFromNameAndMime, type AttachmentKind } from '@termhub/mobile-api';
import type { TChatAttachment } from '@/services/api/contract';
import { ApiError } from '@/services/api/errors';
import type { UploadFile } from '@/services/api/types';
import { CHAT_MSG } from '../model/messages';

// The pt-BR copy lives in the contract package, shared with whatever else speaks about a file.
export { attachmentStatusText, formatBytes };

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
  | { type: 'clear' };

/** The refusal before any upload, or the kind it will upload as. An unknown size is let through: the server measures it. */
export function checkPick(file: PickedFile): { kind: AttachmentKind } | { refused: string } {
  const ext = (/\.[a-z0-9]+$/i.exec(file.name)?.[0] ?? '').toLowerCase();
  if (ext === '.doc' || ext === '.xls') return { refused: CHAT_MSG.attachmentLegacyOffice };
  const kind = kindFromNameAndMime(file.name, file.mime);
  if (!kind) return { refused: CHAT_MSG.attachmentType };
  if (file.bytes !== null && file.bytes > ATTACHMENT_LIMITS[kind]) return { refused: `${CHAT_MSG.attachmentTooLarge} ${formatBytes(ATTACHMENT_LIMITS[kind])}` };
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
  }
}

export const isUploading = (drafts: DraftAttachment[]): boolean => drafts.some((d) => d.phase === 'uploading');
export const uploadedAttachments = (drafts: DraftAttachment[]): TChatAttachment[] => drafts.flatMap((d) => (d.phase === 'uploaded' && d.attachment ? [d.attachment] : []));

export interface AttachmentDeps {
  upload(file: PickedFile, onProgress: (fraction: number) => void): Promise<TChatAttachment>;
  remove(id: string): Promise<void>;
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
      const attachment = await depsRef.current.upload(draft.file, (fraction) => dispatch({ type: 'progress', key: draft.key, fraction }));
      if (dropped.current.delete(draft.key)) {
        void depsRef.current.remove(attachment.id).catch(() => undefined);
        return;
      }
      dispatch({ type: 'uploaded', key: draft.key, attachment });
    } catch (e) {
      if (dropped.current.delete(draft.key)) return;
      dispatch({ type: 'failed', key: draft.key, error: e instanceof ApiError ? e.message : CHAT_MSG.attachmentUploadFailed });
    }
  }, []);

  const add = useCallback(
    (files: PickedFile[]) => {
      const before = latest.current;
      const { drafts: next, notice } = planAdd(before, files, () => `d${++seq.current}`);
      setNotice(notice);
      if (next.length === before.length) return;
      dispatch({ type: 'add', drafts: next });
      for (const draft of next.slice(before.length)) if (!draft.refused) void upload(draft);
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

  return { drafts, notice: noticeRef.current, uploading: isUploading(drafts), uploaded: uploadedAttachments(drafts), add, remove, retry, clear };
}
