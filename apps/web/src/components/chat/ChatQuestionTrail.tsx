import { useTranslation } from '../../i18n';
import { useState } from 'react';
import type { ReactNode } from 'react';
import type { TabQuestion } from '../../lib/types';
import { questionTrailSummary } from '../../lib/chat-question-trail';

/**
 * Whether a trail is open, by its first card's id, outside the component: the thread remounts a row
 * when its key moves or the panel reloads, and a trail the person opened must not snap shut.
 */
const opened = new Set<string>();

/**
 * A run of settled tab cards as one accordion (TER-1108) — a Codex tab asking permission for every
 * command, each answered in the tab before anyone looked — closed by default: one line says how many,
 * whose and how they ended, and a click opens their compact lines, each expandable to the whole card.
 * Only settled cards ever land here (`groupSettledQuestions`): a card still waiting on the person stays
 * in the thread on its own, with its attention border. No `chat-enter` on the row itself: it replaces a
 * card that was already on screen when the run's second card settles, and fading it in would blink.
 */
export function ChatQuestionTrail({ questions, renderQuestion }: { questions: TabQuestion[]; renderQuestion: (question: TabQuestion) => ReactNode }) {
  const { t } = useTranslation();
  const id = questions[0]!.id;
  const [open, setOpen] = useState(() => opened.has(id));
  const toggle = () => {
    if (open) opened.delete(id);
    else opened.add(id);
    setOpen(!open);
  };
  return (
    // Every id, space-separated, like a pending group: the pending bar and a reply's quote can still find
    // a card inside (TER-477, TER-849).
    <li data-chat-card={questions.map((q) => q.id).join(' ')} data-chat-trail="" className="min-w-0 rounded-lg text-xs text-fg-dim">
      <button type="button" aria-expanded={open} className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1 text-left hover:bg-bg-2" onClick={toggle}>
        <span aria-hidden="true">{open ? '▾' : '▸'}</span>
        <span className="min-w-0 flex-1 truncate text-fg-muted">{questionTrailSummary(questions)}</span>
        <span className="shrink-0 underline">{open ? t('Recolher') : t('Ver detalhes')}</span>
      </button>
      {open && <ul className="mt-2 space-y-1">{questions.map(renderQuestion)}</ul>}
    </li>
  );
}
