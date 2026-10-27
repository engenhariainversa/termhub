import { useTranslation } from '../../i18n';
import { memo, useState } from 'react';
import { AlarmClock, ChevronRight, Eye, X } from 'lucide-react';
import type { ChatWatch } from '../../lib/types';
import { watchDetails, watchHeadline, watchStatus } from './watch-text';

export interface ChatWatchesProps {
  watches: ChatWatch[];
  /** The watch whose "Cancelar" is in flight. */
  cancelingId: string | null;
  /** Why a "Cancelar" failed, by watch id. */
  errors: Record<string, string>;
  onCancel: (id: string) => void;
  /** Defaults to now: a prop only so a test can pin the times. */
  now?: Date;
}

interface WatchRowProps {
  watch: ChatWatch;
  canceling: boolean;
  error: string | undefined;
  onCancel: (id: string) => void;
  now: Date;
}

/** One watch on one line: its icon, the person's line, what already happened, and ✕. A click unfolds the details. */
function WatchRow({ watch, canceling, error, onCancel, now }: WatchRowProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const headline = watchHeadline(watch, now);
  const status = watchStatus(watch, now);
  const Icon = watch.kind === 'reminder' ? AlarmClock : Eye;
  return (
    <li className="px-3 py-1">
      <div className="flex items-center gap-2">
        <button type="button" className="flex min-w-0 flex-1 items-center gap-1.5 text-left" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <Icon size={12} className="shrink-0 text-fg-dim" aria-hidden="true" />
          <span className="min-w-0 truncate text-fg">{headline}</span>
          {status && <span className="min-w-[4rem] shrink-[4] truncate text-xs text-fg-dim">· {status}</span>}
        </button>
        <button type="button" className="btn-ghost shrink-0 p-0.5" disabled={canceling} aria-label={t('Cancelar {{name}}', { name: headline })} title={t('Cancelar')} onClick={() => onCancel(watch.id)}>
          <X size={14} aria-hidden="true" />
        </button>
      </div>
      {open && <p className="pl-[18px] text-xs text-fg-dim">{watchDetails(watch)}</p>}
      {error && <p className="pl-[18px] text-xs text-danger">{error}</p>}
    </li>
  );
}

/**
 * "Acompanhando", above the composer (TER-1099, compact since TER-1115): the watches and reminders the
 * concierge keeps for this conversation. One watch is one line; several fold into "Acompanhando 3 coisas ›".
 * Each line is the concierge's sentence for the person (never its note), what already happened and until
 * when; the detailed events show unfolded. `ChatPanel` owns the list (`GET /api/chat` and the `watches`
 * event). Hidden while there is none. Memoised, with stable callbacks: a streamed delta re-renders the
 * panel, and this strip must not follow.
 */
export const ChatWatches = memo(function ChatWatches({ watches, cancelingId, errors, onCancel, now }: ChatWatchesProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  if (watches.length === 0) return null;
  const at = now ?? new Date();
  const rows = watches.map((w) => <WatchRow key={w.id} watch={w} canceling={cancelingId === w.id} error={errors[w.id]} onCancel={onCancel} now={at} />);
  if (watches.length === 1)
    return (
      <section className="mb-2 rounded-xl border border-line bg-bg-2 text-sm" aria-label={t('Acompanhando')}>
        <ul>{rows}</ul>
      </section>
    );
  // A failed "Cancelar" must be seen: it unfolds the list.
  const unfolded = open || watches.some((w) => errors[w.id]);
  return (
    <section className="mb-2 rounded-xl border border-line bg-bg-2 text-sm" aria-label={t('Acompanhando')}>
      <button type="button" className="flex w-full items-center gap-1.5 px-3 py-1 text-left text-fg-dim" aria-expanded={unfolded} onClick={() => setOpen((o) => !o)}>
        <Eye size={12} aria-hidden="true" />
        <span className="flex-1">{t('Acompanhando {{count}} coisas', { count: watches.length })}</span>
        <ChevronRight size={14} className={unfolded ? 'rotate-90' : ''} aria-hidden="true" />
      </button>
      {unfolded && <ul className="max-h-40 overflow-y-auto border-t border-line">{rows}</ul>}
    </section>
  );
});
