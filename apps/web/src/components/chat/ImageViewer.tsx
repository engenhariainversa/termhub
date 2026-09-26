import { X } from 'lucide-react';
import { api } from '../../lib/api';
import type { ChatAttachment } from '../../lib/types';
import { useEscapeLayer } from '../Modal';

/**
 * A sent image, full size, over the page. Escape closes it through the app's layer stack, so an open
 * viewer answers Escape before the drawer or a modal under it; so does a click anywhere but the image.
 */
export function ImageViewer({ attachment, onClose }: { attachment: ChatAttachment | null; onClose: () => void }) {
  useEscapeLayer(attachment !== null, onClose);
  if (!attachment) return null;
  return (
    <div role="dialog" aria-modal="true" aria-label={attachment.name} className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4" onMouseDown={onClose}>
      <img src={api.chat.attachments.url(attachment.id)} alt={attachment.name} className="max-h-full max-w-full rounded object-contain" onMouseDown={(e) => e.stopPropagation()} />
      <button type="button" className="absolute right-4 top-4 rounded-full bg-black/50 p-2 text-white hover:bg-black/70" aria-label="Fechar" onClick={onClose}>
        <X size={18} aria-hidden="true" />
      </button>
    </div>
  );
}
