import { findUrls, isWebUrl, splitUrls } from './links';

const urls = (text: string) => findUrls(text).map((m) => m.url);

// The same table as the web's (`apps/web/src/lib/links.test.ts`).
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

  it('lets only http(s) leave the app', () => {
    expect(isWebUrl('https://a.dev')).toBe(true);
    expect(isWebUrl('HTTP://a.dev')).toBe(true);
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'intent://x', 'mailto:a@b.c', 'termhub-file:a.md']) expect(isWebUrl(url)).toBe(false);
  });
});
