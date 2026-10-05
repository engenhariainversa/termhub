import { dirOf, fileLinkTarget, refusalText } from './refusals';

describe('file preview model', () => {
  it('says each refusal in Portuguese, and something generic for an unknown one', () => {
    expect(refusalText('outside')).toMatch(/fora das pastas/);
    expect(refusalText('too_large')).toMatch(/512 KB/);
    expect(refusalText('nova_razao')).toBe('Não foi possível abrir este arquivo.');
  });

  it('resolves relative links against the file folder and sends only http(s) to the browser', () => {
    expect(fileLinkTarget('../plans/x.md', dirOf('docs/superpowers/specs/a.md'))).toEqual({ kind: 'file', path: 'docs/superpowers/plans/x.md' });
    expect(fileLinkTarget('/tmp/a.md', 'docs')).toEqual({ kind: 'file', path: '/tmp/a.md' });
    expect(fileLinkTarget('https://termhub.dev', 'docs')).toEqual({ kind: 'web', url: 'https://termhub.dev' });
    for (const href of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', '//evil/a.md', '#t', './foto.png']) expect(fileLinkTarget(href, 'docs')).toBeNull();
  });
});
