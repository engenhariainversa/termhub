// Copied from apps/web/src/components/chat/TabLimitCard.tsx's text helpers — keep the two in step (same
// pt-BR copy, spec 2026-09-30 project AI accounts §7.2).
import type { TabLimit } from './types';
import { formatTime } from '@/i18n/format';

/** The card's title. */
export const TAB_LIMIT_TITLE = 'Limite de uso da conta';

/** "03:20", in the phone's clock; null when the reading did not say. */
function resetTime(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : formatTime(d);
}

/** The card's sentence: which account of which tab hit the limit, until when (when known), and on which machine. */
export function tabLimitText(limit: TabLimit): string {
  const account = limit.payload.account ? `A conta ${limit.payload.account.label}` : 'A conta';
  const tab = limit.tab_name ? ` da aba ${limit.tab_name}` : '';
  const reset = resetTime(limit.payload.resets_at);
  return `${account}${tab} atingiu o limite de uso (cota de tokens esgotada)${reset ? ` até ${reset}` : ''}. A troca automática está desligada na máquina ${limit.payload.machine.name}.`;
}

/** How a closed card ended; empty while it is open. */
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

/** Every event carries the whole card: replace it by id, or append it. */
export function upsertTabLimit(list: TabLimit[], l: TabLimit): TabLimit[] {
  return list.some((x) => x.id === l.id) ? list.map((x) => (x.id === l.id ? l : x)) : [...list, l];
}
