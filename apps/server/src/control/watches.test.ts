import { beforeEach, describe, expect, it, vi } from 'vitest';
import { chatBus, type ChatEvent } from '../chat/bus.js';
import type { WatchProbe } from '../chat/watches/evaluate.js';
import { REMINDER_LIMITS, WATCH_LIMITS } from '../chat/watches/kinds.js';
import type { ControlContext } from './context.js';
import { cancelWatch, listWatches, scheduleWakeup, watch } from './watches.js';

const findByIdForUser = vi.fn();
const create = vi.fn();
const countOpen = vi.fn();
const listOpen = vi.fn();
const cancel = vi.fn();
const listByUrlForOwner = vi.fn();
const timeZone = vi.fn();
const scoped = { tab: vi.fn(), task: vi.fn(), taskByRef: vi.fn(), machine: vi.fn() };
const inChat = { id: 'tok', scopes: ['read'], gated: true, chat_conversation_id: 'c1' } as ControlContext['token'];
const ctxWith = (token: ControlContext['token'] = inChat) =>
  ({
    repos: {
      chat: { findByIdForUser, getOrCreateForProject: async () => ({ id: 'c1' }), getOrCreateForUser: async () => ({ id: 'c0' }) },
      chatWatches: { create, countOpen, listOpen, cancel },
      taskPullRequests: { listByUrlForOwner },
      users: { timeZone },
    },
    scope: { user: { id: 'u1' } },
    scoped,
    token,
  }) as unknown as ControlContext;

const probe: WatchProbe = {
  tab: async () => ({ id: 't1', name: 'api', project_id: 'p1', machine_id: 'm1', state: 'finished' }),
  tabEventsAfter: async () => [],
  task: async () => ({ id: 'k1', ref: 'TER-12', title: 'Login', project_id: 'p1', column_id: 'c-todo', status: 'todo' }),
  pullRequests: async () => [],
  machine: async () => ({ id: 'm1', name: 'hulk', online: false, offline_for_ms: 0 }),
  latestAgentVersion: async () => '0.40.2',
};

const row = (input: Record<string, unknown>) => ({
  id: 'w1', status: 'open', created_at: '2026-10-21T12:00:00.000Z', closed_at: null, last_fired_at: null, fire_count: 0, ...input,
  expires_at: (input.expires_at as Date).toISOString(),
});

let events: ChatEvent[];
let off: () => void;
beforeEach(() => {
  for (const f of [findByIdForUser, create, countOpen, listOpen, cancel, listByUrlForOwner, timeZone, ...Object.values(scoped)]) f.mockReset();
  timeZone.mockResolvedValue('America/Sao_Paulo');
  findByIdForUser.mockResolvedValue({ id: 'c1', project_id: 'p1' });
  countOpen.mockResolvedValue(0);
  listOpen.mockResolvedValue([]);
  create.mockImplementation(async (input: Record<string, unknown>) => row(input));
  scoped.tab.mockResolvedValue({ tab: { id: 't1', name: 'api' } });
  scoped.taskByRef.mockResolvedValue({ task: { id: 'k1', ref: 'TER-12', title: 'Login' } });
  scoped.machine.mockResolvedValue({ id: 'm1', name: 'hulk' });
  events = [];
  off?.();
  off = chatBus.subscribe((e) => events.push(e));
});

