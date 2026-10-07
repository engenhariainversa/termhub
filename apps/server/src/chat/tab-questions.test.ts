import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import type { AutoAnswer, TabQuestion } from '../db/repositories/tab-questions.js';
import type { Tab } from '../db/repositories/types.js';
import { monitorBus } from '../monitor/bus.js';
import type { Interpreted } from '../monitor/state.js';
import { chatBus, type ChatEvent } from './bus.js';
import { suggestFor } from './decision-memory.js';
import { heldQuestion, resetQuestionHolds } from '../automation/question-hold.js';
import type { TabQuestionSuggestion } from './decision-text.js';
import type { Embedder } from './embeddings.js';
import { closingScope, expireOrphanTabQuestions, noteHookEvent, openTabQuestion, publishTabQuestions, startTabQuestionExpiry } from './tab-questions.js';

vi.mock('./decision-memory.js', () => ({ suggestFor: vi.fn(async () => null) }));

const tab = { id: 't1', project_id: 'p1', machine_id: 'm1', name: 'api' } as Tab;
const payload = { questions: [{ question: 'Qual cor?', header: 'Cor', multi_select: false, options: [{ label: 'Azul', description: '', recommended: true }, { label: 'Verde', description: '', recommended: false }] }] };
const row = (over: Partial<TabQuestion> = {}): TabQuestion => ({
  id: 'q1', tab_id: 't1', project_id: 'p1', conversation_id: 'c1', user_id: 'u1', kind: 'choice', payload, tool_use_id: 'toolu_1',
  status: 'open', answer: null, error_code: null, answered_by: null, answered_at: null, closed_at: null, injected_at: null, created_at: '2026-09-25T12:00:00.000Z', suggestion: null,
  auto_answer: null, answered_via: null, woken_at: null, ...over,
});
const choice: Interpreted = { kind: 'working', text: null, activity: 'planning', verb: null, meta: { event: 'PreToolUse', tool: 'AskUserQuestion' }, question: { kind: 'choice', payload, tool_use_id: 'toolu_1' } };
const log = () => ({ info: vi.fn(), warn: vi.fn() });
/** A stand-in `Embedder`: `suggestFor` is mocked in this file, so nothing here ever calls `embed` — it
 * only has to be non-null, to exercise `openTabQuestion`'s "an embedder ran" branch. */
const someEmbedder: Embedder = { embed: vi.fn(async () => ({ model: 'm', vectors: [] })) };

