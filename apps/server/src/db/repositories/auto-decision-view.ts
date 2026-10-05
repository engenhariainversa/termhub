import { parseRef } from '../../memory/refs.js';
import type { ChatDecision } from './chat-decisions.js';
import type { Repositories } from './index.js';
import type { AutoAnswerBy } from './tab-questions.js';

/** One memory ref an automatic decision cited, as the chat shows it (TER-641). A `decision:` ref of the
 * person's own that still exists carries its recorded question and answer; any other ref (a card, a
 * note…) or a decision forgotten since carries only the ref (`question`/`answer` null). */
export interface AutoDecisionSource {
  ref: string;
  question: string | null;
  answer: string | null;
}

/** "Decisão automática" (TER-641): what the concierge (or the repeat path, or automatic board work) sent a
 * tab on its own, from memory — the reason it gave and the refs it cited. Absent (null) on anything decided by a click. */
export interface AutoDecisionView {
  reason: string | null;
  sources: AutoDecisionSource[];
  /** Who decided, on a question card's countdown (`AutoAnswer.by`): `'automation'` is the option the agent
   *  recommended in a tab with an automatic run — screens show its reason in the reader's language
   *  ("Opção recomendada pelo agente") and no sources. Absent on an action card. */
  by?: AutoAnswerBy;
}

/** What a caller knows before resolving: the reason and the cited refs (`kind:id`), or null for no badge. */
export interface AutoDecisionInput {
  reason: string | null;
  refs: string[];
  by?: AutoAnswerBy;
}

/** The tools whose optional `sources`/`reason` mark a send as decided from memory (TER-641). */
const SOURCED_TOOLS = new Set(['send_input', 'send_key']);

/** A gated `send_input`/`send_key` call's own `sources` and `reason`, or null when it cited nothing.
 * Read defensively: `args` is whatever the call carried, so anything that is not a well-formed ref is
 * dropped, and an empty list is no badge at all. */
export function autoDecisionOfArgs(tool: string, args: unknown): AutoDecisionInput | null {
  if (!SOURCED_TOOLS.has(tool) || !args || typeof args !== 'object') return null;
  const a = args as { sources?: unknown; reason?: unknown };
  const refs = Array.isArray(a.sources) ? [...new Set(a.sources.filter((r): r is string => typeof r === 'string' && parseRef(r) !== null))].slice(0, 10) : [];
  if (refs.length === 0) return null;
  const reason = typeof a.reason === 'string' && a.reason.trim() ? a.reason.trim() : null;
  return { reason, refs };
}

const answerText = (d: ChatDecision): string => (d.answer.labels.length ? d.answer.labels.join(', ') : (d.answer.text ?? ''));

/**
 * Resolves a batch of automatic decisions for one user, in one owner-scoped read of the cited decisions
 * (none at all when nothing cites one). Another user's decision id, or one forgotten since, resolves like
 * any other ref: the ref alone. Keeps the input's order and its nulls.
 */
export async function describeAutoDecisions(repos: Pick<Repositories, 'chatDecisions'>, inputs: (AutoDecisionInput | null)[], userId: string): Promise<(AutoDecisionView | null)[]> {
  const ids = [...new Set(inputs.flatMap((i) => (i ? i.refs.map(parseRef).filter((r) => r?.kind === 'decision').map((r) => r!.id) : [])))];
  const decisions = ids.length ? await repos.chatDecisions.findManyForUser(ids, userId) : [];
  const byId = new Map(decisions.map((d) => [d.id, d]));
  return inputs.map((input) => {
    if (!input) return null;
    return {
      reason: input.reason,
      sources: input.refs.map((ref) => {
        const parsed = parseRef(ref);
        const d = parsed?.kind === 'decision' ? byId.get(parsed.id) : undefined;
        return { ref, question: d ? d.question : null, answer: d ? answerText(d) : null };
      }),
      ...(input.by ? { by: input.by } : {}),
    };
  });
}
