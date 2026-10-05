import { i18n, useTranslation } from '../../i18n';
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
  const account = limit.payload.account ? i18n.t('A conta {{label}}', { label: limit.payload.account.label }) : i18n.t('A conta');
  const who = limit.tab_name ? i18n.t('{{account}} da aba {{tab}}', { account, tab: limit.tab_name }) : account;
  const reset = resetTime(limit.payload.resets_at);
  const machine = limit.payload.machine.name;
  return reset
    ? i18n.t('{{who}} atingiu o limite de uso (cota de tokens esgotada) até {{reset}}. A troca automática está desligada na máquina {{machine}}.', { who, reset, machine })
    : i18n.t('{{who}} atingiu o limite de uso (cota de tokens esgotada). A troca automática está desligada na máquina {{machine}}.', { who, machine });
}

export function tabLimitStatusLabel(limit: TabLimit): string {
  switch (limit.status) {
    case 'swapped': {
      const to = limit.payload.candidates.find((c) => c.id === limit.result);
      return to ? i18n.t('Conta trocada para {{label}}.', { label: to.label }) : i18n.t('Conta trocada.');
    }
    case 'dismissed':
      return i18n.t('Você escolheu esperar o limite voltar.');
    case 'expired':
      return i18n.t('O limite passou ou a aba foi fechada.');
    case 'failed':
      return i18n.t('A troca não aconteceu.');
    default:
      return '';
  }
}

/**
 * A project tab stuck on its account's usage limit, on a machine that does not swap by itself (TER-589):
 * one button per project account with room, and "Esperar". Presentational: the request lives in `ChatPanel`.
 */
export const TabLimitCard = memo(function TabLimitCard({ limit, busy, error, onAnswer }: { limit: TabLimit; busy: boolean; error?: string; onAnswer: (id: string, accountId: string | null) => void }) {
  const { t } = useTranslation();
  const open = limit.status === 'open';
  return (
    <li className="rounded-xl border border-warn/40 bg-bg-2 px-4 py-3 text-sm">
      <p className="font-medium text-fg">{t('Limite de uso da conta')}</p>
      <p className="mt-1 text-fg">{tabLimitText(limit)}</p>
      {open ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {limit.payload.candidates.map((c) => (
            <button key={c.id} type="button" className="btn-primary" disabled={busy} onClick={() => onAnswer(limit.id, c.id)}>
              {t('Trocar para {{label}}', { label: c.label })}
            </button>
          ))}
          <button type="button" className="btn-ghost" disabled={busy} onClick={() => onAnswer(limit.id, null)}>
            {t('Esperar')}
          </button>
        </div>
      ) : (
        <p className="mt-1 text-xs text-fg-dim">{tabLimitStatusLabel(limit)}</p>
      )}
      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
    </li>
  );
});
