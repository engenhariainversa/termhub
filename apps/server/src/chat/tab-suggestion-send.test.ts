import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import { agents } from '../agent/registry.js';
import { ControlError, type ControlContext } from '../control/context.js';
import type { TabQuestion } from '../db/repositories/tab-questions.js';
import { HttpError, notFound } from '../lib/errors.js';
import { chatBus, type ChatEvent } from './bus.js';

const sendInput = vi.fn(async (_ctx: unknown, input: { tab_id: string }) => ({ tab_id: input.tab_id, sent: true }));
vi.mock('../control/terminals.js', async (orig) => ({ ...(await orig<typeof import('../control/terminals.js')>()), sendInput: (...a: unknown[]) => sendInput(a[0], a[1] as never) }));
const captureStyledScreen = vi.fn();
vi.mock('../agent/screen.js', async (orig) => ({ ...(await orig<typeof import('../agent/screen.js')>()), captureStyledScreen: (...a: unknown[]) => captureStyledScreen(...a) }));

const { dismissTabSuggestion, sendTabSuggestion } = await import('./tab-suggestion-send.js');

const fx = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures/tab-suggestions', name), 'utf8');
const screens = { suggestion: fx('screen-suggestion.ansi'), typed: fx('screen-typed.ansi') };

const row = (over: Partial<TabQuestion> = {}): TabQuestion => ({
  id: 's1', tab_id: 't1', project_id: 'p1', conversation_id: 'c1', user_id: 'u1', kind: 'suggestion', payload: { text: 'commit it' }, tool_use_id: null,
  status: 'open', answer: null, error_code: null, answered_by: null, answered_at: null, closed_at: null, injected_at: null, created_at: '2026-09-25T12:00:00.000Z', ...over,
});

function ctxFor(current: TabQuestion | undefined, opts: { latest?: TabQuestion | undefined; claimLoses?: boolean; denied?: string[]; outOfScope?: boolean } = {}) {
  const tabQuestions = {
    findByIdForUser: vi.fn(async (_id: string, userId: string) => (userId === 'u1' ? current : undefined)),
    findOpenForTab: vi.fn(async () => ('latest' in opts ? opts.latest : current)),
    claimSuggestion: vi.fn(async (_id: string, _u: string, answer: unknown) => (opts.claimLoses || !current ? undefined : { ...current, status: 'answered' as const, answer: answer as never, answered_by: 'u1', answered_at: '2026-09-25T12:01:00.000Z' })),
    markFailed: vi.fn(async (_id: string, code: string) => (current ? { ...current, status: 'failed' as const, error_code: code } : undefined)),
    closeOne: vi.fn(async (_id: string, status: 'answered_in_tab' | 'expired') => (current ? { ...current, status, closed_at: '2026-09-25T12:01:00.000Z' } : undefined)),
    dismiss: vi.fn(async () => (current?.status === 'open' ? { ...current, status: 'dismissed' as const, closed_at: '2026-09-25T12:01:00.000Z' } : undefined)),
    expireOne: vi.fn(async (_id: string) => (current && current.closed_at === null ? { ...current, status: current.status === 'open' ? ('expired' as const) : current.status, closed_at: '2026-09-26T12:02:00.000Z' } : undefined)),
  };
  const scoped = {
    tab: vi.fn(async (id: string) => {
      if (opts.outOfScope) throw notFound('Tab não encontrada');
      return { tab: { id, name: 'api', kind: 'terminal', tmux_session: 'th-t1', state: 'waiting_input' }, machine: { id: 'm1', type: 'agent' }, project: { id: 'p1' }, cwd: '/w' };
    }),
  };
  const repos = { tabQuestions, tabs: { findByIdsForOwner: vi.fn(async () => [{ id: 't1', name: 'api' }]) } };
  const can = vi.fn(async (resource: string, action: string) => !(opts.denied ?? []).includes(`${resource}:${action}`));
  const ctx = { repos, scoped, scope: { user: { id: 'u1' } }, can } as unknown as ControlContext;
  return { ctx, tabQuestions, scoped, can };
}
const log = () => ({ info: vi.fn(), warn: vi.fn() });
const rejects = async (p: Promise<unknown>, status: number, code: string) => {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(HttpError);
  expect(err).toMatchObject({ statusCode: status, code });
};

