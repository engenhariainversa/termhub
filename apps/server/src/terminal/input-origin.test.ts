import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  normalizePrompt,
  ORIGIN_MAX_PER_TAB,
  ORIGIN_TTL_MS,
  recordInputOrigin,
  resetInputOrigins,
  takeInputOrigin,
  type InputOrigin,
} from './input-origin.js';

const assistant: InputOrigin = { level: 'assistant', userId: 'u1' };
const typed: InputOrigin = { level: 'person_typed', userId: 'u1', surface: 'app' };

beforeEach(() => resetInputOrigins());
afterEach(() => vi.useRealTimers());

describe('input origin registry', () => {
  it('matches the typed text once', () => {
    recordInputOrigin('t1', 'faça o merge', assistant);
    expect(takeInputOrigin('t1', 'faça o merge')).toEqual(assistant);
    expect(takeInputOrigin('t1', 'faça o merge')).toBeNull();
  });

  it('never matches another text or another tab', () => {
    recordInputOrigin('t1', 'faça o merge', assistant);
    expect(takeInputOrigin('t1', 'faça o merge agora')).toBeNull();
    expect(takeInputOrigin('t2', 'faça o merge')).toBeNull();
    expect(takeInputOrigin('t1', 'faça o merge')).toEqual(assistant);
  });

  it('expires after the TTL', () => {
    vi.useFakeTimers();
    recordInputOrigin('t1', 'a', assistant);
    vi.advanceTimersByTime(ORIGIN_TTL_MS - 1);
    recordInputOrigin('t1', 'b', assistant);
    vi.advanceTimersByTime(1);
    expect(takeInputOrigin('t1', 'a')).toBeNull();
    expect(takeInputOrigin('t1', 'b')).toEqual(assistant);
  });

  it('keeps at most the newest records per tab', () => {
    for (let i = 0; i <= ORIGIN_MAX_PER_TAB; i++) recordInputOrigin('t1', `msg ${i}`, assistant);
    expect(takeInputOrigin('t1', 'msg 0')).toBeNull();
    expect(takeInputOrigin('t1', `msg ${ORIGIN_MAX_PER_TAB}`)).toEqual(assistant);
  });

  it('takes repeated texts in the order they were typed', () => {
    recordInputOrigin('t1', 'ok', assistant);
    recordInputOrigin('t1', 'ok', typed);
    expect(takeInputOrigin('t1', 'ok')).toEqual(assistant);
    expect(takeInputOrigin('t1', 'ok')).toEqual(typed);
  });

  it('ignores empty texts', () => {
    recordInputOrigin('t1', '  \n', assistant);
    expect(takeInputOrigin('t1', '')).toBeNull();
  });

  it('matches the inside of a paste block, with or without the leading newlines', () => {
    const text = 'linha um\nlinha dois';
    recordInputOrigin('t1', text, assistant);
    recordInputOrigin('t1', text, typed);
    expect(takeInputOrigin('t1', `\n\n<pasted_content id="f13e">\n${text}\n</pasted_content id="f13e">\n`)).toEqual(assistant);
    expect(takeInputOrigin('t1', `<pasted_content id="a0">\n${text}\n</pasted_content id="a0">\n`)).toEqual(typed);
  });
});

describe('normalizePrompt', () => {
  it('folds CRLF and drops surrounding whitespace', () => {
    expect(normalizePrompt('  a\r\nb  \n')).toBe('a\nb');
  });

  it('unwraps a single paste block', () => {
    expect(normalizePrompt('\n\n<pasted_content id="f13e">\nx y\n</pasted_content id="f13e">\n')).toBe('x y');
  });

  it('keeps a prompt with text around the paste block as is', () => {
    const prompt = 'veja isto\n<pasted_content id="f1">\nx\n</pasted_content id="f1">\n';
    expect(normalizePrompt(prompt)).toBe(prompt.trim());
  });

  it('does not unwrap blocks whose ids differ', () => {
    const prompt = '<pasted_content id="f1">\nx\n</pasted_content id="f2">';
    expect(normalizePrompt(prompt)).toBe(prompt);
  });
});
