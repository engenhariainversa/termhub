import { describe, expect, it } from 'vitest';
import { isTabGrantable, mobileDecisionBody } from './chat.js';

describe('mobileDecisionBody', () => {
  it('accepts approve_tab with a challenge and a PIN proof, and refuses it without', () => {
    expect(mobileDecisionBody.safeParse({ decision: 'approve_tab', challenge: 'c', pin_proof: 'p' }).success).toBe(true);
    expect(mobileDecisionBody.safeParse({ decision: 'approve_tab' }).success).toBe(false);
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
