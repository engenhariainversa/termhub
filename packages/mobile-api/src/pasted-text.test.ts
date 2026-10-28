import { describe, expect, it } from 'vitest';
import { mobileMessageBody } from './chat.js';
import { CHAT_MESSAGE_MAX_CHARS, PASTE_AS_FILE_CHARS, insertedRun, pasteGoesAsFile, pastedTextName, utf8Bytes } from './pasted-text.js';

describe('pasteGoesAsFile', () => {
  it('keeps a short paste as text', () => {
    expect(pasteGoesAsFile('olá', 'olá', CHAT_MESSAGE_MAX_CHARS)).toBe(false);
    expect(pasteGoesAsFile('x'.repeat(PASTE_AS_FILE_CHARS - 1), 'x'.repeat(PASTE_AS_FILE_CHARS - 1), CHAT_MESSAGE_MAX_CHARS)).toBe(false);
  });

  it('turns a long paste into a file', () => {
    expect(pasteGoesAsFile('x'.repeat(PASTE_AS_FILE_CHARS), 'x'.repeat(PASTE_AS_FILE_CHARS), CHAT_MESSAGE_MAX_CHARS)).toBe(true);
  });

  it('turns a short paste into a file when the box would no longer fit', () => {
    const typed = 'y'.repeat(CHAT_MESSAGE_MAX_CHARS - 10);
    expect(pasteGoesAsFile('z'.repeat(200), typed + 'z'.repeat(200), CHAT_MESSAGE_MAX_CHARS)).toBe(true);
  });

  it('takes a few letters that cross the limit for typing, not a paste', () => {
    const typed = 'y'.repeat(CHAT_MESSAGE_MAX_CHARS - 2);
    expect(pasteGoesAsFile('palavra', `${typed}palavra`, CHAT_MESSAGE_MAX_CHARS)).toBe(false);
  });

  it('leaves a short paste into a box already too long to the send', () => {
    const typed = 'y'.repeat(CHAT_MESSAGE_MAX_CHARS + 10);
    expect(pasteGoesAsFile('z', typed + 'z', CHAT_MESSAGE_MAX_CHARS)).toBe(false);
  });

  it('follows half of a lower limit, as a tab has', () => {
    expect(pasteGoesAsFile('x'.repeat(2000), 'x'.repeat(2000), 4000)).toBe(true);
    expect(pasteGoesAsFile('x'.repeat(1999), 'x'.repeat(1999), 4000)).toBe(false);
  });

  it('never makes a file of blanks', () => {
    expect(pasteGoesAsFile(' '.repeat(PASTE_AS_FILE_CHARS * 3), ' '.repeat(PASTE_AS_FILE_CHARS * 3), CHAT_MESSAGE_MAX_CHARS)).toBe(false);
  });
});

describe('pastedTextName', () => {
  it('names the file after the local time of the paste', () => {
    expect(pastedTextName(new Date(2026, 9, 28, 9, 5))).toBe('colado-2026-10-28-0905.txt');
  });
});

describe('insertedRun', () => {
  it('finds a paste in the middle of the text', () => {
    expect(insertedRun('abc def', 'abc XYZ def')).toEqual({ head: 'abc ', inserted: 'XYZ ', tail: 'def' });
  });

  it('finds a paste into an empty box', () => {
    expect(insertedRun('', 'tudo')).toEqual({ head: '', inserted: 'tudo', tail: '' });
  });

  it('finds a paste over a selection', () => {
    expect(insertedRun('abc SEL def', 'abc NOVO def')).toEqual({ head: 'abc ', inserted: 'NOVO', tail: ' def' });
  });

  it('puts the run back together', () => {
    const r = insertedRun('aaaa', 'aaaaaaaa');
    expect(r.head + r.inserted + r.tail).toBe('aaaaaaaa');
    expect(r.inserted).toHaveLength(4);
  });
});

describe('utf8Bytes', () => {
  it('counts bytes, not characters', () => {
    expect(utf8Bytes('ação')).toBe(6);
  });
});

describe('the message limit', () => {
  it('is the one the contract enforces', () => {
    expect(mobileMessageBody.safeParse({ text: 'x'.repeat(CHAT_MESSAGE_MAX_CHARS) }).success).toBe(true);
    expect(mobileMessageBody.safeParse({ text: 'x'.repeat(CHAT_MESSAGE_MAX_CHARS + 1) }).success).toBe(false);
  });
});
