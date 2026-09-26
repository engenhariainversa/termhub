import type { TabSuggestion } from '../../lib/types';

/** What `409 TAB_PROMPT_CHANGED` reads as on a suggestion card. */
export const SUGGESTION_CHANGED_TEXT = 'A sugestão mudou na aba';

/** Why the text did not reach the tab, by the code the server stored. */
const FAILURE_TEXT: Record<string, string> = {
  MACHINE_OFFLINE: 'a máquina está offline',
  AGENT_OUTDATED: 'o agente da máquina está desatualizado',
};

/** While open the card asks for an answer (spec 2026-09-26 §6.4); once closed it says what the tab had suggested. */
export const suggestionTitle = (s: TabSuggestion): string => {
  if (s.status === 'open') return s.tab_name ? `«${s.tab_name}» está esperando sua resposta` : 'Uma aba está esperando sua resposta';
  return s.tab_name ? `«${s.tab_name}» sugere:` : 'Uma aba sugere:';
};

/** How much of the agent's message a collapsed card shows. */
export const CONTEXT_PREVIEW_MAX = 400;

/**
 * The collapsed context of a suggestion card (spec 2026-09-26 §6.4): the message's last paragraph — the text
 * after its last blank line; the question usually closes the message — up to `max` characters, keeping the
 * end and marking the cut with "…". Never starts on half a surrogate pair. Keep in step with the app's copy.
 */
export function lastParagraph(text: string, max: number): string {
  const paragraphs = text.trim().split(/\n[ \t]*\n/);
  const last = (paragraphs[paragraphs.length - 1] ?? '').trim();
  if (last.length <= max) return last;
  let tail = last.slice(last.length - (max - 1));
  const first = tail.charCodeAt(0);
  if (first >= 0xdc00 && first <= 0xdfff) tail = tail.slice(1);
  return `…${tail.trimStart()}`;
}

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
