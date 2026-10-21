import { agentLabel } from './agent-label';

it('names the reported AI CLI, a plain terminal, and keeps an unknown one as sent', () => {
  expect(agentLabel('claude')).toBe('Claude');
  expect(agentLabel('codex')).toBe('Codex');
  expect(agentLabel(null)).toBe('Terminal');
  expect(agentLabel('gemini')).toBe('gemini');
});
