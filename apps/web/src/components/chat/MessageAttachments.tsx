import { useTranslation } from '../../i18n';
import { memo, useEffect, useRef, useState } from 'react';
import { Download, Pause, Play } from 'lucide-react';
import { api } from '../../lib/api';
import { attachmentStatusText, formatBytes, thumbSize } from '../../lib/attachments';
import type { ChatAttachment } from '../../lib/types';
import { Dot, KindIcon } from './AttachmentChip';
import { ImageViewer } from './ImageViewer';

/** 240 px at most on either side (`max-*-60` is 15rem); 48 px at least once the size is known. */
const THUMB_BOX = 240;
const THUMB_MIN = 48;

/**
 * What the person sent with a message (spec §5.6): images as thumbnails that open the viewer, every
 * other kind as a chip that downloads, with what the server is doing to it. Memoised like the row:
 * an `attachment_status` event replaces the message object, which is the only time this re-renders.
 */
export const MessageAttachments = memo(function MessageAttachments({ attachments }: { attachments: ChatAttachment[] }) {
  const { t } = useTranslation();
  const [viewing, setViewing] = useState<ChatAttachment | null>(null);
  return (
    <>
      <ul aria-label={t('Anexos da mensagem')} className="mt-2 flex flex-wrap gap-2">
        {attachments.map((a) => {
          if (a.kind === 'image') {
            const size = thumbSize(a.meta, THUMB_BOX, THUMB_MIN);
            return (
              <li key={a.id}>
                <button type="button" className="block overflow-hidden rounded-lg" aria-label={t('Abrir imagem {{name}}', { name: a.name })} onClick={() => setViewing(a)}>
                  {/* Sized from meta before it loads, so rows below do not move (TER-197). */}
                  <img src={api.chat.attachments.url(a.id)} alt={a.name} loading="lazy" className="max-h-60 max-w-60 object-cover" style={size ?? undefined} />
                </button>
              </li>
            );
          }
          if (a.kind === 'audio') {
            return (
              <li key={a.id}>
                <AudioAttachment attachment={a} />
              </li>
            );
          }
          const status = attachmentStatusText(a);
          return (
            <li key={a.id}>
              <a href={api.chat.attachments.url(a.id)} download={a.name} className="flex items-center gap-2 rounded-lg border border-line bg-bg-2 px-2 py-1 text-xs text-fg hover:bg-bg-3">
                <span className="text-fg-dim">
                  <KindIcon kind={a.kind} />
                </span>
                <span className="max-w-[12rem] truncate">{a.name}</span>
                <span className="text-fg-dim">{formatBytes(a.bytes)}</span>
                {status && (
                  <>
                    <Dot />
                    <span className={a.status === 'failed' ? 'text-danger' : 'text-fg-dim'}>{status}</span>
                  </>
                )}
              </a>
            </li>
          );
        })}
      </ul>
      <ImageViewer attachment={viewing} onClose={() => setViewing(null)} />
    </>
  );
});

/** Whole seconds as `m:ss`. */
function clock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** The clip's length as the server measured it (`meta.duration_s`), or `null` before it knows. */
function metaDuration(meta: Record<string, unknown> | null): number | null {
  const d = meta?.duration_s;
  return typeof d === 'number' && Number.isFinite(d) && d > 0 ? d : null;
}

/**
 * A voice note or any sent audio (TER-1036): play/pause, where it is and how long it lasts, a download,
 * and the transcription the server made of it, folded away until asked for. While the server is still
 * transcribing (or gave up) the status says so where the transcription toggle would be. The audio is
 * only fetched once played (`preload="none"`): a thread full of notes downloads nothing on open.
 */
function AudioAttachment({ attachment: a }: { attachment: ChatAttachment }) {
  const { t } = useTranslation();
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [loaded, setLoaded] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const duration = metaDuration(a.meta) ?? loaded;
  const status = attachmentStatusText(a);
  const transcript = typeof a.transcript === 'string' && a.transcript.trim() ? a.transcript.trim() : null;

  // Leaving the thread mid-play stops the sound with the row.
  useEffect(() => () => audio.current?.pause(), []);

  const toggle = () => {
    const el = audio.current;
    if (!el) return;
    if (!playing) void el.play()?.catch(() => setPlaying(false));
    else el.pause();
  };

  return (
    <div className="flex min-w-[14rem] flex-col gap-1 rounded-lg border border-line bg-bg-2 px-2 py-1.5 text-xs text-fg">
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-white transition-colors hover:bg-accent-hover"
          aria-label={playing ? t('Pausar áudio') : t('Reproduzir áudio')}
          onClick={toggle}
        >
          {playing ? <Pause size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
        </button>
        <span className="font-mono text-fg-dim">
          {playing || position > 0 ? `${clock(position)} / ` : ''}
          {duration !== null ? clock(duration) : '–:––'}
        </span>
        <span className="min-w-0 flex-1" />
        <a href={api.chat.attachments.url(a.id)} download={a.name} className="rounded p-1 text-fg-dim hover:bg-bg-3 hover:text-fg" aria-label={t('Baixar {{name}}', { name: a.name })} title={t('Baixar {{name}}', { name: a.name })}>
          <Download size={14} aria-hidden="true" />
        </a>
        <audio
          ref={audio}
          preload="none"
          src={api.chat.attachments.url(a.id)}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => {
            setPlaying(false);
            setPosition(0);
          }}
          onTimeUpdate={(e) => setPosition(e.currentTarget.currentTime)}
          onLoadedMetadata={(e) => {
            const d = e.currentTarget.duration;
            if (Number.isFinite(d) && d > 0) setLoaded(d);
          }}
        />
      </div>
      {transcript ? (
        <>
          <button type="button" className="self-start rounded px-1 text-fg-dim hover:text-fg" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            {open ? t('Ocultar transcrição') : t('Ver transcrição')}
          </button>
          {open && <p className="whitespace-pre-wrap px-1 text-fg">{transcript}</p>}
        </>
      ) : status ? (
        <span className={`px-1 ${a.status === 'failed' ? 'text-danger' : 'text-fg-dim'}`}>{status}</span>
      ) : null}
    </div>
  );
}
