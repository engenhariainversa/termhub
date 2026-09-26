import { describe, expect, it } from 'vitest';
import { splitSettled } from './markdown-split';

describe('splitSettled', () => {
  it('cuts at the last blank line, keeping the whole body between the two halves', () => {
    const body = 'primeiro\n\nsegundo\n\nterc';
    expect(splitSettled(body)).toEqual({ settled: 'primeiro\n\nsegundo\n\n', tail: 'terc' });
  });

  it('has no settled prefix while no paragraph has ended', () => {
    expect(splitSettled('só uma linha')).toEqual({ settled: '', tail: 'só uma linha' });
    expect(splitSettled('duas\nlinhas')).toEqual({ settled: '', tail: 'duas\nlinhas' });
    expect(splitSettled('')).toEqual({ settled: '', tail: '' });
  });

  it('settles everything when the body ends in a blank line', () => {
    expect(splitSettled('pronto\n\n')).toEqual({ settled: 'pronto\n\n', tail: '' });
  });

  it('never cuts inside a code fence, closed or still open', () => {
    const closed = 'antes\n\n```sh\necho a\n\necho b\n```\ndepois';
    expect(splitSettled(closed)).toEqual({ settled: 'antes\n\n', tail: '```sh\necho a\n\necho b\n```\ndepois' });
    const open = 'antes\n\n```sh\necho a\n\necho b';
    expect(splitSettled(open)).toEqual({ settled: 'antes\n\n', tail: '```sh\necho a\n\necho b' });
  });

  it('cuts after a fence that closed, and treats a whitespace-only line as blank', () => {
    const body = '```\ncode\n```\n   \nfim';
    expect(splitSettled(body)).toEqual({ settled: '```\ncode\n```\n   \n', tail: 'fim' });
  });

  it('accepts an indented fence marker (up to three spaces) as a fence too', () => {
    const body = 'a\n\n   ```\nx\n\ny\n   ```\nb';
    expect(splitSettled(body)).toEqual({ settled: 'a\n\n', tail: '   ```\nx\n\ny\n   ```\nb' });
  });
});
