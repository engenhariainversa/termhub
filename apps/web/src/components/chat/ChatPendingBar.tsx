import { i18n, useTranslation } from '../../i18n';
import { memo, useEffect, useId, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { ChatEntry } from '../../lib/chat-timeline';
import { permissionTitle, tabLabel } from './tab-question-text';

/** How long a card found from the bar keeps its ring. */
const HIGHLIGHT_MS = 1500;
const HIGHLIGHT = ['ring-2', 'ring-attention'];
/** What `POST /chat/actions/decisions` takes in one call (the server refuses more). */
const BATCH_MAX = 20;

interface PendingItem {
  id: string;
  line: string;
  /** A reversible confirmation: what "Aprovar as reversíveis" approves. */
  write: boolean;
}

/** What waits on the person, in thread order (spec 2026-09-30 §2.1): pending confirmations and open tab
 * questions and permission prompts. Suggestions never need an answer, so they are not counted. */
function pendingItems(entries: ChatEntry[]): PendingItem[] {
  return entries.flatMap((e): PendingItem[] => {
    if (e.kind === 'action') return e.action.status === 'pending' ? [{ id: e.action.id, line: e.action.summary, write: e.action.class === 'write' }] : [];
    if (e.kind !== 'tab_question' || e.question.status !== 'open') return [];
    const q = e.question;
    const line = q.kind === 'permission' ? permissionTitle(q) : i18n.t('{{tab}} pergunta: {{question}}', { tab: tabLabel(q), question: q.payload.questions[0]?.question ?? '' });
    return [{ id: q.id, line, write: false }];
  });
}

export interface ChatPendingBarProps {
  /** The thread before grouping (`chatTimeline`): its order is the list's, and only a card on screen can be found. */
  entries: ChatEntry[];
  /** A batch decision is in flight (`batchDeciding` in `ChatPanel`). */
  batchDeciding: boolean;
  /** "Aprovar as reversíveis": approves these ids through the batch call, leaving the rest pending. */
  onApprove: (ids: string[]) => void;
  /** Called before the thread scrolls to a card: the panel stops following new content, so the pin to the
   * bottom does not pull the thread back down mid-scroll. */
  onLocate?: () => void;
}

/**
 * "N pendentes", above the composer (TER-477): what waits on the person, however far up the thread it
 * sits. A line scrolls to its card and rings it for a moment; the card stays where it is, the one place
 * it is answered. Cards are found by their `data-chat-card` (a group lists every id it holds, hence `~=`).
 * Hidden while nothing waits. Memoised, with stable callbacks from the panel: a streamed delta
 * re-renders the panel, and this bar must not follow.
 */
export const ChatPendingBar = memo(function ChatPendingBar({ entries, batchDeciding, onApprove, onLocate }: ChatPendingBarProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  // Several panels can be on screen at once (the dock holds one per project): the list's id must be unique.
  const listId = useId();
  const lit = useRef<{ el: Element; timer: ReturnType<typeof setTimeout> } | null>(null);
  useEffect(
    () => () => {
      if (!lit.current) return;
      clearTimeout(lit.current.timer);
      lit.current.el.classList.remove(...HIGHLIGHT);
    },
    [],
  );

  const items = pendingItems(entries);
  if (items.length === 0) return null;
  const writes = items.filter((i) => i.write).slice(0, BATCH_MAX);

  const locate = (id: string) => {
    // Ids are the server's own (uuids), but a quote in one must not break the selector.
    const el = document.querySelector(`[data-chat-card~="${id.replace(/["\\]/g, '\\$&')}"]`);
    if (!el) return;
    onLocate?.();
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    if (lit.current) {
      clearTimeout(lit.current.timer);
      lit.current.el.classList.remove(...HIGHLIGHT);
    }
    el.classList.add(...HIGHLIGHT);
    lit.current = {
      el,
      timer: setTimeout(() => {
        el.classList.remove(...HIGHLIGHT);
        lit.current = null;
      }, HIGHLIGHT_MS),
    };
  };

  return (
    <div className="mb-2 rounded-xl border border-line bg-bg-2 text-sm">
      <div className="flex items-center gap-2 px-3 py-1.5">
        <button type="button" className="flex items-center gap-1 rounded px-1 text-attention hover:bg-bg-3" aria-expanded={open} aria-controls={listId} onClick={() => setOpen((v) => !v)}>
          <ChevronDown size={14} aria-hidden="true" className={open ? 'rotate-180' : ''} />
          {t('{{count}} pendentes', { count: items.length })}
        </button>
        {writes.length >= 2 && (
          <button type="button" className="btn-ghost ml-auto text-xs" disabled={batchDeciding} onClick={() => onApprove(writes.map((w) => w.id))}>
            {t('Aprovar as reversíveis ({{n}})', { n: writes.length })}
          </button>
        )}
      </div>
      {open && (
        <ul id={listId} className="max-h-40 overflow-y-auto border-t border-line py-1">
          {items.map((item) => (
            <li key={item.id}>
              {/* Plain text only — never HTML: a summary can carry a command read off a real terminal screen. */}
              <button type="button" className="block w-full truncate px-3 py-1 text-left text-fg-muted hover:bg-bg-3 hover:text-fg" title={item.line} onClick={() => locate(item.id)}>
                {item.line}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
});
