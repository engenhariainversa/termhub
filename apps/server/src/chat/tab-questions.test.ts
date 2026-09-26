import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import type { TabQuestion } from '../db/repositories/tab-questions.js';
import type { Tab } from '../db/repositories/types.js';
import { monitorBus } from '../monitor/bus.js';
import type { Interpreted } from '../monitor/state.js';
import { chatBus, type ChatEvent } from './bus.js';
import { closesOpenQuestion, expireOrphanTabQuestions, noteHookEvent, openTabQuestion, publishTabQuestions, startTabQuestionExpiry } from './tab-questions.js';

const tab = { id: 't1', project_id: 'p1', machine_id: 'm1', name: 'api' } as Tab;
const payload = { questions: [{ question: 'Qual cor?', header: 'Cor', multi_select: false, options: [{ label: 'Azul', description: '', recommended: true }, { label: 'Verde', description: '', recommended: false }] }] };
const row = (over: Partial<TabQuestion> = {}): TabQuestion => ({
  id: 'q1', tab_id: 't1', project_id: 'p1', conversation_id: 'c1', user_id: 'u1', kind: 'choice', payload, tool_use_id: 'toolu_1',
  status: 'open', answer: null, error_code: null, answered_by: null, answered_at: null, closed_at: null, injected_at: null, created_at: '2026-09-25T12:00:00.000Z', ...over,
});
const choice: Interpreted = { kind: 'working', text: null, activity: 'planning', verb: null, meta: { event: 'PreToolUse', tool: 'AskUserQuestion' }, question: { kind: 'choice', payload, tool_use_id: 'toolu_1' } };
const log = () => ({ info: vi.fn(), warn: vi.fn() });

function fakeRepos(opts: { conversation?: { id: string; user_id: string } | null; closed?: TabQuestion[]; opened?: TabQuestion | null; owner?: string | null } = {}) {
  const conversation = opts.conversation === undefined ? { id: 'c1', user_id: 'u1' } : (opts.conversation ?? undefined);
  const owner = opts.owner === undefined ? 'u1' : opts.owner;
  return {
    projects: { findById: vi.fn(async (id: string) => (id === 'p1' ? { id: 'p1', owner_id: owner } : undefined)) },
    chat: { findLatestActiveForProject: vi.fn(async () => conversation) },
    tabQuestions: {
      open: vi.fn(async () => ({ question: opts.opened === undefined ? row() : opts.opened, closed: opts.closed ?? [] })),
      closeForTab: vi.fn(async () => opts.closed ?? []),
    },
    tabs: { findByIdsForOwner: vi.fn(async (ids: string[], owner: string) => (owner === 'u1' && ids.includes('t1') ? [tab] : [])) },
  };
}
const asRepos = (r: ReturnType<typeof fakeRepos>) => r as unknown as Repositories;

let events: ChatEvent[];
let unsubscribe: () => void;
beforeEach(() => {
  events = [];
  unsubscribe = chatBus.subscribe((e) => events.push(e));
});
afterEach(() => unsubscribe());

describe('closesOpenQuestion', () => {
  it.each([
    ['a tool call', { kind: 'working', text: null, meta: { event: 'PreToolUse', tool: 'Edit' } }, true],
    ['a finished turn', { kind: 'waiting_input', text: null, meta: { event: 'Stop' } }, true],
    ['a new prompt', { kind: 'working', text: null, meta: { event: 'UserPromptSubmit' } }, true],
    ['the permission_prompt notification', { kind: 'waiting_permission', text: 'x', meta: { event: 'Notification', type: 'permission_prompt' } }, false],
    ['an idle reminder', { kind: 'waiting_input', text: 'x', meta: { event: 'Notification', type: 'idle_prompt' } }, false],
    ['AskUserQuestion\'s own PermissionRequest', { kind: 'waiting_permission', text: null, meta: { event: 'PermissionRequest', tool: 'AskUserQuestion' } }, false],
    ['an event that opens a question', choice, false],
    ["a subagent's tool call", { kind: 'working', text: null, meta: { event: 'PreToolUse', tool: 'Bash', subagent: true } }, false],
    ["a subagent's permission prompt that opens no card (ExitPlanMode)", { kind: 'waiting_permission', text: null, meta: { event: 'PermissionRequest', tool: 'ExitPlanMode', subagent: true } }, false],
  ] as [string, Interpreted, boolean][])('%s → %s', (_l, next, closes) => {
    expect(closesOpenQuestion(next)).toBe(closes);
  });
});

