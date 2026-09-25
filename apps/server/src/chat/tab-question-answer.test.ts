import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ControlError, type ControlContext } from '../control/context.js';
import type { TabQuestion } from '../db/repositories/tab-questions.js';
import { HttpError, notFound } from '../lib/errors.js';
import { chatBus, type ChatEvent } from './bus.js';

const sendKey = vi.fn(async (_ctx: unknown, input: { tab_id: string; key: string }) => ({ tab_id: input.tab_id, key: input.key, sent: true }));
const sendInput = vi.fn(async (_ctx: unknown, input: { tab_id: string }) => ({ tab_id: input.tab_id, sent: true }));
const readScreen = vi.fn(async (_ctx: unknown, input: { tab_id: string; lines?: number }) => ({ tab_id: input.tab_id, lines: input.lines ?? 60, text: screens.choice }));
// Partial mocks: everything else these modules export stays real for whoever else imports them.
vi.mock('../control/terminals.js', async (orig) => ({
  ...(await orig<typeof import('../control/terminals.js')>()),
  sendKey: (...a: unknown[]) => sendKey(a[0], a[1] as never),
  sendInput: (...a: unknown[]) => sendInput(a[0], a[1] as never),
}));
vi.mock('../control/screen.js', async (orig) => ({ ...(await orig<typeof import('../control/screen.js')>()), readScreen: (...a: unknown[]) => readScreen(a[0], a[1] as never) }));

const { answerTabQuestion, lastNonBlankLines, promptVisible, requirePinFor, tabQuestionScreen } = await import('./tab-question-answer.js');

const fx = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures/tab-questions', name), 'utf8');
const screens = { choice: fx('screen-choice.txt'), permission: fx('screen-permission.txt') };

const colors = { question: 'What is your favorite color?', header: 'Color', multi_select: false, options: ['Blue', 'Green', 'Red'].map((label, i) => ({ label, description: '', recommended: i === 0 })) };
const fruits = { question: 'Which fruits do you like?', header: 'Fruits', multi_select: true, options: ['Apple', 'Banana', 'Mango'].map((label) => ({ label, description: '', recommended: false })) };
const row = (over: Partial<TabQuestion> = {}): TabQuestion => ({
  id: 'q1', tab_id: 't1', project_id: 'p1', conversation_id: 'c1', user_id: 'u1', kind: 'choice', payload: { questions: [colors, fruits] }, tool_use_id: 'toolu_1',
  status: 'open', answer: null, error_code: null, answered_by: null, answered_at: null, closed_at: null, injected_at: null, created_at: '2026-09-25T12:00:00.000Z', ...over,
});
const permission = (over: Partial<TabQuestion> = {}) => row({ id: 'q2', kind: 'permission', payload: { tool_name: 'Bash' }, tool_use_id: null, ...over });

function ctxFor(current: TabQuestion | undefined, opts: { latest?: TabQuestion | undefined; outOfScope?: boolean; claimLoses?: boolean } = {}) {
  const tabQuestions = {
    findByIdForUser: vi.fn(async (_id: string, userId: string) => (userId === 'u1' ? current : undefined)),
    findOpenForTab: vi.fn(async () => ('latest' in opts ? opts.latest : current)),
    claim: vi.fn(async (_id: string, _u: string, answer: unknown) => (opts.claimLoses || !current ? undefined : { ...current, status: 'answered' as const, answer: answer as never, answered_by: 'u1', answered_at: '2026-09-25T12:01:00.000Z' })),
    markFailed: vi.fn(async (_id: string, code: string) => (current ? { ...current, status: 'failed' as const, error_code: code } : undefined)),
  };
  const scoped = {
    tab: vi.fn(async (id: string) => {
      if (opts.outOfScope) throw notFound('Tab não encontrada');
      return { tab: { id, kind: 'terminal', tmux_session: 'th-t1', state: 'waiting_permission' }, machine: { id: 'm1', type: 'agent' }, project: { id: 'p1' }, cwd: '/w' };
    }),
  };
  const repos = { tabQuestions, tabs: { findByIdsForOwner: vi.fn(async () => [{ id: 't1', name: 'api' }]) } };
  const ctx = { repos, scoped, scope: { user: { id: 'u1' } } } as unknown as ControlContext;
  return { ctx, tabQuestions, scoped };
}
const log = () => ({ info: vi.fn(), warn: vi.fn() });
const noSleep = async () => undefined;
/** Every key and text sent, in the order they were sent. */
const steps = () =>
  [
    ...sendKey.mock.calls.map((c, i) => ({ order: sendKey.mock.invocationCallOrder[i]!, step: `key:${c[1].key}` })),
    ...sendInput.mock.calls.map((c, i) => ({ order: sendInput.mock.invocationCallOrder[i]!, step: `text:${(c[1] as { text: string }).text}` })),
  ]
    .sort((a, b) => a.order - b.order)
    .map((s) => s.step);