function fakeRepos(
  opts: {
    conversation?: { id: string; user_id: string } | null;
    closed?: TabQuestion[];
    opened?: TabQuestion | null;
    owner?: string | null;
    /** `setSuggestion`'s outcome: attaches it ('ok', default), finds the row no longer open
     *  ('not-open'), or fails outright ('throws'). */
    setSuggestion?: 'ok' | 'not-open' | 'throws';
    /** What `findOpenForTab` reports back when `openTabQuestion` re-checks a stale `null` suggestion.
     *  Defaults to the row it just opened, i.e. "still the same open question". */
    stillOpen?: TabQuestion | undefined;
    /** The person's "Responder sozinho" switch (off by default). */
    autodecide?: boolean;
  } = {},
) {
  const conversation = opts.conversation === undefined ? { id: 'c1', user_id: 'u1' } : (opts.conversation ?? undefined);
  const owner = opts.owner === undefined ? 'u1' : opts.owner;
  const opened = opts.opened === undefined ? row() : opts.opened;
  return {
    projects: { findById: vi.fn(async (id: string) => (id === 'p1' ? { id: 'p1', owner_id: owner } : undefined)) },
    chat: { findLatestActiveForProject: vi.fn(async () => conversation) },
    tabQuestions: {
      open: vi.fn(async () => ({ question: opened, closed: opts.closed ?? [] })),
      closeForTab: vi.fn(async () => opts.closed ?? []),
      setSuggestion: vi.fn(async (_id: string, s: TabQuestionSuggestion) => {
        if (opts.setSuggestion === 'not-open') return undefined;
        if (opts.setSuggestion === 'throws') throw Object.assign(new Error('db down'), { code: 'P2024' });
        return { ...(opened ?? row()), suggestion: s };
      }),
      findOpenForTab: vi.fn(async () => ('stillOpen' in opts ? opts.stillOpen : opened)),
      setAutoAnswer: vi.fn(async (_id: string, auto: AutoAnswer) => ({ ...(opened ?? row()), suggestion: null as TabQuestionSuggestion | null, auto_answer: auto })),
    },
    users: { chatAutodecide: vi.fn(async () => opts.autodecide ?? false) },
    // The repeat path re-reads the decisions a suggestion cites: `d1` answered "Azul" to this same card.
    chatDecisions: {
      findManyForUser: vi.fn(async (ids: string[], userId: string) =>
        ids.includes('d1') && userId === 'u1'
          ? [{ id: 'd1', user_id: 'u1', project_id: 'p1', project_name: 'Proj', conversation_id: null, tab_question_id: null, question_index: 0, header: 'Cor', question: 'Qual cor?', options: [{ label: 'Azul', description: '' }, { label: 'Verde', description: '' }], multi_select: false, answer: { labels: ['Azul'] }, embed_model: 'm', suggested_count: 0, accepted_count: 0, auto_count: 0, status: 'current', expires_at: null, supersedes: null, created_at: '2026-09-20T00:00:00.000Z' }]
          : [],
      ),
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

describe('closingScope', () => {
  it.each([
    ['an event that opens a question', choice, null],
    ['a notification', { kind: 'waiting_permission', text: null, meta: { event: 'Notification' } }, null],
    ['an idle reminder', { kind: 'waiting_input', text: null, meta: { event: 'Notification', type: 'idle_prompt' } }, null],
    ['the question companion', { kind: 'waiting_permission', text: null, meta: { event: 'PermissionRequest', tool: 'AskUserQuestion' } }, null],
    ['an old script subagent', { kind: 'working', text: null, meta: { event: 'PreToolUse', subagent: true } }, null],
    ['a subagent tool call', { kind: 'working', text: null, meta: { event: 'PreToolUse', subagent: true, agent_id: 'A' } }, { agent: 'A', leavesQueue: false }],
    ['a subagent ending', { kind: 'working', text: null, closeOnly: true, meta: { event: 'SubagentStop', subagent: true, agent_id: 'A' } }, { agent: 'A', leavesQueue: true }],
    ['subagent ExitPlanMode', { kind: 'waiting_permission', text: null, meta: { event: 'PermissionRequest', tool: 'ExitPlanMode', subagent: true, agent_id: 'A' } }, { agent: 'A', leavesQueue: false }],
    ['main ExitPlanMode', { kind: 'waiting_permission', text: null, meta: { event: 'PermissionRequest', tool: 'ExitPlanMode' } }, { agent: null, leavesQueue: true }],
    ['main tool call', { kind: 'working', text: null, meta: { event: 'PreToolUse' } }, { agent: null, leavesQueue: true }],
    ['Stop with background work', { kind: 'waiting_input', text: null, backgroundTasks: 2, meta: { event: 'Stop' } }, { agent: null, leavesQueue: true }],
    ['StopFailure', { kind: 'waiting_input', text: null, meta: { event: 'StopFailure' } }, { agent: null, leavesQueue: true }],
    ['Stop without background work', { kind: 'waiting_input', text: null, meta: { event: 'Stop' } }, 'all'],
    ['Stop with zero background tasks', { kind: 'waiting_input', text: null, backgroundTasks: 0, meta: { event: 'Stop' } }, 'all'],
    ['a new prompt', { kind: 'working', text: null, meta: { event: 'UserPromptSubmit' } }, { agent: null, leavesQueue: true }],
    ['session end', { kind: 'idle', text: null, meta: { event: 'SessionEnd' } }, 'all'],
    // Codex's notify only repeats the Stop hook's end of turn; closing on it would close the reply card
    // that Stop just opened (TER-497), so it closes nothing.
    ['Codex turn complete', { kind: 'waiting_input', text: null, meta: { event: 'agent-turn-complete' } }, null],
    ["Codex's PostToolUse", { kind: 'working', text: null, meta: { event: 'PostToolUse', tool: 'request_user_input' } }, { agent: null, leavesQueue: true }],
    ["Codex's Interrupt", { kind: 'waiting_input', text: null, meta: { event: 'Interrupt' } }, { agent: null, leavesQueue: true }],
  ] as [string, Interpreted, { agent: string | null; leavesQueue: boolean } | 'all' | null][])('%s', (_label, next, scope) => {
    expect(closingScope(next)).toEqual(scope);
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
    expect(repos.tabQuestions.open).toHaveBeenCalledWith({ tab_id: 't1', project_id: 'p1', conversation_id: 'c1', kind: 'choice', payload, tool_use_id: 'toolu_1', agent_id: null });
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
    expect(repos.tabQuestions.open).toHaveBeenCalledWith({ tab_id: 't1', project_id: 'p1', conversation_id: null, kind: 'permission', payload: { tool_name: 'Bash' }, tool_use_id: null, agent_id: null });
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

  it('attaches the suggestion before announcing the card', async () => {
    const suggestion: TabQuestionSuggestion = {
      items: [{ question_index: 0, decision_id: 'd1', similarity: 0.9, selected: [0], source: { question: 'Qual cor?', project_name: 'Proj', answered_at: '2026-09-20T00:00:00.000Z' } }],
    };
    vi.mocked(suggestFor).mockResolvedValueOnce(suggestion);
    const opened = row({ id: 'q1' });
    const repos = fakeRepos({ opened });
    const q = await openTabQuestion(asRepos(repos), tab, { kind: 'choice', payload, tool_use_id: 'toolu_1' });
    expect(q).toEqual({ ...opened, suggestion });
    expect(repos.tabQuestions.setSuggestion).toHaveBeenCalledWith('q1', suggestion);
    const tqEvent = events.find((e) => e.type === 'tab_question');
    expect(tqEvent && 'question' in tqEvent ? tqEvent.question.suggestion : undefined).toEqual(suggestion);
  });

  it('the repeat path: a near-verbatim precedent with the switch on publishes the card once, carrying the countdown', async () => {
    const suggestion: TabQuestionSuggestion = {
      items: [{ question_index: 0, decision_id: 'd1', similarity: 0.99, selected: [0], source: { question: 'Qual cor?', project_name: 'Proj', answered_at: '2026-09-20T00:00:00.000Z' } }],
    };
    vi.mocked(suggestFor).mockResolvedValueOnce(suggestion);
    const repos = fakeRepos({ opened: row({ id: 'q1' }), autodecide: true });
    repos.tabQuestions.setAutoAnswer.mockImplementation(async (_id: string, auto: AutoAnswer) => ({ ...row({ id: 'q1' }), suggestion, auto_answer: auto }));
    const q = await openTabQuestion(asRepos(repos), tab, { kind: 'choice', payload, tool_use_id: 'toolu_1' });
    expect(q?.auto_answer).toMatchObject({ status: 'scheduled', by: 'memory', sources: [{ kind: 'decision', id: 'd1' }] });
    const published = events.filter((e) => e.type === 'tab_question');
    expect(published).toHaveLength(1);
    expect(published[0] && 'question' in published[0] ? published[0].question.auto_answer : undefined).toMatchObject({ status: 'scheduled', answer: { answers: [{ selected: [0] }] } });
  });

  it('the repeat path with the switch off publishes the plain suggested card, no countdown', async () => {
    const suggestion: TabQuestionSuggestion = {
      items: [{ question_index: 0, decision_id: 'd1', similarity: 0.99, selected: [0], source: { question: 'Qual cor?', project_name: 'Proj', answered_at: '2026-09-20T00:00:00.000Z' } }],
    };
    vi.mocked(suggestFor).mockResolvedValueOnce(suggestion);
    const repos = fakeRepos({ opened: row({ id: 'q1' }) });
    const q = await openTabQuestion(asRepos(repos), tab, { kind: 'choice', payload, tool_use_id: 'toolu_1' });
    expect(q?.auto_answer).toBeNull();
    expect(repos.tabQuestions.setAutoAnswer).not.toHaveBeenCalled();
    expect(events.filter((e) => e.type === 'tab_question')).toHaveLength(1);
  });

  it('the repeat path failing (a db hiccup) still announces the suggested card', async () => {
    const suggestion: TabQuestionSuggestion = {
      items: [{ question_index: 0, decision_id: 'd1', similarity: 0.99, selected: [0], source: { question: 'Qual cor?', project_name: 'Proj', answered_at: '2026-09-20T00:00:00.000Z' } }],
    };
    vi.mocked(suggestFor).mockResolvedValueOnce(suggestion);
    const repos = fakeRepos({ opened: row({ id: 'q1' }), autodecide: true });
    repos.tabQuestions.setAutoAnswer.mockRejectedValue(Object.assign(new Error('db down'), { code: 'P1001' }));
    const l = log();
    const q = await openTabQuestion(asRepos(repos), tab, { kind: 'choice', payload, tool_use_id: 'toolu_1' }, { embedder: null, log: l });
    expect(q?.suggestion).toEqual(suggestion);
    expect(events.filter((e) => e.type === 'tab_question')).toHaveLength(1);
    expect(l.warn).toHaveBeenCalledWith({ tabQuestionId: 'q1', code: 'P1001' }, 'auto answer not scheduled');
  });

  it('publishes without a suggestion when suggestFor gives null, and does not re-check the tab with no embedder configured', async () => {
    vi.mocked(suggestFor).mockResolvedValueOnce(null);
    const opened = row({ id: 'q1' });
    const repos = fakeRepos({ opened });
    const q = await openTabQuestion(asRepos(repos), tab, { kind: 'choice', payload, tool_use_id: 'toolu_1' });
    expect(q).toEqual(opened);
    expect(repos.tabQuestions.setSuggestion).not.toHaveBeenCalled();
    expect(repos.tabQuestions.findOpenForTab).not.toHaveBeenCalled();
    const tqEvent = events.find((e) => e.type === 'tab_question');
    expect(tqEvent && 'question' in tqEvent ? tqEvent.question.suggestion : undefined).toBeNull();
  });

  it('setSuggestion finding the row no longer open: nothing is announced and openTabQuestion resolves null', async () => {
    const suggestion: TabQuestionSuggestion = {
      items: [{ question_index: 0, decision_id: 'd1', similarity: 0.9, selected: [0], source: { question: 'Qual cor?', project_name: 'Proj', answered_at: '2026-09-20T00:00:00.000Z' } }],
    };
    vi.mocked(suggestFor).mockResolvedValueOnce(suggestion);
    const repos = fakeRepos({ opened: row({ id: 'q1' }), setSuggestion: 'not-open' });
    const q = await openTabQuestion(asRepos(repos), tab, { kind: 'choice', payload, tool_use_id: 'toolu_1' });
    expect(q).toBeNull();
    expect(events.some((e) => e.type === 'tab_question')).toBe(false);
  });

  it('setSuggestion itself failing still announces the plain card, suggestion folded in for that one view', async () => {
    const suggestion: TabQuestionSuggestion = {
      items: [{ question_index: 0, decision_id: 'd1', similarity: 0.9, selected: [0], source: { question: 'Qual cor?', project_name: 'Proj', answered_at: '2026-09-20T00:00:00.000Z' } }],
    };
    vi.mocked(suggestFor).mockResolvedValueOnce(suggestion);
    const opened = row({ id: 'q1' });
    const repos = fakeRepos({ opened, setSuggestion: 'throws' });
    const q = await openTabQuestion(asRepos(repos), tab, { kind: 'choice', payload, tool_use_id: 'toolu_1' });
    expect(q).toEqual({ ...opened, suggestion });
    const tqEvent = events.find((e) => e.type === 'tab_question');
    expect(tqEvent && 'question' in tqEvent ? tqEvent.question.suggestion : undefined).toEqual(suggestion);
  });

  it('an embedder that ran and found nothing re-checks the tab: a card that moved on announces nothing', async () => {
    vi.mocked(suggestFor).mockResolvedValueOnce(null);
    const opened = row({ id: 'q1' });
    const repos = fakeRepos({ opened, stillOpen: row({ id: 'q9' }) }); // a newer question is open now
    const q = await openTabQuestion(asRepos(repos), tab, { kind: 'choice', payload, tool_use_id: 'toolu_1' }, { embedder: someEmbedder, log: log() });
    expect(q).toBeNull();
    expect(repos.tabQuestions.findOpenForTab).toHaveBeenCalledWith('t1');
    expect(events.some((e) => e.type === 'tab_question')).toBe(false);
  });

  it('an embedder that ran and found nothing, but the row is still the open one, announces it as usual', async () => {
    vi.mocked(suggestFor).mockResolvedValueOnce(null);
    const opened = row({ id: 'q1' });
    const repos = fakeRepos({ opened, stillOpen: opened });
    const q = await openTabQuestion(asRepos(repos), tab, { kind: 'choice', payload, tool_use_id: 'toolu_1' }, { embedder: someEmbedder, log: log() });
    expect(q).toEqual(opened);
    expect(events.some((e) => e.type === 'tab_question')).toBe(true);
  });

  it('a fresh choice card with no automatic answer wakes the concierge once, after the card is published', async () => {
    vi.mocked(suggestFor).mockResolvedValueOnce(null);
    const opened = row({ id: 'q1' });
    const repos = fakeRepos({ opened });
    const waker = { wake: vi.fn(async (r: TabQuestion) => { expect(events.some((e) => e.type === 'tab_question')).toBe(true); return r.id === 'q1'; }) };
    const q = await openTabQuestion(asRepos(repos), tab, { kind: 'choice', payload, tool_use_id: 'toolu_1' }, { waker });
    expect(q).toEqual(opened);
    expect(waker.wake).toHaveBeenCalledTimes(1);
    expect(waker.wake).toHaveBeenCalledWith(opened, 'api');
  });

  it('the repeat path scheduling a countdown: the concierge is not woken (the card already carries an answer)', async () => {
    const suggestion: TabQuestionSuggestion = {
      items: [{ question_index: 0, decision_id: 'd1', similarity: 0.99, selected: [0], source: { question: 'Qual cor?', project_name: 'Proj', answered_at: '2026-09-20T00:00:00.000Z' } }],
    };
    vi.mocked(suggestFor).mockResolvedValueOnce(suggestion);
    const repos = fakeRepos({ opened: row({ id: 'q1' }), autodecide: true });
    repos.tabQuestions.setAutoAnswer.mockImplementation(async (_id: string, auto: AutoAnswer) => ({ ...row({ id: 'q1' }), suggestion, auto_answer: auto }));
    const waker = { wake: vi.fn(async () => true) };
    const q = await openTabQuestion(asRepos(repos), tab, { kind: 'choice', payload, tool_use_id: 'toolu_1' }, { waker });
    expect(q?.auto_answer).toMatchObject({ status: 'scheduled' });
    expect(waker.wake).not.toHaveBeenCalled();
  });

  it('a permission card is never woken for (not a choice)', async () => {
    const repos = fakeRepos({ opened: null, closed: [row({ id: 'q0', kind: 'permission', payload: { tool_name: 'Bash' }, status: 'answered_in_tab' })] });
    const waker = { wake: vi.fn(async () => true) };
    await openTabQuestion(asRepos(repos), tab, { kind: 'permission', payload: { tool_name: 'Edit' }, tool_use_id: null }, { waker });
    expect(waker.wake).not.toHaveBeenCalled();
  });
});

describe('openTabQuestion in a tab with an automatic run (agentic board D18)', () => {
  /** `fakeRepos` plus the automation side: the tab's active run, its project's setup, the pauses, and
   *  what `automationAnswer` writes (runs, events). */
  function automaticRepos(o: { run?: boolean; paused?: boolean; enabled?: boolean; waiting?: boolean } = {}) {
    const repos = fakeRepos({ opened: row({ id: 'q1' }) });
    const run = { id: 'run1', project_id: 'p1', task_id: 'task1', tab_id: 't1', status: o.waiting ? 'waiting' : 'running', waiting_reason: o.waiting ? 'question_unanswered' : null, claimed_by: 'me' };
    return Object.assign(repos, {
      automationRuns: { activeByTab: vi.fn(async () => ((o.run ?? true) ? run : null)), updateActive: vi.fn(async () => true) },
      projectSetup: { get: vi.fn(async () => ({ data: { automation: { enabled: o.enabled ?? true } } })) },
      automationPauses: { state: vi.fn(async () => ({ user: o.paused ? new Date() : null, project: null })) },
      automationEvents: { insert: vi.fn(async (e: object) => ({ ...e, id: 'e1', created_at: '' })), countForRun: vi.fn(async () => 0), payloadsForRun: vi.fn(async () => []) },
      tabs: { ...repos.tabs, findById: vi.fn(async () => tab) },
    });
  }

  it('a card with a recommended option gets the automation countdown, with the switch off and no wake', async () => {
    vi.mocked(suggestFor).mockResolvedValueOnce(null);
    const repos = automaticRepos();
    const waker = { wake: vi.fn(async () => true) };
    await openTabQuestion(asRepos(repos), tab, { kind: 'choice', payload, tool_use_id: 'toolu_1' }, { waker });
    await vi.waitFor(() => expect(repos.tabQuestions.setAutoAnswer).toHaveBeenCalledTimes(1));
    expect(repos.tabQuestions.setAutoAnswer.mock.calls[0]![1]).toMatchObject({ by: 'automation', answer: { answers: [{ selected: [0] }] }, status: 'scheduled' });
    expect(waker.wake).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(repos.automationEvents.insert).toHaveBeenCalledWith(expect.objectContaining({ kind: 'question_answered' })));
  });

  it('a card with nothing recommended wakes the chat as automatic work', async () => {
    vi.mocked(suggestFor).mockResolvedValueOnce(null);
    const plain = { questions: [{ ...payload.questions[0]!, options: payload.questions[0]!.options.map((op) => ({ ...op, recommended: false })) }] };
    const repos = automaticRepos();
    repos.tabQuestions.open.mockResolvedValueOnce({ question: row({ id: 'q1', payload: plain }), closed: [] });
    const waker = { wake: vi.fn(async () => true) };
    await openTabQuestion(asRepos(repos), tab, { kind: 'choice', payload: plain, tool_use_id: 'toolu_1' }, { waker });
    await vi.waitFor(() => expect(waker.wake).toHaveBeenCalledTimes(1));
    expect(waker.wake).toHaveBeenCalledWith(expect.objectContaining({ id: 'q1' }), 'api', { automatic: true });
    expect(repos.tabQuestions.setAutoAnswer).not.toHaveBeenCalled();
  });

  it('a choice with no card (no active conversation) parks the run before anything can type into the question (review I1)', async () => {
    const repos = automaticRepos();
    repos.tabQuestions.open.mockResolvedValueOnce({ question: null, closed: [] });
    repos.chat.findLatestActiveForProject.mockResolvedValueOnce(undefined);
    const waker = { wake: vi.fn(async () => true) };
    expect(await openTabQuestion(asRepos(repos), tab, { kind: 'choice', payload, tool_use_id: 'toolu_1' }, { waker })).toBeNull();
    // awaited inside openTabQuestion: parked before the hook POST returns
    expect(repos.automationRuns.updateActive).toHaveBeenCalledWith('run1', 'me', { status: 'waiting', waiting_reason: 'question_unanswered' }, { unlessWaitingFor: 'question_unanswered' });
    expect(repos.automationEvents.insert).toHaveBeenCalledWith(expect.objectContaining({ kind: 'escalated', run_id: 'run1', payload: { reason: 'question_unanswered', tab_id: 't1' } }));
    expect(waker.wake).not.toHaveBeenCalled();
  });

  it('a choice with no card in a manual tab (or a permission queued behind an open card) parks nothing, as before', async () => {
    for (const [o, input] of [
      [{ run: false }, { kind: 'choice' as const, payload, tool_use_id: 'toolu_1' }],
      [{}, { kind: 'permission' as const, payload: { tool_name: 'Bash' }, tool_use_id: null }],
    ] as const) {
      const repos = automaticRepos(o);
      repos.tabQuestions.open.mockResolvedValueOnce({ question: null, closed: [] });
      await openTabQuestion(asRepos(repos), tab, input);
      expect(repos.automationRuns.updateActive).not.toHaveBeenCalled();
      expect(repos.automationEvents.insert).not.toHaveBeenCalled();
    }
  });

  it('a permission card goes to answerPermissionAutomatically: a Bash request (no command known) escalates the run', async () => {
    const repos = automaticRepos();
    const perm = row({ id: 'q1', kind: 'permission', payload: { tool_name: 'Bash' }, tool_use_id: null });
    repos.tabQuestions.open.mockResolvedValueOnce({ question: perm, closed: [] });
    Object.assign(repos, { tasks: { findById: vi.fn(async () => ({ id: 'task1', auto: true })) } });
    const waker = { wake: vi.fn(async () => true) };
    await openTabQuestion(asRepos(repos), tab, { kind: 'permission', payload: { tool_name: 'Bash' }, tool_use_id: null }, { waker });
    await vi.waitFor(() => expect(repos.automationRuns.updateActive).toHaveBeenCalledWith('run1', 'me', { status: 'waiting', waiting_reason: 'permission_needed' }, { unlessWaitingFor: 'permission_needed' }));
    expect(repos.automationEvents.insert).toHaveBeenCalledWith(expect.objectContaining({ kind: 'escalated', payload: { reason: 'permission_needed', tab_id: 't1' } }));
    expect(waker.wake).not.toHaveBeenCalled();
  });

  it('a permission card in a manual tab, or a paused or disabled project, is left to the person exactly as before', async () => {
    for (const o of [{ run: false }, { paused: true }, { enabled: false }]) {
      const repos = automaticRepos(o);
      const perm = row({ id: 'q1', kind: 'permission', payload: { tool_name: 'Bash' }, tool_use_id: null });
      repos.tabQuestions.open.mockResolvedValueOnce({ question: perm, closed: [] });
      const waker = { wake: vi.fn(async () => true) };
      expect(await openTabQuestion(asRepos(repos), tab, { kind: 'permission', payload: { tool_name: 'Bash' }, tool_use_id: null }, { waker })).toEqual(perm);
      await new Promise((r) => setTimeout(r, 10));
      expect(repos.automationRuns.updateActive).not.toHaveBeenCalled();
      expect(repos.automationEvents.insert).not.toHaveBeenCalled();
      expect(waker.wake).not.toHaveBeenCalled();
    }
  });

  it('a permission with no card because there is no conversation parks the run as permission_needed', async () => {
    const repos = automaticRepos();
    repos.tabQuestions.open.mockResolvedValueOnce({ question: null, closed: [] });
    repos.chat.findLatestActiveForProject.mockResolvedValueOnce(undefined);
    expect(await openTabQuestion(asRepos(repos), tab, { kind: 'permission', payload: { tool_name: 'Bash' }, tool_use_id: null })).toBeNull();
    expect(repos.automationRuns.updateActive).toHaveBeenCalledWith('run1', 'me', { status: 'waiting', waiting_reason: 'permission_needed' }, { unlessWaitingFor: 'permission_needed' });
  });

  describe("the card's own push waits for automation's verdict (D25, review I2)", () => {
    afterEach(() => resetQuestionHolds());

    it('a card automation took over (a recommended countdown) is held: no card push', async () => {
      vi.mocked(suggestFor).mockResolvedValueOnce(null);
      const repos = automaticRepos();
      await openTabQuestion(asRepos(repos), tab, { kind: 'choice', payload, tool_use_id: 'toolu_1' }, { waker: { wake: vi.fn(async () => true) } });
      expect(await heldQuestion('q1')).toBe(true);
    });

    it('a permission escalated (Bash, no command known) is held: the escalation is pushed instead', async () => {
      const repos = automaticRepos();
      repos.tabQuestions.open.mockResolvedValueOnce({ question: row({ id: 'q1', kind: 'permission', payload: { tool_name: 'Bash' }, tool_use_id: null }), closed: [] });
      Object.assign(repos, { tasks: { findById: vi.fn(async () => ({ id: 'task1', auto: true })) } });
      await openTabQuestion(asRepos(repos), tab, { kind: 'permission', payload: { tool_name: 'Bash' }, tool_use_id: null });
      expect(await heldQuestion('q1')).toBe(true);
    });

    it('an allowed permission left to the person (the card was untagged during the settle) is pushed', async () => {
      const repos = automaticRepos();
      vi.mocked(repos.automationRuns.activeByTab).mockResolvedValue({ id: 'run1', project_id: 'p1', task_id: 'task1', tab_id: 't1', status: 'running', claimed_by: 'me', allowed_tools: ['WebFetch'] } as never);
      repos.tabQuestions.open.mockResolvedValueOnce({ question: row({ id: 'q1', kind: 'permission', payload: { tool_name: 'WebFetch' }, tool_use_id: null }), closed: [] });
      Object.assign(repos, { tasks: { findById: vi.fn(async () => ({ id: 'task1', auto: false })) } });
      await openTabQuestion(asRepos(repos), tab, { kind: 'permission', payload: { tool_name: 'WebFetch' }, tool_use_id: null });
      expect(await heldQuestion('q1')).toBe(false);
      expect(repos.automationEvents.insert).not.toHaveBeenCalled();
    }, 10_000);

    it('automation that throws lets the card be pushed', async () => {
      vi.mocked(suggestFor).mockResolvedValueOnce(null);
      const plain = { questions: [{ ...payload.questions[0]!, options: payload.questions[0]!.options.map((op) => ({ ...op, recommended: false })) }] };
      const repos = automaticRepos();
      repos.tabQuestions.open.mockResolvedValueOnce({ question: row({ id: 'q1', payload: plain }), closed: [] });
      vi.mocked(repos.automationRuns.updateActive).mockRejectedValue(new Error('db down'));
      // no waker: automation goes straight to the escalation, whose write throws
      await openTabQuestion(asRepos(repos), tab, { kind: 'choice', payload: plain, tool_use_id: 'toolu_1' });
      expect(await heldQuestion('q1')).toBe(false);
    });

    it('a run already waiting for the person, or a manual tab, holds nothing: the card is pushed at once', async () => {
      for (const o of [{ waiting: true }, { run: false }]) {
        vi.mocked(suggestFor).mockResolvedValueOnce(null);
        const repos = automaticRepos(o);
        await openTabQuestion(asRepos(repos), tab, { kind: 'choice', payload, tool_use_id: 'toolu_1' }, { waker: { wake: vi.fn(async () => true) } });
        expect(heldQuestion('q1')).toBeNull();
      }
    });
  });

  it('a manual tab (no run), or a paused or disabled project, behaves exactly as before: the plain wake, nothing scheduled', async () => {
    for (const o of [{ run: false }, { paused: true }, { enabled: false }]) {
      vi.mocked(suggestFor).mockResolvedValueOnce(null);
      const repos = automaticRepos(o);
      const waker = { wake: vi.fn(async () => true) };
      await openTabQuestion(asRepos(repos), tab, { kind: 'choice', payload, tool_use_id: 'toolu_1' }, { waker });
      expect(waker.wake).toHaveBeenCalledTimes(1);
      expect(waker.wake).toHaveBeenCalledWith(row({ id: 'q1' }), 'api');
      await new Promise((r) => setTimeout(r, 10));
      expect(repos.tabQuestions.setAutoAnswer).not.toHaveBeenCalled();
      expect(repos.automationEvents.insert).not.toHaveBeenCalled();
    }
  });
});

describe('noteHookEvent', () => {
  it('follows the measured two-background-agent sequence, scoping every close and open', async () => {
    const repos = fakeRepos({ opened: null });
    const main = { agent: null, leavesQueue: true };
    const tool = (agent: string) => ({ agent, leavesQueue: false });
    const ended = (agent: string) => ({ agent, leavesQueue: true });
    const event = (name: string, agent?: string, extra: Partial<Interpreted> = {}): Interpreted => ({
      kind: 'working', text: null,
      meta: { event: name, ...(agent ? { subagent: true, agent_id: agent } : {}), ...(name === 'PreToolUse' ? { tool: agent ? 'Bash' : 'Agent' } : {}) },
      ...extra,
    });
    const permission = (agent: string): Interpreted => event('PermissionRequest', agent, {
      question: { kind: 'permission', payload: { tool_name: 'Bash' }, tool_use_id: null },
    });
    const sequence = [
      { next: event('PreToolUse'), scope: main },
      { next: event('Stop', undefined, { backgroundTasks: 2 }), scope: main },
      { next: event('PreToolUse', 'A'), scope: tool('A') },
      { next: permission('A'), opens: 'A' },
      { next: event('PreToolUse', 'B'), scope: tool('B') },
      { next: permission('B'), opens: 'B' },
      { next: event('SubagentStop', 'H', { closeOnly: true }), scope: ended('H') },
      { next: event('Notification', undefined, { meta: { event: 'Notification', type: 'permission_prompt' } }) },
      { next: event('SubagentStop', 'A', { closeOnly: true }), scope: ended('A') },
      { next: event('Stop', undefined, { backgroundTasks: 1 }), scope: main },
      { next: event('SubagentStop', 'B', { closeOnly: true }), scope: ended('B') },
      { next: event('Stop'), scope: 'all' },
    ];
    for (const step of sequence) {
      repos.tabQuestions.open.mockClear();
      repos.tabQuestions.closeForTab.mockClear();
      await noteHookEvent(asRepos(repos), log(), tab, step.next);
      if (step.opens) {
        expect(repos.tabQuestions.open).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ agent_id: step.opens, kind: 'permission' }));
        expect(repos.tabQuestions.closeForTab).not.toHaveBeenCalled();
      } else if (step.scope) {
        expect(repos.tabQuestions.closeForTab).toHaveBeenCalledExactlyOnceWith('t1', 'answered_in_tab', step.scope);
        expect(repos.tabQuestions.open).not.toHaveBeenCalled();
      } else {
        expect(repos.tabQuestions.open).not.toHaveBeenCalled();
        expect(repos.tabQuestions.closeForTab).not.toHaveBeenCalled();
      }
    }
  });

  it('opens on a question, closes on anything else, leaves it alone on a notification', async () => {
    const repos = fakeRepos();
    await noteHookEvent(asRepos(repos), log(), tab, choice);
    expect(repos.tabQuestions.open).toHaveBeenCalledTimes(1);
    await noteHookEvent(asRepos(repos), log(), tab, { kind: 'waiting_permission', text: 'x', meta: { event: 'Notification', type: 'permission_prompt' } });
    expect(repos.tabQuestions.closeForTab).not.toHaveBeenCalled();
    await noteHookEvent(asRepos(repos), log(), tab, { kind: 'working', text: null, meta: { event: 'PreToolUse', tool: 'Bash' } });
    expect(repos.tabQuestions.closeForTab).toHaveBeenCalledWith('t1', 'answered_in_tab', { agent: null, leavesQueue: true }); // the main thread leaves its permission queue
  });

  it("an old script subagent event updates nothing on the card: no close", async () => {
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

  it('never throws on the closing path either', async () => {
    const repos = fakeRepos();
    repos.tabQuestions.closeForTab.mockRejectedValue(Object.assign(new Error('Qual cor? secret'), { code: 'P1001' }));
    const l = log();
    await expect(noteHookEvent(asRepos(repos), l, tab, { kind: 'working', text: null, meta: { event: 'PreToolUse', tool: 'Bash' } })).resolves.toBeUndefined();
    expect(l.warn).toHaveBeenCalledWith({ tabId: 't1', code: 'P1001' }, 'tab question bookkeeping failed');
    expect(JSON.stringify(l.warn.mock.calls)).not.toContain('secret');
  });

  it('never throws on the no-conversation path either', async () => {
    const repos = fakeRepos({ conversation: null });
    repos.tabQuestions.open.mockRejectedValue(Object.assign(new Error('Qual cor? secret'), { code: 'P2034' }));
    const l = log();
    await expect(noteHookEvent(asRepos(repos), l, tab, choice)).resolves.toBeUndefined();
    expect(repos.tabQuestions.open).toHaveBeenCalledWith(expect.objectContaining({ conversation_id: null }));
    expect(l.warn).toHaveBeenCalledWith({ tabId: 't1', code: 'P2034' }, 'tab question bookkeeping failed');
  });

  it('passes its own logger into the suggestion step', async () => {
    const l = log();
    await noteHookEvent(asRepos(fakeRepos()), l, tab, choice);
    expect(vi.mocked(suggestFor)).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: 'q1' }), expect.objectContaining({ log: l }));
  });

  it('passes its own waker down to openTabQuestion', async () => {
    vi.mocked(suggestFor).mockResolvedValueOnce(null);
    const waker = { wake: vi.fn(async () => true) };
    await noteHookEvent(asRepos(fakeRepos()), log(), tab, choice, waker);
    expect(waker.wake).toHaveBeenCalledTimes(1);
  });
});

