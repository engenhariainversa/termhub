import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ControlError, type ControlContext } from '../control/context.js';
import type { TabQuestion } from '../db/repositories/tab-questions.js';
import { HttpError, notFound } from '../lib/errors.js';
import { chatBus, type ChatEvent } from './bus.js';

const sendKey = vi.fn(async (_ctx: unknown, input: { tab_id: string; key: string }) => ({ tab_id: input.tab_id, key: input.key, sent: true }));
const sendInput = vi.fn(async (_ctx: unknown, input: { tab_id: string }) => ({ tab_id: input.tab_id, sent: true }));
const readScreen = vi.fn(async (_ctx: unknown, input: { tab_id: string; lines?: number }, _opts?: { plain?: boolean }) => ({ tab_id: input.tab_id, lines: input.lines ?? 60, text: screens.choice, styled: false }));
// Partial mocks: everything else these modules export stays real for whoever else imports them.
vi.mock('../control/terminals.js', async (orig) => ({
  ...(await orig<typeof import('../control/terminals.js')>()),
  sendKey: (...a: unknown[]) => sendKey(a[0], a[1] as never),
  sendInput: (...a: unknown[]) => sendInput(a[0], a[1] as never),
}));
vi.mock('../control/screen.js', async (orig) => ({ ...(await orig<typeof import('../control/screen.js')>()), readScreen: (...a: unknown[]) => readScreen(a[0], a[1] as never, a[2] as never) }));

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

