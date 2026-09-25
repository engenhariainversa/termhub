import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import type { TabQuestion } from '../db/repositories/tab-questions.js';
import type { Tab } from '../db/repositories/types.js';
import { monitorBus } from '../monitor/bus.js';
import type { Interpreted } from '../monitor/state.js';
import { chatBus, type ChatEvent } from './bus.js';
import { closesOpenQuestion, noteHookEvent, openTabQuestion, startTabQuestionExpiry } from './tab-questions.js';

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

  it('a project with no conversation gets nothing, but the tab\'s old question still closes', async () => {
    const repos = fakeRepos({ conversation: null, closed: [row({ id: 'q0', status: 'answered_in_tab' })] });
    expect(await openTabQuestion(asRepos(repos), tab, { kind: 'permission', payload: { tool_name: 'Bash' }, tool_use_id: null })).toBeNull();
    expect(repos.tabQuestions.open).not.toHaveBeenCalled();
    expect(repos.tabQuestions.closeForTab).toHaveBeenCalledWith('t1', 'answered_in_tab');
    expect(events.map((e) => e.type)).toEqual(['tab_question_closed']);
  });

  it('a project with no owner has no chat to show it in: nothing opens, the old question still closes', async () => {
    const repos = fakeRepos({ owner: null, closed: [row({ id: 'q0', status: 'answered_in_tab' })] });
    expect(await openTabQuestion(asRepos(repos), tab, { kind: 'choice', payload, tool_use_id: 'toolu_1' })).toBeNull();
    expect(repos.chat.findLatestActiveForProject).not.toHaveBeenCalled();
    expect(repos.tabQuestions.open).not.toHaveBeenCalled();
    expect(repos.tabQuestions.closeForTab).toHaveBeenCalledWith('t1', 'answered_in_tab');
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
    expect(repos.tabQuestions.closeForTab).toHaveBeenCalledWith('t1', 'answered_in_tab');
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
