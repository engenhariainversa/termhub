import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { choiceKeyPlan, permissionKeyPlan } from './tab-question-keys.js';
import { parseAskUserQuestion, type ChoicePayload } from './tab-question-payload.js';

const fixture = (name: string) => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/tab-questions', name), 'utf8')) as { tool_input: unknown };
const two = parseAskUserQuestion(fixture('pretooluse-ask-two-questions.json').tool_input)!;
const one = parseAskUserQuestion(fixture('permissionrequest-ask-one-question.json').tool_input)!;
const multiOnly: ChoicePayload = { questions: [two.questions[1]!] };

describe('choiceKeyPlan (spec §5.4)', () => {
  it('single-select: the option digit; multi-select: a digit per option then Tab; 2+ questions end on the Submit tab', () => {
    expect(choiceKeyPlan(two, { answers: [{ selected: [1] }, { selected: [2, 0] }] })).toEqual([{ key: '2' }, { key: '1' }, { key: '3' }, { key: 'Tab' }, { key: '1' }]);
  });

  it('a single single-select question is one digit, no Submit step', () => {
    expect(choiceKeyPlan(one, { answers: [{ selected: [2] }] })).toEqual([{ key: '3' }]);
  });

  it('a single multi-select question: its digits and Tab, no Submit step', () => {
    expect(choiceKeyPlan(multiOnly, { answers: [{ selected: [0, 1] }] })).toEqual([{ key: '1' }, { key: '2' }, { key: 'Tab' }]);
  });

  it('free text: the digit after the last option, the text, Enter', () => {
    expect(choiceKeyPlan(two, { answers: [{ selected: [], text: 'Purple' }, { selected: [1] }] })).toEqual([
      { key: '4' },
      { text: 'Purple' },
      { key: 'Enter' },
      { key: '2' },
      { key: 'Tab' },
      { key: '1' },
    ]);
  });

  it('never types a key it cannot name', () => {
    const five = { questions: [{ ...one.questions[0]!, options: Array.from({ length: 9 }, (_, i) => ({ label: `o${i}`, description: '', recommended: false })) }] };
    expect(() => choiceKeyPlan(five, { answers: [{ selected: [], text: 'x' }] })).toThrow(RangeError);
  });
});

describe('permissionKeyPlan', () => {
  it('allow is "1" (always "Yes")', () => {
    expect(permissionKeyPlan({ allow: true })).toEqual([{ key: '1' }]);
  });
  it('deny is Escape; with text, the text and Enter at the prompt Claude is back at', () => {
    expect(permissionKeyPlan({ allow: false })).toEqual([{ key: 'Escape' }]);
    expect(permissionKeyPlan({ allow: false, text: 'use pnpm' })).toEqual([{ key: 'Escape' }, { text: 'use pnpm' }, { key: 'Enter' }]);
  });
});
