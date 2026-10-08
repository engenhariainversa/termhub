import { expect, it } from 'vitest';
import { messageRefLine, withMessageRef } from './message-ref.js';

it('names the message and tells the concierge how to relay it', () => {
  expect(messageRefLine('abc123', 'oi')).toContain('its ref is message:abc123');
  expect(messageRefLine('abc123', 'oi')).toContain('on_behalf_of: ["message:abc123"]');
});

it('gives a message that indexes nothing (files alone) no line, since its ref would not resolve', () => {
  expect(messageRefLine('abc123', '')).toBeNull();
  expect(withMessageRef('Anexos…', 'abc123', '', true)).toBe('Anexos…');
});

it('puts the line first, only for a typed message', () => {
  expect(withMessageRef('oi', 'abc123', 'oi', true)).toBe(`${messageRefLine('abc123', 'oi')}\n\noi`);
  expect(withMessageRef('oi', 'abc123', 'oi', false)).toBe('oi');
  expect(withMessageRef('oi', 'abc123', 'oi', undefined)).toBe('oi');
});
