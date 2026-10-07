import type { AutomationEventPayload } from '../db/repositories/automation-events.js';
import type { TabQuestion } from '../db/repositories/tab-questions.js';
import { t, tk, type Locale } from '../i18n/index.js';
import { PERMISSION_NEEDED, QUESTION_EXPIRED, QUESTION_UNANSWERED } from './escalation-text.js';

/*
 * Why the automatic work answered a question or escalated it (TER-1011): every `question_answered`,
 * `permission_auto_approved` and `escalated` event carries `why` (one of the codes below), the rule or
 * precedent it rests on (`rule_ref`: `decision:<id>`, `note:<id>`, or an allow rule such as
 * `Bash(npm test:*)`) and the precedent's similarity (`score`, 0..1) when there is one. The feed shows them
 * next to the line (web and app), so the person sees what each automatic answer or escalation was based on.
 * Ids and rule names only: never the question's text (terminal content, D27).
 */

/** Answered from a decision the person took on an earlier card (memory repeat, or the concierge citing it). */
export const WHY_PRECEDENT = 'precedent';
/** Answered with the option the agent itself marked recommended: no precedent in the memory. */
export const WHY_RECOMMENDED = 'recommended';
/** A permission allowed by a rule of the project's allow list. */
export const WHY_ALLOW_RULE = 'allow_rule';
/** A permission for termhub's own card tools, always allowed in an automatic tab. */
export const WHY_TERMHUB_TOOL = 'termhub_tool';
/** Escalated: the memory had no decision for this question. */
export const WHY_NO_PRECEDENT = 'no_precedent';
/** Escalated: the closest decision was not close enough to answer alone. */
export const WHY_WEAK_PRECEDENT = 'weak_precedent';
/** Escalated: a countdown started but did not go out (cancelled, or the send failed). */
export const WHY_AUTO_ANSWER_STOPPED = 'auto_answer_stopped';
/** Escalated: the permission is outside every rule of the allow list. */
export const WHY_OUTSIDE_RULES = 'outside_rules';

/** The sentence of each code, as the feed shows it under the line. */
export const WHY_TEXT: Record<string, string> = {
  [WHY_PRECEDENT]: tk('respondida com uma decisão sua de antes'),
  [WHY_RECOMMENDED]: tk('sem precedente na memória; usada a opção recomendada pelo agente'),
  [WHY_ALLOW_RULE]: tk('liberada por uma regra do projeto'),
  [WHY_TERMHUB_TOOL]: tk('ferramenta do termhub sempre liberada no automático'),
  [WHY_NO_PRECEDENT]: tk('nenhuma decisão sua na memória para esta pergunta'),
  [WHY_WEAK_PRECEDENT]: tk('a decisão mais parecida não era próxima o bastante para responder sozinho'),
  [WHY_AUTO_ANSWER_STOPPED]: tk('a resposta automática foi cancelada ou não saiu'),
  [WHY_OUTSIDE_RULES]: tk('nenhuma regra do projeto libera esta permissão'),
};

/** The feed's sentence for a `why` code, in the reader's language; null for none or an unknown code. */
export function whyText(why: string | null, locale: Locale): string | null {
  const text = why ? WHY_TEXT[why] : undefined;
  return text ? t(locale, text) : null;
}

/** A similarity kept to 2 decimals (the event is a fact, not a float dump); null when not a number. */
export const roundScore = (n: number | null | undefined): number | null => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 100) / 100 : null);

/** `why` with its ref and score, leaving out what is null (the payload is flat). */
function payloadOf(why: string, ref: string | null, score: number | null): AutomationEventPayload {
  return { why, ...(ref ? { rule_ref: ref } : {}), ...(score !== null ? { score } : {}) };
}

/**
 * The precedent behind a card's countdown: the first decision its `auto_answer` cites (`decision:<id>`, or
 * the first source of another kind) and its similarity — the suggestion's for a memory repeat (the lowest
 * of the card's questions), the score the concierge's check measured otherwise (`auto_answer.score`).
 */
export function countdownPrecedent(q: Pick<TabQuestion, 'auto_answer' | 'suggestion'>): { ref: string | null; score: number | null } {
  const auto = q.auto_answer;
  if (!auto) return { ref: null, score: null };
  const source = auto.sources.find((s) => s.kind === 'decision') ?? auto.sources[0];
  const ref = source ? `${source.kind}:${source.id}` : null;
  let score = roundScore(auto.score);
  if (score === null && source?.kind === 'decision') {
    const sims = (q.suggestion?.items ?? []).filter((it) => it.decision_id === source.id && it.similarity > 0).map((it) => it.similarity);
    if (sims.length) score = roundScore(Math.min(...sims));
  }
  return { ref, score };
}

/** Why a question of an automatic tab was answered: `via` is `answers.ts`' path. */
export function answerWhy(q: Pick<TabQuestion, 'auto_answer' | 'suggestion'>, via: 'repeat' | 'recommended' | 'concierge'): AutomationEventPayload {
  // a countdown already running may be the agent's recommendation scheduled earlier
  if (via === 'recommended' || q.auto_answer?.by === 'automation') return payloadOf(WHY_RECOMMENDED, null, null);
  const { ref, score } = countdownPrecedent(q);
  return payloadOf(WHY_PRECEDENT, ref, score);
}

/** Why a permission was allowed: the allow rule it matched, or termhub's own tool. */
export function permissionWhy(rule: string, mcp: boolean): AutomationEventPayload {
  return mcp ? payloadOf(WHY_TERMHUB_TOOL, rule, null) : payloadOf(WHY_ALLOW_RULE, rule, null);
}

/**
 * Why a run was escalated about a question card (`reason`), from the card the escalation is about (the
 * tab's newest one): its countdown that did not go out, or else the closest decision the suggestion found
 * (ref and score), or no decision at all. A permission outside the rules says so. Empty for every other
 * reason: the reason's own text explains it.
 */
export function escalationWhy(reason: string, card: Pick<TabQuestion, 'kind' | 'auto_answer' | 'suggestion'> | undefined): AutomationEventPayload {
  if (reason === PERMISSION_NEEDED) return payloadOf(WHY_OUTSIDE_RULES, null, null);
  if (reason !== QUESTION_UNANSWERED && reason !== QUESTION_EXPIRED) return {};
  if (!card || card.kind !== 'choice') return payloadOf(WHY_NO_PRECEDENT, null, null);
  const status = card.auto_answer?.status;
  if (status === 'cancelled' || status === 'failed') {
    const { ref, score } = countdownPrecedent(card);
    return payloadOf(WHY_AUTO_ANSWER_STOPPED, ref, score);
  }
  const best = (card.suggestion?.items ?? []).filter((it) => it.decision_id !== '').sort((a, b) => b.similarity - a.similarity)[0];
  if (!best) return payloadOf(WHY_NO_PRECEDENT, null, null);
  return payloadOf(WHY_WEAK_PRECEDENT, `decision:${best.decision_id}`, best.similarity > 0 ? roundScore(best.similarity) : null);
}