let events: ChatEvent[];
let unsubscribe: () => void;
beforeEach(() => {
  vi.clearAllMocks();
  readScreen.mockImplementation(async (_ctx, input) => ({ tab_id: input.tab_id, lines: 60, text: screens.choice }));
  events = [];
  unsubscribe = chatBus.subscribe((e) => events.push(e));
});
afterEach(() => unsubscribe());

const rejects = async (p: Promise<unknown>, status: number, code: string) => {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(HttpError);
  expect(err).toMatchObject({ statusCode: status, code });
};

describe('answerTabQuestion', () => {
  it('checks, claims, types the key plan in order and announces the answered card', async () => {
    const { ctx, tabQuestions } = ctxFor(row());
    const view = await answerTabQuestion(ctx, 'q1', { answers: [{ selected: [1] }, { selected: [2, 0] }] }, { log: log(), sleep: noSleep });
    expect(steps()).toEqual(['key:2', 'key:1', 'key:3', 'key:Tab', 'key:1']);
    expect(sendKey.mock.calls.every((c) => c[1].tab_id === 't1')).toBe(true);
    expect(tabQuestions.claim).toHaveBeenCalledWith('q1', 'u1', { answers: [{ selected: [1] }, { selected: [2, 0] }] });
    expect(view).toMatchObject({ id: 'q1', tab_name: 'api', status: 'answered' });
    expect(events).toEqual([expect.objectContaining({ type: 'tab_question_answered', user_id: 'u1', conversation_id: 'c1', question: expect.objectContaining({ status: 'answered' }) })]);
  });

  it('types free text literally, answering the prompt on purpose, then Enter', async () => {
    const { ctx } = ctxFor(row({ payload: { questions: [colors] } }));
    await answerTabQuestion(ctx, 'q1', { answers: [{ selected: [], text: 'Purple' }] }, { log: log(), sleep: noSleep });
    expect(steps()).toEqual(['key:4', 'text:Purple', 'key:Enter']);
    expect(sendInput).toHaveBeenCalledWith(ctx, { tab_id: 't1', text: 'Purple', enter: false, answering_permission: true });
  });

  it('pauses between keys, never before the first', async () => {
    const sleep = vi.fn(async () => undefined);
    const { ctx } = ctxFor(permission());
    readScreen.mockResolvedValue({ tab_id: 't1', lines: 60, text: screens.permission });
    await answerTabQuestion(ctx, 'q2', { allow: false, text: 'use pnpm' }, { log: log(), sleep });
    expect(steps()).toEqual(['key:Escape', 'text:use pnpm', 'key:Enter']);
    expect(sleep.mock.calls).toEqual([[150], [150]]);
  });

  it('allow is "1"', async () => {
    const { ctx } = ctxFor(permission());
    readScreen.mockResolvedValue({ tab_id: 't1', lines: 60, text: screens.permission });
    await answerTabQuestion(ctx, 'q2', { allow: true }, { log: log(), sleep: noSleep });
    expect(steps()).toEqual(['key:1']);
  });

  it('404: not this user\'s question, or its tab is outside the scope — nothing claimed nor typed', async () => {
    await rejects(answerTabQuestion(ctxFor(undefined).ctx, 'q1', { answers: [{ selected: [0] }, { selected: [0] }] }, { log: log() }), 404, 'NOT_FOUND');
    const out = ctxFor(row(), { outOfScope: true });
    await rejects(answerTabQuestion(out.ctx, 'q1', { answers: [{ selected: [0] }, { selected: [0] }] }, { log: log() }), 404, 'NOT_FOUND');
    expect(out.tabQuestions.claim).not.toHaveBeenCalled();
    expect(sendKey).not.toHaveBeenCalled();
  });

  it('400: a body that does not fit the question', async () => {
    const { ctx } = ctxFor(row());
    await rejects(answerTabQuestion(ctx, 'q1', { answers: [{ selected: [0] }] }, { log: log() }), 400, 'ANSWER_COUNT');
    await expect(answerTabQuestion(ctx, 'q1', { allow: true }, { log: log() })).rejects.toMatchObject({ name: 'ZodError' });
  });

  it.each([
    ['it is no longer open', () => ctxFor(row({ status: 'answered_in_tab' }))],
    ['a newer question replaced it', () => ctxFor(row(), { latest: row({ id: 'q9' }) })],
    ['somebody else claimed it first (the double click)', () => ctxFor(row(), { claimLoses: true })],
  ])('409 TAB_PROMPT_CHANGED when %s — nothing typed', async (_l, make) => {
    const { ctx } = make();
    await rejects(answerTabQuestion(ctx, 'q1', { answers: [{ selected: [0] }, { selected: [0] }] }, { log: log(), sleep: noSleep }), 409, 'TAB_PROMPT_CHANGED');
    expect(sendKey).not.toHaveBeenCalled();
  });

  it('409 TAB_PROMPT_CHANGED when the question is not on the live screen — before any claim', async () => {
    const { ctx, tabQuestions } = ctxFor(row());
    readScreen.mockResolvedValue({ tab_id: 't1', lines: 60, text: '$ ls\nREADME.md\n' });
    await rejects(answerTabQuestion(ctx, 'q1', { answers: [{ selected: [0] }, { selected: [0] }] }, { log: log() }), 409, 'TAB_PROMPT_CHANGED');
    expect(tabQuestions.claim).not.toHaveBeenCalled();
  });

  it('409 TAB_PROMPT_CHANGED when only the tool name is on screen, without "Do you want" — nothing claimed nor typed', async () => {
    const { ctx, tabQuestions } = ctxFor(permission());
    readScreen.mockResolvedValue({ tab_id: 't1', lines: 60, text: '● Bash(npm test)\n  ⎿  Tests 3 passed\n> ' });
    await rejects(answerTabQuestion(ctx, 'q2', { allow: true }, { log: log(), sleep: noSleep }), 409, 'TAB_PROMPT_CHANGED');
    expect(tabQuestions.claim).not.toHaveBeenCalled();
    expect(sendKey).not.toHaveBeenCalled();
  });

  it('an offline machine at the screen check is a 409 with its own code, nothing claimed', async () => {
    const { ctx, tabQuestions } = ctxFor(row());
    readScreen.mockRejectedValue(new ControlError('MACHINE_OFFLINE', 'A máquina está offline'));
    await rejects(answerTabQuestion(ctx, 'q1', { answers: [{ selected: [0] }, { selected: [0] }] }, { log: log() }), 409, 'MACHINE_OFFLINE');
    expect(tabQuestions.claim).not.toHaveBeenCalled();
  });

  it('a key that fails after the claim marks the row failed, announces it and answers 502 with the code', async () => {
    const { ctx, tabQuestions } = ctxFor(row());
    sendKey.mockRejectedValueOnce(new ControlError('MACHINE_OFFLINE', 'A máquina está offline'));
    const l = log();
    await rejects(answerTabQuestion(ctx, 'q1', { answers: [{ selected: [0] }, { selected: [1] }] }, { log: l, sleep: noSleep }), 502, 'MACHINE_OFFLINE');
    expect(tabQuestions.markFailed).toHaveBeenCalledWith('q1', 'MACHINE_OFFLINE');
    expect(events).toEqual([expect.objectContaining({ type: 'tab_question_answered', question: expect.objectContaining({ status: 'failed', error_code: 'MACHINE_OFFLINE' }) })]);
    expect(l.warn).toHaveBeenCalledWith({ tabQuestionId: 'q1', tabId: 't1', kind: 'choice', code: 'MACHINE_OFFLINE' }, 'tab question answer failed');
  });

  it('logs ids, kind and step count — never the answer', async () => {
    const { ctx } = ctxFor(row({ payload: { questions: [colors] } }));
    const l = log();
    await answerTabQuestion(ctx, 'q1', { answers: [{ selected: [], text: 'segredo' }] }, { log: l, sleep: noSleep });
    expect(l.info).toHaveBeenCalledWith({ tabQuestionId: 'q1', tabId: 't1', kind: 'choice', steps: 3 }, 'tab question answered');
    expect(JSON.stringify([l.info.mock.calls, l.warn.mock.calls])).not.toContain('segredo');
  });

  it('asks `beforeSend` after the checks and before the claim; the PIN is never required today', async () => {
    const { ctx, tabQuestions } = ctxFor(permission());
    readScreen.mockResolvedValue({ tab_id: 't1', lines: 60, text: screens.permission });
    const beforeSend = vi.fn(() => {
      throw new HttpError(403, 'PIN', 'PIN_REQUIRED');
    });
    await rejects(answerTabQuestion(ctx, 'q2', { allow: true }, { log: log(), beforeSend }), 403, 'PIN_REQUIRED');
    expect(beforeSend).toHaveBeenCalledWith(expect.objectContaining({ id: 'q2' }), { allow: true });
    expect(tabQuestions.claim).not.toHaveBeenCalled();
    expect(requirePinFor('permission', { allow: true })).toBe(false);
    expect(requirePinFor('choice', { answers: [{ selected: [0] }] })).toBe(false);
  });
});

