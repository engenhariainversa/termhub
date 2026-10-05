// A tab's state in one short line (spec 2026-10-01 tab chat §6): the Sessões rows and the session header.
import { t } from '@/i18n';
import type { TTabSummary } from '@/services/api/contract';

/** "Esperando você" whenever the tab needs the person; "Trabalhando · Bash" while it works, with the
 * tool it runs; "Em segundo plano" while it only waits on its own background work; "Erro"; "Concluído"
 * once it ended its turn with a report and asks nothing (TER-972); else "Parado". */
export function stateLine(tab: Pick<TTabSummary, 'state' | 'background' | 'finished' | 'needs_you' | 'activity'>): string {
  if (tab.needs_you || tab.state === 'waiting_input' || tab.state === 'waiting_permission') return t('Esperando você');
  if (tab.state === 'working') {
    if (tab.background) return t('Em segundo plano');
    return tab.activity ? t('Trabalhando · {{activity}}', { activity: tab.activity }) : t('Trabalhando');
  }
  if (tab.state === 'error') return t('Erro');
  if (tab.state === 'idle' && tab.finished) return t('Concluído');
  return t('Parado');
}
