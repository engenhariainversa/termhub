import { describe, expect, it } from 'vitest';
import { canonicalHtu, decisionProofMessage } from './proofs.js';

describe('proof helpers', () => {
  it('builds the htu from the base and the path, dropping the query and a trailing slash', () => {
    expect(canonicalHtu('https://termhub.dev/', '/api/m/v1/chat?project=p1')).toBe('https://termhub.dev/api/m/v1/chat');
  });
  it('the decision message binds challenge, action and the word approve, newline-separated', () => {
    expect(decisionProofMessage('c1', 'a1', 'approve')).toBe('c1\na1\napprove');
  });
  it('a grant is signed with its own word, so an "approve" proof cannot open one', () => {
    expect(decisionProofMessage('c1', 'a1', 'approve_tab')).toBe('c1\na1\napprove_tab');
    expect(decisionProofMessage('c1', 'a1', 'approve_tab')).not.toBe(decisionProofMessage('c1', 'a1', 'approve'));
  });
});
