import { expect, it } from 'vitest';
import { ORCHESTRATOR_PROMPT, streamedSystemPrompt } from './concierge-prompt.js';

it('tells the concierge to delegate in the background and stay free', () => {
  expect(ORCHESTRATOR_PROMPT).toContain('run_in_background: true');
  expect(ORCHESTRATOR_PROMPT).toMatch(/end your turn/i);
});

it('goes first, with the project prompt after it, and fits the protocol cap with the longest project prompt', () => {
  expect(streamedSystemPrompt(null)).toBe(ORCHESTRATOR_PROMPT);
  expect(streamedSystemPrompt('projeto')).toBe(`${ORCHESTRATOR_PROMPT}\n\nprojeto`);
  expect(streamedSystemPrompt('x'.repeat(4000)).length).toBeLessThanOrEqual(8000);
});
