import { useTranslation } from '../../i18n';
import { memo, useState } from 'react';
import { api } from '../../lib/api';
import { attachmentStatusText, canRetryAttachment, formatBytes, thumbSize } from '../../lib/attachments';
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
  /** Ids whose retry is on its way, and the one that the server refused, with why. */
  const [retrying, setRetrying] = useState<ReadonlySet<string>>(new Set());
  const [retryError, setRetryError] = useState<{ id: string; message: string } | null>(null);
  const retry = (id: string) => {
    setRetrying((s) => new Set(s).add(id));
    setRetryError(null);
    // The bubble moves to "transcrevendo…" with the `attachment_status` the server publishes.
    api.chat.attachments
      .retry(id)
      .catch((err: unknown) => setRetryError({ id, message: err instanceof Error ? err.message : t('Não foi possível tentar de novo') }))
      .finally(() =>
        setRetrying((s) => {
          const next = new Set(s);
          next.delete(id);
          return next;
        }),
      );
  };
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
          const status = attachmentStatusText(a);
          return (
            <li key={a.id} className="flex flex-wrap items-center gap-2">
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
              {canRetryAttachment(a) && (
                <button type="button" className="text-xs text-fg-dim underline hover:text-fg disabled:opacity-50" disabled={retrying.has(a.id)} onClick={() => retry(a.id)}>
                  {t('tentar de novo')}
                </button>
              )}
              {retryError?.id === a.id && <span className="text-xs text-danger">{retryError.message}</span>}
            </li>
          );
        })}
      </ul>
      <ImageViewer attachment={viewing} onClose={() => setViewing(null)} />
    </>
  );
});
