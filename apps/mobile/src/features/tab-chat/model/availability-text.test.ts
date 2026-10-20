import { availabilityText } from './availability-text';

it.each([
  ['offline', 'Máquina offline'],
  ['agent_outdated', 'Atualize o agente desta máquina'],
  ['no_session', 'Nenhuma sessão informada nesta aba'],
  ['unsupported_tool', 'Só Claude Code e Codex por enquanto'],
  ['unsupported_machine', 'Esta máquina não usa o agente do termhub'],
  ['something_newer', 'Indisponível no momento'],
])('%s reads "%s"', (availability, text) => {
  expect(availabilityText(availability)).toBe(text);
});

it('ready says nothing', () => {
  expect(availabilityText('ready')).toBeNull();
});
