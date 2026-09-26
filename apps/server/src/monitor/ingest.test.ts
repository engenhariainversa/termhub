import { describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import type { Tab } from '../db/repositories/types.js';

const publish = vi.fn();
vi.mock('./bus.js', () => ({ monitorBus: { publish: (...a: unknown[]) => publish(...a) } }));
const note = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('../chat/tab-questions.js', () => ({ noteHookEvent: (...a: unknown[]) => note(...a) }));
const schedule = vi.fn();
const cancel = vi.fn();
vi.mock('../chat/tab-suggestions.js', () => ({ scheduleTabSuggestion: (...a: unknown[]) => schedule(...a), cancelTabSuggestion: (...a: unknown[]) => cancel(...a) }));
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
  return {
    r: {
      tabs: { findByTmuxSession: vi.fn(async () => current), recordEvent, setActivity, setAgentFields },
      projects: { findById: vi.fn(async () => ({ id: 'p1', machine_id: 'm1' })) },
      machines: { findById: vi.fn(async () => ({ id: 'm1', owner_id: 'u1' })) },
    } as unknown as Repositories,
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

describe('ingestHookEvent — suggestions', () => {
  it('a Claude Stop schedules the suggestion check; every event of the tab first cancels a pending one', async () => {
    schedule.mockClear();
    cancel.mockClear();
    const { r } = repos(tab({ state: 'working' }));
    await ingestHookEvent(r, log, { machineId: 'm1', tool: 'claude', session: 'th-t1', event: { hook_event_name: 'Stop' } });
    expect(cancel).toHaveBeenCalledWith('t1');
    expect(schedule).toHaveBeenCalledWith(r, log, 't1');
    expect(cancel.mock.invocationCallOrder[0]!).toBeLessThan(schedule.mock.invocationCallOrder[0]!);
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

  it('clears rate_limited_at once Claude runs again, only when it was set', async () => {
    const limited = repos(tab({ rate_limited_at: '2026-01-01T00:00:00.000Z' }));
    await ingestHookEvent(limited.r, log, { machineId: 'm1', tool: 'claude', session: 'th-t1', event: { hook_event_name: 'UserPromptSubmit' } });
    expect(limited.setAgentFields).toHaveBeenCalledWith('t1', { rate_limited_at: null });

    const notLimited = repos(tab({ rate_limited_at: null }));
    await ingestHookEvent(notLimited.r, log, { machineId: 'm1', tool: 'claude', session: 'th-t1', event: { hook_event_name: 'UserPromptSubmit' } });
    expect(notLimited.setAgentFields).not.toHaveBeenCalled();
  });

  it('a normal Stop clears rate_limited_at (the account works again); a rate_limit StopFailure still sets it', async () => {
    const limited = repos(tab({ rate_limited_at: '2026-01-01T00:00:00.000Z' }));
    await ingestHookEvent(limited.r, log, { machineId: 'm1', tool: 'claude', session: 'th-t1', event: { hook_event_name: 'Stop' } });
    expect(limited.setAgentFields).toHaveBeenCalledWith('t1', { rate_limited_at: null });

    const again = repos(tab({ rate_limited_at: '2026-01-01T00:00:00.000Z' }));
    await ingestHookEvent(again.r, log, { machineId: 'm1', tool: 'claude', session: 'th-t1', event: { hook_event_name: 'StopFailure', error: 'rate_limit' } });
    expect(again.setAgentFields).toHaveBeenCalledWith('t1', { rate_limited_at: expect.any(Date) });
  });

  it('another API error neither sets rate_limited_at nor swaps', async () => {
    autoSwapOnLimit.mockClear();
    const { r, setAgentFields } = repos(tab({ rate_limited_at: null }));
    await ingestHookEvent(r, log, { machineId: 'm1', tool: 'claude', session: 'th-t1', event: { hook_event_name: 'StopFailure', error: 'authentication_failed' } });
    expect(setAgentFields).not.toHaveBeenCalled();
    expect(autoSwapOnLimit).not.toHaveBeenCalled();
  });
});
