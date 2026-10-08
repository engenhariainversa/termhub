import { useTranslation } from '../../i18n';
import { useState } from 'react';
import type { ReactNode } from 'react';
import type { ChatAction } from '../../lib/types';
import { actionTrailSummary } from '../../lib/chat-action-trail';

/**
 * Whether a trail is open, by its first action's id, outside the component: the thread remounts a
 * row when its key moves or the panel reloads, and a trail the person opened must not snap shut.
 */
const opened = new Set<string>();

/**
 * A turn's settled gate cards as one accordion above its answer (TER-1024), closed by default: one line
 * says how many, how they ended and what they did, and a click opens the cards as they always read.
 * Only settled cards ever land here (`groupSettledActions`): a pending card, a tab's question or
 * permission stays in the thread on its own. No `chat-enter` on the row itself: it replaces a card that
 * was already on screen when the turn's second action lands, and fading it in again would blink (TER-1001).
 */
export function ChatActionTrail({ actions, renderAction, initiallyOpen = false }: { actions: ChatAction[]; renderAction: (action: ChatAction) => ReactNode; initiallyOpen?: boolean }) {
  const { t } = useTranslation();
  const id = actions[0]!.id;
  // `initiallyOpen`: cards the person just decided here, whose note ("Sua decisão foi registrada.")
  // they have not read yet, are not folded away under their own click.
  const [open, setOpen] = useState(() => opened.has(id) || initiallyOpen);
  const toggle = () => {
    if (open) opened.delete(id);
    else opened.add(id);
    setOpen(!open);
  };
  return (
    // Every id, space-separated, like a pending group: a reply's quote can still find its card (TER-849).
    <li data-chat-card={actions.map((a) => a.id).join(' ')} data-chat-trail="" className="min-w-0 rounded-lg text-xs text-fg-dim">
      <button type="button" aria-expanded={open} className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1 text-left hover:bg-bg-2" onClick={toggle}>
        <span aria-hidden="true">{open ? '▾' : '▸'}</span>
        <span className="min-w-0 flex-1 truncate text-fg-muted">{actionTrailSummary(actions)}</span>
        <span className="shrink-0 underline">{open ? t('Recolher') : t('Ver ações')}</span>
      </button>
      {open && <ul className="mt-2 space-y-2">{actions.map(renderAction)}</ul>}
    </li>
  );
}
