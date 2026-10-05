import { i18n, tk } from '../../i18n';
import { formatTime } from '../../lib/format';
import type { TabSuggestion } from '../../lib/types';

/** What `409 TAB_PROMPT_CHANGED` reads as on a suggestion card. */
export const SUGGESTION_CHANGED_TEXT = tk('A sugestão mudou na aba');

/** Why the text did not reach the tab, by the code the server stored. */
const FAILURE_TEXT: Record<string, string> = {
  MACHINE_OFFLINE: tk('a máquina está offline'),
  AGENT_OUTDATED: tk('o agente da máquina está desatualizado'),
};

/**
 * While open the card offers Claude Code's suggestion for a tab that finished its turn — it asks nothing (spec
 * 2026-09-26 TER-203 §5); once closed it says what the tab had suggested. Keep in step with the app's copy.
 */
export const suggestionTitle = (s: TabSuggestion): string => {
  if (s.payload.exited) {
    // TER-643: the tab's agent exited without finishing its turn; the card offers the line that resumes it.
    const who = s.tab_name ? `«${s.tab_name}»` : i18n.t('Uma aba');
    return s.status === 'open' ? i18n.t('{{who}} parou: o agente encerrou sem terminar o turno.', { who }) : i18n.t('{{who}} parou; comando para retomar:', { who });
  }
  if (s.status === 'open') {
    const who = s.payload.agent === 'codex' ? i18n.t('o Codex perguntou:') : i18n.t('o Claude Code sugere:');
    return s.tab_name ? i18n.t('«{{name}}» terminou — {{who}}', { name: s.tab_name, who }) : i18n.t('Uma aba terminou — {{who}}', { who });
  }
  if (s.payload.agent === 'codex') {
    // A Codex reply card asked; the chat's answer (sent, or claimed and failed) is what the card shows under it.
    const asked = s.tab_name ? i18n.t('«{{name}}» perguntou', { name: s.tab_name }) : i18n.t('Uma aba perguntou');
    return s.status === 'answered' || s.status === 'failed' ? i18n.t('{{asked}}; você respondeu:', { asked }) : `${asked}:`;
  }
  return s.tab_name ? i18n.t('«{{name}}» sugere:', { name: s.tab_name }) : i18n.t('Uma aba sugere:');
};

/** Under an open card's title: a suggestion never needs an answer (spec 2026-09-26 TER-203 §5). */
export const SUGGESTION_HINT = tk('Não precisa responder.');

/** A Codex reply card (`payload.agent === 'codex'`) is a question ending the Codex's turn: the person answers. */
export const CODEX_REPLY_HINT = tk('Responda aqui ou na aba.');
/** The empty input of a Codex reply card, and its accessible name (a pt-BR key: translate where shown). */
export const CODEX_REPLY_PLACEHOLDER = tk('Sua resposta');

/** "05:48", in the viewer's time zone; null for a missing or broken timestamp. */
function clock(iso: string | null | undefined): string | null {
  const at = iso ? new Date(iso) : null;
  if (!at || Number.isNaN(at.getTime())) return null;
  return formatTime(at);
}

export const suggestionHint = (s: TabSuggestion): string => {
  if (s.payload.exited) {
    const last = clock(s.payload.last_at);
    return last
      ? i18n.t('Última atividade às {{time}}. Envie o comando para retomar a sessão na aba, ou dispense.', { time: last })
      : i18n.t('Envie o comando para retomar a sessão na aba, ou dispense.');
  }
  return i18n.t(s.payload.agent === 'codex' ? CODEX_REPLY_HINT : SUGGESTION_HINT);
};

/** A Codex reply card asks for an answer; every other card holds a line to edit (TER-643: a resume card of Codex too). */
export const isReplyCard = (s: TabSuggestion): boolean => s.payload.agent === 'codex' && !s.payload.exited;

/** The label over the editable line. */
export const suggestionFieldLabel = (s: TabSuggestion): string => (s.payload.exited ? i18n.t('Comando para retomar (edite ou dispense)') : i18n.t('Sugestão do Claude Code (opcional — edite ou dispense)'));

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
      return i18n.t('Enviada');
    case 'dismissed':
      return i18n.t('Dispensada');
    case 'answered_in_tab':
      return i18n.t('Respondida na aba');
    case 'expired':
      return i18n.t('Expirada');
    case 'failed':
      return i18n.t('Falhou — {{reason}}', { reason: i18n.t(FAILURE_TEXT[s.error_code ?? ''] ?? tk('não foi possível digitar na aba')) });
  }
}

/** Every event carries the whole card: replace it by id, or append it. */
export function upsertTabSuggestion(list: TabSuggestion[], s: TabSuggestion): TabSuggestion[] {
  return list.some((x) => x.id === s.id) ? list.map((x) => (x.id === s.id ? s : x)) : [...list, s];
}