let events: ChatEvent[];
let unsubscribe: () => void;
beforeEach(() => {
  vi.clearAllMocks();
  captureStyledScreen.mockResolvedValue({ text: screens.suggestion, styled: true });
  vi.spyOn(agents, 'isOnline').mockReturnValue(true);
  events = [];
  unsubscribe = chatBus.subscribe((e) => events.push(e));
});
afterEach(() => {
  unsubscribe();
  vi.restoreAllMocks();
});

describe('sendTabSuggestion', () => {
  it('checks the live prompt, claims, types the text and Enter, and announces the card closed as sent', async () => {
    const { ctx, tabQuestions } = ctxFor(row());
    const l = log();
    const view = await sendTabSuggestion(ctx, 's1', { text: 'commit it' }, { log: l });
    expect(captureStyledScreen).toHaveBeenCalledWith({ id: 'm1', type: 'agent' }, 'th-t1', 15);
    expect(tabQuestions.claimSuggestion).toHaveBeenCalledWith('s1', 'u1', { text: 'commit it' });
    expect(sendInput).toHaveBeenCalledWith(ctx, { tab_id: 't1', text: 'commit it', enter: true });
    expect(tabQuestions.claimSuggestion.mock.invocationCallOrder[0]!).toBeLessThan(sendInput.mock.invocationCallOrder[0]!);
    expect(view).toMatchObject({ id: 's1', tab_name: 'api', status: 'answered', answer: { text: 'commit it' } });
    expect(events).toEqual([expect.objectContaining({ type: 'tab_suggestion_closed', user_id: 'u1', conversation_id: 'c1', suggestion: expect.objectContaining({ status: 'answered' }) })]);
    expect(l.info).toHaveBeenCalledWith({ tabQuestionId: 's1', tabId: 't1', kind: 'suggestion', chars: 9, edited: false }, 'tab suggestion sent');
    expect(JSON.stringify(l.info.mock.calls)).not.toContain('commit');
  });

  it('sends the text as edited; the live check still compares the suggestion itself', async () => {
    const { ctx, tabQuestions } = ctxFor(row());
    await sendTabSuggestion(ctx, 's1', { text: '  commit it and push ' }, { log: log() });
    expect(tabQuestions.claimSuggestion).toHaveBeenCalledWith('s1', 'u1', { text: 'commit it and push' });
    expect(sendInput).toHaveBeenCalledWith(ctx, { tab_id: 't1', text: 'commit it and push', enter: true });
  });

  it.each([
    ['text typed in the tab', { text: screens.typed, styled: true }],
    ['a different suggestion now', { text: '❯ \x1b[2mrun the tests\x1b[0m', styled: true }],
    ['a capture without attributes', { text: '❯ commit it', styled: false }],
  ])('409 TAB_PROMPT_CHANGED and the card closes when the prompt shows %s', async (_label, shot) => {
    captureStyledScreen.mockResolvedValue(shot);
    const { ctx, tabQuestions } = ctxFor(row());
    await rejects(sendTabSuggestion(ctx, 's1', { text: 'commit it' }, { log: log() }), 409, 'TAB_PROMPT_CHANGED');
    expect(tabQuestions.closeOne).toHaveBeenCalledWith('s1', 'answered_in_tab');
    expect(events).toEqual([expect.objectContaining({ type: 'tab_suggestion_closed', suggestion: expect.objectContaining({ status: 'answered_in_tab' }) })]);
    expect(tabQuestions.claimSuggestion).not.toHaveBeenCalled();
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('says "A sugestão mudou na aba"', async () => {
    captureStyledScreen.mockResolvedValue({ text: screens.typed, styled: true });
    const { ctx } = ctxFor(row());
    await expect(sendTabSuggestion(ctx, 's1', { text: 'commit it' }, { log: log() })).rejects.toThrow('A sugestão mudou na aba');
  });

  it('403 FORBIDDEN without terminals:write, nothing read', async () => {
    const { ctx, can, tabQuestions } = ctxFor(row(), { denied: ['terminals:write'] });
    await rejects(sendTabSuggestion(ctx, 's1', { text: 'commit it' }, { log: log() }), 403, 'FORBIDDEN');
    expect(can).toHaveBeenCalledWith('terminals', 'write');
    expect(tabQuestions.findByIdForUser).not.toHaveBeenCalled();
  });

  it.each([
    ['unknown', undefined],
    ['a question, not a suggestion', row({ id: 'q1', kind: 'permission', payload: { tool_name: 'Bash' } })],
  ])('404 for %s', async (_label, current) => {
    const { ctx, tabQuestions } = ctxFor(current);
    await rejects(sendTabSuggestion(ctx, 's1', { text: 'commit it' }, { log: log() }), 404, 'NOT_FOUND');
    expect(tabQuestions.claimSuggestion).not.toHaveBeenCalled();
    expect(captureStyledScreen).not.toHaveBeenCalled();
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('refuses C1 in the text, before any screen read or claim', async () => {
    const { ctx, tabQuestions } = ctxFor(row());
    await expect(sendTabSuggestion(ctx, 's1', { text: 'commit\u009bit' }, { log: log() })).rejects.toBeInstanceOf(ZodError);
    expect(captureStyledScreen).not.toHaveBeenCalled();
    expect(tabQuestions.claimSuggestion).not.toHaveBeenCalled();
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('404 when the tab is gone or left the scope: the card closes as expired, on its own event', async () => {
    const { ctx, tabQuestions } = ctxFor(row(), { outOfScope: true });
    await rejects(sendTabSuggestion(ctx, 's1', { text: 'commit it' }, { log: log() }), 404, 'NOT_FOUND');
    expect(tabQuestions.expireOne).toHaveBeenCalledWith('s1');
    expect(events).toEqual([expect.objectContaining({ type: 'tab_suggestion_closed', suggestion: expect.objectContaining({ id: 's1', status: 'expired' }) })]);
    expect(captureStyledScreen).not.toHaveBeenCalled();
  });

  it('409 without typing: not open, not the tab\'s latest, or the claim lost (a double click)', async () => {
    await rejects(sendTabSuggestion(ctxFor(row({ status: 'dismissed' })).ctx, 's1', { text: 'commit it' }, { log: log() }), 409, 'TAB_PROMPT_CHANGED');
    await rejects(sendTabSuggestion(ctxFor(row(), { latest: row({ id: 's2' }) }).ctx, 's1', { text: 'commit it' }, { log: log() }), 409, 'TAB_PROMPT_CHANGED');
    await rejects(sendTabSuggestion(ctxFor(row(), { claimLoses: true }).ctx, 's1', { text: 'commit it' }, { log: log() }), 409, 'TAB_PROMPT_CHANGED');
    expect(sendInput).not.toHaveBeenCalled();
  });

  it.each([['!rm -rf .'], ['/exit'], ['a\nb'], ['tab\there'], [''], ['   '], ['x'.repeat(2001)]])('refuses %j before anything is read', async (text) => {
    const { ctx } = ctxFor(row());
    await expect(sendTabSuggestion(ctx, 's1', { text }, { log: log() })).rejects.toBeInstanceOf(ZodError);
    expect(captureStyledScreen).not.toHaveBeenCalled();
  });

  it('an offline agent is 409 MACHINE_OFFLINE, nothing claimed', async () => {
    vi.mocked(agents.isOnline).mockReturnValue(false);
    const { ctx, tabQuestions } = ctxFor(row());
    await rejects(sendTabSuggestion(ctx, 's1', { text: 'commit it' }, { log: log() }), 409, 'MACHINE_OFFLINE');
    expect(tabQuestions.claimSuggestion).not.toHaveBeenCalled();
  });

  it('a live check that cannot read the tab answers its error: nothing closed, claimed or typed', async () => {
    captureStyledScreen.mockRejectedValueOnce(new ControlError('MACHINE_FAILED', 'Falha na máquina'));
    const { ctx, tabQuestions } = ctxFor(row());
    const err = await sendTabSuggestion(ctx, 's1', { text: 'commit it' }, { log: log() }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ code: 'MACHINE_FAILED' });
    expect(tabQuestions.closeOne).not.toHaveBeenCalled();
    expect(tabQuestions.claimSuggestion).not.toHaveBeenCalled();
    expect(sendInput).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it('a send that fails after the claim marks the card failed and answers 502', async () => {
    sendInput.mockRejectedValueOnce(new ControlError('MACHINE_OFFLINE', 'A máquina está offline'));
    const { ctx, tabQuestions } = ctxFor(row());
    await rejects(sendTabSuggestion(ctx, 's1', { text: 'commit it' }, { log: log() }), 502, 'MACHINE_OFFLINE');
    expect(tabQuestions.markFailed).toHaveBeenCalledWith('s1', 'MACHINE_OFFLINE');
    expect(events).toEqual([expect.objectContaining({ type: 'tab_suggestion_closed', suggestion: expect.objectContaining({ status: 'failed', error_code: 'MACHINE_OFFLINE' }) })]);
  });
});

describe('dismissTabSuggestion', () => {
  it('closes an open suggestion as dismissed without touching the tab', async () => {
    const { ctx, tabQuestions } = ctxFor(row());
    const view = await dismissTabSuggestion(ctx, 's1', { log: log() });
    expect(tabQuestions.dismiss).toHaveBeenCalledWith('s1', 'u1');
    expect(view).toMatchObject({ id: 's1', status: 'dismissed' });
    expect(events).toEqual([expect.objectContaining({ type: 'tab_suggestion_closed', suggestion: expect.objectContaining({ status: 'dismissed' }) })]);
    expect(captureStyledScreen).not.toHaveBeenCalled();
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('a dismiss whose announcement fails still answers dismissed, and logs by code only', async () => {
    const { ctx } = ctxFor(row());
    (ctx.repos as unknown as { tabs: { findByIdsForOwner: ReturnType<typeof vi.fn> } }).tabs.findByIdsForOwner.mockRejectedValueOnce(new Error('db down'));
    const l = log();
    const view = await dismissTabSuggestion(ctx, 's1', { log: l });
    expect(view).toMatchObject({ id: 's1', status: 'dismissed' });
    expect(l.warn).toHaveBeenCalledWith({ tabQuestionId: 's1', tabId: 't1', code: 'PUBLISH_FAILED' }, 'tab suggestion dismiss not announced');
    expect(JSON.stringify(l.warn.mock.calls)).not.toContain('db down');
  });

  it('a suggestion already sent or closed stays as it is, and nothing is announced', async () => {
    const { ctx } = ctxFor(row({ status: 'answered', answer: { text: 'commit it' } }));
    expect(await dismissTabSuggestion(ctx, 's1', { log: log() })).toMatchObject({ status: 'answered' });
    expect(events).toEqual([]);
  });

  it('404 for a question id or another user\'s row', async () => {
    await rejects(dismissTabSuggestion(ctxFor(row({ kind: 'choice' })).ctx, 's1', { log: log() }), 404, 'NOT_FOUND');
    await rejects(dismissTabSuggestion(ctxFor(undefined).ctx, 's1', { log: log() }), 404, 'NOT_FOUND');
  });
});
