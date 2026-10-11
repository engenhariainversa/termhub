// Copied from apps/web/src/components/chat/TabLimitCard.tsx's text helpers — keep the two in step (same
// pt-BR copy, which is also the translation key; spec 2026-09-30 project AI accounts §7.2).
import { t, tk } from '@/i18n';
import type { TabLimit } from './types';
import { formatTime } from '@/i18n/format';

/** The card's title: a translation key, shown as `t(TAB_LIMIT_TITLE)`. */
export const TAB_LIMIT_TITLE = tk('Limite de uso da conta');

/** "03:20", in the phone's clock; null when the reading did not say. */
function resetTime(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : formatTime(d);
}

/** The card's sentence: which account of which tab hit the limit, until when (when known), and on which machine. */
export function tabLimitText(limit: TabLimit): string {
  const label = limit.payload.account?.label;
  const tab = limit.tab_name;
  const account = label
    ? tab
      ? t('A conta {{label}} da aba {{tab}}', { label, tab })
      : t('A conta {{label}}', { label })
    : tab
      ? t('A conta da aba {{tab}}', { tab })
      : t('A conta');
  const reset = resetTime(limit.payload.resets_at);
  const machine = limit.payload.machine.name;
  return reset
    ? t('{{account}} atingiu o limite de uso (cota de tokens esgotada) até {{reset}}. A troca automática está desligada na máquina {{machine}}.', { account, reset, machine })
    : t('{{account}} atingiu o limite de uso (cota de tokens esgotada). A troca automática está desligada na máquina {{machine}}.', { account, machine });
}

/** How a closed card ended; empty while it is open. */
export function tabLimitStatusLabel(limit: TabLimit): string {
  switch (limit.status) {
    case 'swapped': {
      const to = limit.payload.candidates.find((c) => c.id === limit.result);
      return to ? t('Conta trocada para {{label}}.', { label: to.label }) : t('Conta trocada.');
    }
    case 'dismissed':
      return t('Você escolheu esperar o limite voltar.');
    case 'expired':
      return t('O limite passou ou a aba foi fechada.');
    case 'failed':
      return t('A troca não aconteceu.');
    default:
      return '';
  }
}

/** Every event carries the whole card: replace it by id, or append it. */
export function upsertTabLimit(list: TabLimit[], l: TabLimit): TabLimit[] {
  return list.some((x) => x.id === l.id) ? list.map((x) => (x.id === l.id ? l : x)) : [...list, l];
}
