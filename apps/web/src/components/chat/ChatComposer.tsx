import { i18n, tk, useTranslation } from '../../i18n';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AudioLines, Paperclip, Trash2 } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useChatInbox } from '../../lib/chat-inbox';
import { ACCEPT_ATTRIBUTE, MAX_ATTACHMENTS_PER_MESSAGE, attachmentStatusText, checkFile, type AttachmentKind } from '../../lib/attachments';
import { sendsMessage } from '../../lib/chat-scroll';
import { downscaleImage } from '../../lib/image-downscale';
import type { ReplyTarget } from '../../lib/chat-reply';
import type { ChatAttachment, ReplyCardKind } from '../../lib/types';
import { useDictation, type Dictation } from '../../lib/use-dictation';
import type { Clip } from '../../lib/voice-recorder';
import { useVoiceNote } from '../../lib/use-voice-note';
import { AttachmentChip } from './AttachmentChip';

export interface ChatComposerProps {
  /**
   * Sends what is in the box, with the ids of the uploaded attachments (none until the attachment
   * chips land). The box is emptied the moment this is called — a box that keeps the sent text until
   * the server answers reads as a chat that swallowed the message — and the text comes back when this
   * resolves `false` (or throws), unless something new was typed meanwhile. Several sends may be in
   * flight at once: an answer being written never locks the box (spec 2026-09-26, concierge always free).
   */
  onSend: (text: string, attachmentIds: string[], replyToId?: string) => Promise<boolean>;
  /** The message the next send answers (TER-447): previewed above the text, its id sent with it. */
  replyTo?: ReplyTarget | null;
  /** ✕ on the preview, or Esc in the box. */
  onCancelReply?: () => void;
  /**
   * Why nothing can be sent right now — the chat's host cannot run it (no machine, none chosen, one
   * that is asleep, an agent too old). The button refuses and this is the reason it shows: a box that
   * goes grey with no explanation is the one thing this screen must never do. The text itself stays
   * editable, so a message can be typed while the machine is being woken up.
   */
  blockedReason?: string | null;
  /** The last send or decision error (pt-BR), shown in the status line in the danger colour. */
  status?: string | null;
  /** Something the panel has to say that is not an error ("Compactando…"), below `status` in rank. */
  notice?: string | null;
  /** The project whose chat this is; travels with every upload so the file lands in that conversation. */
  projectId?: string | null;
  /**
   * The latest `attachment_status` the panel saw for each attachment, by id. A chip whose upload has
   * landed learns from it that the server finished with the file ("processando…" goes) or gave up
   * ("falhou: …"); the panel keeps the socket, so it is the panel that hears the event.
   */
  attachmentStatuses?: Readonly<Record<string, ChatAttachment>>;
}

/** The preview's heading for a card being answered (TER-849). */
const CARD_HEADING: Record<ReplyCardKind, string> = { action: tk('Respondendo à confirmação'), tab_question: tk('Respondendo à pergunta da aba') };

const MIN_ROWS = 1;
const MAX_ROWS = 8;
/** What a line is taken to measure when the box has no computed line height (jsdom). */
const FALLBACK_LINE_PX = 24;

/**
 * Appends a transcription to whatever is already in the box.
 *
 * Whisper returns its own leading/trailing spaces, so the clip is trimmed and a single space is
 * inserted, except when the box is empty (no leading space) or already ends in whitespace, where the
 * separator the person typed is kept exactly: a newline they wrote stays a newline. A clip that trims
 * away to nothing (silence, a stray tap) leaves the box untouched.
 *
 * Dictation has its own button beside the paperclip (TER-1036), there with or without text, so a
 * clip often lands after something typed: that is what the joining branch is for.
 */
function appendDictated(current: string, text: string): string {
  const clip = text.trim();
  if (!clip) return current;
  if (!current) return clip;
  return /\s$/.test(current) ? current + clip : `${current} ${clip}`;
}

