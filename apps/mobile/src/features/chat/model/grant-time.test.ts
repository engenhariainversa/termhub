import { activeGrantIndex, isGrantActive, untilLabel } from './grant-time';

const now = new Date(2026, 8, 25, 10, 0); // local time, 25 Sep 2026 10:00
it('says the hour when it ends today', () => {
  expect(untilLabel(new Date(2026, 8, 25, 14, 32).toISOString(), now)).toBe('até 14:32');
});
it('says tomorrow when it ends tomorrow', () => {
  expect(untilLabel(new Date(2026, 8, 26, 9, 5).toISOString(), now)).toBe('até amanhã, 09:05');
});
it('is active only before its expiry', () => {
  expect(isGrantActive({ expires_at: new Date(2026, 8, 25, 10, 1).toISOString() }, now)).toBe(true);
  expect(isGrantActive({ expires_at: new Date(2026, 8, 25, 9, 59).toISOString() }, now)).toBe(false);
});

it('indexes the grants still in force by the card that created them, skipping expired ones and those with no source', () => {
  const live = { id: 'g1', source_action_id: 'a1', expires_at: new Date(2026, 8, 25, 10, 1).toISOString() };
  const ended = { id: 'g2', source_action_id: 'a2', expires_at: new Date(2026, 8, 25, 9, 59).toISOString() };
  const orphan = { id: 'g3', source_action_id: null, expires_at: new Date(2026, 8, 25, 10, 1).toISOString() };
  const index = activeGrantIndex([live, ended, orphan], now);
  expect([...index.keys()]).toEqual(['a1']);
  expect(index.get('a1')).toBe(live);
});
