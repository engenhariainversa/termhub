import type { TabQuestionView } from '../db/repositories/tab-questions-view.js';
import type { ChoiceAnswer, ChoicePayload, PermissionAnswer, PermissionPayload } from './tab-question-payload.js';

const tabOf = (q: TabQuestionView) => `«${q.tab_name ?? q.tab_id}»`;

function linesOf(q: TabQuestionView): string[] {
  if (q.kind === 'permission') {
    const a = q.answer as PermissionAnswer | null;
    const said = !a ? 'não respondeu' : a.allow ? 'permitiu' : a.text ? `negou e disse «${a.text}»` : 'negou';
    return [`- a aba ${tabOf(q)} pediu permissão para usar «${(q.payload as PermissionPayload).tool_name}»; o usuário ${said}.`];
  }
  const a = q.answer as ChoiceAnswer | null;
  return (q.payload as ChoicePayload).questions.map((item, i) => {
    const ans = a?.answers[i];
    const said = !ans ? '—' : (ans.text ?? ans.selected.map((s) => item.options[s]?.label ?? '?').join(', '));
    return `- a aba ${tabOf(q)} perguntou «${item.question}»; o usuário respondeu «${said}».`;
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
