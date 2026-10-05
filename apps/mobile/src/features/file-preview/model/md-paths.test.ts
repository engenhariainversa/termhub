import { filePathOfLink, findMdPaths, linkifyMarkdown } from './md-paths';

// The same table as the web (apps/web/src/lib/md-paths.test.ts): both clients link the same paths.
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
});

describe('linkifyMarkdown', () => {
  it('links paths in prose and a code span that is exactly a path', () => {
    expect(linkifyMarkdown('Veja ~/r.md e `docs/a.md`.')).toBe('Veja [~/r.md](termhub-file:~%2Fr.md) e [`docs/a.md`](termhub-file:docs%2Fa.md).');
  });

  it('leaves fenced code, a code span with more than a path, and existing links alone', () => {
    const md = ['```bash', 'cat docs/a.md', '```', '`cat docs/a.md`', '[spec](docs/a.md) e <https://x/a.md>'].join('\n');
    expect(linkifyMarkdown(md)).toBe(md);
  });

  it('round-trips the path through the link', () => {
    const md = linkifyMarkdown('docs/lições/ação.md');
    const url = /\((termhub-file:[^)]+)\)/.exec(md)?.[1] ?? '';
    expect(filePathOfLink(url)).toBe('docs/lições/ação.md');
    expect(filePathOfLink('https://x')).toBeNull();
  });
});
