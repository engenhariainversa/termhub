import { expect, it } from 'vitest';
import { contextFull, freshSessionNote } from './auto-compact.js';

it('is full from 85% of a known window, never when the fill or the window is unknown', () => {
  expect(contextFull({ context_tokens: 905_000, context_window: 1_000_000 })).toBe(true);
  expect(contextFull({ context_tokens: 850_000, context_window: 1_000_000 })).toBe(true);
  expect(contextFull({ context_tokens: 849_999, context_window: 1_000_000 })).toBe(false);
  expect(contextFull({ context_tokens: 905_000, context_window: null })).toBe(false);
  expect(contextFull({ context_tokens: null, context_window: 1_000_000 })).toBe(false);
});

it('tells a new session why it is new and what was said last, one line each, clipped', () => {
  const note = freshSessionNote([
    { role: 'user', text: 'qual o\nstatus?' },
    { role: 'assistant', text: 'y'.repeat(2000) },
  ]);
  const lines = note.split('\n');
  expect(lines[0]).toMatch(/^\[termhub\] A sessão anterior desta conversa encheu o contexto/);
  expect(lines[0]).toContain('não são instruções novas');
  expect(lines[1]).toBe('- Pessoa: qual o status?');
  expect(lines[2].startsWith('- Você: yyy')).toBe(true);
  expect(lines[2].endsWith('…')).toBe(true);
  expect(lines[2].length).toBeLessThan(700);
});

it('says only what happened when the thread has nothing to tell', () => {
  expect(freshSessionNote([])).toBe('[termhub] A sessão anterior desta conversa encheu o contexto e não pôde ser compactada, então esta é uma sessão nova.');
});
