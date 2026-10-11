import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { answerKeyPlan, choiceKeyPlan, codexChoiceKeyPlan, codexPermissionKeyPlan, permissionKeyPlan } from './tab-question-keys.js';
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

  it('a single multi-select question: its digits, Tab, then "1" on the review step it lands on', () => {
    expect(choiceKeyPlan(multiOnly, { answers: [{ selected: [0, 1] }] })).toEqual([{ key: '1' }, { key: '2' }, { key: 'Tab' }, { key: '1' }]);
  });

  it('a single single-select question with free text submits on Enter, no review step', () => {
    expect(choiceKeyPlan(one, { answers: [{ selected: [], text: 'Mate' }] })).toEqual([{ key: String(one.questions[0]!.options.length + 1) }, { text: 'Mate' }, { key: 'Enter' }]);
  });

  it('multi-select free text: Down to the field (a digit there only toggles it), the text, Tab to the Next/Submit row, Enter', () => {
    const n = multiOnly.questions[0]!.options.length;
    const down = Array.from({ length: n }, () => ({ key: 'Down' }));
    expect(choiceKeyPlan(multiOnly, { answers: [{ selected: [], text: 'Kiwi' }] })).toEqual([...down, { text: 'Kiwi' }, { key: 'Tab' }, { key: 'Enter' }, { key: '1' }]);
    const multiFirst: ChoicePayload = { questions: [two.questions[1]!, two.questions[0]!] };
    expect(choiceKeyPlan(multiFirst, { answers: [{ selected: [], text: 'Kiwi' }, { selected: [0] }] })).toEqual([...down, { text: 'Kiwi' }, { key: 'Tab' }, { key: 'Enter' }, { key: '1' }, { key: '1' }]);
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
  it('an option of the dialog is its digit (TER-995)', () => {
    expect(permissionKeyPlan({ allow: true, option: { number: 3, label: 'Yes, and switch to auto mode' } })).toEqual([{ key: '3' }]);
    expect(permissionKeyPlan({ allow: false, option: { number: 4, label: 'No' } })).toEqual([{ key: '4' }]);
  });
});

const codexAsk: ChoicePayload = {
  agent: 'codex',
  questions: [
    { question: 'Qual cor?', header: 'Cor', multi_select: false, options: ['Azul', 'Verde'].map((label) => ({ label, description: '', recommended: false })) },
    { question: 'Qual tamanho?', header: 'Tam', multi_select: false, options: ['P', 'M', 'G'].map((label) => ({ label, description: '', recommended: false })) },
  ],
};

describe('codexChoiceKeyPlan (Codex 0.159.2, verified by hand)', () => {
  it('an option is its digit, per question, with no final submit key', () => {
    expect(codexChoiceKeyPlan(codexAsk, { answers: [{ selected: [1] }, { selected: [2] }] })).toEqual([{ key: '2' }, { key: '3' }]);
  });
  it('free text: Down past the options to "None of the above", Tab for the notes, the text, Enter', () => {
    expect(codexChoiceKeyPlan(codexAsk, { answers: [{ selected: [], text: 'Roxo' }, { selected: [0] }] })).toEqual([
      { key: 'Down' }, { key: 'Down' }, { key: 'Tab' }, { text: 'Roxo' }, { key: 'Enter' }, { key: '1' },
    ]);
    expect(codexChoiceKeyPlan(codexAsk, { answers: [{ selected: [0] }, { selected: [], text: 'XG' }] })).toEqual([
      { key: '1' }, { key: 'Down' }, { key: 'Down' }, { key: 'Down' }, { key: 'Tab' }, { text: 'XG' }, { key: 'Enter' },
    ]);
  });
});

describe('codexPermissionKeyPlan', () => {
  it('allow is "y"; deny is Escape; deny with text follows with the text and Enter', () => {
    expect(codexPermissionKeyPlan({ allow: true })).toEqual([{ key: 'y' }]);
    expect(codexPermissionKeyPlan({ allow: false })).toEqual([{ key: 'Escape' }]);
    expect(codexPermissionKeyPlan({ allow: false, text: 'use azul.txt' })).toEqual([{ key: 'Escape' }, { text: 'use azul.txt' }, { key: 'Enter' }]);
  });
  it('an option of the menu: the arrows from the cursor, then Enter (TER-995)', () => {
    const option = (number: number) => ({ allow: true, option: { number, label: 'x' } });
    expect(codexPermissionKeyPlan(option(1))).toEqual([{ key: 'Enter' }]);
    expect(codexPermissionKeyPlan(option(3))).toEqual([{ key: 'Down' }, { key: 'Down' }, { key: 'Enter' }]);
    expect(codexPermissionKeyPlan(option(1), 2)).toEqual([{ key: 'Up' }, { key: 'Enter' }]);
  });
});

describe('answerKeyPlan', () => {
  it('picks the plan by the row payload agent', () => {
    expect(answerKeyPlan('choice', one, { answers: [{ selected: [1] }] })).toEqual(choiceKeyPlan(one, { answers: [{ selected: [1] }] }));
    expect(answerKeyPlan('choice', codexAsk, { answers: [{ selected: [1] }, { selected: [0] }] })).toEqual([{ key: '2' }, { key: '1' }]);
    expect(answerKeyPlan('permission', { tool_name: 'Bash' }, { allow: true })).toEqual([{ key: '1' }]);
    expect(answerKeyPlan('permission', { tool_name: 'Bash', agent: 'codex' }, { allow: true })).toEqual([{ key: 'y' }]);
  });
});