describe('watch', () => {
  it('only works in the chat', async () => {
    await expect(watch(ctxWith({ id: 'tok', scopes: ['read'] }), { kind: 'tab', tab_id: 't1', note: 'x' }, probe)).rejects.toMatchObject({ code: 'NOT_IN_CHAT' });
  });

  it('keeps a tab watch in the conversation\'s scope with the default stops, 24 h, and tells the screens', async () => {
    const out = await watch(ctxWith(), { kind: 'tab', tab_id: 't1', note: '  Ler e avisar  ' }, probe);
    const input = create.mock.calls[0][0];
    expect(input).toMatchObject({ user_id: 'u1', project_id: 'p1', conversation_id: 'c1', kind: 'tab', target_id: 't1', label: 'api', note: 'Ler e avisar', recurring: false });
    expect(input.params.events).toContain('finished');
    expect(input.params.events).toContain('gone');
    expect(input.params.events).not.toContain('waiting_background');
    expect(input.baseline).toEqual({ cursor: expect.any(String) });
    expect(input.expires_at.getTime() - Date.parse(input.baseline.cursor)).toBe(24 * 3600_000);
    expect(out.current).toEqual({ state: 'finished' });
    expect(out.note).toMatch(/Não lance subagente para esperar/);
    expect(events).toEqual([expect.objectContaining({ type: 'watches', user_id: 'u1', conversation_id: 'c1' })]);
  });

  it('takes a card by its ref, with `to`', async () => {
    await watch(ctxWith(), { kind: 'card', task_id: 'TER-12', to: 'done', note: 'x' }, probe);
    expect(scoped.taskByRef).toHaveBeenCalledWith('TER-12');
    expect(create.mock.calls[0][0]).toMatchObject({ target_id: 'k1', label: 'TER-12 Login', params: { events: ['moved', 'gone'], to: 'done' }, baseline: { column_id: 'c-todo', status: 'todo' } });
  });

  it('refuses events the kind does not have, a validity beyond 7 days and a 31st watch', async () => {
    await expect(watch(ctxWith(), { kind: 'tab', tab_id: 't1', events: ['merged'], note: 'x' }, probe)).rejects.toMatchObject({ code: 'INVALID_WATCH' });
    await expect(watch(ctxWith(), { kind: 'tab', tab_id: 't1', hours: 24 * 8, note: 'x' }, probe)).rejects.toMatchObject({ code: 'INVALID_WATCH' });
    countOpen.mockResolvedValue(WATCH_LIMITS.openPerScope);
    await expect(watch(ctxWith(), { kind: 'tab', tab_id: 't1', note: 'x' }, probe)).rejects.toMatchObject({ code: 'WATCH_LIMIT' });
    expect(create).not.toHaveBeenCalled();
  });

  it('a PR by URL must be one termhub follows', async () => {
    listByUrlForOwner.mockResolvedValue([]);
    await expect(watch(ctxWith(), { kind: 'pr', pr_url: 'https://github.com/o/r/pull/9', note: 'x' }, probe)).rejects.toMatchObject({ code: 'PR_NOT_TRACKED' });
    await expect(watch(ctxWith(), { kind: 'pr', pr_url: 'https://example.com/x', note: 'x' }, probe)).rejects.toMatchObject({ code: 'INVALID_WATCH' });
    listByUrlForOwner.mockResolvedValue([{ number: 9, title: 'Fix' }]);
    await watch(ctxWith(), { kind: 'pr', pr_url: 'https://github.com/o/r/pull/9', note: 'x' }, probe);
    expect(create.mock.calls[0][0]).toMatchObject({ target_id: null, label: 'PR #9 Fix', params: { pr_url: 'https://github.com/o/r/pull/9', events: ['merged', 'closed', 'ci_failed'] } });
  });

  it('an agent release needs a version and starts from the one on npm', async () => {
    await expect(watch(ctxWith(), { kind: 'agent_release', note: 'x' }, probe)).rejects.toMatchObject({ code: 'INVALID_WATCH' });
    const out = await watch(ctxWith(), { kind: 'agent_release', version: '0.41.0', note: 'x', recurring: true }, probe);
    expect(create.mock.calls[0][0]).toMatchObject({ label: '@termhub/agent ≥ 0.41.0', baseline: { seen: '0.40.2' }, recurring: true });
    expect(out.current).toEqual({ latest: '0.40.2' });
  });

  it('a machine watch remembers whether it was online', async () => {
    await watch(ctxWith(), { kind: 'machine', machine_id: 'm1', events: ['online'], note: 'x' }, probe);
    expect(create.mock.calls[0][0]).toMatchObject({ label: 'hulk', baseline: { online: false }, params: { events: ['online'] } });
  });
});

