import { useTranslation } from '../../i18n';
import { memo } from 'react';
import { Eye } from 'lucide-react';
import type { ChatWatch } from '../../lib/types';
import { watchEventsLabel, watchKindLabel, watchUntilLabel } from './watch-text';

export interface ChatWatchesProps {
  watches: ChatWatch[];
  /** The watch whose "Cancelar" is in flight. */
  cancelingId: string | null;
  /** Why a "Cancelar" failed, by watch id. */
  errors: Record<string, string>;
  onCancel: (id: string) => void;
}

/**
 * "Acompanhando", above the composer (TER-1099): the watches the concierge keeps for this conversation
 * ("me avise quando…"), each with its "Cancelar". `ChatPanel` owns the list (`GET /api/chat` and the
 * `watches` event). Hidden while there is none. Memoised, with stable callbacks: a streamed delta
 * re-renders the panel, and this strip must not follow. `label` and `note` are data, shown as they came.
 */
export const ChatWatches = memo(function ChatWatches({ watches, cancelingId, errors, onCancel }: ChatWatchesProps) {
  const { t } = useTranslation();
  if (watches.length === 0) return null;
  return (
    <section className="mb-2 rounded-xl border border-line bg-bg-2 text-sm" aria-label={t('Acompanhando')}>
      <p className="flex items-center gap-1 px-3 pt-1.5 text-xs text-fg-dim">
        <Eye size={12} aria-hidden="true" />
        {t('Acompanhando')}
      </p>
      <ul className="max-h-40 overflow-y-auto py-1">
        {watches.map((w) => (
          <li key={w.id} className="flex items-start gap-2 px-3 py-1">
            <div className="min-w-0 flex-1" title={w.note || undefined}>
              <p className="truncate text-fg">
                <span className="text-fg-muted">{watchKindLabel(w.kind)}</span> {w.label}
              </p>
              <p className="truncate text-xs text-fg-dim">
                {[w.events.length > 0 ? t('avisa em: {{events}}', { events: watchEventsLabel(w.events) }) : null, w.recurring ? t('sempre') : null, watchUntilLabel(w)].filter(Boolean).join(' · ')}
              </p>
              {w.note && <p className="truncate text-xs text-fg-dim">{w.note}</p>}
              {errors[w.id] && <p className="text-xs text-danger">{errors[w.id]}</p>}
            </div>
            <button type="button" className="btn-ghost shrink-0 text-xs" disabled={cancelingId === w.id} aria-label={t('Cancelar {{name}}', { name: w.label })} onClick={() => onCancel(w.id)}>
              {t('Cancelar')}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
});
