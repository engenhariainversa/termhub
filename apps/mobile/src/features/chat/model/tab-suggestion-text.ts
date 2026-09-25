// Copied from apps/web/src/components/chat/tab-suggestion-text.ts — keep the two in step (same pt-BR copy).
import type { TabSuggestion } from './types';

/** Why the text did not reach the tab, by the code the server stored. */
const FAILURE_TEXT: Record<string, string> = {
  MACHINE_OFFLINE: 'a máquina está offline',
  AGENT_OUTDATED: 'o agente da máquina está desatualizado',
};

export const suggestionTitle = (s: TabSuggestion): string => (s.tab_name ? `«${s.tab_name}» sugere:` : 'Uma aba sugere:');

export function suggestionStatusLabel(s: TabSuggestion): string {
  switch (s.status) {
    case 'open':
      return '';
    case 'answered':
      return 'Enviada';
    case 'dismissed':
      return 'Dispensada';
    case 'answered_in_tab':
      return 'Respondida na aba';
    case 'expired':
      return 'Expirada';
    case 'failed':
      return `Falhou — ${FAILURE_TEXT[s.error_code ?? ''] ?? 'não foi possível digitar na aba'}`;
  }
}

/** Every event carries the whole card: replace it by id, or append it. */
export function upsertTabSuggestion(list: TabSuggestion[], s: TabSuggestion): TabSuggestion[] {
  return list.some((x) => x.id === s.id) ? list.map((x) => (x.id === s.id ? s : x)) : [...list, s];
}