describe('openTabQuestion', () => {
  it('opens in the project\'s latest conversation, closing and announcing the one it replaces', async () => {
    const replaced = row({ id: 'q0', status: 'answered_in_tab', closed_at: '2026-09-25T12:00:00.000Z' });
    const repos = fakeRepos({ closed: [replaced], opened: row({ id: 'q1' }) });
    const q = await openTabQuestion(asRepos(repos), tab, { kind: 'choice', payload, tool_use_id: 'toolu_1' });
    expect(q?.id).toBe('q1');
    // Only the project owner's conversations: a former owner's chat never gets the card.
    expect(repos.chat.findLatestActiveForProject).toHaveBeenCalledWith('p1', 'u1');
    expect(repos.tabQuestions.open).toHaveBeenCalledWith({ tab_id: 't1', project_id: 'p1', conversation_id: 'c1', kind: 'choice', payload, tool_use_id: 'toolu_1' });
    expect(events.map((e) => [e.type, 'question' in e ? e.question.id : null])).toEqual([
      ['tab_question_closed', 'q0'],
      ['tab_question', 'q1'],
    ]);
    expect(events[1]).toMatchObject({ user_id: 'u1', conversation_id: 'c1', question: { tab_name: 'api', status: 'open', payload } });
  });

  it('a project with no conversation gets no card, but the queue rules still run: the old question closes', async () => {
    const repos = fakeRepos({ conversation: null, opened: null, closed: [row({ id: 'q0', status: 'answered_in_tab' })] });
    expect(await openTabQuestion(asRepos(repos), tab, { kind: 'permission', payload: { tool_name: 'Bash' }, tool_use_id: null })).toBeNull();
    // Through `open` with no conversation: under the tab's lock, the queue marking included (spec 2026-09-26 §4.1).
    expect(repos.tabQuestions.open).toHaveBeenCalledWith({ tab_id: 't1', project_id: 'p1', conversation_id: null, kind: 'permission', payload: { tool_name: 'Bash' }, tool_use_id: null });
    expect(repos.tabQuestions.closeForTab).not.toHaveBeenCalled();
    expect(events.map((e) => e.type)).toEqual(['tab_question_closed']);
  });

  it('a project with no owner has no chat to show it in: the same path, no conversation looked up', async () => {
    const repos = fakeRepos({ owner: null, opened: null, closed: [row({ id: 'q0', status: 'answered_in_tab' })] });
    expect(await openTabQuestion(asRepos(repos), tab, { kind: 'choice', payload, tool_use_id: 'toolu_1' })).toBeNull();
    expect(repos.chat.findLatestActiveForProject).not.toHaveBeenCalled();
    expect(repos.tabQuestions.open).toHaveBeenCalledWith(expect.objectContaining({ conversation_id: null, kind: 'choice' }));
    expect(repos.tabQuestions.closeForTab).not.toHaveBeenCalled();
  });

  it('a permission queued behind an open one (the repo opens nothing): the old card closes, no new card', async () => {
    const repos = fakeRepos({ opened: null, closed: [row({ id: 'q0', kind: 'permission', payload: { tool_name: 'Bash' }, status: 'answered_in_tab' })] });
    expect(await openTabQuestion(asRepos(repos), tab, { kind: 'permission', payload: { tool_name: 'Edit' }, tool_use_id: null })).toBeNull();
    expect(events.map((e) => [e.type, 'question' in e ? e.question.id : null])).toEqual([['tab_question_closed', 'q0']]);
  });
});

describe('noteHookEvent', () => {
  it('opens on a question, closes on anything else, leaves it alone on a notification', async () => {
    const repos = fakeRepos();
    await noteHookEvent(asRepos(repos), log(), tab, choice);
    expect(repos.tabQuestions.open).toHaveBeenCalledTimes(1);
    await noteHookEvent(asRepos(repos), log(), tab, { kind: 'waiting_permission', text: 'x', meta: { event: 'Notification', type: 'permission_prompt' } });
    expect(repos.tabQuestions.closeForTab).not.toHaveBeenCalled();
    await noteHookEvent(asRepos(repos), log(), tab, { kind: 'working', text: null, meta: { event: 'PreToolUse', tool: 'Bash' } });
    expect(repos.tabQuestions.closeForTab).toHaveBeenCalledWith('t1', 'answered_in_tab'); // a closing event: ends a permission queue
  });

  it("a subagent's event updates nothing on the card: no close", async () => {
    const repos = fakeRepos();
    await noteHookEvent(asRepos(repos), log(), tab, { kind: 'working', text: null, meta: { event: 'PreToolUse', tool: 'Bash', subagent: true } });
    expect(repos.tabQuestions.closeForTab).not.toHaveBeenCalled();
    expect(repos.tabQuestions.open).not.toHaveBeenCalled();
  });

  it('never throws, and logs the failure by code and ids only', async () => {
    const repos = fakeRepos();
    repos.tabQuestions.open.mockRejectedValue(Object.assign(new Error('Qual cor? secret'), { code: 'P2002' }));
    const l = log();
    await expect(noteHookEvent(asRepos(repos), l, tab, choice)).resolves.toBeUndefined();
    expect(l.warn).toHaveBeenCalledWith({ tabId: 't1', code: 'P2002' }, 'tab question bookkeeping failed');
  });

  it('logs an opened question by id, kind and count — never its text', async () => {
    const l = log();
    await noteHookEvent(asRepos(fakeRepos()), l, tab, choice);
    expect(l.info).toHaveBeenCalledWith({ tabId: 't1', tabQuestionId: 'q1', kind: 'choice', questions: 1 }, 'tab question opened');
    expect(JSON.stringify(l.info.mock.calls)).not.toContain('Qual cor');
  });
});

