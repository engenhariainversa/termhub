import { modeLabel } from './mode-label';

it.each([
  ['default', 'Padrão'],
  ['acceptEdits', 'Aceitar edições'],
  ['plan', 'Plano'],
  ['bypassPermissions', 'Sem confirmações'],
  ['auto', 'Automático'],
  ['someNewMode', 'someNewMode'],
])('%s reads "%s"', (mode, label) => {
  expect(modeLabel(mode)).toBe(label);
});

it('no mode, or one the footer could not read, shows nothing', () => {
  expect(modeLabel(null)).toBeNull();
  expect(modeLabel('unknown')).toBeNull();
});
