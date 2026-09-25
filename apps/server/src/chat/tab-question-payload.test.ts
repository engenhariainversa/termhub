import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkChoiceAnswer, choiceAnswerBody, normaliseLabel, parseAskUserQuestion, parsePermissionTool, permissionAnswerBody, toolUseIdOf } from './tab-question-payload.js';

const fixture = (name: string) => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/tab-questions', name), 'utf8')) as Record<string, unknown>;
const two = fixture('pretooluse-ask-two-questions.json');
const one = fixture('permissionrequest-ask-one-question.json');

describe('parseAskUserQuestion', () => {
  it('normalises the captured two-question payload, recommended flag out of the label', () => {
    expect(parseAskUserQuestion(two.tool_input)).toEqual({
      questions: [
        {
          question: 'What is your favorite color?',
          header: 'Color',
          multi_select: false,
          options: [
            { label: 'Blue', description: 'Calm and classic.', recommended: true },
            { label: 'Green', description: 'Fresh and natural.', recommended: false },
            { label: 'Red', description: 'Bold and energetic.', recommended: false },
          ],
        },
        {
          question: 'Which fruits do you like?',
          header: 'Fruits',
          multi_select: true,
          options: [
            { label: 'Apple', description: 'Crisp and sweet.', recommended: false },
            { label: 'Banana', description: 'Soft and easy to eat.', recommended: false },
            { label: 'Mango', description: 'Tropical and juicy.', recommended: false },
          ],
        },
      ],
    });
  });

  it('parses the single-question payload', () => {
    expect(parseAskUserQuestion(one.tool_input)?.questions).toHaveLength(1);
  });

  it('fills a missing header, description and multiSelect', () => {
    const r = parseAskUserQuestion({ questions: [{ question: 'Q?', options: [{ label: 'a' }, { label: 'b' }] }] });
    expect(r?.questions[0]).toEqual({ question: 'Q?', header: '', multi_select: false, options: [{ label: 'a', description: '', recommended: false }, { label: 'b', description: '', recommended: false }] });
  });

  it.each([
    ['no questions', { questions: [] }],
    ['five questions', { questions: Array.from({ length: 5 }, () => ({ question: 'Q', options: [{ label: 'a' }, { label: 'b' }] })) }],
    ['one option', { questions: [{ question: 'Q', options: [{ label: 'a' }] }] }],
    ['five options', { questions: [{ question: 'Q', options: ['a', 'b', 'c', 'd', 'e'].map((label) => ({ label })) }] }],
    ['an oversized question', { questions: [{ question: 'x'.repeat(1001), options: [{ label: 'a' }, { label: 'b' }] }] }],
    ['an empty label', { questions: [{ question: 'Q', options: [{ label: ' ' }, { label: 'b' }] }] }],
    ['not an object', 'questions'],
    ['nothing', undefined],
  ])('drops %s', (_l, input) => {
    expect(parseAskUserQuestion(input)).toBeNull();
  });
});

describe('normaliseLabel', () => {
  it.each([
    ['Blue (Recommended)', { label: 'Blue', recommended: true }],
    ['Blue  (recommended) ', { label: 'Blue', recommended: true }],
    ['Blue', { label: 'Blue', recommended: false }],
    ['(Recommended)', { label: '(Recommended)', recommended: false }],
    ['Recommended option', { label: 'Recommended option', recommended: false }],
  ])('%s', (input, out) => {
    expect(normaliseLabel(input)).toEqual(out);
  });
});

describe('tool name and tool_use_id', () => {
  it('accepts the names the hook script lets through, nothing else', () => {
    expect(parsePermissionTool('Bash')).toEqual({ tool_name: 'Bash' });
    expect(parsePermissionTool('mcp__claude-in-chrome__click')).toEqual({ tool_name: 'mcp__claude-in-chrome__click' });
    for (const bad of ['', 'Ev"il', 'a b', 42, null, 'x'.repeat(129)]) expect(parsePermissionTool(bad)).toBeNull();
  });
  it('keeps a plain tool_use_id only', () => {
    expect(toolUseIdOf('toolu_01XsgR974r49WEBYg2aeDAGq')).toBe('toolu_01XsgR974r49WEBYg2aeDAGq');
    expect(toolUseIdOf('../x')).toBeNull();
    expect(toolUseIdOf(undefined)).toBeNull();
  });
});

describe('answer bodies', () => {
  const payload = parseAskUserQuestion(two.tool_input)!;

  it('accepts one entry per question: one option, several options, or text', () => {
    const ok = choiceAnswerBody.parse({ answers: [{ selected: [1] }, { selected: [0, 2] }] });
    expect(checkChoiceAnswer(payload, ok)).toBeNull();
    expect(checkChoiceAnswer(payload, choiceAnswerBody.parse({ answers: [{ selected: [], text: 'Purple' }, { selected: [1] }] }))).toBeNull();
  });

  it.each([
    ['a missing answer', { answers: [{ selected: [1] }] }, 'ANSWER_COUNT'],
    ['an option that does not exist', { answers: [{ selected: [3] }, { selected: [0] }] }, 'ANSWER_OPTION'],
    ['a repeated option', { answers: [{ selected: [1] }, { selected: [0, 0] }] }, 'ANSWER_OPTION'],
    ['two options on a single-select', { answers: [{ selected: [0, 1] }, { selected: [0] }] }, 'ANSWER_SHAPE'],
    ['nothing picked nor typed', { answers: [{ selected: [] }, { selected: [0] }] }, 'ANSWER_SHAPE'],
    ['both picked and typed', { answers: [{ selected: [0], text: 'x' }, { selected: [0] }] }, 'ANSWER_SHAPE'],
  ])('refuses %s', (_l, body, code) => {
    expect(checkChoiceAnswer(payload, choiceAnswerBody.parse(body))).toBe(code);
  });

  it('refuses control characters, newlines and oversized text', () => {
    for (const text of ['a\u001bb', 'linha 1\nlinha 2', 'x'.repeat(2001), '   ']) {
      expect(choiceAnswerBody.safeParse({ answers: [{ selected: [], text }] }).success).toBe(false);
    }
  });

  it('permission: allow alone, deny with or without text, never text with allow nor a "!" or "/" command', () => {
    expect(permissionAnswerBody.parse({ allow: true })).toEqual({ allow: true });
    expect(permissionAnswerBody.parse({ allow: false, text: ' use pnpm ' })).toEqual({ allow: false, text: 'use pnpm' });
    expect(permissionAnswerBody.safeParse({ allow: true, text: 'x' }).success).toBe(false);
    expect(permissionAnswerBody.safeParse({ allow: false, text: '  !rm -rf /' }).success).toBe(false);
    // After Escape, Claude Code is back at its prompt, where a leading "/" runs a slash command (/exit).
    expect(permissionAnswerBody.safeParse({ allow: false, text: '/exit' }).success).toBe(false);
    expect(permissionAnswerBody.safeParse({ allow: false, text: '  /clear' }).success).toBe(false);
    expect(permissionAnswerBody.safeParse({ allow: false, text: 'use a/b instead' }).success).toBe(true);
    expect(permissionAnswerBody.safeParse({}).success).toBe(false);
  });
});
