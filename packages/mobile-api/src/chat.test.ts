import { describe, expect, it } from 'vitest';
import { isTabGrantable, mobileBatchDecisionBody, mobileDecisionBody } from './chat.js';

describe('mobileDecisionBody', () => {
  it('accepts approve_tab with a challenge and a PIN proof, and refuses it without', () => {
    expect(mobileDecisionBody.safeParse({ decision: 'approve_tab', challenge: 'c', pin_proof: 'p' }).success).toBe(true);
    expect(mobileDecisionBody.safeParse({ decision: 'approve_tab' }).success).toBe(false);
  });

  it('accepts approve with both challenge and PIN proof or with neither, never with only one', () => {
    expect(mobileDecisionBody.safeParse({ decision: 'approve' }).success).toBe(true);
    expect(mobileDecisionBody.safeParse({ decision: 'approve', challenge: 'c', pin_proof: 'p' }).success).toBe(true);
    expect(mobileDecisionBody.safeParse({ decision: 'approve', challenge: 'c' }).success).toBe(false);
    expect(mobileDecisionBody.safeParse({ decision: 'approve', pin_proof: 'p' }).success).toBe(false);
  });
});

describe('mobileBatchDecisionBody', () => {
  const ok = (decisions: unknown) => mobileBatchDecisionBody.safeParse({ decisions }).success;
  it('accepts a deny-only batch and approvals carrying their own proof', () => {
    expect(ok([{ id: 'a1', decision: 'deny' }])).toBe(true);
    expect(ok([{ id: 'a1', decision: 'approve', challenge: 'c', pin_proof: 'p' }, { id: 'a2', decision: 'deny' }])).toBe(true);
  });
  it('refuses an approval without proof, approve_tab, repeated ids and an empty batch', () => {
    expect(ok([{ id: 'a1', decision: 'approve' }])).toBe(false);
    expect(ok([{ id: 'a1', decision: 'approve_tab', challenge: 'c', pin_proof: 'p' }])).toBe(false);
    expect(ok([{ id: 'a1', decision: 'deny' }, { id: 'a1', decision: 'deny' }])).toBe(false);
    expect(ok([])).toBe(false);
  });
});

describe('isTabGrantable', () => {
  const base = { tool: 'send_input', args: { tab_id: 't1', text: 'oi' }, tab_id: 't1' };
  it('is only send_input to a tab, not answering a permission', () => {
    expect(isTabGrantable(base)).toBe(true);
    expect(isTabGrantable({ ...base, args: { tab_id: 't1', text: '1', answering_permission: true } })).toBe(false);
    expect(isTabGrantable({ ...base, tool: 'run_command' })).toBe(false);
    expect(isTabGrantable({ ...base, tab_id: null })).toBe(false);
  });
});
