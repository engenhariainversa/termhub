import type { TabQuestionView } from '../db/repositories/tab-questions-view.js';
import { CONTROL_CHARS_RE, FORMAT_CHARS_RE, type ChoiceAnswer, type ChoicePayload, type PermissionAnswer, type PermissionPayload, type SuggestionAnswer, type SuggestionPayload } from './tab-question-payload.js';

/**
 * Replaced by a space before the whitespace collapses: C0, DEL and C1 controls (newlines included), bidi
 * and invisible format controls (spec 2026-09-26 §4.11), and U+2028 / U+2029 — already `\s`, listed so
 * the rule reads whole.
 */
const UNSAFE = new RegExp(`${CONTROL_CHARS_RE.source}|${FORMAT_CHARS_RE.source}|[\\u2028\\u2029]`, 'g');

/**
 * Every string interpolated between « and » here can come from the tab side (the question, its
 * headers and option labels — Claude Code's own words, shown to the person but not validated as
 * "safe prose") or be the person's own typed answer: neither is escaped by `tab-question-payload.ts`
 * (it allows «, » and, in a question, control characters, including newlines), so left alone either
 * could close the quote early and read as narrative, or a fresh instruction, in the concierge's own
 * prompt — or reorder itself on screen with a bidi control. Stripped to one line of plain text:
 * everything `UNSAFE` becomes a space, « and » are dropped outright — so nothing interpolated can ever
 * contain the very delimiters that quote it — and the run of whitespace that leaves behind collapses
 * back to one space each.
 */
const sanitise = (s: string): string => s.replace(UNSAFE, ' ').replace(/[«»]/g, '').replace(/\s+/g, ' ').trim();

const tabOf = (q: TabQuestionView) => `«${sanitise(q.tab_name ?? q.tab_id)}»`;

function linesOf(q: TabQuestionView): string[] {
  if (q.kind === 'suggestion') {
    // Only a sent suggestion is news for the concierge; a dismissed one never reaches here (not `answered`).
    const sent = (q.answer as SuggestionAnswer | null)?.text;
    return sent === undefined ? [] : [`- a aba ${tabOf(q)} sugeria «${sanitise((q.payload as SuggestionPayload).text)}»; o usuário enviou «${sanitise(sent)}».`];
  }
  if (q.kind === 'permission') {
    const a = q.answer as PermissionAnswer | null;
    const said = !a ? 'não respondeu' : a.allow ? 'permitiu' : a.text ? `negou e disse «${sanitise(a.text)}»` : 'negou';
    return [`- a aba ${tabOf(q)} pediu permissão para usar «${sanitise((q.payload as PermissionPayload).tool_name)}»; o usuário ${said}.`];
  }
  const a = q.answer as ChoiceAnswer | null;
  return (q.payload as ChoicePayload).questions.map((item, i) => {
    const ans = a?.answers[i];
    const said = !ans ? '—' : (ans.text ?? ans.selected.map((s) => item.options[s]?.label ?? '?').join(', '));
    return `- a aba ${tabOf(q)} perguntou «${sanitise(item.question)}»; o usuário respondeu «${sanitise(said)}».`;
  });
}

/**
 * What the concierge is told about the tabs' questions the person answered from the chat since its
 * last turn (spec 2026-09-25 §5.5): the question and the answer, both written to be shown to the
 * person — never a screen. Null when there is nothing to tell.
 */
export function tabQuestionContext(questions: TabQuestionView[]): string | null {
  const lines = questions.flatMap(linesOf);
  return lines.length ? `Enquanto isso:\n${lines.join('\n')}` : null;
}
