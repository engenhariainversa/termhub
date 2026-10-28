import { describe, expect, it } from 'vitest';
import { watchWakeText } from './text.js';

describe('watch wake text', () => {
  const watch = { id: 'w1', kind: 'tab' as const, label: 'stripe', note: 'avisar', recurring: true };
  const fire = (payload: Record<string, unknown>) => ({ event: 'finished', payload: { tab_id: 't1', tab_name: 'stripe', at: '2026-10-21T12:05:00.000Z', ...payload } });

  it('a recurring watch still open says it goes on', () => {
    expect(watchWakeText([{ watch: { ...watch, status: 'open' }, fire: fire({}) }])).toContain('A assinatura continua ativa.');
  });

  // TER-1144: the cap closes a recurring watch; the concierge must know it stopped following.
  it('the last fire of a capped watch says the watch ended', () => {
    const text = watchWakeText([{ watch: { ...watch, status: 'done' }, fire: fire({ last: true, max_fires: 10 }) }]);
    expect(text).toContain('último aviso desta assinatura');
    expect(text).not.toContain('continua ativa');
  });
});
