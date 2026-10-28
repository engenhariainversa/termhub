import { setLocale } from '@/i18n';
import type { ChatWatch } from './types';
import { watchEventLabel, watchEventsText, watchHeadline, watchKindLabel, watchPlainEvents, watchStatus, watchUntilLabel, withoutWatch } from './watch-text';

const watch = (patch: Partial<ChatWatch> = {}): ChatWatch => ({
  id: 'w1',
  kind: 'pr',
  target_id: 'pr-511',
  label: 'PR #511',
  events: ['merged', 'ci_failed'],
  recurring: false,
  note: '',
  created_at: '2026-10-21T12:00:00.000Z',
  expires_at: '2026-10-22T12:00:00.000Z',
  fire_count: 0,
  ...patch,
});

afterEach(() => setLocale(null));

it('names the kind and the events in words', () => {
  expect(watchKindLabel('agent_release')).toBe('Versão do agent');
  expect(watchEventLabel('tab', 'gone')).toBe('for fechada');
  expect(watchEventLabel('machine', 'gone')).toBe('for removida');
  expect(watchEventsText(watch())).toBe('Quando for mergeado, o CI falhar');
});

it('reads a kind or an event this app does not know as its raw name', () => {
  expect(watchKindLabel('pipeline')).toBe('pipeline');
  expect(watchEventLabel('pr', 'reverted')).toBe('reverted');
  expect(watchEventsText(watch({ kind: 'pipeline', events: ['done'] }))).toBe('Quando done');
  expect(watchEventsText(watch({ events: [] }))).toBe('');
});

it('says until when: the time today, date and time on another day', () => {
  const now = new Date(2026, 9, 21, 9, 0);
  expect(watchUntilLabel(new Date(2026, 9, 21, 14, 32).toISOString(), now)).toMatch(/^até \d{2}:\d{2}$/);
  expect(watchUntilLabel(new Date(2026, 9, 23, 9, 5).toISOString(), now)).toMatch(/^até 23\/10.*09:05$/);
  expect(watchUntilLabel('not a date', now)).toBe('');
});

it('reads in English', () => {
  setLocale('en');
  expect(watchKindLabel('machine')).toBe('Machine');
  expect(watchEventsText(watch())).toBe('When it is merged, CI fails');
  expect(watchHeadline(watch({ summary: null }))).toBe('PR #511: I\'ll let you know when it is merged or CI fails');
});

it('withoutWatch says where the row was', () => {
  const list = [watch(), watch({ id: 'w2' })];
  expect(withoutWatch(list, 'w2')).toEqual({ list: [list[0]], index: 1, watch: list[1] });
  expect(withoutWatch(list, 'nope')).toEqual({ list, index: -1, watch: null });
});

// TER-1100: a reminder says when and how often it wakes the chat; TER-1115: with the person's line.
it('tells a reminder by its next time, its line and its pace', () => {
  const now = new Date(2026, 9, 21, 9, 0);
  const next = new Date(2026, 9, 21, 18, 0).toISOString();
  expect(watchKindLabel('reminder')).toBe('Lembrete');
  expect(watchHeadline(watch({ kind: 'reminder', events: ['due'], summary: 'Conferir o build', next_at: next }), now)).toBe('Às 18:00: Conferir o build');
  expect(watchHeadline(watch({ kind: 'reminder', events: ['due'], summary: null, label: 'nota interna', next_at: next }), now)).toBe('Lembrete às 18:00');
  expect(watchStatus(watch({ kind: 'reminder', events: ['due'], recurring: true, next_at: next, every_minutes: 10, expires_at: new Date(2026, 9, 21, 20, 0).toISOString() }), now)).toBe('a cada 10 min · até 20:00');
});

// TER-1115
it('shows the concierge\'s line, or composes one in plain words for an older watch', () => {
  expect(watchHeadline(watch({ summary: 'Te aviso quando o PR #511 for mesclado' }))).toBe('Te aviso quando o PR #511 for mesclado');
  expect(watchHeadline(watch({ summary: null }))).toBe('PR #511: te aviso quando for mergeado ou o CI falhar');
  const tab = watch({ kind: 'tab', label: 'api', events: ['finished', 'waiting_input', 'waiting_permission', 'idle', 'error', 'blocked', 'gone'] });
  expect(watchPlainEvents(tab)).toBe('terminar, perguntar algo ou der erro');
  expect(watchHeadline({ ...tab, summary: null })).toBe('Aba api: te aviso quando terminar, perguntar algo ou der erro');
  expect(watchPlainEvents(watch({ kind: 'tab', events: ['gone'] }))).toBe('for fechada');
});

it('says what already happened, the tab\'s state now and until when', () => {
  const now = new Date(2026, 9, 22, 14, 0);
  const w = watch({
    kind: 'tab', recurring: true, fire_count: 2, last_event: 'finished', last_fired_at: new Date(2026, 9, 22, 13, 32).toISOString(), target_state: 'working',
    expires_at: new Date(2026, 9, 23, 16, 0).toISOString(),
  });
  expect(watchStatus(w, now)).toBe('trabalhando agora · terminou às 13:32 · avisou 2× · até amanhã 16:00');
  expect(watchStatus({ ...w, target_state: 'waiting_input', fire_count: 1, last_event: 'rebooted' }, now)).toBe('parada agora · rebooted às 13:32 · até amanhã 16:00');
});