describe('startTabQuestionExpiry', () => {
  it('a removed tab expires its question; an opened or renamed one does not', async () => {
    const repos = fakeRepos({ closed: [row({ status: 'expired' })] });
    const stop = startTabQuestionExpiry(asRepos(repos), log());
    monitorBus.publishLifecycle({ kind: 'upsert', tab, project_id: 'p1', machine_id: 'm1', owner_id: 'u1' });
    monitorBus.publishLifecycle({ kind: 'removed', tab_id: 't1', project_id: 'p1', machine_id: 'm1', owner_id: 'u1' });
    await vi.waitFor(() => expect(events.map((e) => e.type)).toEqual(['tab_question_closed']));
    stop();
    expect(repos.tabQuestions.closeForTab).toHaveBeenCalledTimes(1);
    expect(repos.tabQuestions.closeForTab).toHaveBeenCalledWith('t1', 'expired', 'all');
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

  it('marks a changed open card as an update, and only an open one (TER-919)', async () => {
    const repos = fakeRepos();
    const q = row({ id: 'q1' });
    await publishTabQuestions(asRepos(repos), 'tab_question', [q]);
    await publishTabQuestions(asRepos(repos), 'tab_question', [q], { update: true });
    await publishTabQuestions(asRepos(repos), 'tab_question_answered', [{ ...q, status: 'answered' }], { update: true });
    expect(events.map((e) => [e.type, 'update' in e ? e.update : undefined])).toEqual([
      ['tab_question', undefined],
      ['tab_question', true],
      ['tab_question_answered', undefined],
    ]);
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