describe('promptVisible', () => {
  it('finds the first question on the captured card and the permission prompt on its own screen', () => {
    expect(promptVisible(screens.choice, row())).toBe(true);
    expect(promptVisible(screens.permission, permission())).toBe(true);
    expect(promptVisible(screens.permission, row())).toBe(false);
    expect(promptVisible('$ ls\n', permission())).toBe(false);
    expect(promptVisible('● Bash(npm test)\n  ⎿  ok\n', permission())).toBe(false);
  });
  it('matches a question the terminal wrapped', () => {
    const long = { ...colors, question: 'Which of these deployment targets should the new staging environment use from now on?' };
    expect(promptVisible('Which of these deployment targets should the new\n  staging environment use from now on?\n❯ 1. A', row({ payload: { questions: [long] } }))).toBe(true);
  });
});

describe('tabQuestionScreen', () => {
  it('answers the last 20 non-blank lines while the question is open', async () => {
    const { ctx } = ctxFor(permission());
    readScreen.mockResolvedValue({ tab_id: 't1', lines: 60, text: Array.from({ length: 30 }, (_, i) => `l${i}\n`).join('\n') });
    const { text } = await tabQuestionScreen(ctx, 'q2');
    expect(text.split('\n')).toEqual(Array.from({ length: 20 }, (_, i) => `l${i + 10}`));
  });
  it('409 once it is closed, 404 when it is not this user\'s', async () => {
    await rejects(tabQuestionScreen(ctxFor(permission({ status: 'expired' })).ctx, 'q2'), 409, 'TAB_PROMPT_CHANGED');
    await rejects(tabQuestionScreen(ctxFor(undefined).ctx, 'q2'), 404, 'NOT_FOUND');
    expect(lastNonBlankLines('a\n\n  \nb\n', 5)).toBe('a\nb');
  });
});
