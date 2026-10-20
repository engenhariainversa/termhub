// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { codeLanguage, decorateCodeBlocks } from './code-blocks';

function parse(html: string): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = html;
  return el;
}

describe('codeLanguage', () => {
  it('reads the language out of a language-* class', () => {
    expect(codeLanguage('language-bash')).toBe('bash');
  });

  it('returns null when there is no class to read', () => {
    expect(codeLanguage(null)).toBeNull();
  });

  it('keeps only [a-z0-9+#-]{1,20} (case-insensitive) and drops anything else the model wrote', () => {
    // The class comes straight from the model's fence info string, after the sanitiser has already
    // run — this is the one place that text could still reach the DOM unescaped.
    expect(codeLanguage('language-<img src=x onerror=alert(1)>')).toBeNull();
    expect(codeLanguage('language-C++')).toBe('C++');
    expect(codeLanguage('language-TypeScript')).toBe('TypeScript');
  });
});

describe('decorateCodeBlocks', () => {
  it('gives a fence with class="language-bash" a header reading "bash", and keeps the <pre> content unchanged', () => {
    const el = parse(decorateCodeBlocks('<pre><code class="language-bash">npm test</code></pre>'));
    const figure = el.querySelector('figure');
    expect(figure).not.toBeNull();
    expect(figure?.querySelector('[data-code-language]')?.textContent).toBe('bash');
    expect(figure?.querySelector('pre > code')?.textContent).toBe('npm test');
  });

  it('builds the block with its own empty live region, so a copy can be announced into it later', () => {
    // Mounted with the block, not created when the copy happens: a live region a browser inserts
    // together with its text is not reliably announced. `ChatTurn` writes the outcome in here.
    const el = parse(decorateCodeBlocks('<pre><code class="language-bash">npm test</code></pre>'));
    const live = el.querySelector('[data-copy-live]');
    expect(live?.getAttribute('role')).toBe('status');
    expect(live?.textContent).toBe('');
  });

  it('puts a download button next to the copy one, named "Baixar como arquivo" (TER-1084)', () => {
    const el = parse(decorateCodeBlocks('<pre><code class="language-bash">npm test</code></pre>'));
    const download = el.querySelector('[data-download]');
    expect(download?.tagName).toBe('BUTTON');
    expect(download?.getAttribute('type')).toBe('button');
    expect(download?.getAttribute('aria-label')).toBe('Baixar como arquivo');
    expect(download?.parentElement).toBe(el.querySelector('[data-copy]')?.parentElement);
  });

  it('gives a fence with no language a header reading "código"', () => {
    const el = parse(decorateCodeBlocks('<pre><code>npm test</code></pre>'));
    expect(el.querySelector('[data-code-language]')?.textContent).toBe('código');
  });

  it('never lets the language class reach the DOM unsanitised: no img element, no onerror attribute anywhere', () => {
    // The class value itself, quoted inside the original <code>, is just a string to the parser — the
    // `<img>` inside it never becomes an element there. What this pins is that the *header this
    // function builds* never turns that string into markup either.
    const html = decorateCodeBlocks('<pre><code class="language-&lt;img src=x onerror=alert(1)&gt;">rm -rf /</code></pre>');
    const el = parse(html);
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelectorAll('[onerror]').length).toBe(0);
    // Falls back to the safe label rather than emitting any part of the untrusted class.
    expect(el.querySelector('[data-code-language]')?.textContent).toBe('código');
  });

  it('leaves a <pre> with no <code> child alone (not a fence)', () => {
    const input = '<pre>plain text, no fence</pre>';
    const html = decorateCodeBlocks(input);
    const el = parse(html);
    expect(el.querySelector('figure')).toBeNull();
    expect(el.querySelector('pre')?.textContent).toBe('plain text, no fence');
  });

  it('leaves prose without any <pre> unchanged', () => {
    const input = '<p>oi, <strong>tudo bem</strong>?</p>';
    expect(decorateCodeBlocks(input)).toBe(input);
  });

  it('is idempotent: decorating already-decorated HTML does not nest a second header', () => {
    const once = decorateCodeBlocks('<pre><code class="language-bash">npm test</code></pre>');
    const twice = decorateCodeBlocks(once);
    const el = parse(twice);
    expect(el.querySelectorAll('[data-code-language]').length).toBe(1);
    expect(el.querySelectorAll('figure').length).toBe(1);
    expect(el.querySelector('pre > code')?.textContent).toBe('npm test');
  });
});
