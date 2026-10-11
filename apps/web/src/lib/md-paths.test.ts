// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { filePreviewHref, findMdPaths, linkifyMdPaths } from './md-paths';

// The same table lives in apps/mobile (md-paths.test.ts): both clients link the same paths.
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

function parse(html: string): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = html;
  return el;
}

describe('linkifyMdPaths', () => {
  const href = (p: string) => `/projects/p1?file=${encodeURIComponent(p)}`;

  it('links a path in prose and in inline code', () => {
    const el = parse(linkifyMdPaths('<p>Veja <code>docs/a.md</code> e ~/r.md.</p>', href));
    const links = [...el.querySelectorAll('a[data-md-path]')];
    expect(links.map((a) => a.getAttribute('data-md-path'))).toEqual(['docs/a.md', '~/r.md']);
    expect(links[0].getAttribute('href')).toBe('/projects/p1?file=docs%2Fa.md');
    expect(el.querySelector('code > a')?.textContent).toBe('docs/a.md');
    expect(el.textContent).toBe('Veja docs/a.md e ~/r.md.');
  });

  it('leaves code blocks and existing links alone', () => {
    const html = '<pre><code>cat docs/a.md</code></pre><p><a href="https://x">docs/b.md</a></p>';
    expect(linkifyMdPaths(html, href)).toBe(html);
  });

  it('cannot inject markup through the path', () => {
    const el = parse(linkifyMdPaths('<p>&lt;img src=x onerror=alert(1)&gt;/a.md</p>', href));
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('[onerror]')).toBeNull();
  });

  it('returns the same string when nothing is linked', () => {
    expect(linkifyMdPaths('<p>nada aqui</p>', href)).toBe('<p>nada aqui</p>');
  });
});

describe('filePreviewHref', () => {
  it('opens in the project, or on the file page outside one', () => {
    expect(filePreviewHref('p1', 'docs/a.md')).toBe('/projects/p1?file=docs%2Fa.md');
    expect(filePreviewHref(null, '~/r.md', 'm1')).toBe('/files?file=%7E%2Fr.md&machine=m1');
  });
});
