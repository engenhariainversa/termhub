import { expect, it } from 'vitest';
import { TOOLS } from './tools.js';

it('read_screen says what ⟦…⟧ means and what styled: false means', () => {
  const d = TOOLS.find((t) => t.name === 'read_screen')!.description;
  expect(d).toContain('Text between ⟦ and ⟧ is dimmed');
  expect(d).toContain('never report it as an unsent message and never press Enter because of it');
  expect(d).toContain('styled: false');
});
