import { memo, useState } from 'react';
import { api } from '../../lib/api';
import { attachmentStatusText, formatBytes } from '../../lib/attachments';
import type { ChatAttachment } from '../../lib/types';
import { Dot, KindIcon } from './AttachmentChip';
import { ImageViewer } from './ImageViewer';

/**
 * What the person sent with a message (spec §5.6): images as thumbnails that open the viewer, every
 * other kind as a chip that downloads, with what the server is doing to it. Memoised like the row:
 * an `attachment_status` event replaces the message object, which is the only time this re-renders.
 */
export const MessageAttachments = memo(function MessageAttachments({ attachments }: { attachments: ChatAttachment[] }) {
  const [viewing, setViewing] = useState<ChatAttachment | null>(null);
  return (
    <>
      <ul aria-label="Anexos da mensagem" className="mt-2 flex flex-wrap gap-2">
        {attachments.map((a) => {
          if (a.kind === 'image') {
            return (
              <li key={a.id}>
                <button type="button" className="block overflow-hidden rounded-lg" aria-label={`Abrir imagem ${a.name}`} onClick={() => setViewing(a)}>
                  {/* 240 px at most on either side (`max-*-60` is 15rem). */}
                  <img src={api.chat.attachments.url(a.id)} alt={a.name} loading="lazy" className="max-h-60 max-w-60 object-cover" />
                </button>
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
