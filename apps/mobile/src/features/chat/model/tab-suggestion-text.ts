// Copied from apps/web/src/components/chat/tab-suggestion-text.ts — keep the two in step (same pt-BR copy,
// which is also the translation key).
import { t, tk } from '@/i18n';
import type { TabSuggestion } from './types';

/** Why the text did not reach the tab, by the code the server stored. */
const FAILURE_TEXT: Record<string, string> = {
  MACHINE_OFFLINE: tk('a máquina está offline'),
  AGENT_OUTDATED: tk('o agente da máquina está desatualizado'),
};

/**
 * While open the card offers Claude Code's suggestion for a tab that finished its turn — it asks nothing (spec
 * 2026-09-26 TER-203 §5); once closed it says what the tab had suggested. Keep in step with the web's copy.
 */
export const suggestionTitle = (s: TabSuggestion): string => {
  if (s.payload.exited) {
    // TER-643: the tab's agent exited without finishing its turn; the card offers the line that resumes it.
    const who = s.tab_name ? `«${s.tab_name}»` : t('Uma aba');
    return s.status === 'open' ? t('{{who}} parou: o agente encerrou sem terminar o turno.', { who }) : t('{{who}} parou; comando para retomar:', { who });
  }
  const tab = s.tab_name;
  if (s.status === 'open') {
    if (s.payload.agent === 'codex') return tab ? t('«{{tab}}» terminou — o Codex perguntou:', { tab }) : t('Uma aba terminou — o Codex perguntou:');
    return tab ? t('«{{tab}}» terminou — o Claude Code sugere:', { tab }) : t('Uma aba terminou — o Claude Code sugere:');
  }
  if (s.payload.agent === 'codex') {
    // A Codex reply card asked; the chat's answer (sent, or claimed and failed) is what the card shows under it.
    if (s.status === 'answered' || s.status === 'failed') return tab ? t('«{{tab}}» perguntou; você respondeu:', { tab }) : t('Uma aba perguntou; você respondeu:');
    return tab ? t('«{{tab}}» perguntou:', { tab }) : t('Uma aba perguntou:');
  }
  return tab ? t('«{{tab}}» sugere:', { tab }) : t('Uma aba sugere:');
};

/** Under an open card's title: a suggestion never needs an answer (spec 2026-09-26 TER-203 §5). A
 * translation key, shown as `t(SUGGESTION_HINT)` (`suggestionHint` already translates it). */
export const SUGGESTION_HINT = tk('Não precisa responder.');

/** A Codex reply card (`payload.agent === 'codex'`) is a question ending the Codex's turn: the person
 * answers. A translation key, like `SUGGESTION_HINT`. */
export const CODEX_REPLY_HINT = tk('Responda aqui ou na aba.');
/** The empty input of a Codex reply card, and its accessible name: a translation key, shown as
 * `t(CODEX_REPLY_PLACEHOLDER)`. */
export const CODEX_REPLY_PLACEHOLDER = tk('Sua resposta');

/** "05:48", in the viewer's time zone; null for a missing or broken timestamp. */
function clock(iso: string | null | undefined): string | null {
  const at = iso ? new Date(iso) : null;
  if (!at || Number.isNaN(at.getTime())) return null;
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}

export const suggestionHint = (s: TabSuggestion): string => {
  if (s.payload.exited) {
    const last = clock(s.payload.last_at);
    const send = t('Envie o comando para retomar a sessão na aba, ou dispense.');
    return last ? `${t('Última atividade às {{time}}.', { time: last })} ${send}` : send;
  }
  return t(s.payload.agent === 'codex' ? CODEX_REPLY_HINT : SUGGESTION_HINT);
};

/** A Codex reply card asks for an answer; every other card holds a line to edit (TER-643: a resume card of Codex too). */
export const isReplyCard = (s: TabSuggestion): boolean => s.payload.agent === 'codex' && !s.payload.exited;

/** The label over the editable line. */
export const suggestionFieldLabel = (s: TabSuggestion): string => (s.payload.exited ? t('Comando para retomar (edite ou dispense)') : t('Sugestão do Claude Code (opcional — edite ou dispense)'));

/** The editable line's length cap, the server's: a resume line (an automatic tab's runs to about 3 KB) is
 *  sourced from a file on the machine and takes up to 16 000 characters (TER-988); any other text, 2000.
 *  On Android `maxLength` also cuts a value set by code, so a longer resume line would arrive cut. */
export const suggestionFieldMax = (s: TabSuggestion): number => (s.payload.exited ? 16_000 : 2000);

/** How much of the agent's message a collapsed card shows. */
export const CONTEXT_PREVIEW_MAX = 400;

/**
 * The collapsed context of a suggestion card (spec 2026-09-26 §6.4): the message's last paragraph — the text
 * after its last blank line; the question usually closes the message — up to `max` characters, keeping the
 * end and marking the cut with "…". Never starts on half a surrogate pair. Keep in step with the web's copy.
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
      return t('Enviada');
    case 'dismissed':
      return t('Dispensada');
    case 'answered_in_tab':
      return t('Respondida na aba');
    case 'expired':
      return t('Expirada');
    case 'failed':
      return t('Falhou — {{reason}}', { reason: t(FAILURE_TEXT[s.error_code ?? ''] ?? tk('não foi possível digitar na aba')) });
  }
}

/** Every event carries the whole card: replace it by id, or append it. */
export function upsertTabSuggestion(list: TabSuggestion[], s: TabSuggestion): TabSuggestion[] {
  return list.some((x) => x.id === s.id) ? list.map((x) => (x.id === s.id ? s : x)) : [...list, s];
}
