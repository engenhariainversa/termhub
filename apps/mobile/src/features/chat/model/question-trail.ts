import { t } from '@/i18n';
import type { TabQuestion } from './types';

/**
 * The one line a run of settled tab cards reads as while their accordion is closed (TER-1108): how many,
 * whose and how they ended — "4 permissões do Codex respondidas na aba", "2 perguntas respondidas no
 * chat", "3 perguntas e permissões resolvidas". Ported verbatim from the web's
 * `apps/web/src/lib/chat-question-trail.ts`, so a person who uses both reads the same words.
 */

/** How a settled card ended, as the summary counts it. */
type Outcome = 'in_tab' | 'chat' | 'expired' | 'failed';
const outcomeOf = (q: TabQuestion): Outcome => (q.status === 'answered_in_tab' ? 'in_tab' : q.status === 'answered' ? 'chat' : q.status === 'expired' ? 'expired' : 'failed');

function outcomeText(outcome: Outcome): string {
  switch (outcome) {
    case 'in_tab':
      return t('respondidas na aba');
    case 'chat':
      return t('respondidas no chat');
    case 'expired':
      return t('expiradas');
    case 'failed':
      return t('falharam');
  }
}

export function questionTrailSummary(questions: TabQuestion[]): string {
  const count = questions.length;
  const kinds = new Set(questions.map((q) => q.kind));
  const head = kinds.size > 1 ? t('{{count}} perguntas e permissões', { count }) : kinds.has('permission') ? t('{{count}} permissões', { count }) : t('{{count}} perguntas', { count });
  // Named only when every card is the Codex's: a Claude card carries no agent, and a mixed run names nobody.
  const codex = questions.every((q) => q.payload.agent === 'codex');
  const outcomes = new Set(questions.map(outcomeOf));
  const outcome = outcomes.size === 1 ? outcomeText([...outcomes][0]!) : t('resolvidas');
  return [head, codex ? t('do Codex') : null, outcome].filter((part) => part !== null).join(' ');
}
