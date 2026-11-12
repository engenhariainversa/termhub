import { describe, expect, it } from 'vitest';
import { describeFire, watchWakeText } from './text.js';

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

// TER-1168: a watch that waited for an agent that is gone tells why, so the concierge tells the person
describe('watch wake text for an agent that is gone (TER-1168)', () => {
  const watch = { id: 'w2', kind: 'tab' as const, label: 'pda', note: 'avisar quando o pda-app subir', recurring: false, status: 'gone' as const };
  it('names the exit and what to do', () => {
    const text = watchWakeText([{ watch, fire: { event: 'gone', payload: { tab_id: 't1', tab_name: 'pda', reason: 'agent_exited', at: '2026-11-11T10:00:00.000Z' } } }]);
    expect(text).toContain('o agente da aba «pda» (tab_id t1) saiu');
    expect(text).toContain('Conte à pessoa agora');
  });
  it('names a text that started no turn, with its reason', () => {
    const text = watchWakeText([{ watch, fire: { event: 'gone', payload: { tab_id: 't1', tab_name: 'pda', reason: 'not_delivered', why: 'agent_exited', at: '2026-11-11T10:00:00.000Z' } } }]);
    expect(text).toContain('não começou nenhum turno (o agente saiu e o texto caiu no shell)');
  });
});

describe('a quiet waiting_background (TER-1168)', () => {
  it('says the background work may have ended without waking the agent', () => {
    const line = describeFire({ kind: 'tab', label: 'APPS-456' }, { event: 'waiting_background', payload: { tab_id: 't1', tab_name: 'APPS-456', at: '2026-11-12T03:06:28Z', quiet_minutes: 20 } });
    expect(line).toContain('não reporta nada há 20 min');
    expect(line).toContain('tab_id t1');
  });
});
