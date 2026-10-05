import { useTranslation } from '../../i18n';
import { useState } from 'react';
import type { ChatAction } from '../../lib/types';

export type BatchDecision = { id: string; decision: 'approve' | 'deny' };

/**
 * The person's own ticks, by action id, outside the component (TER-530). What is left unticked is
 * denied, so a selection that fell back to the defaults would turn every irreversible card the person
 * had ticked into a refusal on the next click. The group remounts whenever its key moves (a new pending
 * card, a card brought back to the end of the thread) and after a failed request; the ticks must not.
 */
const chosen = new Map<string, boolean>();

/**
 * Several pending gate cards as one confirmation (spec 2026-09-26 §7.1). Writes start checked,
 * irreversible actions unchecked; what is left unchecked is denied in the same batch, so the concierge is
 * never left waiting on a card nobody sees. "Ver separadas" hands back to the ordinary cards (the way
 * to "Permitir sempre nesta aba"). Presentational: `ChatPanel` owns the request.
 */
export function ChatActionGroup({ actions, deciding, onDecide, onShowSeparately }: { actions: ChatAction[]; deciding: boolean; onDecide: (d: BatchDecision[]) => void; onShowSeparately: () => void }) {
  const { t } = useTranslation();
  const [checked, setChecked] = useState<Record<string, boolean>>(() => Object.fromEntries(actions.map((a) => [a.id, chosen.get(a.id) ?? a.class !== 'irreversible'])));
  const isChecked = (a: ChatAction) => checked[a.id] ?? chosen.get(a.id) ?? a.class !== 'irreversible';
  const toggle = (id: string, value: boolean) => {
    chosen.set(id, value);
    setChecked((prev) => ({ ...prev, [id]: value }));
  };
  const count = actions.filter(isChecked).length;
  return (
    // Every id, space-separated: the pending bar finds any one of them with `[data-chat-card~="<id>"]` (TER-477).
    <li data-chat-card={actions.map((a) => a.id).join(' ')} className="rounded-xl border border-attention/40 bg-bg-2 px-4 py-3 text-sm">
      <p className="font-medium text-fg">{t('{{count}} ações aguardando sua confirmação', { count: actions.length })}</p>
      <ul className="mt-2 space-y-1">
        {actions.map((a) => (
          <li key={a.id}>
            <label className="flex items-start gap-2">
              <input type="checkbox" className="mt-1" checked={isChecked(a)} disabled={deciding} onChange={(e) => toggle(a.id, e.target.checked)} />
              <span className="flex-1">
                {/* Plain text only — never HTML: a summary can carry a command read off a real terminal screen. */}
                <span className="whitespace-pre-wrap text-fg">{a.summary}</span>
                {/* The subagent whose turn proposed this action (spec 2026-09-26 §4), when there is one. */}
                {a.subagent && <span className="block text-xs text-fg-dim">{t('Pedido pelo subagente «{{name}}»', { name: a.subagent.description })}</span>}
              </span>
              {a.class === 'irreversible' && <span className="ml-auto shrink-0 text-xs text-danger">{t('irreversível')}</span>}
            </label>
          </li>
        ))}
      </ul>
      {count < actions.length && <p className="mt-2 text-xs text-fg-dim">{t('As desmarcadas serão recusadas.')}</p>}
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" className="btn-primary" disabled={deciding || count === 0} onClick={() => onDecide(actions.map((a) => ({ id: a.id, decision: isChecked(a) ? 'approve' : 'deny' })))}>
          {t('Aprovar selecionadas ({{n}})', { n: count })}
        </button>
        <button type="button" className="btn-danger" disabled={deciding} onClick={() => onDecide(actions.map((a) => ({ id: a.id, decision: 'deny' })))}>
          {t('Recusar todas')}
        </button>
        <button type="button" className="btn-ghost" disabled={deciding} onClick={onShowSeparately}>
          {t('Ver separadas')}
        </button>
      </div>
    </li>
  );
}
