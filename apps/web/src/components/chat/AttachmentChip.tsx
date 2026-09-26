import { FileAudio, FileSpreadsheet, FileText, FileVideo, File as FileIcon, Image as ImageIcon, X } from 'lucide-react';
import type { AttachmentKind } from '../../lib/attachments';
import { formatBytes } from '../../lib/attachments';

export interface AttachmentChipProps {
  name: string;
  kind: AttachmentKind | null;
  bytes: number;
  /** An image's object URL, shown as the thumbnail; null for every other kind. */
  previewUrl: string | null;
  phase: 'uploading' | 'uploaded' | 'failed';
  /** 0..1 while uploading. */
  progress: number;
  /** After the upload: what the server is doing with it ("processando…"), or null once ready. */
  statusText: string | null;
  /** Why it failed — the server's pt-BR refusal, or the box's own. */
  error: string | null;
  /** A failed upload can be tried again; a refused file cannot. */
  retryable: boolean;
  onRemove: () => void;
  onRetry: () => void;
}

/** The kind's glyph, shared with the thread's bubbles. */
export function KindIcon({ kind }: { kind: AttachmentKind | null }) {
  const props = { size: 16, 'aria-hidden': true as const };
  switch (kind) {
    case 'image':
      return <ImageIcon {...props} />;
    case 'audio':
      return <FileAudio {...props} />;
    case 'video':
      return <FileVideo {...props} />;
    case 'xlsx':
      return <FileSpreadsheet {...props} />;
    case 'pdf':
    case 'docx':
    case 'text':
      return <FileText {...props} />;
    default:
      return <FileIcon {...props} />;
  }
}

/** A ring that fills clockwise; announced as a progress bar with a percentage. */
function ProgressRing({ fraction }: { fraction: number }) {
  const r = 8;
  const c = 2 * Math.PI * r;
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" role="progressbar" aria-label="Enviando" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fraction * 100)} className="shrink-0 text-accent">
      <circle cx="11" cy="11" r={r} fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" />
      <circle cx="11" cy="11" r={r} fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - fraction)} transform="rotate(-90 11 11)" />
    </svg>
  );
}

/** The dot between the size and what follows it — its own element, so the words next to it stay whole text nodes. */
function Dot() {
  return <span aria-hidden="true">·</span>;
}

/**
 * One file in the box (spec §5.6): a thumbnail or an icon, the name and size, and what is happening
 * to it — a progress ring while it uploads, the server's status once it landed, or why it failed.
 * ✕ is always there: a chip can be dropped in any state.
 */
export function AttachmentChip({ name, kind, bytes, previewUrl, phase, progress, statusText, error, retryable, onRemove, onRetry }: AttachmentChipProps) {
  return (
    <li className={`flex max-w-full items-center gap-2 rounded-lg border px-2 py-1 text-xs ${phase === 'failed' ? 'border-danger/60 bg-danger/5' : 'border-line bg-bg-3'}`}>
      {previewUrl ? (
        <img src={previewUrl} alt={name} className="h-9 w-9 shrink-0 rounded object-cover" />
      ) : (
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded bg-bg-2 text-fg-dim">
          <KindIcon kind={kind} />
        </span>
      )}
      <span className="flex min-w-0 flex-col">
        <span className="max-w-[12rem] truncate text-fg">{name}</span>
        <span className="flex items-center gap-1 text-fg-dim">
          <span>{formatBytes(bytes)}</span>
          {phase === 'uploaded' && statusText && (
            <>
              <Dot />
              <span>{statusText}</span>
            </>
          )}
          {phase === 'failed' && error && (
            <>
              <Dot />
              <span className="text-danger">{error}</span>
            </>
          )}
          {phase === 'failed' && retryable && (
            <button type="button" className="underline hover:text-fg" onClick={onRetry}>
              tentar de novo
            </button>
          )}
        </span>
      </span>
      {phase === 'uploading' && <ProgressRing fraction={progress} />}
      <button type="button" className="ml-1 shrink-0 rounded p-1 text-fg-dim hover:bg-bg-2 hover:text-fg" aria-label={`Remover ${name}`} title="Remover" onClick={onRemove}>
        <X size={14} aria-hidden="true" />
      </button>
    </li>
  );
}
