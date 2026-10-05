import { memo } from 'react';
import type { TabLimit } from '../../lib/types';
import { formatTime } from '../../lib/format';

/** "03:20", in the viewer's clock; null when the reading did not say. */
function resetTime(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : formatTime(d, { hour: '2-digit', minute: '2-digit' });
}

/** The card's sentence (spec 2026-09-30 project AI accounts §7.2). Shared with the tests. */
export function tabLimitText(limit: TabLimit): string {
  const account = limit.payload.account ? `A conta ${limit.payload.account.label}` : 'A conta';
  const tab = limit.tab_name ? ` da aba ${limit.tab_name}` : '';
  const reset = resetTime(limit.payload.resets_at);
  return `${account}${tab} atingiu o limite de uso (cota de tokens esgotada)${reset ? ` até ${reset}` : ''}. A troca automática está desligada na máquina ${limit.payload.machine.name}.`;
}

export function tabLimitStatusLabel(limit: TabLimit): string {
  switch (limit.status) {
    case 'swapped': {
      const to = limit.payload.candidates.find((c) => c.id === limit.result);
      return `Conta trocada${to ? ` para ${to.label}` : ''}.`;
    }
    case 'dismissed':
      return 'Você escolheu esperar o limite voltar.';
    case 'expired':
      return 'O limite passou ou a aba foi fechada.';
    case 'failed':
      return 'A troca não aconteceu.';
    default:
      return '';
  }
}

/**
 * A project tab stuck on its account's usage limit, on a machine that does not swap by itself (TER-589):
 * one button per project account with room, and "Esperar". Presentational: the request lives in `ChatPanel`.
 */
export const TabLimitCard = memo(function TabLimitCard({ limit, busy, error, onAnswer }: { limit: TabLimit; busy: boolean; error?: string; onAnswer: (id: string, accountId: string | null) => void }) {
  const open = limit.status === 'open';
  return (
    <li className="rounded-xl border border-warn/40 bg-bg-2 px-4 py-3 text-sm">
      <p className="font-medium text-fg">Limite de uso da conta</p>
      <p className="mt-1 text-fg">{tabLimitText(limit)}</p>
      {open ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {limit.payload.candidates.map((c) => (
            <button key={c.id} type="button" className="btn-primary" disabled={busy} onClick={() => onAnswer(limit.id, c.id)}>
              Trocar para {c.label}
            </button>
          ))}
          <button type="button" className="btn-ghost" disabled={busy} onClick={() => onAnswer(limit.id, null)}>
            Esperar
          </button>
        </div>
      ) : (
        <p className="mt-1 text-xs text-fg-dim">{tabLimitStatusLabel(limit)}</p>
      )}
      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
    </li>
  );
});