describe('list_watches and cancel_watch', () => {
  it('lists the scope\'s open watches', async () => {
    listOpen.mockResolvedValue([row({ kind: 'tab', target_id: 't1', params: { events: ['finished'] }, label: 'api', note: 'x', recurring: false, expires_at: new Date('2026-10-22T12:00:00.000Z') })]);
    expect((await listWatches(ctxWith())).watches).toEqual([expect.objectContaining({ id: 'w1', kind: 'tab', events: ['finished'], label: 'api' })]);
    expect(listOpen).toHaveBeenCalledWith('u1', 'p1');
  });

  it('cancels one of the person\'s and tells the screens; another\'s or a closed one is not found', async () => {
    cancel.mockResolvedValueOnce(row({ user_id: 'u1', project_id: 'p1', kind: 'tab', params: { events: [] }, expires_at: new Date(), status: 'cancelled' }));
    expect((await cancelWatch(ctxWith(), { watch_id: 'w1' })).watch.id).toBe('w1');
    expect(cancel).toHaveBeenCalledWith('w1', 'u1');
    expect(events.some((e) => e.type === 'watches')).toBe(true);
    cancel.mockResolvedValueOnce(null);
    await expect(cancelWatch(ctxWith(), { watch_id: 'w2' })).rejects.toMatchObject({ code: 'WATCH_NOT_FOUND' });
  });
});

