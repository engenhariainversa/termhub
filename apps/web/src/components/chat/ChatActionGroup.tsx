import { useState } from 'react';
import type { ChatAction } from '../../lib/types';

export type BatchDecision = { id: string; decision: 'approve' | 'deny' };

/**
 * Several pending gate cards as one confirmation (spec 2026-09-26 §7.1). Writes start checked,
 * irreversible actions unchecked; what is left unchecked is denied in the same batch, so the concierge is
 * never left waiting on a card nobody sees. "Ver separadas" hands back to the ordinary cards (the way
 * to "Permitir sempre nesta aba"). Presentational: `ChatPanel` owns the request.
 */
export function ChatActionGroup({ actions, deciding, onDecide, onShowSeparately }: { actions: ChatAction[]; deciding: boolean; onDecide: (d: BatchDecision[]) => void; onShowSeparately: () => void }) {
  const [checked, setChecked] = useState<Record<string, boolean>>(() => Object.fromEntries(actions.map((a) => [a.id, a.class !== 'irreversible'])));
  const isChecked = (a: ChatAction) => checked[a.id] ?? a.class !== 'irreversible';
  const count = actions.filter(isChecked).length;
  return (
    <li className="rounded-xl border border-attention/40 bg-bg-2 px-4 py-3 text-sm">
      <p className="font-medium text-fg">{`${actions.length} ações aguardando sua confirmação`}</p>
      <ul className="mt-2 space-y-1">
        {actions.map((a) => (
          <li key={a.id}>
            <label className="flex items-start gap-2">
              <input type="checkbox" className="mt-1" checked={isChecked(a)} disabled={deciding} onChange={(e) => setChecked((prev) => ({ ...prev, [a.id]: e.target.checked }))} />
              {/* Plain text only — never HTML: a summary can carry a command read off a real terminal screen. */}
              <span className="whitespace-pre-wrap text-fg">{a.summary}</span>
              {a.class === 'irreversible' && <span className="ml-auto shrink-0 text-xs text-danger">irreversível</span>}
            </label>
          </li>
        ))}
      </ul>
      {count < actions.length && <p className="mt-2 text-xs text-fg-dim">As desmarcadas serão recusadas.</p>}
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" className="btn-primary" disabled={deciding || count === 0} onClick={() => onDecide(actions.map((a) => ({ id: a.id, decision: isChecked(a) ? 'approve' : 'deny' })))}>
          {`Aprovar selecionadas (${count})`}
        </button>
        <button type="button" className="btn-danger" disabled={deciding} onClick={() => onDecide(actions.map((a) => ({ id: a.id, decision: 'deny' })))}>
          Recusar todas
        </button>
        <button type="button" className="btn-ghost" disabled={deciding} onClick={onShowSeparately}>
          Ver separadas
        </button>
      </div>
    </li>
  );
}
