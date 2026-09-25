import type { TmuxKey } from '@termhub/agent-protocol';
import type { ChoiceAnswer, ChoicePayload, PermissionAnswer } from './tab-question-payload.js';

/** One thing to do in the tab: press a key from `TMUX_KEYS`, or type text literally (no Enter). */
export type KeyStep = { key: TmuxKey } | { text: string };

const DIGITS: readonly TmuxKey[] = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

function digit(n: number): TmuxKey {
  const key = DIGITS[n - 1];
  if (!key) throw new RangeError(`no key for option ${n}`);
  return key;
}

/**
 * The keys that answer Claude Code's question card (spec §3 and §5.4), as seen on Claude Code 2.1.282:
 * a digit picks a single-select option and moves on (or submits, when it is the only question); the
 * digit after the last option focuses its free-text field, whose text is typed and sent with Enter.
 * On a multi-select a digit toggles without moving the focus and Tab moves on; its free-text row takes
 * the text only once focused (Down past the options; a digit only toggles it), then Tab reaches the
 * question's "Next"/"Submit" row and Enter leaves it. Every multi-select, even a lone one, leads to the
 * review step when it is last, and so do 2+ questions: there "1" is "Submit answers".
 * Pure: the answer is already checked against the payload (`checkChoiceAnswer`).
 */
export function choiceKeyPlan(payload: ChoicePayload, answer: ChoiceAnswer): KeyStep[] {
  const steps: KeyStep[] = [];
  payload.questions.forEach((q, i) => {
    const a = answer.answers[i]!;
    if (a.text !== undefined && q.multi_select) {
      for (let n = 0; n < q.options.length; n++) steps.push({ key: 'Down' });
      steps.push({ text: a.text }, { key: 'Tab' }, { key: 'Enter' });
      return;
    }
    if (a.text !== undefined) {
      steps.push({ key: digit(q.options.length + 1) }, { text: a.text }, { key: 'Enter' });
      return;
    }
    if (!q.multi_select) {
      steps.push({ key: digit(a.selected[0]! + 1) });
      return;
    }
    for (const s of [...a.selected].sort((x, y) => x - y)) steps.push({ key: digit(s + 1) });
    steps.push({ key: 'Tab' });
  });
  if (payload.questions.length >= 2 || payload.questions.at(-1)?.multi_select) steps.push({ key: '1' });
  return steps;
}

/** "1" is always "Yes"; Escape always rejects, and leaves Claude at its prompt for the text, if any. */
export function permissionKeyPlan(answer: PermissionAnswer): KeyStep[] {
  if (answer.allow) return [{ key: '1' }];
  return answer.text === undefined ? [{ key: 'Escape' }] : [{ key: 'Escape' }, { text: answer.text }, { key: 'Enter' }];
}
