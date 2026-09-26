import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONTROL_CHARS_RE, answerText, checkChoiceAnswer, choiceAnswerBody, normaliseLabel, parseAskUserQuestion, parsePermissionTool, permissionAnswerBody, sliceUnits, toolUseIdOf, typedText } from './tab-question-payload.js';

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

describe('text rules (spec 2026-09-26 §4.4, §5.1, §5.3)', () => {
  it('CONTROL_CHARS_RE is C0, DEL and C1 — nothing printable', () => {
    for (const c of ['\x00', '\n', '\x1b', '\x1f', '\x7f', '\x80', '\x85', '\x9b', '\x9f']) expect(CONTROL_CHARS_RE.test(c)).toBe(true);
    for (const c of [' ', 'a', '\xa0', 'é', '❯', '😀']) expect(CONTROL_CHARS_RE.test(c)).toBe(false);
  });

  it('answer text refuses C1 exactly like C0', () => {
    expect(answerText.safeParse('ok\x9b31m').success).toBe(false);
    expect(answerText.safeParse('ok\x85').success).toBe(false);
    expect(answerText.safeParse('ação ✓ 😀').success).toBe(true);
  });

  it('typedText refuses a leading ! or / after the trim, and allows them anywhere else', () => {
    for (const bad of ['!ls', '  !ls', '/exit', ' /clear']) expect(typedText.safeParse(bad).success).toBe(false);
    for (const ok of ['use a/b', 'yes!', 'rode `!ls`?']) expect(typedText.safeParse(ok).success).toBe(true);
    expect(typedText.parse('  pode seguir ')).toBe('pode seguir');
  });

  it("a choice's free text follows typedText (it is typed into Claude Code's dialog field)", () => {
    expect(choiceAnswerBody.safeParse({ answers: [{ selected: [], text: '!rm -rf /' }] }).success).toBe(false);
    expect(choiceAnswerBody.safeParse({ answers: [{ selected: [], text: ' /exit' }] }).success).toBe(false);
    expect(choiceAnswerBody.safeParse({ answers: [{ selected: [], text: 'Roxo\x9b' }] }).success).toBe(false);
    expect(choiceAnswerBody.safeParse({ answers: [{ selected: [], text: 'use a/b' }] }).success).toBe(true);
  });

  it('a permission deny text keeps its path on the error', () => {
    const r = permissionAnswerBody.safeParse({ allow: false, text: '/exit' });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path).toEqual(['text']);
  });

  it('sliceUnits never ends on the first half of a surrogate pair', () => {
    expect(sliceUnits('ab😀c', 3)).toBe('ab');
    expect(sliceUnits('ab😀c', 4)).toBe('ab😀');
    expect(sliceUnits('abc', 10)).toBe('abc');
    expect(sliceUnits('', 3)).toBe('');
  });
});