function ctxFor(current: TabQuestion | undefined, opts: { latest?: TabQuestion | undefined; outOfScope?: boolean; tabFails?: Error; claimLoses?: boolean; denied?: string[] } = {}) {
  const tabQuestions = {
    findByIdForUser: vi.fn(async (_id: string, userId: string) => (userId === 'u1' ? current : undefined)),
    findOpenForTab: vi.fn(async () => ('latest' in opts ? opts.latest : current)),
    claim: vi.fn(async (_id: string, _u: string, answer: unknown) => (opts.claimLoses || !current ? undefined : { ...current, status: 'answered' as const, answer: answer as never, answered_by: 'u1', answered_at: '2026-09-25T12:01:00.000Z' })),
    markFailed: vi.fn(async (_id: string, code: string) => (current ? { ...current, status: 'failed' as const, error_code: code } : undefined)),
    closeOne: vi.fn(async (_id: string, status: 'answered_in_tab' | 'expired') => (current ? { ...current, status, closed_at: '2026-09-25T12:01:00.000Z' } : undefined)),
    expireOne: vi.fn(async (_id: string) => (current && current.closed_at === null ? { ...current, status: current.status === 'open' ? ('expired' as const) : current.status, closed_at: '2026-09-26T12:02:00.000Z' } : undefined)),
  };
  const scoped = {
    tab: vi.fn(async (id: string) => {
      if (opts.tabFails) throw opts.tabFails;
      if (opts.outOfScope) throw notFound('Tab não encontrada');
      return { tab: { id, name: 'api', kind: 'terminal', tmux_session: 'th-t1', state: 'waiting_permission' }, machine: { id: 'm1', type: 'agent' }, project: { id: 'p1' }, cwd: '/w' };
    }),
  };
  const repos = { tabQuestions, tabs: { findByIdsForOwner: vi.fn(async () => [{ id: 't1', name: 'api' }]) } };
  const can = vi.fn(async (resource: string, action: string) => !(opts.denied ?? []).includes(`${resource}:${action}`));
  const ctx = { repos, scoped, scope: { user: { id: 'u1' } }, can } as unknown as ControlContext;
  return { ctx, tabQuestions, scoped, can };
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
  readScreen.mockImplementation(async (_ctx, input) => ({ tab_id: input.tab_id, lines: 60, text: screens.choice, styled: false }));
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

  it('reads the live screen plain: ⟦…⟧ is for the concierge, not for this check', async () => {
    const { ctx } = ctxFor(row());
    await answerTabQuestion(ctx, 'q1', { answers: [{ selected: [1] }, { selected: [2, 0] }] }, { log: log(), sleep: noSleep });
    expect(readScreen).toHaveBeenCalledWith(expect.anything(), { tab_id: 't1', lines: 60 }, { plain: true });
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
    readScreen.mockResolvedValue({ tab_id: 't1', lines: 60, text: screens.permission, styled: false });
    await answerTabQuestion(ctx, 'q2', { allow: false, text: 'use pnpm' }, { log: log(), sleep });
    expect(steps()).toEqual(['key:Escape', 'text:use pnpm', 'key:Enter']);
    expect(sleep.mock.calls).toEqual([[150], [150]]);
  });

  it('allow is "1"', async () => {
    const { ctx } = ctxFor(permission());
    readScreen.mockResolvedValue({ tab_id: 't1', lines: 60, text: screens.permission, styled: false });
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

  it('409 TAB_PROMPT_CHANGED when the question is not on the live screen — before any claim, and the card closes', async () => {
    const { ctx, tabQuestions } = ctxFor(row());
    readScreen.mockResolvedValue({ tab_id: 't1', lines: 60, text: '$ ls\nREADME.md\n', styled: false });
    await rejects(answerTabQuestion(ctx, 'q1', { answers: [{ selected: [0] }, { selected: [0] }] }, { log: log() }), 409, 'TAB_PROMPT_CHANGED');
    expect(tabQuestions.claim).not.toHaveBeenCalled();
    // Only this row, and only while it is still open: never the tab's other (newer) questions.
    expect(tabQuestions.closeOne).toHaveBeenCalledWith('q1', 'answered_in_tab');
    expect(events).toEqual([expect.objectContaining({ type: 'tab_question_closed', user_id: 'u1', question: expect.objectContaining({ id: 'q1', status: 'answered_in_tab' }) })]);
  });

  it('a row refused as not open or not the latest, or a screen that could not be read, stays untouched', async () => {
    for (const { ctx, tabQuestions } of [ctxFor(row({ status: 'answered_in_tab' })), ctxFor(row(), { latest: row({ id: 'q9' }) })]) {
      await rejects(answerTabQuestion(ctx, 'q1', { answers: [{ selected: [0] }, { selected: [0] }] }, { log: log() }), 409, 'TAB_PROMPT_CHANGED');
      expect(tabQuestions.closeOne).not.toHaveBeenCalled();
    }
    const offline = ctxFor(row());
    readScreen.mockRejectedValue(new ControlError('MACHINE_OFFLINE', 'A máquina está offline'));
    await rejects(answerTabQuestion(offline.ctx, 'q1', { answers: [{ selected: [0] }, { selected: [0] }] }, { log: log() }), 409, 'MACHINE_OFFLINE');
    expect(offline.tabQuestions.closeOne).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it('403 FORBIDDEN without terminals:write — nothing loaded, claimed nor typed', async () => {
    const { ctx, tabQuestions, can } = ctxFor(row(), { denied: ['terminals:write'] });
    await rejects(answerTabQuestion(ctx, 'q1', { answers: [{ selected: [0] }, { selected: [0] }] }, { log: log(), sleep: noSleep }), 403, 'FORBIDDEN');
    expect(can).toHaveBeenCalledWith('terminals', 'write');
    expect(tabQuestions.claim).not.toHaveBeenCalled();
    expect(readScreen).not.toHaveBeenCalled();
    expect(sendKey).not.toHaveBeenCalled();
  });

  it('409 TAB_PROMPT_CHANGED when only the tool name is on screen, without "Do you want" — nothing claimed nor typed', async () => {
    const { ctx, tabQuestions } = ctxFor(permission());
    readScreen.mockResolvedValue({ tab_id: 't1', lines: 60, text: '● Bash(npm test)\n  ⎿  Tests 3 passed\n> ', styled: false });
    await rejects(answerTabQuestion(ctx, 'q2', { allow: true }, { log: log(), sleep: noSleep }), 409, 'TAB_PROMPT_CHANGED');
    expect(tabQuestions.claim).not.toHaveBeenCalled();
    expect(sendKey).not.toHaveBeenCalled();
  });

  it('409 TAB_PROMPT_CHANGED on prose saying "Do you want me to…" with no dialog footer — nothing claimed nor typed', async () => {
    const { ctx, tabQuestions } = ctxFor(permission());
    readScreen.mockResolvedValue({ tab_id: 't1', lines: 60, text: '● Bash(npm test)\n● Do you want me to fix the failing test?\n────\n❯ \n', styled: false });
    await rejects(answerTabQuestion(ctx, 'q2', { allow: false }, { log: log(), sleep: noSleep }), 409, 'TAB_PROMPT_CHANGED');
    expect(tabQuestions.claim).not.toHaveBeenCalled();
    expect(sendKey).not.toHaveBeenCalled();
  });

  it('409 TAB_PROMPT_CHANGED when the choice question is only in the scrollback', async () => {
    const { ctx } = ctxFor(row());
    readScreen.mockResolvedValue({ tab_id: 't1', lines: 60, text: `${screens.choice}\n● Blue it is.\n────\n❯ \n`, styled: false });
    await rejects(answerTabQuestion(ctx, 'q1', { answers: [{ selected: [0] }, { selected: [0] }] }, { log: log(), sleep: noSleep }), 409, 'TAB_PROMPT_CHANGED');
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

  it('a failure to mark or announce the failed row keeps the send error (502, its code) and its warning', async () => {
    const { ctx, tabQuestions } = ctxFor(row());
    sendKey.mockRejectedValueOnce(new ControlError('MACHINE_OFFLINE', 'A máquina está offline'));
    tabQuestions.markFailed.mockRejectedValueOnce(new Error('db down'));
    const l = log();
    await rejects(answerTabQuestion(ctx, 'q1', { answers: [{ selected: [0] }, { selected: [1] }] }, { log: l, sleep: noSleep }), 502, 'MACHINE_OFFLINE');
    expect(l.warn).toHaveBeenCalledWith({ tabQuestionId: 'q1', tabId: 't1', kind: 'choice', code: 'MACHINE_OFFLINE' }, 'tab question answer failed');
    expect(l.warn).toHaveBeenCalledWith({ tabQuestionId: 'q1', tabId: 't1', code: 'RECORD_FAILED' }, 'tab question failure not recorded');
  });

  it('once the keys were typed, a failure to announce it still answers 200 with the answered card', async () => {
    const { ctx } = ctxFor(row());
    (ctx.repos.tabs.findByIdsForOwner as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('db down'));
    const l = log();
    const view = await answerTabQuestion(ctx, 'q1', { answers: [{ selected: [0] }, { selected: [1] }] }, { log: l, sleep: noSleep });
    expect(view).toMatchObject({ id: 'q1', tab_name: 'api', status: 'answered' });
    expect(l.info).toHaveBeenCalledWith(expect.objectContaining({ tabQuestionId: 'q1' }), 'tab question answered');
    expect(l.warn).toHaveBeenCalledWith({ tabQuestionId: 'q1', tabId: 't1', code: 'PUBLISH_FAILED' }, 'tab question answer not announced');
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
    readScreen.mockResolvedValue({ tab_id: 't1', lines: 60, text: screens.permission, styled: false });
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

const CHOICE_FOOTER = 'Enter to select · Tab/Arrow keys to navigate · Esc to cancel';
const PERMISSION_FOOTER = 'Esc to cancel · Tab to amend';

describe('promptVisible', () => {
  it('finds the first question on the captured card and the permission prompt on its own screen', () => {
    expect(promptVisible(screens.choice, row())).toBe(true);
    expect(promptVisible(screens.permission, permission())).toBe(true);
    expect(promptVisible(screens.permission, row())).toBe(false);
    expect(promptVisible('$ ls\n', permission())).toBe(false);
    expect(promptVisible('● Bash(npm test)\n  ⎿  ok\n', permission())).toBe(false);
  });
  it('ignores markdown and punctuation the terminal renders differently', () => {
    const md = { ...colors, question: 'Should we run `pnpm test` or **"npm test"** before the merge?' };
    // Claude Code renders the markdown (no backticks nor asterisks) and may curl the quotes.
    const shown = `Should we run pnpm test or “npm test” before the merge?\n\u276f 1. A\n${CHOICE_FOOTER}`;
    expect(promptVisible(shown, row({ payload: { questions: [md] } }))).toBe(true);
    expect(promptVisible(`Should we run yarn test before the merge?\n${CHOICE_FOOTER}`, row({ payload: { questions: [md] } }))).toBe(false);
  });
  it('a choice question with no letters or digits never matches', () => {
    const bare = { ...colors, question: '?? — …' };
    expect(promptVisible(`?? — …\n\u276f 1. Blue\n${CHOICE_FOOTER}`, row({ payload: { questions: [bare] } }))).toBe(false);
  });
  it('matches a question the terminal wrapped', () => {
    const long = { ...colors, question: 'Which of these deployment targets should the new staging environment use from now on?' };
    expect(promptVisible(`Which of these deployment targets should the new\n  staging environment use from now on?\n❯ 1. A\n${CHOICE_FOOTER}`, row({ payload: { questions: [long] } }))).toBe(true);
  });
  it('is anchored to the dialog: its footer must be the last non-blank line', () => {
    // Claude's own prose asking "Do you want me to…", with the normal prompt below it: no dialog.
    expect(promptVisible('● Done. Do you want me to also run the tests?\n\n────\n❯ \n────\n  ? for shortcuts\n', permission())).toBe(false);
    // The choice question still in the scrollback, the tab back at its normal prompt.
    expect(promptVisible(`${screens.choice}\n● Thanks, blue it is.\n────\n❯ \n────\n  ? for shortcuts\n`, row())).toBe(false);
    // The footer is there but the marker scrolled more than 25 non-blank lines above it.
    const far = ['Do you want to proceed?', ...Array.from({ length: 25 }, (_, i) => `line ${i}`), PERMISSION_FOOTER].join('\n');
    expect(promptVisible(far, permission())).toBe(false);
    const near = ['Do you want to proceed?', ...Array.from({ length: 23 }, (_, i) => `line ${i}`), PERMISSION_FOOTER].join('\n');
    expect(promptVisible(near, permission())).toBe(true);
  });
});

describe('tabQuestionScreen', () => {
  it('answers the last 20 non-blank lines while the question is open', async () => {
    const { ctx } = ctxFor(permission());
    readScreen.mockResolvedValue({ tab_id: 't1', lines: 60, text: Array.from({ length: 30 }, (_, i) => `l${i}\n`).join('\n'), styled: false });
    const { text } = await tabQuestionScreen(ctx, 'q2');
    expect(text.split('\n')).toEqual(Array.from({ length: 20 }, (_, i) => `l${i + 10}`));
  });
  it('the excerpt is the plain screen', async () => {
    const { ctx } = ctxFor(permission());
    await tabQuestionScreen(ctx, 'q2');
    expect(readScreen).toHaveBeenCalledWith(expect.anything(), { tab_id: 't1', lines: 60 }, { plain: true });
  });
  it('403 FORBIDDEN without terminals:read, nothing read', async () => {
    const { ctx, can } = ctxFor(permission(), { denied: ['terminals:read'] });
    await rejects(tabQuestionScreen(ctx, 'q2'), 403, 'FORBIDDEN');
    expect(can).toHaveBeenCalledWith('terminals', 'read');
    expect(readScreen).not.toHaveBeenCalled();
  });
  it('404 when the question\'s tab is outside the scope, nothing read', async () => {
    await rejects(tabQuestionScreen(ctxFor(permission(), { outOfScope: true }).ctx, 'q2'), 404, 'NOT_FOUND');
    expect(readScreen).not.toHaveBeenCalled();
  });
  it('409 once it is closed, 404 when it is not this user\'s', async () => {
    await rejects(tabQuestionScreen(ctxFor(permission({ status: 'expired' })).ctx, 'q2'), 409, 'TAB_PROMPT_CHANGED');
    await rejects(tabQuestionScreen(ctxFor(undefined).ctx, 'q2'), 404, 'NOT_FOUND');
    expect(lastNonBlankLines('a\n\n  \nb\n', 5)).toBe('a\nb');
  });
});

describe('suggestion rows', () => {
  it('are not questions: 404 on answer and screen, nothing read', async () => {
    const { ctx } = ctxFor(row({ id: 's1', kind: 'suggestion', payload: { text: 'commit it' }, tool_use_id: null }));
    await rejects(answerTabQuestion(ctx, 's1', { allow: true }, { log: log(), sleep: noSleep }), 404, 'NOT_FOUND');
    await rejects(tabQuestionScreen(ctx, 's1'), 404, 'NOT_FOUND');
    expect(readScreen).not.toHaveBeenCalled();
  });
});

describe('a dead card (spec 2026-09-26 §4.7)', () => {
  const body = { answers: [{ selected: [0] }, { selected: [0] }] };

  it('answer: a 404 from the scope closes the card as expired, says so, and still answers 404', async () => {
    const { ctx, tabQuestions } = ctxFor(row(), { outOfScope: true });
    await rejects(answerTabQuestion(ctx, 'q1', body, { log: log() }), 404, 'NOT_FOUND');
    expect(tabQuestions.expireOne).toHaveBeenCalledWith('q1');
    expect(events).toEqual([expect.objectContaining({ type: 'tab_question_closed', user_id: 'u1', question: expect.objectContaining({ id: 'q1', status: 'expired' }) })]);
    expect(tabQuestions.claim).not.toHaveBeenCalled();
    expect(sendKey).not.toHaveBeenCalled();
  });

  it('screen: the same', async () => {
    const { ctx, tabQuestions } = ctxFor(permission(), { outOfScope: true });
    await rejects(tabQuestionScreen(ctx, 'q2', { log: log() }), 404, 'NOT_FOUND');
    expect(tabQuestions.expireOne).toHaveBeenCalledWith('q2');
    expect(events.map((e) => e.type)).toEqual(['tab_question_closed']);
  });

  it('any other failure of the scope leaves the card alone', async () => {
    const { ctx, tabQuestions } = ctxFor(row(), { tabFails: new HttpError(503, 'Máquina offline', 'MACHINE_OFFLINE') });
    await rejects(answerTabQuestion(ctx, 'q1', body, { log: log() }), 503, 'MACHINE_OFFLINE');
    expect(tabQuestions.expireOne).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it('closing it is best effort: a failed close still answers 404, and logs the code only', async () => {
    const { ctx, tabQuestions } = ctxFor(row(), { outOfScope: true });
    tabQuestions.expireOne.mockRejectedValueOnce(Object.assign(new Error('Qual cor?'), { code: 'P1001' }));
    const l = log();
    await rejects(answerTabQuestion(ctx, 'q1', body, { log: l }), 404, 'NOT_FOUND');
    expect(l.warn).toHaveBeenCalledWith({ tabQuestionId: 'q1', tabId: 't1', code: 'CLOSE_FAILED' }, 'dead tab question not closed');
  });
});
