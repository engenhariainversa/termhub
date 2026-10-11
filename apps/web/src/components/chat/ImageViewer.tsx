import { useTranslation } from '../../i18n';
import { X } from 'lucide-react';
import { useRef } from 'react';
import { api } from '../../lib/api';
import type { ChatAttachment } from '../../lib/types';
import { useDialogFocus, useEscapeLayer } from '../Modal';

/**
 * A sent image, full size, over the page. Escape closes it through the app's layer stack, so an open
 * viewer answers Escape before a modal under it; so does a click anywhere but the image.
 * Focus starts on "Fechar", stays inside, and goes back to the thumbnail on close (TER-199).
 */
export function ImageViewer({ attachment, onClose }: { attachment: ChatAttachment | null; onClose: () => void }) {
  const { t } = useTranslation();
  useEscapeLayer(attachment !== null, onClose);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const onKeyDown = useDialogFocus(attachment !== null, dialogRef, closeRef);
  if (!attachment) return null;
  return (
    <div ref={dialogRef} tabIndex={-1} onKeyDown={onKeyDown} role="dialog" aria-modal="true" aria-label={attachment.name} className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4 outline-none" onMouseDown={onClose}>
      <img src={api.chat.attachments.url(attachment.id)} alt={attachment.name} className="max-h-full max-w-full rounded object-contain" onMouseDown={(e) => e.stopPropagation()} />
      <button ref={closeRef} type="button" className="absolute right-4 top-4 rounded-full bg-black/50 p-2 text-white hover:bg-black/70" aria-label={t('Fechar')} onClick={onClose}>
        <X size={18} aria-hidden="true" />
      </button>
    </div>
  );
}
