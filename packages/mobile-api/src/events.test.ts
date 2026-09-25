import { describe, expect, it } from 'vitest';
import { chatEventSchema } from './events.js';

const base = { user_id: 'u1', conversation_id: 'c1' };
const grant = { id: 'g1', tab_id: 't1', tool: 'send_input', source_action_id: 'a1', created_at: '2026-09-25T10:00:00.000Z', expires_at: '2026-09-26T10:00:00.000Z', tab_name: 'api' };
const card = { id: 'a2', tool: 'send_input', args: { tab_id: 't1', text: 'oi' }, class: 'write', status: 'executed', machine_id: null, project_id: null, tab_id: 't1', grant_id: 'g1', summary: 'digitar `oi` na aba api', created_at: '2026-09-25T10:01:00.000Z' };

describe('chatEventSchema: grants', () => {
  it.each([
    ['grant', { type: 'grant', ...base, grant }],
    ['grant_revoked', { type: 'grant_revoked', ...base, grant_id: 'g1' }],
    ['granted_action', { type: 'granted_action', ...base, action: card }],
  ])('accepts %s', (_t, e) => {
    const r = chatEventSchema.safeParse(e);
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
  });
  it('keeps grant_id on the card', () => {
    const r = chatEventSchema.parse({ type: 'granted_action', ...base, action: card });
    expect(r.type === 'granted_action' && r.action.grant_id).toBe('g1');
  });
});