describe('startTabQuestionExpiry', () => {
  it('a removed tab expires its question; an opened or renamed one does not', async () => {
    const repos = fakeRepos({ closed: [row({ status: 'expired' })] });
    const stop = startTabQuestionExpiry(asRepos(repos), log());
    monitorBus.publishLifecycle({ kind: 'upsert', tab, project_id: 'p1', machine_id: 'm1', owner_id: 'u1' });
    monitorBus.publishLifecycle({ kind: 'removed', tab_id: 't1', project_id: 'p1', machine_id: 'm1', owner_id: 'u1' });
    await new Promise((r) => setTimeout(r, 10));
    stop();
    expect(repos.tabQuestions.closeForTab).toHaveBeenCalledTimes(1);
    expect(repos.tabQuestions.closeForTab).toHaveBeenCalledWith('t1', 'expired');
    expect(events.map((e) => e.type)).toEqual(['tab_question_closed']);
  });
});

describe('publishTabQuestions', () => {
  it('a suggestion row goes out on its own events, never as a tab question', async () => {
    const repos = fakeRepos();
    const s = row({ id: 's1', kind: 'suggestion', payload: { text: 'commit it' }, tool_use_id: null });
    await publishTabQuestions(asRepos(repos), 'tab_question', [s]);
    await publishTabQuestions(asRepos(repos), 'tab_question_answered', [{ ...s, status: 'answered', answer: { text: 'commit it' } }]);
    await publishTabQuestions(asRepos(repos), 'tab_question_closed', [{ ...s, status: 'dismissed' }]);
    expect(events.map((e) => e.type)).toEqual(['tab_suggestion', 'tab_suggestion_closed', 'tab_suggestion_closed']);
    expect(events[0]).toMatchObject({ user_id: 'u1', conversation_id: 'c1', suggestion: { id: 's1', tab_name: 'api', kind: 'suggestion', payload: { text: 'commit it' } } });
  });
});

describe('expireOrphanTabQuestions', () => {
  it('closes and announces every card whose tab is gone; logs the count only', async () => {
    const repos = fakeRepos();
    const gone = row({ status: 'expired', closed_at: '2026-09-26T12:00:00.000Z' });
    (repos.tabQuestions as Record<string, unknown>).expireOrphans = vi.fn(async () => [gone]);
    const l = log();
    expect(await expireOrphanTabQuestions(asRepos(repos), l)).toBe(1);
    expect(events).toEqual([expect.objectContaining({ type: 'tab_question_closed', question: expect.objectContaining({ id: 'q1', status: 'expired' }) })]);
    expect(l.info).toHaveBeenCalledWith({ count: 1 }, 'orphan tab questions expired');
  });

  it('says nothing when there is nothing to sweep, and never throws', async () => {
    const repos = fakeRepos();
    (repos.tabQuestions as Record<string, unknown>).expireOrphans = vi.fn(async () => []);
    const l = log();
    expect(await expireOrphanTabQuestions(asRepos(repos), l)).toBe(0);
    expect(l.info).not.toHaveBeenCalled();
    (repos.tabQuestions as Record<string, unknown>).expireOrphans = vi.fn(async () => {
      throw Object.assign(new Error('x'), { code: 'P1001' });
    });
    expect(await expireOrphanTabQuestions(asRepos(repos), l)).toBe(0);
    expect(l.warn).toHaveBeenCalledWith({ code: 'P1001' }, 'orphan tab question sweep failed');
  });
});
