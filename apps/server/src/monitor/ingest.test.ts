import { describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import type { Tab } from '../db/repositories/types.js';
import { STATE_TEXT_MAX } from './state.js';
import { decideWait, type HistoryRow } from './wait-decision.js';

const publish = vi.fn();
vi.mock('./bus.js', () => ({ monitorBus: { publish: (...a: unknown[]) => publish(...a) } }));
const note = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('../chat/tab-questions.js', () => ({ noteHookEvent: (...a: unknown[]) => note(...a) }));
const schedule = vi.fn();
const cancel = vi.fn();
const openReply = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('../chat/tab-suggestions.js', () => ({ scheduleTabSuggestion: (...a: unknown[]) => schedule(...a), cancelTabSuggestion: (...a: unknown[]) => cancel(...a), openCodexReply: (...a: unknown[]) => openReply(...a) }));
const autoSwapOnLimit = vi.fn();
vi.mock('../control/account-swap.js', () => ({ autoSwapOnLimit: (...a: unknown[]) => autoSwapOnLimit(...a) }));

const { ingestHookEvent } = await import('./ingest.js');

const tab = (over: Partial<Tab>): Tab => ({
  id: 't1',
  project_id: 'p1',
  name: 't',
  kind: 'terminal',
  tmux_session: 'th-t1',
  simulator_udid: null,
  created_by_token_id: null,
  position: 0,
  state: null,
  state_text: null,
  state_tool: null,
  state_at: null,
  state_seen_at: null,
  activity: null,
  activity_verb: null,
  agent_session_id: null,
  agent_transcript_path: null,
  ai_account_id: null,
  rate_limited_at: null,
  created_at: '',
  ...over,
}) as Tab;
const log = { info: vi.fn(), debug: vi.fn(), warn: vi.fn() } as never;

function repos(current: Tab) {
  const recordEvent = vi.fn(async (_id: string, ev: { kind: string; activity?: string; activityVerb?: string | null }) => ({ tab: tab({ ...current, state: ev.kind as Tab['state'], activity: (ev.activity as Tab['activity']) ?? null, activity_verb: ev.activityVerb ?? null }), event: {} }));
  const setActivity = vi.fn(async (_id: string, activity: Tab['activity'], verb: string | null): Promise<Tab | undefined> => tab({ ...current, activity, activity_verb: verb }));
  const setAgentFields = vi.fn(async (_id: string, patch: { agent_session_id?: string | null; agent_transcript_path?: string | null; ai_account_id?: string | null; rate_limited_at?: Date | null }) =>
    tab({ ...current, ...patch, rate_limited_at: patch.rate_limited_at === undefined ? current.rate_limited_at : patch.rate_limited_at && patch.rate_limited_at.toISOString() }),
  );
  // no automation run names the tab: the usage meter stops at this lookup
  const latestByTab = vi.fn(async () => null);
  return {
    r: {
      tabs: { findByTmuxSession: vi.fn(async () => current), recordEvent, setActivity, setAgentFields },
      projects: { findById: vi.fn(async () => ({ id: 'p1', machine_id: 'm1' })) },
      machines: { findById: vi.fn(async () => ({ id: 'm1', owner_id: 'u1' })) },
      automationRuns: { latestByTab },
    } as unknown as Repositories,
    latestByTab,
    recordEvent,
    setActivity,
    setAgentFields,
  };
}
const pre = (tool_name: string, verb?: string) => ({ machineId: 'm1', tool: 'claude' as const, session: 'th-t1', event: { hook_event_name: 'PreToolUse', tool_name, ...(verb ? { verb } : {}) } });

describe('ingestHookEvent — activity', () => {
  it('records an event when the state changes, carrying the activity', async () => {
    publish.mockClear();
    const { r, recordEvent, setActivity } = repos(tab({ state: 'waiting_input' }));
    const res = await ingestHookEvent(r, log, pre('Edit'));
    expect(res).toMatchObject({ ok: true, tab: { state: 'working', activity: 'coding' } });
    expect(recordEvent).toHaveBeenCalledWith('t1', expect.objectContaining({ kind: 'working', activity: 'coding' }));
    expect(setActivity).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalled();
  });

  it('takes the light path when only the activity changes on a working tab', async () => {
    publish.mockClear();
    const { r, recordEvent, setActivity } = repos(tab({ state: 'working', activity: 'coding' }));
    const res = await ingestHookEvent(r, log, pre('Read'));
    expect(res).toMatchObject({ ok: true, tab: { activity: 'reading' } });
    expect(setActivity).toHaveBeenCalledWith('t1', 'reading', null);
    expect(recordEvent).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('writes nothing when the activity is already stored', async () => {
    publish.mockClear();
    const { r, recordEvent, setActivity } = repos(tab({ state: 'working', activity: 'coding' }));
    const res = await ingestHookEvent(r, log, pre('Write'));
    expect(res).toMatchObject({ ok: true });
    expect(setActivity).not.toHaveBeenCalled();
    expect(recordEvent).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('falls through to the full path when the tab left working between the read and the write', async () => {
    publish.mockClear();
    const { r, recordEvent, setActivity } = repos(tab({ state: 'working', activity: 'coding' }));
    setActivity.mockImplementation(async () => undefined); // the conditional UPDATE matched no row
    const res = await ingestHookEvent(r, log, pre('Read'));
    expect(setActivity).toHaveBeenCalledWith('t1', 'reading', null);
    expect(recordEvent).toHaveBeenCalledWith('t1', expect.objectContaining({ kind: 'working', activity: 'reading' }));
    expect(res).toMatchObject({ ok: true, tab: { state: 'working', activity: 'reading' } });
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('never logs the tool input, on either path', async () => {
    const withInput = { ...pre('Edit'), event: { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: '/secret' } } };
    await ingestHookEvent(repos(tab({ state: 'waiting_input' })).r, log, withInput); // full path: log.info
    await ingestHookEvent(repos(tab({ state: 'working', activity: 'reading' })).r, log, withInput); // light path: log.debug
    const calls = log as unknown as { info: { mock: { calls: unknown[] } }; debug: { mock: { calls: unknown[] } } };
    expect(calls.info.mock.calls).not.toHaveLength(0);
    expect(calls.debug.mock.calls).not.toHaveLength(0);
    expect(JSON.stringify([calls.info.mock.calls, calls.debug.mock.calls])).not.toContain('secret');
  });

  it('records the spinner verb with the state change', async () => {
    publish.mockClear();
    const { r, recordEvent } = repos(tab({ state: 'waiting_input' }));
    const res = await ingestHookEvent(r, log, pre('Edit', 'Moonwalking'));
    expect(recordEvent).toHaveBeenCalledWith('t1', expect.objectContaining({ kind: 'working', activity: 'coding', activityVerb: 'Moonwalking' }));
    expect(res).toMatchObject({ ok: true, tab: { activity: 'coding', activity_verb: 'Moonwalking' } });
  });

  it('takes the light path when only the verb changes, and writes nothing when both are the same', async () => {
    publish.mockClear();
    const same = repos(tab({ state: 'working', activity: 'coding', activity_verb: 'Brewing' }));
    await ingestHookEvent(same.r, log, pre('Edit', 'Brewing'));
    expect(same.setActivity).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    const changed = repos(tab({ state: 'working', activity: 'coding', activity_verb: 'Brewing' }));
    const res = await ingestHookEvent(changed.r, log, pre('Edit', 'Musing'));
    expect(changed.setActivity).toHaveBeenCalledWith('t1', 'coding', 'Musing');
    expect(changed.recordEvent).not.toHaveBeenCalled();
    expect(res).toMatchObject({ ok: true, tab: { activity_verb: 'Musing' } });
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('clears a stored verb when the next tool call comes without one', async () => {
    const { r, setActivity } = repos(tab({ state: 'working', activity: 'coding', activity_verb: 'Brewing' }));
    await ingestHookEvent(r, log, pre('Edit'));
    expect(setActivity).toHaveBeenCalledWith('t1', 'coding', null);
  });

  it('never logs the verb itself', async () => {
    const spy = { info: vi.fn(), debug: vi.fn(), warn: vi.fn() };
    await ingestHookEvent(repos(tab({ state: 'waiting_input' })).r, spy as never, pre('Edit', 'Zyzzyvating'));
    await ingestHookEvent(repos(tab({ state: 'working', activity: 'coding' })).r, spy as never, pre('Edit', 'Zyzzyvating'));
    expect(spy.info.mock.calls.length + spy.debug.mock.calls.length).toBe(2);
    expect(JSON.stringify([spy.info.mock.calls, spy.debug.mock.calls])).not.toContain('Zyzzyvating');
  });
});

describe('ingestHookEvent — tab questions', () => {
  const ask = { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_use_id: 'toolu_1', tool_input: { questions: [{ question: 'Qual cor?', header: 'Cor', options: [{ label: 'Azul (Recommended)', description: 'Calma' }, { label: 'Verde', description: 'Fresca' }], multiSelect: false }] } };

  it('hands the interpretation, question included, to the tab-question service — even on the light path that writes nothing', async () => {
    note.mockClear();
    const { r, recordEvent, setActivity } = repos(tab({ state: 'working', activity: 'planning' }));
    await ingestHookEvent(r, log, { machineId: 'm1', tool: 'claude', session: 'th-t1', event: ask });
    expect(recordEvent).not.toHaveBeenCalled();
    expect(setActivity).not.toHaveBeenCalled();
    expect(note).toHaveBeenCalledTimes(1);
    const [, , passedTab, interpreted] = note.mock.calls[0]!;
    expect(passedTab).toMatchObject({ id: 't1' });
    expect(interpreted).toMatchObject({ question: { kind: 'choice', tool_use_id: 'toolu_1' } });
  });

  it('hands over the updated tab after a full state change', async () => {
    note.mockClear();
    const { r } = repos(tab({ state: 'waiting_permission' }));
    await ingestHookEvent(r, log, pre('Bash'));
    expect(note.mock.calls[0]![2]).toMatchObject({ id: 't1', state: 'working' });
  });

  it('does not call the service for an event the interpreter ignores, nor for an unknown session', async () => {
    note.mockClear();
    await ingestHookEvent(repos(tab({})).r, log, { machineId: 'm1', tool: 'claude', session: 'th-t1', event: { hook_event_name: 'SubagentStop' } });
    const none = repos(tab({}));
    (none.r.tabs.findByTmuxSession as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    await ingestHookEvent(none.r, log, pre('Edit'));
    expect(note).not.toHaveBeenCalled();
  });

  it('never logs the question', async () => {
    const spy = { info: vi.fn(), debug: vi.fn(), warn: vi.fn() };
    await ingestHookEvent(repos(tab({ state: 'waiting_input' })).r, spy as never, { machineId: 'm1', tool: 'claude', session: 'th-t1', event: ask });
    expect(JSON.stringify([spy.info.mock.calls, spy.debug.mock.calls])).not.toContain('Qual cor');
  });
});

describe('ingestHookEvent — close-only events (spec 2026-09-30 tab questions per subagent)', () => {
  it("a Claude SubagentStop records nothing, cancels no suggestion check and reaches the tab-question service", async () => {
    note.mockClear();
    cancel.mockClear();
    const current = tab({ state: 'waiting_permission' });
    const { r, recordEvent, setActivity, setAgentFields } = repos(current);
    const event = { hook_event_name: 'SubagentStop', subagent: true, agent_id: 'ac5724783efd1ee13' };
    const out = await ingestHookEvent(r, log, { machineId: 'm1', tool: 'claude', session: 'th-t1', event });
    expect(recordEvent).not.toHaveBeenCalled();
    expect(setActivity).not.toHaveBeenCalled();
    expect(setAgentFields).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(note).toHaveBeenCalledTimes(1);
    const [, , passedTab, interpreted] = note.mock.calls[0]!;
    expect(passedTab).toBe(current);
    expect(interpreted).toMatchObject({ closeOnly: true, meta: { event: 'SubagentStop', agent_id: 'ac5724783efd1ee13' } });
    expect(out).toEqual({ ok: true, tab: current });
  });
});

describe('ingestHookEvent — suggestions', () => {
  it('a Claude Stop schedules the suggestion check; every event of the tab first cancels a pending one', async () => {
    schedule.mockClear();
    cancel.mockClear();
    const { r } = repos(tab({ state: 'working' }));
    await ingestHookEvent(r, log, { machineId: 'm1', tool: 'claude', session: 'th-t1', event: { hook_event_name: 'Stop' } });
    expect(cancel).toHaveBeenCalledWith('t1');
    expect(schedule).toHaveBeenCalledWith(r, log, 't1', { context: null, backgroundTasks: 0 });
    expect(cancel.mock.invocationCallOrder[0]!).toBeLessThan(schedule.mock.invocationCallOrder[0]!);
  });

  it("hands the Stop's own message and running background count to the check", async () => {
    schedule.mockClear();
    const { r } = repos(tab({ state: 'working' }));
    const event = { hook_event_name: 'Stop', last_assistant_message: 'Vigiando o CI.', background_tasks: [{ id: 'b1', type: 'shell', status: 'running' }] };
    await ingestHookEvent(r, log, { machineId: 'm1', tool: 'claude', session: 'th-t1', event });
    expect(schedule).toHaveBeenCalledWith(r, log, 't1', { context: 'Vigiando o CI.', backgroundTasks: 1 });
  });

  it('any other event only cancels — even one the interpreter ignores', async () => {
    schedule.mockClear();
    cancel.mockClear();
    const { r } = repos(tab({ state: 'waiting_input' }));
    await ingestHookEvent(r, log, pre('Edit'));
    await ingestHookEvent(r, log, { machineId: 'm1', tool: 'claude', session: 'th-t1', event: { hook_event_name: 'SomethingNew' } });
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(schedule).not.toHaveBeenCalled();
  });

  it('a Codex turn end is not a Claude Stop', async () => {
    schedule.mockClear();
    const { r } = repos(tab({ state: 'working' }));
    await ingestHookEvent(r, log, { machineId: 'm1', tool: 'codex', session: 'th-t1', event: { type: 'agent-turn-complete', 'last-assistant-message': 'ok' } });
    expect(schedule).not.toHaveBeenCalled();
  });

  it("meters the tab's usage on a main-thread Stop (Claude or Codex), never on a subagent's", async () => {
    const session = { state_tool: 'claude', agent_session_id: '0f8fad5b-d9cb-469f-a165-70867728950e', agent_transcript_path: '~/.claude/projects/x/0f8fad5b-d9cb-469f-a165-70867728950e.jsonl' };
    const claude = repos(tab(session));
    await ingestHookEvent(claude.r, log, { machineId: 'm1', tool: 'claude', session: 'th-t1', event: { hook_event_name: 'Stop', agent_id: 'a1b2c3' } });
    await new Promise((r) => setTimeout(r, 0));
    expect(claude.latestByTab).not.toHaveBeenCalled();
    await ingestHookEvent(claude.r, log, { machineId: 'm1', tool: 'claude', session: 'th-t1', event: { hook_event_name: 'Stop' } });
    await vi.waitFor(() => expect(claude.latestByTab).toHaveBeenCalledWith('t1'));
    const codex = repos(tab({ state_tool: 'codex' }));
    await ingestHookEvent(codex.r, log, { machineId: 'm1', tool: 'codex', session: 'th-t1', event: { hook_event_name: 'Stop', last_assistant_message: 'Pronto.' } });
    await vi.waitFor(() => expect(codex.latestByTab).toHaveBeenCalledWith('t1'));
    expect((log as unknown as { warn: ReturnType<typeof vi.fn> }).warn).not.toHaveBeenCalledWith(expect.anything(), 'automation: tab usage failed');
    schedule.mockClear(); // the Claude Stops above scheduled a suggestion check
  });
});

describe('ingestHookEvent — a Codex Stop that asks a question', () => {
  const stop = (extra: object = {}, tool: 'codex' | 'claude' = 'codex') => ({ machineId: 'm1', tool, session: 'th-t1', event: { hook_event_name: 'Stop', last_assistant_message: 'Rodo os testes?', ...extra } });

  it('opens the reply card after noteHookEvent, with the tab and the message', async () => {
    openReply.mockClear();
    note.mockClear();
    const { r } = repos(tab({ state: 'working' }));
    await ingestHookEvent(r, log, stop());
    expect(openReply).toHaveBeenCalledTimes(1);
    expect(openReply).toHaveBeenCalledWith(r, log, 't1', 'Rodo os testes?');
    expect(note.mock.invocationCallOrder[0]!).toBeLessThan(openReply.mock.invocationCallOrder[0]!);
    expect(schedule).not.toHaveBeenCalled();
  });

  it('hands over the whole message, not the capped state text', async () => {
    openReply.mockClear();
    const long = `${'a'.repeat(STATE_TEXT_MAX * 2)}\n\nRodo os testes?`;
    const { r } = repos(tab({ state: 'working' }));
    await ingestHookEvent(r, log, stop({ last_assistant_message: long }));
    expect(openReply).toHaveBeenCalledWith(r, log, 't1', long);
  });

  it('a subagent Stop, a Claude Stop and a Codex notify open no reply card', async () => {
    openReply.mockClear();
    const { r } = repos(tab({ state: 'working' }));
    await ingestHookEvent(r, log, stop({ subagent: true }));
    await ingestHookEvent(r, log, stop({}, 'claude'));
    await ingestHookEvent(r, log, { machineId: 'm1', tool: 'codex', session: 'th-t1', event: { type: 'agent-turn-complete', 'last-assistant-message': 'Rodo os testes?' } });
    expect(openReply).not.toHaveBeenCalled();
  });
});

describe('ingestHookEvent — claude session and rate limit (spec 2026-09-26 account swap)', () => {
  const SID = '6d127d73-4bd0-42d6-b4a6-d96899507e62';
  const TRANSCRIPT = `/h/.claude/projects/-p/${SID}.jsonl`;
  const sessionStart = (session_id?: string, transcript_path?: string) => ({
    machineId: 'm1',
    tool: 'claude' as const,
    session: 'th-t1',
    event: { hook_event_name: 'SessionStart', ...(session_id !== undefined ? { session_id } : {}), ...(transcript_path !== undefined ? { transcript_path } : {}) },
  });

  it('records a valid session/transcript pair', async () => {
    const { r, setAgentFields } = repos(tab({ agent_session_id: null, agent_transcript_path: null }));
    await ingestHookEvent(r, log, sessionStart(SID, TRANSCRIPT));
    expect(setAgentFields).toHaveBeenCalledWith('t1', { agent_session_id: SID, agent_transcript_path: TRANSCRIPT });
  });

  it('does not write again when the tab already has the same pair', async () => {
    const { r, setAgentFields } = repos(tab({ agent_session_id: SID, agent_transcript_path: TRANSCRIPT }));
    await ingestHookEvent(r, log, sessionStart(SID, TRANSCRIPT));
    expect(setAgentFields).not.toHaveBeenCalled();
  });

  it('never writes a malformed pair', async () => {
    const { r, setAgentFields } = repos(tab({ agent_session_id: null, agent_transcript_path: null }));
    await ingestHookEvent(r, log, sessionStart('not-a-uuid', TRANSCRIPT));
    await ingestHookEvent(r, log, sessionStart(SID));
    expect(setAgentFields).not.toHaveBeenCalled();
  });

  it('a rate_limit StopFailure sets rate_limited_at and fires the auto-swap with the updated tab', async () => {
    autoSwapOnLimit.mockClear();
    const { r, setAgentFields } = repos(tab({ rate_limited_at: null }));
    const res = await ingestHookEvent(r, log, { machineId: 'm1', tool: 'claude', session: 'th-t1', event: { hook_event_name: 'StopFailure', error: 'rate_limit' } });
    expect(setAgentFields).toHaveBeenCalledWith('t1', { rate_limited_at: expect.any(Date) });
    expect(autoSwapOnLimit).toHaveBeenCalledWith(r, log, res.ok && res.tab);
  });

  // TER-587: right after the StopFailure, Claude Code dequeues a queued prompt (a background task's
  // notification) and subagents keep calling tools. None of that proves the account works again.
  it.each([
    ['a prompt (a queued task notification)', { hook_event_name: 'UserPromptSubmit' }],
    ['a session start', { hook_event_name: 'SessionStart' }],
    ['a tool call', { hook_event_name: 'PreToolUse', tool_name: 'Bash' }],
    ["a subagent's tool call", { hook_event_name: 'PreToolUse', tool_name: 'Bash', subagent: true }],
    ["a subagent's Stop", { hook_event_name: 'Stop', agent_id: 'a1b2c3' }],
  ])('%s does not clear rate_limited_at', async (_label, event) => {
    const limited = repos(tab({ rate_limited_at: '2026-01-01T00:00:00.000Z' }));
    await ingestHookEvent(limited.r, log, { machineId: 'm1', tool: 'claude', session: 'th-t1', event });
    expect(limited.setAgentFields).not.toHaveBeenCalled();
  });

  it("a normal Stop of the main thread clears rate_limited_at (the account works again), only when it was set", async () => {
    const limited = repos(tab({ rate_limited_at: '2026-01-01T00:00:00.000Z' }));
    await ingestHookEvent(limited.r, log, { machineId: 'm1', tool: 'claude', session: 'th-t1', event: { hook_event_name: 'Stop' } });
    expect(limited.setAgentFields).toHaveBeenCalledWith('t1', { rate_limited_at: null });

    const notLimited = repos(tab({ rate_limited_at: null }));
    await ingestHookEvent(notLimited.r, log, { machineId: 'm1', tool: 'claude', session: 'th-t1', event: { hook_event_name: 'Stop' } });
    expect(notLimited.setAgentFields).not.toHaveBeenCalled();
  });

  // A limit must not outlive the Claude that hit it: otherwise the banner (and its stale time) would come
  // back on the next session of the tab.
  it('the Claude leaving (SessionEnd) clears rate_limited_at', async () => {
    const limited = repos(tab({ rate_limited_at: '2026-01-01T00:00:00.000Z' }));
    await ingestHookEvent(limited.r, log, { machineId: 'm1', tool: 'claude', session: 'th-t1', event: { hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' } });
    expect(limited.setAgentFields).toHaveBeenCalledWith('t1', { rate_limited_at: null });
  });

  it('a SessionStart of another session clears rate_limited_at; the same session (a resume) does not', async () => {
    const OTHER = '0e9c1d2a-0000-4000-8000-000000000000';
    const fresh = repos(tab({ rate_limited_at: '2026-01-01T00:00:00.000Z', agent_session_id: SID, agent_transcript_path: TRANSCRIPT }));
    await ingestHookEvent(fresh.r, log, sessionStart(OTHER, `/h/.claude/projects/-p/${OTHER}.jsonl`));
    expect(fresh.setAgentFields).toHaveBeenCalledWith('t1', expect.objectContaining({ agent_session_id: OTHER, rate_limited_at: null }));

    const resumed = repos(tab({ rate_limited_at: '2026-01-01T00:00:00.000Z', agent_session_id: SID, agent_transcript_path: TRANSCRIPT }));
    await ingestHookEvent(resumed.r, log, sessionStart(SID, TRANSCRIPT));
    expect(resumed.setAgentFields).not.toHaveBeenCalled();
  });

  it('a second rate_limit StopFailure keeps the time of the first (one incident, one automatic swap)', async () => {
    autoSwapOnLimit.mockClear();
    const again = repos(tab({ rate_limited_at: '2026-01-01T00:00:00.000Z' }));
    const res = await ingestHookEvent(again.r, log, { machineId: 'm1', tool: 'claude', session: 'th-t1', event: { hook_event_name: 'StopFailure', error: 'rate_limit' } });
    expect(again.setAgentFields).not.toHaveBeenCalled();
    expect(res.ok && res.tab.rate_limited_at).toBe('2026-01-01T00:00:00.000Z');
    expect(autoSwapOnLimit).toHaveBeenCalledTimes(1);
  });

  it('another API error neither sets rate_limited_at nor swaps', async () => {
    autoSwapOnLimit.mockClear();
    const { r, setAgentFields } = repos(tab({ rate_limited_at: null }));
    await ingestHookEvent(r, log, { machineId: 'm1', tool: 'claude', session: 'th-t1', event: { hook_event_name: 'StopFailure', error: 'authentication_failed' } });
    expect(setAgentFields).not.toHaveBeenCalled();
    expect(autoSwapOnLimit).not.toHaveBeenCalled();
  });
});

describe('ingestHookEvent — a Codex request_user_input answered, through the real wait rule', () => {
  /** A repository whose recordEvent keeps its own rows and asks decideWait, as TabsRepository does. */
  function waitRuleRepos() {
    let current = tab({ state: 'working', state_tool: 'codex' });
    const rows: HistoryRow[] = [];
    const recordEvent = vi.fn(async (_id: string, ev: { kind: Tab['state']; meta?: Record<string, unknown>; continuesWait?: boolean; keepsWaitText?: boolean }) => {
      const name = typeof ev.meta?.event === 'string' ? ev.meta.event : null;
      const outcome = decideWait({ state: current.state, seen: false, hasActivity: false, seenAgeMs: null }, rows, { kind: ev.kind!, name, continuesWait: !!ev.continuesWait, keepsWaitText: !!ev.keepsWaitText });
      if (outcome.action === 'drop') return { tab: current, event: null, rearm: null };
      rows.unshift({ kind: ev.kind!, event: name, ageMs: 0, backgroundTasks: false });
      current = tab({ ...current, state: ev.kind });
      return { tab: current, event: {}, rearm: null };
    });
    const r = {
      tabs: { findByTmuxSession: vi.fn(async () => current), recordEvent, setActivity: vi.fn(async () => undefined), setAgentFields: vi.fn() },
      machines: { findById: vi.fn(async () => ({ id: 'm1', owner_id: 'u1' })) },
      automationRuns: { latestByTab: vi.fn(async () => null) },
    } as unknown as Repositories;
    return { r, state: () => current.state };
  }
  const codex = (event: object) => ({ machineId: 'm1', tool: 'codex' as const, session: 'th-t1', event: { session_id: 's', turn_id: 'u', cwd: '/w', ...event } });
  const question = codex({ hook_event_name: 'PreToolUse', tool_name: 'request_user_input', tool_use_id: 'call_1', tool_input: { questions: [{ id: 'cor', header: 'Cor', question: 'Qual cor?', options: [{ label: 'Azul', description: 'Calma' }, { label: 'Verde', description: 'Fresca' }] }] } });
  const answered = codex({ hook_event_name: 'PostToolUse', tool_name: 'request_user_input', tool_use_id: 'call_1' });

  it('the PostToolUse after the answer puts the tab back to working and reaches the card service', async () => {
    note.mockClear();
    const { r, state } = waitRuleRepos();
    await ingestHookEvent(r, log, question);
    expect(state()).toBe('waiting_input');
    expect(note.mock.calls[0]![3]).toMatchObject({ question: { kind: 'choice' } });

    const res = await ingestHookEvent(r, log, answered);
    expect(res).toMatchObject({ ok: true, tab: { state: 'working' } });
    expect(state()).toBe('working');
    // noteHookEvent closes the question card on this PostToolUse (closingScope, chat/tab-questions.ts)
    expect(note).toHaveBeenCalledTimes(2);
    expect(note.mock.calls[1]![3]).toMatchObject({ kind: 'working', meta: { event: 'PostToolUse', tool: 'request_user_input' } });
  });

  it('a question dismissed with an Esc still drops the trailing PostToolUse', async () => {
    note.mockClear();
    const { r, state } = waitRuleRepos();
    await ingestHookEvent(r, log, question);
    await ingestHookEvent(r, log, codex({ hook_event_name: 'Interrupt' }));
    const res = await ingestHookEvent(r, log, answered);
    expect(res).toEqual({ ok: false, reason: 'ignored' });
    expect(state()).toBe('waiting_input');
    expect(note).toHaveBeenCalledTimes(2);
  });
});

describe('ingestHookEvent — an event the repository dropped', () => {
  it('ends as ignored: nothing is published, no card is touched, no suggestion check is scheduled', async () => {
    publish.mockClear();
    note.mockClear();
    schedule.mockClear();
    const current = tab({ state: 'working', state_tool: 'cursor' });
    const { r } = repos(current);
    (r.tabs.recordEvent as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ tab: current, event: null, rearm: null });

    const res = await ingestHookEvent(r, log, { machineId: 'm1', tool: 'cursor', session: 'th-t1', event: { hook_event_name: 'sessionStart' } });

    expect(res).toEqual({ ok: false, reason: 'ignored' });
    expect(publish).not.toHaveBeenCalled();
    expect(note).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
  });
  it('a subagent tool call dropped while the tab waits still closes that subagent\'s own card (TER-615)', async () => {
    publish.mockClear();
    note.mockClear();
    const current = tab({ state: 'waiting_input' });
    const { r } = repos(current);
    (r.tabs.recordEvent as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ tab: current, event: null, rearm: null });

    const res = await ingestHookEvent(r, log, { machineId: 'm1', tool: 'claude', session: 'th-t1', event: { hook_event_name: 'PreToolUse', tool_name: 'Bash', subagent: true, agent_id: 'a1' } });

    expect(res).toEqual({ ok: false, reason: 'ignored' });
    expect(publish).not.toHaveBeenCalled();
    expect(note).toHaveBeenCalledWith(r, log, current, expect.objectContaining({ meta: expect.objectContaining({ subagent: true, agent_id: 'a1' }) }), undefined);
  });
});

describe('ingestHookEvent — a seen wait that alerts again', () => {
  it('is logged with event names and flags, never the text', async () => {
    const info = vi.fn();
    const current = tab({ state: 'working' });
    const { r } = repos(current);
    (r.tabs.recordEvent as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      tab: tab({ ...current, state: 'waiting_input' }),
      event: {},
      rearm: { previous: 'PreToolUse', background: true, afterSessionEnd: false },
    });

    await ingestHookEvent(r, { info, debug: vi.fn(), warn: vi.fn() } as never, { machineId: 'm1', tool: 'claude', session: 'th-t1', event: { hook_event_name: 'Stop', last_assistant_message: 'segredo do terminal' } });

    expect(info).toHaveBeenCalledWith({ tabId: 't1', tool: 'claude', previous: 'PreToolUse', event: 'Stop', background: true, afterSessionEnd: false }, 'monitor: seen wait re-armed');
    expect(JSON.stringify(info.mock.calls)).not.toContain('segredo do terminal');
  });

  it('is not logged for an event that re-armed nothing', async () => {
    const info = vi.fn();
    const { r } = repos(tab({ state: 'working' }));
    await ingestHookEvent(r, { info, debug: vi.fn(), warn: vi.fn() } as never, { machineId: 'm1', tool: 'claude', session: 'th-t1', event: { hook_event_name: 'Stop', last_assistant_message: 'Pronto.' } });
    expect(info.mock.calls.some((c) => c[1] === 'monitor: seen wait re-armed')).toBe(false);
  });
});

describe('ingestHookEvent — the last answer reaches the repository (spec 2026-09-30 last answer, issue #160 item 5)', () => {
  const long = 'segredo.'.repeat(1250); // 10 000 characters
  const hook = (tool: 'claude' | 'codex' | 'cursor', event: Record<string, unknown>) => ({ machineId: 'm1', tool, session: 'th-t1', event });

  it.each([
    ['claude Stop', 'claude', { hook_event_name: 'Stop', last_assistant_message: long }],
    ['codex Stop', 'codex', { hook_event_name: 'Stop', last_assistant_message: long }],
    ['codex notify', 'codex', { type: 'agent-turn-complete', 'last-assistant-message': long }],
    ['cursor afterAgentResponse', 'cursor', { hook_event_name: 'afterAgentResponse', text: long }],
  ] as const)('%s: recordEvent gets the whole answer and the capped text; neither is logged', async (_label, tool, event) => {
    const spy = { info: vi.fn(), debug: vi.fn(), warn: vi.fn() };
    const { r, recordEvent } = repos(tab({ state: 'working' }));
    await ingestHookEvent(r, spy as never, hook(tool, event));
    expect(recordEvent).toHaveBeenCalledTimes(1);
    const passed = recordEvent.mock.calls[0]![1] as { answer?: string; text?: string | null };
    expect(passed.answer).toBe(long);
    expect(passed.answer).toHaveLength(10_000);
    expect(passed.text).toHaveLength(STATE_TEXT_MAX);
    expect(passed.text!.endsWith('…')).toBe(true);
    expect(spy.info).toHaveBeenCalledWith(expect.objectContaining({ answerLen: 10_000 }), 'monitor: tab state');
    expect(JSON.stringify([spy.info.mock.calls, spy.debug.mock.calls, spy.warn.mock.calls])).not.toContain('segredo');
  });

  it.each([
    ['claude idle_prompt', { hook_event_name: 'Notification', notification_type: 'idle_prompt', message: long }],
    ['claude StopFailure', { hook_event_name: 'StopFailure', error: 'rate_limit', last_assistant_message: long }],
  ] as const)('%s: recordEvent gets no answer key', async (_label, event) => {
    const { r, recordEvent } = repos(tab({ state: 'waiting_input' }));
    await ingestHookEvent(r, log, hook('claude', event));
    expect(recordEvent).toHaveBeenCalledTimes(1);
    expect(recordEvent.mock.calls[0]![1]).not.toHaveProperty('answer');
  });
});

describe('ingestHookEvent — the tab chat is told (spec 2026-10-01 tab chat §5.3)', () => {
  it('a Claude event calls onTabEvent with the tab id, after the tab row is updated', async () => {
    const { r, recordEvent } = repos(tab({ state: 'waiting_input' }));
    const onTabEvent = vi.fn(() => expect(recordEvent).toHaveBeenCalledTimes(1));
    await ingestHookEvent(r, log, { machineId: 'm1', tool: 'claude', session: 'th-t1', event: { hook_event_name: 'UserPromptSubmit', prompt: 'x' } }, undefined, onTabEvent);
    expect(onTabEvent).toHaveBeenCalledWith('t1');
  });

  it('a Claude event the monitor ignores still calls it: the transcript moved anyway', async () => {
    const { r } = repos(tab({ state: 'working' }));
    const onTabEvent = vi.fn();
    await ingestHookEvent(r, log, { machineId: 'm1', tool: 'claude', session: 'th-t1', event: { hook_event_name: 'SomethingNew' } }, undefined, onTabEvent);
    expect(onTabEvent).toHaveBeenCalledWith('t1');
  });

  it('a Codex event, or a session of no tab, does not', async () => {
    const onTabEvent = vi.fn();
    const { r } = repos(tab({ state: 'waiting_input' }));
    await ingestHookEvent(r, log, { machineId: 'm1', tool: 'codex', session: 'th-t1', event: { hook_event_name: 'UserPromptSubmit', prompt: 'x' } }, undefined, onTabEvent);
    const none = { tabs: { findByTmuxSession: vi.fn(async () => undefined) } } as unknown as Repositories;
    await ingestHookEvent(none, log, { machineId: 'm1', tool: 'claude', session: 'th-x', event: { hook_event_name: 'Stop' } }, undefined, onTabEvent);
    expect(onTabEvent).not.toHaveBeenCalled();
  });
});