/** Whole seconds as `m:ss` — 65 reads as `1:05`, the way a stopwatch is read. */
function formatClock(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * What the single circular button does right now. Exactly one of these, in every state: `record` is
 * the voice note held on it (TER-1036), `sendVoice` sends a locked one, `stop` ends a dictation.
 */
type PrimaryRole = 'record' | 'send' | 'stop' | 'sendVoice';

const PRIMARY_LABEL: Record<PrimaryRole, string> = {
  record: tk('Gravar áudio'),
  send: tk('Enviar'),
  stop: tk('Parar'),
  sendVoice: tk('Enviar áudio'),
};

/** A hold dragged this far to the left drops the recording; this far up, locks it (WhatsApp's). */
const CANCEL_DRAG_PX = 100;
const LOCK_DRAG_PX = 70;

/** `audio-2026-10-07-14-03-55.webm`: the voice note's file name, by the container the browser recorded. */
function voiceNoteFile(clip: Clip): File {
  const type = clip.audio.type.split(';')[0].trim() || 'audio/webm';
  const ext = type === 'audio/mp4' ? 'm4a' : type === 'audio/ogg' ? 'ogg' : 'webm';
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return new File([clip.audio], `audio-${stamp}.${ext}`, { type });
}

/** One file in the box, from the moment it was picked until the message that carries it is sent. */
interface DraftAttachment {
  key: string;
  file: File;
  name: string;
  kind: AttachmentKind | null;
  bytes: number;
  /** Object URL of an image, for its thumbnail; revoked when the chip goes. */
  previewUrl: string | null;
  phase: 'uploading' | 'uploaded' | 'failed';
  /** 0..1 while uploading. */
  progress: number;
  attachment: ChatAttachment | null;
  error: string | null;
  /** The box refused it before any upload (type, size): there is nothing to retry. */
  refused: boolean;
  controller: AbortController | null;
}

function revokePreview(d: DraftAttachment) {
  if (d.previewUrl) URL.revokeObjectURL(d.previewUrl);
}

/**
 * What ✕ does to a chip, wherever the chip goes for good: its thumbnail is released, an upload on the
 * wire is aborted, and one already on the server is deleted there too, quietly — the sweep would get
 * it anyway after 24 h.
 */
function discard(d: DraftAttachment) {
  revokePreview(d);
  if (d.phase === 'uploading') d.controller?.abort();
  else if (d.phase === 'uploaded' && d.attachment) void api.chat.attachments.remove(d.attachment.id).catch(() => undefined);
}

/** Whether a status the panel heard says something this chip's attachment does not already say. */
function newsFor(current: ChatAttachment, heard: ChatAttachment | undefined): heard is ChatAttachment {
  return heard !== undefined && (heard.status !== current.status || heard.error_code !== current.error_code);
}

/**
 * The chips of the box (spec §5.6): each file uploads the moment it is added, with progress; ✕ aborts
 * or deletes; a message can only leave once every chip has landed. Lives here, not in `ChatPanel`, for
 * the same reason the text does: a percentage ticking must not re-render the thread.
 */
function useAttachmentDrafts(projectId: string | null | undefined, statuses: Readonly<Record<string, ChatAttachment>> | undefined) {
  const [drafts, setDrafts] = useState<DraftAttachment[]>([]);
  /** The one line the box has to say about a batch of files ("No máximo 5…"); cleared on the next add or remove. */
  const [notice, setNotice] = useState<string | null>(null);
  const seq = useRef(0);
  const latest = useRef(drafts);
  latest.current = drafts;
  const heard = useRef(statuses);
  heard.current = statuses;

  const patch = useCallback((key: string, p: Partial<DraftAttachment>) => setDrafts((prev) => prev.map((d) => (d.key === key ? { ...d, ...p } : d))), []);

  const upload = useCallback(
    async (draft: DraftAttachment) => {
      const controller = new AbortController();
      patch(draft.key, { phase: 'uploading', progress: 0, error: null, attachment: null, controller });
      try {
        const body = draft.kind === 'image' ? await downscaleImage(draft.file) : draft.file;
        if (controller.signal.aborted) return;
        const name = body === draft.file ? draft.name : body.name;
        const { attachment: stored } = await api.chat.attachments.upload(body, name, projectId ?? null, (fraction) => patch(draft.key, { progress: fraction }), controller.signal);
        // A small file can be extracted before this response is read: a status heard meanwhile is
        // the newer word. The name and size are the server's (an image went up downscaled).
        const status = heard.current?.[stored.id];
        const attachment = newsFor(stored, status) ? status : stored;
        patch(draft.key, { phase: 'uploaded', progress: 1, attachment, name: attachment.name, bytes: attachment.bytes, controller: null });
      } catch (e) {
        // Aborted by ✕: the chip is already gone, nothing to report.
        if (e instanceof ApiError && e.code === 'ABORTED') return;
        patch(draft.key, { phase: 'failed', controller: null, error: e instanceof ApiError ? e.message : i18n.t('Não foi possível enviar o arquivo') });
      }
    },
    [patch, projectId],
  );

  // The statuses the panel hears over the socket, applied to the chips that have landed. The list is
  // only replaced when some chip has news, so a status for a chip already sent re-renders nothing.
  useEffect(() => {
    if (!statuses) return;
    setDrafts((prev) => {
      let changed = false;
      const next = prev.map((d) => {
        if (d.phase !== 'uploaded' || !d.attachment) return d;
        const status = statuses[d.attachment.id];
        if (!newsFor(d.attachment, status)) return d;
        changed = true;
        return { ...d, attachment: status };
      });
      return changed ? next : prev;
    });
  }, [statuses]);

  const add = useCallback(
    (files: Iterable<File>): string[] => {
      const list = [...files];
      if (list.length === 0) return [];
      const room = MAX_ATTACHMENTS_PER_MESSAGE - latest.current.length;
      setNotice(list.length > room ? i18n.t('No máximo {{max}} anexos por mensagem', { max: MAX_ATTACHMENTS_PER_MESSAGE }) : null);
      const next: DraftAttachment[] = list.slice(0, Math.max(0, room)).map((file) => {
        const check = checkFile(file.name, file.type, file.size);
        const refused = 'refused' in check;
        const kind = refused ? null : check.kind;
        seq.current += 1;
        return {
          key: `d${seq.current}`,
          file,
          name: file.name,
          kind,
          bytes: file.size,
          previewUrl: kind === 'image' ? URL.createObjectURL(file) : null,
          phase: refused ? 'failed' : 'uploading',
          progress: 0,
          attachment: null,
          error: refused ? check.refused : null,
          refused,
          controller: null,
        };
      });
      if (next.length === 0) return [];
      setDrafts((prev) => [...prev, ...next]);
      for (const draft of next) if (!draft.refused) void upload(draft);
      return next.map((d) => d.key);
    },
    [upload],
  );

  const remove = useCallback((key: string) => {
    const draft = latest.current.find((d) => d.key === key);
    if (!draft) return;
    setDrafts((prev) => prev.filter((d) => d.key !== key));
    // The cap's notice was about a box that is one chip lighter now.
    setNotice(null);
    discard(draft);
  }, []);

  const retry = useCallback(
    (key: string) => {
      const draft = latest.current.find((d) => d.key === key);
      if (draft && draft.phase === 'failed' && !draft.refused) void upload(draft);
    },
    [upload],
  );

  /**
   * Takes the chips out of the box the moment the message leaves, the way the text goes (see
   * `onSend`): `commit` lets them go once the message is in, `restore` puts them back in front of
   * whatever was added meanwhile when it was not — capped at the limit, the surplus (the newest of
   * what was added meanwhile) dropped the way ✕ drops a chip: aborted or deleted, never left on the
   * server as an orphan the sweep has to find. With `keys`, only those chips go (a voice note leaves
   * on its own, whatever else was added meanwhile).
   */
  const take = useCallback((keys?: string[]) => {
    const taken = keys ? latest.current.filter((d) => keys.includes(d.key)) : latest.current;
    setDrafts((prev) => (keys ? prev.filter((d) => !keys.includes(d.key)) : []));
    setNotice(null);
    return {
      commit() {
        for (const d of taken) revokePreview(d);
      },
      restore() {
        // Read outside the updater, whose body must stay pure: aborting and deleting are effects.
        const merged = [...taken, ...latest.current];
        for (const d of merged.slice(MAX_ATTACHMENTS_PER_MESSAGE)) discard(d);
        setDrafts(merged.slice(0, MAX_ATTACHMENTS_PER_MESSAGE));
      },
    };
  }, []);

  // Unmounted mid-upload (the chat closed, or was pushed out of the kept-mounted chats): nothing keeps
  // uploading into a box that is gone. What landed and was never sent is swept by the server after 24 h.
  useEffect(
    () => () => {
      for (const d of latest.current) {
        d.controller?.abort();
        revokePreview(d);
      }
    },
    [],
  );

  return { drafts, notice, add, remove, retry, take };
}

/**
 * The message box and its one action button. Owns its text, its height and its dictation — the panel
 * only learns of the text when it is sent, so a keystroke re-renders this box and nothing else.
 *
 * Grows with the content up to `MAX_ROWS` and then scrolls: no library and no hidden mirror element.
 * The height is measured in a layout effect (`height: auto`, then the box's own `scrollHeight` capped
 * at eight lines), so it is set before paint — the box never shows at the old height for a frame, and
 * there is no `rows` round trip. jsdom lays nothing out (`scrollHeight` is 0 and no line height is
 * computed), so the measurement floors at one line of a fallback height.
 *
 * Enter sends on a fine pointer (a mouse) and writes a newline on a coarse one (a touch keyboard,
 * where Enter is how every other line got started); Shift+Enter is always a newline, on either. Either
 * way it can only send what the button itself would send.
 *
 * An empty box makes the button a microphone for voice notes, WhatsApp's way (TER-1036): hold to
 * record, let go to send, drag left to drop it, drag up to lock it (then Descartar / Enviar áudio); a
 * click only says "Segure para gravar". The microphone is only asked for once a hold starts recording.
 * The note goes as an audio attachment, which the server transcribes like any other.
 */
export function ChatComposer({ onSend, replyTo = null, onCancelReply, blockedReason, status, notice, projectId, attachmentStatuses }: ChatComposerProps) {
  const { t } = useTranslation();
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const attachments = useAttachmentDrafts(projectId, attachmentStatuses);
  // A file sent here from a preview ("Mandar para o chat") lands as a chip, like a dropped one.
  useChatInbox(projectId ?? null, (files) => attachments.add(files));
  const uploading = attachments.drafts.some((d) => d.phase === 'uploading');
  const uploadedIds = useMemo(() => attachments.drafts.flatMap((d) => (d.phase === 'uploaded' && d.attachment ? [d.attachment.id] : [])), [attachments.drafts]);
  /** A chip that is not a refusal counts as content: a box with one is a box about to send. */
  const hasChips = attachments.drafts.some((d) => d.phase !== 'failed');

  // The hook keeps the latest callback; the functional update reads the box as it is when the clip lands.
  const dictation = useDictation((clip) => {
    setText((current) => appendDictated(current, clip));
    // The button the person just pressed is disabled by now and about to change role, so a browser
    // has already dropped focus to `body` — a keyboard user would lose their place at the exact
    // moment the text appears. The box is also where they want to be: what anyone does with a
    // transcription is read it and fix it.
    ref.current?.focus();
  });

  // The voice note (TER-1036): the clip goes into the box as a chip, uploads like any file, and leaves on
  // its own the moment it has landed. A failed upload keeps the chip, with its retry and the send
  // arrow, so a recording is never lost to a network blip.
  const voiceKey = useRef<string | null>(null);
  const voiceNote = useVoiceNote((clip) => {
    voiceKey.current = attachments.add([voiceNoteFile(clip)])[0] ?? null;
  });
  const replyRef = useRef(replyTo);
  replyRef.current = replyTo;
  const onSendRef = useRef(onSend);
  onSendRef.current = onSend;
  useEffect(() => {
    const key = voiceKey.current;
    if (!key) return;
    const draft = attachments.drafts.find((d) => d.key === key);
    if (!draft || draft.phase === 'failed') {
      voiceKey.current = null;
      return;
    }
    if (draft.phase !== 'uploaded' || !draft.attachment) return;
    voiceKey.current = null;
    const id = draft.attachment.id;
    const taken = attachments.take([key]);
    const reply = replyRef.current;
    void (async () => {
      let ok = false;
      try {
        ok = await (reply ? onSendRef.current('', [id], reply.id) : onSendRef.current('', [id]));
      } catch {
        ok = false;
      }
      if (ok) taken.commit();
      else taken.restore();
    })();
  }, [attachments]);
  /** Where the hold started, while the pointer is down on the microphone. */
  const held = useRef<{ x: number; y: number } | null>(null);
  /** The click that ends a hold which locked the recording is not a click on "Enviar áudio". */
  const swallowClick = useRef(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Collapsing the box to measure it also collapses how far it can be scrolled, and the browser
    // clamps `scrollTop` to that while it is collapsed — restoring the height does not bring the
    // scroll position back. Without this, a message past `MAX_ROWS` jumped to its first line on
    // every keystroke.
    const scrollTop = el.scrollTop;
    // `auto` first, so deleting a line shrinks the box back down too, not just growth.
    el.style.height = 'auto';
    const style = getComputedStyle(el);
    const lineHeight = parseFloat(style.lineHeight) || FALLBACK_LINE_PX;
    const vPadding = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
    const min = lineHeight * MIN_ROWS + vPadding;
    const max = lineHeight * MAX_ROWS + vPadding;
    el.style.height = `${Math.min(max, Math.max(min, el.scrollHeight))}px`;
    el.scrollTop = scrollTop;
  }, [text]);

  const hasText = text.trim().length > 0;
  /** The clip is on its way to the server: nothing else can be done with the box's content yet. */
  const busy = dictation.state === 'uploading' || dictation.state === 'transcribing';
  // Recording outranks the text: a box that is listening stops, it never sends mid-sentence. With
  // nothing typed the button dictates — unless dictation is off, where the empty box keeps the
  // ordinary (disabled) send button and nothing explains the missing microphone, because a browser
  // that cannot record is not a fault the person can fix from this screen. While the hook is still
  // `checking` the button is already the microphone, just disabled: dictation is what an empty box is
  // about to offer, and showing a send arrow for that instant only to swap it is a flicker. `starting`
  // is the same microphone, also disabled: the browser's permission sheet is up, nothing is listening
  // yet, and a button that looks pressable there does nothing when it is pressed.
  // A blocked host makes the button the (disabled) send arrow: dictating more text into a box that
  // cannot send it is an invitation to lose it. A recording already under way still stops, so nothing
  // is left listening.
  // A chip in the box (even one still uploading) is content too: the button is the send arrow.
  // A voice note under way keeps the microphone where the finger is (its pointer is captured there)
  // until it ends; a locked one turns it into its send button.
  const blocked = Boolean(blockedReason);
  const voiceActive = voiceNote.phase !== 'idle';
  const role: PrimaryRole =
    dictation.state === 'recording'
      ? 'stop'
      : voiceNote.phase === 'locked'
        ? 'sendVoice'
        : voiceActive
          ? 'record'
          : hasText || hasChips || blocked || dictation.state === 'off'
            ? 'send'
            : 'record';
  const notReadyToDictate = busy || dictation.state === 'checking' || dictation.state === 'starting';
  // Review Focus #2: nothing leaves while a chip is still on the wire.
  const disabled =
    role === 'stop' || role === 'sendVoice' ? false : role === 'send' ? blocked || !(hasText || uploadedIds.length > 0) || uploading || busy : !voiceActive && (blocked || notReadyToDictate);
  /** Dictation lives on its own button now (left of the row): the box's text, transcribed. */
  const dictateOff = blocked || notReadyToDictate || dictation.state === 'recording' || voiceActive;
  const sendingVoice = voiceKey.current !== null && attachments.drafts.some((d) => d.key === voiceKey.current && d.phase === 'uploading');
  /** The one condition sending obeys, so the keyboard can never send what the button would refuse. */
  const canSend = role === 'send' && !disabled;

  // Never refused for a send still in flight: the box empties at once, so a second click has nothing to
  // send, and a message typed meanwhile goes to the concierge at once (spec 2026-09-26).
  const send = useCallback(async () => {
    if (!canSend) return;
    const value = text.trim();
    // Cleared before the request, not after (see `onSend`). On failure the text and the chips come
    // back below.
    setText('');
    const taken = attachments.take();
    let ok = false;
    try {
      // The third argument only with a reply, so a plain send calls `onSend` exactly as before.
      ok = await (replyTo ? onSend(value, uploadedIds, replyTo.id) : onSend(value, uploadedIds));
    } catch {
      ok = false;
    }
    if (ok) {
      taken.commit();
      return;
    }
    // Give the text back so nothing is lost — unless something new was typed meanwhile.
    setText((current) => current || value);
    taken.restore();
  }, [canSend, text, uploadedIds, attachments, onSend, replyTo]);

  // Answering is about to be typed: the box takes the focus as the preview appears.
  const replyId = replyTo?.id;
  useEffect(() => {
    if (replyId) ref.current?.focus();
  }, [replyId]);

  // One line, fixed height, always mounted: what appears here moves nothing. The host's own reason
  // outranks everything (it is the one that is not going to resolve on its own); a chip still on the
  // wire comes next (it is why the button is refusing); then a clip being transcribed (its text is
  // about to land in this very box); then the last send or decision error; then the panel's own notice
  // (a compaction under way or just done); and last, what the box had to say about the files just
  // added (the cap). An answer being written never locks the box, so
  // nothing here says to wait for it (spec 2026-09-26).
  const line = blockedReason
    ? { text: blockedReason, danger: false }
    : voiceNote.hint
      ? { text: voiceNote.hint, danger: false }
      : uploading
        ? { text: sendingVoice ? t('enviando áudio…') : t('enviando anexo…'), danger: false }
        : busy
          ? { text: t('transcrevendo…'), danger: false }
          : status
            ? { text: status, danger: true }
            : notice
              ? { text: notice, danger: false }
              : { text: attachments.notice ?? '', danger: false };

  return (
    // `env(safe-area-inset-bottom)` resolves to 0px in every browser today, because the app-wide
    // viewport meta in `index.html` has no `viewport-fit=cover` — this padding is not protecting
    // anything yet, it is what becomes correct the day that meta changes (a change that touches the
    // terminal pages too, so it is not made here). The soft keyboard is a separate follow-up.
    <div className="mb-4 pb-[env(safe-area-inset-bottom)]">
      {/* One rounded box on the page background: the text on top, the action row beneath it (the
          attachment chips go above the text when they land). The box, not the textarea, shows the
          focus — the textarea's own outline would draw inside the rounded border, so it is dropped
          and the border lights up instead; a keyboard user must still see where they are. */}
      <div
        className="min-w-0 rounded-2xl border border-line bg-bg px-3 py-2 focus-within:border-accent focus-within:ring-1 focus-within:ring-accent"
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('Files')) e.preventDefault();
        }}
        onDrop={(e) => {
          if (e.dataTransfer.files.length === 0) return;
          e.preventDefault();
          attachments.add(e.dataTransfer.files);
        }}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          accept={ACCEPT_ATTRIBUTE}
          aria-label={t('Arquivos para anexar')}
          onChange={(e) => {
            if (e.target.files) attachments.add(e.target.files);
            // The same file picked twice must fire again.
            e.target.value = '';
          }}
        />
        {replyTo && (
          <div className="mb-2 flex items-start gap-2 rounded-lg border-l-2 border-accent bg-bg-3 px-2.5 py-1.5 text-xs">
            <div className="min-w-0 flex-1">
              <div className="font-medium text-accent">{replyTo.card ? t(CARD_HEADING[replyTo.card]) : replyTo.role === 'assistant' ? t('Respondendo a Concierge') : t('Respondendo a você')}</div>
              <div className="truncate text-fg-dim">{replyTo.excerpt}</div>
            </div>
            <button type="button" aria-label={t('Cancelar resposta')} onClick={onCancelReply} className="rounded px-1 text-fg-dim hover:text-fg">
              ✕
            </button>
          </div>
        )}
        <ul aria-label={t('Anexos')} className={`flex flex-wrap gap-2 ${attachments.drafts.length > 0 ? 'mb-2' : ''}`}>
          {attachments.drafts.map((d) => (
            <AttachmentChip
              key={d.key}
              name={d.name}
              kind={d.kind}
              bytes={d.bytes}
              previewUrl={d.previewUrl}
              phase={d.phase}
              progress={d.progress}
              statusText={d.attachment ? attachmentStatusText(d.attachment) : null}
              error={d.error}
              retryable={d.phase === 'failed' && !d.refused}
              onRemove={() => attachments.remove(d.key)}
              onRetry={() => attachments.retry(d.key)}
            />
          ))}
        </ul>
        {/* 16px, not the 14px the rest of the chat uses: iOS Safari zooms the page into any field
            whose font is under 16px the moment it takes focus, and a zoomed page is wider than the
            screen — which is what "the side blows out when I tap the box" was. The zoom is silent,
            irreversible without a pinch, and it also lets the whole page pan vertically afterwards. */}
        <textarea
          ref={ref}
          className="block w-full resize-none overflow-y-auto overscroll-contain border-0 bg-transparent px-0 py-1 text-base text-fg placeholder:text-fg-dim focus:outline-none"
          rows={MIN_ROWS}
          value={text}
          placeholder={t('Pergunte ou peça algo às suas máquinas')}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            // Files only; a text paste stays the browser's.
            const files = e.clipboardData?.files;
            if (!files || files.length === 0) return;
            e.preventDefault();
            attachments.add(files);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && replyTo) {
              e.preventDefault();
              onCancelReply?.();
              return;
            }
            // `canSend`, not just the key rule: while the box is recording the button reads "Parar",
            // and an Enter that still sent put a half-typed line in front of an agent that acts on the
            // person's real machines — with the transcription then landing in the box that send had
            // just emptied. Nothing is swallowed when it cannot send: the Enter stays the newline the
            // textarea would have written anyway.
            if (sendsMessage(e) && canSend) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div className="mt-1 flex items-center justify-between gap-2">
          {/* The left slot of the row: the attachment button, greyed once the box holds its five. */}
          <div className="flex items-center gap-1">
            <button
              type="button"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-fg-dim transition-colors hover:bg-bg-3 hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
              aria-label={t('Anexar arquivo')}
              title={t('Anexar arquivo')}
              disabled={attachments.drafts.length >= MAX_ATTACHMENTS_PER_MESSAGE}
              onClick={() => fileInputRef.current?.click()}
            >
              <Paperclip size={18} aria-hidden="true" />
            </button>
            {dictation.state !== 'off' && (
              <button
                type="button"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-fg-dim transition-colors hover:bg-bg-3 hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
                aria-label={t('Ditar')}
                title={t('Ditar')}
                disabled={dictateOff}
                onClick={dictation.start}
              >
                <AudioLines size={18} aria-hidden="true" />
              </button>
            )}
          </div>
          <div className="flex min-w-0 items-center gap-2">
            {dictation.state === 'recording' && <RecordingStatus dictation={dictation} />}
            {(voiceNote.phase === 'recording' || voiceNote.phase === 'locked') && (
              <VoiceNoteStatus seconds={voiceNote.seconds} locked={voiceNote.phase === 'locked'} onDiscard={voiceNote.cancel} />
            )}
            {/* Mounted at all times: a live region a browser inserts together with its text is not
                reliably announced — the region has to be in the accessibility tree before the text
                changes. Fixed height (`h-4`), so a line appearing here shifts nothing; `empty:-mr-2`
                so an empty one does not open a second gap between "cancelar" and the stop button
                while recording. Deliberately not on the clock next door: a live region that ticks
                every second is worse than one that says nothing. */}
            <span role="status" title={line.text || undefined} className={`h-4 min-w-0 truncate text-xs leading-4 empty:-mr-2 ${line.danger ? 'text-danger' : 'text-fg-muted'}`}>
              {line.text}
            </span>
            {/* One element in every role, so a hold that locks keeps the very button its pointer is
                captured on. The microphone records while held (pointer events, so a mouse and a finger
                alike; `touch-none` so a phone browser does not take the drag for a scroll), and the
                keyboard holds it with Space or Enter; Escape drops a recording. */}
            <button
              type="button"
              className={`flex h-10 w-10 shrink-0 touch-none select-none items-center justify-center rounded-full text-white transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                role === 'record' && voiceActive ? 'scale-110 bg-danger' : 'bg-accent hover:bg-accent-hover'
              }`}
              aria-label={t(PRIMARY_LABEL[role])}
              title={role === 'record' ? t('Segure para gravar') : t(PRIMARY_LABEL[role])}
              disabled={disabled}
              onContextMenu={(e) => {
                if (role === 'record') e.preventDefault();
              }}
              onPointerDown={(e) => {
                swallowClick.current = false;
                if (role !== 'record' || disabled || e.button !== 0) return;
                held.current = { x: e.clientX, y: e.clientY };
                e.currentTarget.setPointerCapture?.(e.pointerId);
                voiceNote.press();
              }}
              onPointerMove={(e) => {
                const from = held.current;
                if (!from || voiceNote.phase !== 'recording') return;
                if (e.clientX - from.x <= -CANCEL_DRAG_PX) {
                  held.current = null;
                  voiceNote.cancel();
                } else if (e.clientY - from.y <= -LOCK_DRAG_PX) {
                  voiceNote.lock();
                }
              }}
              onPointerUp={() => {
                if (!held.current) return;
                held.current = null;
                swallowClick.current = voiceNote.phase === 'locked';
                voiceNote.release();
              }}
              onPointerCancel={() => {
                if (!held.current) return;
                held.current = null;
                voiceNote.cancel();
              }}
              onKeyDown={(e) => {
                if (role === 'record' && (e.key === ' ' || e.key === 'Enter')) {
                  e.preventDefault();
                  if (!e.repeat && !disabled) voiceNote.begin();
                } else if (e.key === 'Escape' && voiceActive) {
                  e.preventDefault();
                  voiceNote.cancel();
                }
              }}
              onKeyUp={(e) => {
                if (role === 'record' && (e.key === ' ' || e.key === 'Enter')) {
                  e.preventDefault();
                  voiceNote.release();
                }
              }}
              onClick={() => {
                if (swallowClick.current) {
                  swallowClick.current = false;
                  return;
                }
                if (role === 'stop') dictation.stop();
                else if (role === 'send') void send();
                else if (role === 'sendVoice') voiceNote.send();
              }}
            >
              {role === 'stop' ? <StopIcon /> : role === 'send' || role === 'sendVoice' ? <ArrowUpIcon /> : <MicIcon />}
            </button>
          </div>
        </div>
      </div>
      {/* Both mounted at all times, for the same reason as the status above, and told apart by colour
          rather than by wording: an error is a failure (`danger`), a notice is not (`fg-muted`) — a
          clip too short to hold speech, or one with no words in it, is nobody's fault. `empty:mt-0`
          keeps an empty one from holding a line of space open. */}
      <p role="status" className="mt-1 px-1 text-xs text-danger empty:mt-0">
        {dictation.error ?? voiceNote.error ?? ''}
      </p>
      <p role="status" className="mt-1 px-1 text-xs text-fg-muted empty:mt-0">
        {dictation.notice ?? voiceNote.notice ?? ''}
      </p>
    </div>
  );
}

