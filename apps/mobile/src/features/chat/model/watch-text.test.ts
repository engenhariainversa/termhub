import { setLocale } from '@/i18n';
import type { ChatWatch } from './types';
import { watchEventLabel, watchEventsText, watchKindLabel, watchUntilLabel, withoutWatch } from './watch-text';

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
});

it('withoutWatch says where the row was', () => {
  const list = [watch(), watch({ id: 'w2' })];
  expect(withoutWatch(list, 'w2')).toEqual({ list: [list[0]], index: 1, watch: list[1] });
  expect(withoutWatch(list, 'nope')).toEqual({ list, index: -1, watch: null });
});
