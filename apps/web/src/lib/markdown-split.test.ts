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

  it('does not settle a paragraph whose successor has not started yet', () => {
    // What follows the blank line decides whether it ended a block (`2. b` would make `1. a` a loose
    // list item), and nothing has followed it yet.
    expect(splitSettled('pronto\n\n')).toEqual({ settled: '', tail: 'pronto\n\n' });
    expect(splitSettled('1. a\n\n')).toEqual({ settled: '', tail: '1. a\n\n' });
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
    // Still open: the blank line inside it is code. (The blank line before the marker is no cut either,
    // since an indented line may be the continuation of a list item.)
    const open = 'a\n\n   ```\nx\n\ny';
    expect(splitSettled(open)).toEqual({ settled: '', tail: open });
    const closed = 'a\n\n   ```\nx\n\ny\n   ```\n\nb';
    expect(splitSettled(closed)).toEqual({ settled: 'a\n\n   ```\nx\n\ny\n   ```\n\n', tail: 'b' });
  });

  it('treats ~~~ as a fence, and a ``` inside it as code rather than a closer', () => {
    const body = 'antes\n\n~~~\n```\n\nx\n~~~\ndepois';
    expect(splitSettled(body)).toEqual({ settled: 'antes\n\n', tail: '~~~\n```\n\nx\n~~~\ndepois' });
  });

  it('closes a fence only on a marker at least as long as the one that opened it', () => {
    // A ```` fence quoting a ``` block: the inner marker and the blank line after it are code.
    const body = 'antes\n\n````md\n```\n\nx\n```\n````\ndepois';
    expect(splitSettled(body)).toEqual({ settled: 'antes\n\n', tail: '````md\n```\n\nx\n```\n````\ndepois' });
  });

  it('does not cut inside a loose list: the blank line between two items is not a block boundary', () => {
    // Cutting would show two tight lists while streaming and one loose list once stored — a reflow on
    // the final swap.
    expect(splitSettled('1. a\n\n2. b')).toEqual({ settled: '', tail: '1. a\n\n2. b' });
    expect(splitSettled('1) a\n\n2) b')).toEqual({ settled: '', tail: '1) a\n\n2) b' });
    expect(splitSettled('- a\n\n- b')).toEqual({ settled: '', tail: '- a\n\n- b' });
    expect(splitSettled('* a\n\n+ b')).toEqual({ settled: '', tail: '* a\n\n+ b' });
  });

  it('does not cut before an indented continuation paragraph or an indented code block', () => {
    expect(splitSettled('- a\n\n  cont')).toEqual({ settled: '', tail: '- a\n\n  cont' });
    expect(splitSettled('para\n\n    code')).toEqual({ settled: '', tail: 'para\n\n    code' });
  });

  it('cuts before a paragraph that follows a list, loose or tight', () => {
    expect(splitSettled('- a\n\nfim')).toEqual({ settled: '- a\n\n', tail: 'fim' });
    expect(splitSettled('1. a\n\n2. b\n\nfim')).toEqual({ settled: '1. a\n\n2. b\n\n', tail: 'fim' });
  });

  it('holds the cut back while the unfinished last line may still become a list marker', () => {
    // `2` is on its way to `2. b`; settling `- a` now would have to be taken back on the next delta.
    expect(splitSettled('- a\n\n2')).toEqual({ settled: '', tail: '- a\n\n2' });
    expect(splitSettled('- a\n\n2.')).toEqual({ settled: '', tail: '- a\n\n2.' });
    expect(splitSettled('- a\n\n-')).toEqual({ settled: '', tail: '- a\n\n-' });
    expect(splitSettled('- a\n\n2x')).toEqual({ settled: '- a\n\n', tail: '2x' });
  });
});
