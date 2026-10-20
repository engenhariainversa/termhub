// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { toHtml } from '../components/chat/ChatTurn';
import { findUrls, openLinksInNewTab, splitUrls } from './links';

const urls = (text: string) => findUrls(text).map((m) => m.url);

// The same table as the app's (`apps/mobile/src/features/chat/model/links.test.ts`).
const CASES: [string, string[]][] = [
  ['veja http://192.168.68.114:8765/termhub-linkedin-final.png', ['http://192.168.68.114:8765/termhub-linkedin-final.png']],
  ['https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c&redirect_uri=https%3A%2F%2Fx&state=ab_c-d', ['https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c&redirect_uri=https%3A%2F%2Fx&state=ab_c-d']],
  ['Abra https://termhub.dev/docs#instalar.', ['https://termhub.dev/docs#instalar']],
  ['Pronto: https://termhub.dev, https://app.termhub.dev; e http://x.io!', ['https://termhub.dev', 'https://app.termhub.dev', 'http://x.io']],
  ['(veja https://termhub.dev/a)', ['https://termhub.dev/a']],
  ['https://en.wikipedia.org/wiki/Tmux_(software).', ['https://en.wikipedia.org/wiki/Tmux_(software)']],
  ['[https://termhub.dev/x]', ['https://termhub.dev/x']],
  ['"https://termhub.dev/q" e <https://termhub.dev/r>', ['https://termhub.dev/q', 'https://termhub.dev/r']],
  ['- item https://a.dev/1\n- item HTTPS://B.DEV/2', ['https://a.dev/1', 'HTTPS://B.DEV/2']],
  ['| a | https://a.dev/t |', ['https://a.dev/t']],
  ['javascript:alert(1) file:///etc/passwd ftp://x.dev mailto:a@b.c', []],
  ['xhttp://a.dev http:// https://?q', []],
];

describe('findUrls (TER-1089)', () => {
  it.each(CASES)('%s', (text, expected) => {
    expect(urls(text)).toEqual(expected);
  });

  it('splits the text into pieces that add up to it', () => {
    const text = 'abre (https://a.dev/x) agora.';
    const pieces = splitUrls(text);
    expect(pieces.map((p) => p.text).join('')).toBe(text);
    expect(pieces.filter((p) => p.url).map((p) => p.url)).toEqual(['https://a.dev/x']);
    expect(splitUrls('sem link')).toEqual([{ text: 'sem link' }]);
  });
});

describe('links in an answer (TER-1089)', () => {
  const links = (md: string) => {
    const doc = new DOMParser().parseFromString(toHtml(md, null), 'text/html');
    return Array.from(doc.querySelectorAll('a')).map((a) => ({ href: a.getAttribute('href'), target: a.getAttribute('target'), rel: a.getAttribute('rel'), text: a.textContent }));
  };

  it('links a bare URL with an IP and port, without the final full stop, in a new tab', () => {
    expect(links('A imagem: http://192.168.68.114:8765/termhub-linkedin-final.png.')).toEqual([
      { href: 'http://192.168.68.114:8765/termhub-linkedin-final.png', target: '_blank', rel: 'noopener noreferrer', text: 'http://192.168.68.114:8765/termhub-linkedin-final.png' },
    ]);
  });

  it('keeps a Markdown link and leaves out the parenthesis around a bare one', () => {
    expect(links('[login](https://claude.com/cai/oauth/authorize?a=1&b=2) (ou https://termhub.dev/x)')).toEqual([
      { href: 'https://claude.com/cai/oauth/authorize?a=1&b=2', target: '_blank', rel: 'noopener noreferrer', text: 'login' },
      { href: 'https://termhub.dev/x', target: '_blank', rel: 'noopener noreferrer', text: 'https://termhub.dev/x' },
    ]);
  });

  it('links URLs in lists and tables', () => {
    expect(links('- https://a.dev/1\n\n| x |\n|---|\n| https://a.dev/2 |').map((l) => l.href)).toEqual(['https://a.dev/1', 'https://a.dev/2']);
  });

  it('never links a URL in code, and keeps the copy button', () => {
    const html = toHtml('`https://a.dev/1`\n\n```\ncurl https://a.dev/2\n```', null);
    expect(html).not.toContain('<a');
    expect(html).toContain('data-copy');
  });

  it('leaves a Markdown path link in the app', () => {
    expect(links('Veja docs/a.md')).toEqual([expect.objectContaining({ target: null })]);
  });

  it('touches only http(s) links', () => {
    expect(openLinksInNewTab('<a href="/projects/x">a</a>')).toBe('<a href="/projects/x">a</a>');
    expect(openLinksInNewTab('<p>sem link</p>')).toBe('<p>sem link</p>');
  });
});
