import { describe, expect, it } from 'vitest';
import { findMdPaths, mdPathsIn, stripFencedBlocks } from './md-paths.js';

// The same table lives in apps/web and apps/mobile (md-paths.test.ts): the list cites what the chat links.
const CASES: [string, string[]][] = [
  ['Relatório em ~/relatorio-termhub-10-dias.md', ['~/relatorio-termhub-10-dias.md']],
  ['Escrevi /tmp/report.md e /home/u/p/docs/x.markdown', ['/tmp/report.md', '/home/u/p/docs/x.markdown']],
  ['Spec: docs/superpowers/specs/2026-10-04-file-preview-design.md.', ['docs/superpowers/specs/2026-10-04-file-preview-design.md']],
  ['Veja ./NOTAS.md e ../outro/README.md', ['NOTAS.md', '../outro/README.md']],
  ['(docs/a.md)', ['docs/a.md']],
  ['"docs/lições/ação.md"', ['docs/lições/ação.md']],
  ['README.md', ['README.md']],
  ['https://github.com/o/r/blob/main/docs/a.md', []],
  ['github.com/o/r/blob/main/a.md', []],
  ['http://exemplo.com/a.md?x=1', []],
  ['config.mdx e notas.mdown e a.md5', []],
  ['package.json, requirements.txt', []],
  ['foo:bar.md', []],
];

describe('findMdPaths', () => {
  it.each(CASES)('%s', (text, paths) => {
    expect(findMdPaths(text).map((m) => m.path)).toEqual(paths);
  });

  it('reports where each path is in the text', () => {
    const text = 'Veja docs/a.md agora';
    const [m] = findMdPaths(text);
    expect(text.slice(m.start, m.end)).toBe('docs/a.md');
  });
});

describe('mdPathsIn', () => {
  it('skips paths inside fenced code blocks, keeps inline code', () => {
    const text = ['Veja `docs/a.md`.', '```bash', 'cat docs/b.md', '```', 'e ~/c.md', '~~~', '/tmp/d.md', '~~~'].join('\n');
    expect(mdPathsIn(text)).toEqual(['docs/a.md', '~/c.md']);
  });

  it('treats an unclosed fence as running to the end', () => {
    expect(mdPathsIn('docs/a.md\n```\ndocs/b.md')).toEqual(['docs/a.md']);
  });

  it('closes a fence only with the same character, at least as long', () => {
    expect(mdPathsIn('````\n```\ndocs/b.md\n````\ndocs/c.md')).toEqual(['docs/c.md']);
    expect(mdPathsIn('```\n~~~\ndocs/b.md\n```\ndocs/c.md')).toEqual(['docs/c.md']);
  });

  it('drops duplicates and keeps the order', () => {
    expect(mdPathsIn('docs/b.md, docs/a.md e docs/b.md')).toEqual(['docs/b.md', 'docs/a.md']);
  });

  it('keeps a text without fences as it is', () => {
    expect(stripFencedBlocks('a\nb')).toBe('a\nb');
  });
});
