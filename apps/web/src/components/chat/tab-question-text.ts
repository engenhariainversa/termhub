import type { ChoiceAnswer, TabQuestion, TabQuestionChoice, TabQuestionItem, TabQuestionPermission, TabQuestionSuggestionItem } from '../../lib/types';
import { formatDate } from '../../lib/format';

/** What `409 TAB_PROMPT_CHANGED` reads as on a card. */
export const PROMPT_CHANGED_TEXT = 'A aba já não mostra esta pergunta: nada foi enviado.';

/** Why an answer did not reach the tab, by the code the server stored. */
const FAILURE_TEXT: Record<string, string> = {
  MACHINE_OFFLINE: 'a máquina está offline',
  AGENT_OUTDATED: 'o agente da máquina está desatualizado',
};

/** "0:42", never negative (a countdown at or past `due_at` reads as 0, not a negative number). */
export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

/** Whole seconds left until `due_at` (spec 2026-09-26 concierge memory §6/§8), never negative. */
export function autoAnswerSeconds(dueAt: string, now = Date.now()): number {
  return Math.max(0, Math.ceil((Date.parse(dueAt) - now) / 1000));
}

/** What a `ChoiceAnswer` would say, one value per question, no question text (the countdown/auto-answer
 *  lines only ever show what would be sent, never restate what was asked). */
export function choiceAnswerLabel(payload: { questions: TabQuestionItem[] }, answer: ChoiceAnswer): string {
  return payload.questions
    .map((item, i) => {
      const a = answer.answers[i];
      if (!a) return null;
      return a.text ?? a.selected.map((s) => item.options[s]?.label ?? '?').join(', ');
    })
    .filter((v): v is string => v !== null)
    .join(' / ');
}

/** How much of one option's description the countdown line shows. */
const DESCRIPTION_MAX = 80;

/** The chosen options' descriptions, for the countdown line (spec 2026-09-26 concierge memory §8):
 *  Claude Code's options often carry their meaning there ("Opção 1" — "faz merge e push para main"), so
 *  the label alone does not say what will be sent. Each cut at 80 characters with "…", joined like the
 *  labels; null when no chosen option has one (or the answer is free text). */
export function choiceAnswerDescription(payload: { questions: TabQuestionItem[] }, answer: ChoiceAnswer): string | null {
  const parts = payload.questions.flatMap((item, i) => {
    const a = answer.answers[i];
    if (!a || a.text !== undefined) return [];
    return a.selected.flatMap((s) => {
      const d = item.options[s]?.description?.trim();
      return d ? [d.length > DESCRIPTION_MAX ? `${d.slice(0, DESCRIPTION_MAX)}…` : d] : [];
    });
  });
  return parts.length > 0 ? parts.join(' / ') : null;
}

/** "Não consegui responder sozinho…" (spec 2026-09-26 concierge memory §6/§8, controller ruling): the
 *  countdown's own failure line, shown only while the card is still open. */
export function autoAnswerFailureText(code?: string | null): string {
  switch (code) {
    case 'TAB_PROMPT_CHANGED':
      return 'Não consegui responder sozinho: a pergunta mudou na aba.';
    case 'AUTODECIDE_OFF':
      return 'Resposta automática cancelada: você desligou «Responder sozinho».';
    case 'PRECEDENT_FORGOTTEN':
      return 'Resposta automática cancelada: o precedente foi esquecido.';
    default:
      return 'Não consegui responder sozinho.';
  }
}

export const tabLabel = (q: TabQuestion): string => (q.tab_name ? `A aba «${q.tab_name}»` : 'Uma aba');

/** The title of a choice card: says so when the question came from Codex (`payload.agent`). */
export const choiceTitle = (q: TabQuestionChoice): string => `${tabLabel(q)} perguntou${q.payload.agent === 'codex' ? ' (o Codex)' : ''}`;

/** A permission card's title, also its line in the pending bar (TER-477), so it names the tab: two Codex tabs
 *  must read apart there. Codex's approval is asked in its own words (`payload.question`, shown apart). */
export const permissionTitle = (q: TabQuestionPermission): string => (q.payload.agent === 'codex' ? `${tabLabel(q)} pede permissão (o Codex)` : `${tabLabel(q)} pede permissão para usar «${q.payload.tool_name}»`);

export function statusLabel(q: TabQuestion): string {
  switch (q.status) {
    case 'open':
      return '';
    case 'answered':
      return 'Respondida';
    case 'answered_in_tab':
      return 'Respondida na aba';
    case 'expired':
      return 'Expirada';
    case 'failed':
      return `Falhou — ${FAILURE_TEXT[q.error_code ?? ''] ?? 'não foi possível digitar na aba'}`;
  }
}

/** The read-only summary a closed card keeps: each question and what was answered, when the chat answered it. */
export function answerSummary(q: TabQuestion): string[] {
  if (q.kind === 'permission') {
    if (!q.answer) return [];
    return [q.answer.allow ? 'Permitido' : q.answer.text ? `Negado: «${q.answer.text}»` : 'Negado'];
  }
  const answers = q.answer?.answers;
  return q.payload.questions.map((item, i) => {
    const a = answers?.[i];
    if (!a) return item.question;
    return `${item.question} → ${a.text ?? a.selected.map((s) => item.options[s]?.label ?? '?').join(', ')}`;
  });
}

/** The value a suggestion pre-selects, in `item`'s own option labels (or the free text). */
function suggestionValue(item: TabQuestionItem, hint: TabQuestionSuggestionItem): string {
  return hint.text ?? hint.selected.map((i) => item.options[i]?.label ?? '?').join(', ');
}

/** "você respondeu «X» a «pergunta» em termhub, 24/09/2026": the past-decision sentence, reused as the
 * countdown's "Fonte:" (spec 2026-09-26 concierge memory §8, controller ruling for `by: 'memory'`). */
export function suggestionSourceSentence(item: TabQuestionItem, hint: TabQuestionSuggestionItem): string {
  const date = formatDate(hint.source.answered_at);
  const project = hint.source.project_name ?? 'sem projeto';
  return `você respondeu «${suggestionValue(item, hint)}» a «${hint.source.question}» em ${project}, ${date}`;
}

/** "Sugestão da memória" (or "Sugestão do concierge") under a pre-selected question (spec 2026-09-26
 * chat decision memory §5.1, concierge memory §5.4): where the pre-selection came from, so "Responder"
 * clicked as-is answers what it says here. `item`'s `selected` is already in this question's own option
 * indexes. */
export function suggestionLine(item: TabQuestionItem, hint: TabQuestionSuggestionItem): string {
  if (hint.by === 'concierge') return `Sugestão do concierge: «${suggestionValue(item, hint)}». Motivo: ${hint.reason ?? ''}`;
  return `Sugestão da memória: ${suggestionSourceSentence(item, hint)}`;
}

/** Every event carries the whole card: replace it by id, or append it. */
export function upsertTabQuestion(list: TabQuestion[], q: TabQuestion): TabQuestion[] {
  return list.some((x) => x.id === q.id) ? list.map((x) => (x.id === q.id ? q : x)) : [...list, q];
}