describe('schedule_wakeup (TER-1100)', () => {
  // 15:00 in São Paulo (UTC-3, no DST in 2026).
  const now = new Date('2026-10-21T18:00:00.000Z');

  it('only works in the chat', async () => {
    await expect(scheduleWakeup(ctxWith({ id: 'tok', scopes: ['read'] }), { in_minutes: 5, note: 'x' }, now)).rejects.toMatchObject({ code: 'NOT_IN_CHAT' });
  });

  it('"em 5 min": a one-shot reminder in the scope, due in 5 minutes, told back on the person\'s clock', async () => {
    const out = await scheduleWakeup(ctxWith(), { in_minutes: 5, note: '  Conferir o build\ne mandar o link  ' }, now);
    const input = create.mock.calls[0][0];
    expect(input).toMatchObject({
      user_id: 'u1', project_id: 'p1', conversation_id: 'c1', kind: 'reminder', target_id: null, recurring: false,
      label: 'Conferir o build', note: 'Conferir o build\ne mandar o link',
      params: { events: ['due'], at: '2026-10-21T18:05:00.000Z', zone: 'America/Sao_Paulo' },
      baseline: { next: '2026-10-21T18:05:00.000Z' },
    });
    expect(input.params.every_minutes).toBeUndefined();
    expect(input.expires_at.getTime()).toBeGreaterThan(Date.parse('2026-10-21T18:05:00.000Z'));
    expect(out).toMatchObject({ due_at: '2026-10-21T18:05:00.000Z', due_local: '2026-10-21 15:05', time_zone: 'America/Sao_Paulo', until_local: null });
    expect(out.watch).toMatchObject({ kind: 'reminder', next_at: '2026-10-21T18:05:00.000Z', every_minutes: null });
    expect(out.note).toMatch(/Confirme à pessoa o horário no fuso dela/);
    expect(events).toEqual([expect.objectContaining({ type: 'watches', user_id: 'u1', conversation_id: 'c1' })]);
  });

  it('"às 18:00" is the person\'s 18:00 (their time zone), today or tomorrow', async () => {
    expect((await scheduleWakeup(ctxWith(), { at_time: '18:00', note: 'x' }, now)).due_at).toBe('2026-10-21T21:00:00.000Z');
    expect((await scheduleWakeup(ctxWith(), { at_time: '09:00', note: 'x' }, now)).due_at).toBe('2026-10-22T12:00:00.000Z');
    timeZone.mockResolvedValue('Asia/Tokyo');
    const tokyo = await scheduleWakeup(ctxWith(), { at_time: '09:00', note: 'x' }, now);
    expect(tokyo).toMatchObject({ due_at: '2026-10-22T00:00:00.000Z', due_local: '2026-10-22 09:00', time_zone: 'Asia/Tokyo' });
  });

  it('`at` with an offset is that instant; without, it is read on the person\'s clock; no zone known is UTC', async () => {
    expect((await scheduleWakeup(ctxWith(), { at: '2026-10-22T10:00:00Z', note: 'x' }, now)).due_at).toBe('2026-10-22T10:00:00.000Z');
    expect((await scheduleWakeup(ctxWith(), { at: '2026-10-22T10:00', note: 'x' }, now)).due_at).toBe('2026-10-22T13:00:00.000Z');
    timeZone.mockResolvedValue(null);
    expect((await scheduleWakeup(ctxWith(), { at: '2026-10-22 10:00', note: 'x' }, now))).toMatchObject({ due_at: '2026-10-22T10:00:00.000Z', time_zone: 'UTC' });
  });

  it('refuses a time in the past, beyond 7 days, an unreadable one, or none / several', async () => {
    for (const a of [{ at: '2026-10-21T17:00:00Z' }, { in_minutes: 8 * 24 * 60 }, { at: 'amanhã' }, { at: '2026-02-30T10:00' }, {}, { in_minutes: 5, at_time: '18:00' }]) {
      await expect(scheduleWakeup(ctxWith(), { ...a, note: 'x' }, now)).rejects.toMatchObject({ code: 'INVALID_WATCH' });
    }
    expect(create).not.toHaveBeenCalled();
  });

  it('repeats every N minutes with a cap; neither cap nor end is a day; min 5 min; times/until need every_minutes', async () => {
    const capped = await scheduleWakeup(ctxWith(), { in_minutes: 10, every_minutes: 10, times: 3, note: 'x' }, now);
    expect(create.mock.calls[0][0]).toMatchObject({ recurring: true, params: { every_minutes: 10, times: 3, until: '2026-10-21T18:30:00.000Z' } });
    expect(capped.until_local).toBe('2026-10-21 15:30');
    await scheduleWakeup(ctxWith(), { in_minutes: 10, every_minutes: 30, until_time: '17:00', note: 'x' }, now);
    expect(create.mock.calls[1][0].params.until).toBe('2026-10-21T20:00:00.000Z');
    await scheduleWakeup(ctxWith(), { in_minutes: 10, every_minutes: 60, note: 'x' }, now);
    expect(create.mock.calls[2][0].params.until).toBe('2026-10-22T18:10:00.000Z');
    await expect(scheduleWakeup(ctxWith(), { in_minutes: 10, every_minutes: REMINDER_LIMITS.minEveryMinutes - 1, note: 'x' }, now)).rejects.toMatchObject({ code: 'INVALID_WATCH' });
    await expect(scheduleWakeup(ctxWith(), { in_minutes: 10, times: 3, note: 'x' }, now)).rejects.toMatchObject({ code: 'INVALID_WATCH' });
    await expect(scheduleWakeup(ctxWith(), { in_minutes: 10, every_minutes: 10, until: '2026-10-21T18:05:00Z', note: 'x' }, now)).rejects.toMatchObject({ code: 'INVALID_WATCH' });
  });

  it('a repetition never runs past 7 days from now', async () => {
    await scheduleWakeup(ctxWith(), { in_minutes: 10, every_minutes: 60, until: '2026-11-30T00:00:00Z', note: 'x' }, now);
    expect(create.mock.calls[0][0].params.until).toBe(new Date(now.getTime() + WATCH_LIMITS.maxHours * 3600_000).toISOString());
  });

  it('a periodic summary stops with an open watch of the chat (TER-1101 stop_with)', async () => {
    listOpen.mockResolvedValue([{ id: 'job', kind: 'tab' }, { id: 'rem', kind: 'reminder' }]);
    const out = await scheduleWakeup(ctxWith(), { in_minutes: 60, every_minutes: 60, stop_with: 'job', note: 'Resumo' }, now);
    expect(create.mock.calls[0][0].params).toMatchObject({ every_minutes: 60, stop_with: 'job' });
    expect(out.note).toMatch(/para sozinho quando a assinatura stop_with fechar/);
    for (const a of [{ stop_with: 'job' }, { every_minutes: 60, stop_with: 'rem' }, { every_minutes: 60, stop_with: 'nope' }]) {
      await expect(scheduleWakeup(ctxWith(), { in_minutes: 60, ...a, note: 'x' }, now)).rejects.toMatchObject({ code: 'INVALID_WATCH' });
    }
  });

  it('refuses an 11th open reminder, and a 31st watch of any kind', async () => {
    const reminder = { kind: 'reminder' };
    listOpen.mockResolvedValue(Array.from({ length: REMINDER_LIMITS.openPerScope }, () => reminder));
    await expect(scheduleWakeup(ctxWith(), { in_minutes: 5, note: 'x' }, now)).rejects.toMatchObject({ code: 'REMINDER_LIMIT' });
    listOpen.mockResolvedValue(Array.from({ length: WATCH_LIMITS.openPerScope }, () => ({ kind: 'tab' })));
    await expect(scheduleWakeup(ctxWith(), { in_minutes: 5, note: 'x' }, now)).rejects.toMatchObject({ code: 'WATCH_LIMIT' });
    expect(create).not.toHaveBeenCalled();
  });
});