/**
 * Next to the status while the mic is open: it is listening, for this long, and it can be dropped.
 * Only while `recording` — once the clip is uploading, the hook's `cancel()` can no longer stop
 * anything, so a cancel button there would be a promise the product cannot keep.
 */
function RecordingStatus({ dictation }: { dictation: Dictation }) {
  const { t } = useTranslation();
  return (
    <>
      <span className="h-2 w-2 animate-pulse rounded-full bg-attention" aria-hidden="true" />
      <span className="font-mono text-xs text-fg">{formatClock(dictation.seconds)}</span>
      <button type="button" className="rounded-md px-2 py-1 text-xs text-fg-muted transition-colors hover:bg-bg-3 hover:text-fg" onClick={dictation.cancel}>
        {t('cancelar')}
      </button>
    </>
  );
}

/** Heights of the recording's wave bars, in px: a fixed, uneven profile that pulses, not a meter. */
const WAVE = [6, 12, 8, 16, 10, 14, 7, 12];

/**
 * Next to the status while a voice note records: it is listening, for this long; held, how to drop
 * it ("‹ deslize para cancelar"); locked, the button that drops it (the primary one sends).
 */
function VoiceNoteStatus({ seconds, locked, onDiscard }: { seconds: number; locked: boolean; onDiscard: () => void }) {
  const { t } = useTranslation();
  return (
    <>
      {locked && (
        <button type="button" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-fg-dim transition-colors hover:bg-bg-3 hover:text-danger" aria-label={t('Descartar áudio')} title={t('Descartar áudio')} onClick={onDiscard}>
          <Trash2 size={18} aria-hidden="true" />
        </button>
      )}
      <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-danger" aria-hidden="true" />
      <span className="font-mono text-xs text-fg">{formatClock(seconds)}</span>
      <span data-testid="voice-note-wave" className="flex h-4 items-center gap-0.5" aria-hidden="true">
        {WAVE.map((h, i) => (
          <span key={i} className="w-0.5 animate-pulse rounded-full bg-fg-muted" style={{ height: h, animationDelay: `${i * 120}ms` }} />
        ))}
      </span>
      {!locked && <span className="truncate text-xs text-fg-muted">{t('‹ deslize para cancelar')}</span>}
    </>
  );
}

function MicIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10a7 7 0 0 0 14 0" />
      <path d="M12 17v4M8 21h8" />
    </svg>
  );
}

function ArrowUpIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 20V4" />
      <path d="M5 11l7-7 7 7" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="7" y="7" width="10" height="10" rx="2" />
    </svg>
  );
}
