import { describe, expect, it } from 'vitest';
import { showsTrustQuestion } from './trust.js';

// Claude Code 2.1.x, a new worktree (TER-1025)
const QUESTION = [
  'Accessing workspace:',
  '',
  '/home/dev/.termhub/worktrees/p1/TER-7',
  '',
  'Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open',
  'source project, or work from your team). If not, take a moment to review what\'s in this folder first.',
  '',
  ' ❯ 1. Yes, I trust this folder',
  '   2. No, exit',
  '',
  ' Enter to confirm · Esc to cancel',
].join('\n');

describe('showsTrustQuestion', () => {
  it('sees the question with "Yes" selected', () => {
    expect(showsTrustQuestion(QUESTION)).toBe(true);
  });

  it('leaves alone a screen where "No" is selected, or any other screen', () => {
    expect(showsTrustQuestion(QUESTION.replace(' ❯ 1.', '   1.').replace('   2. No', ' ❯ 2. No'))).toBe(false);
    expect(showsTrustQuestion('> Continue a tarefa\n ❯ 1. Yes\n   2. No')).toBe(false);
    expect(showsTrustQuestion('')).toBe(false);
  });
});
