import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderLegal, slugify } from './render';

const read = (file: string) => readFileSync(fileURLToPath(new URL(`../../legal/${file}`, import.meta.url)), 'utf8');

describe('renderLegal', () => {
  it('takes the title out of the body', () => {
    const out = renderLegal('# Termos de Uso\n\nTexto.\n');
    expect(out.title).toBe('Termos de Uso');
    expect(out.html).not.toContain('<h1');
    expect(out.html).toContain('<p>Texto.</p>');
  });

  it('drops the review header and the review notes, and keeps ordinary quotes', () => {
    const md = [
      '# T',
      '> **RASCUNHO PARA REVISÃO JURÍDICA (TER-702). Não publicar.**',
      '> Ver [`duvidas-advogado.md`](duvidas-advogado.md).',
      '',
      'Antes.',
      '',
      '> Nota: só para o advogado.',
      '',
      '> Uma citação de verdade.',
      '',
      'Depois.',
    ].join('\n');
    const { html } = renderLegal(md);
    expect(html).not.toMatch(/RASCUNHO|Nota:|advogado|duvidas-advogado/);
    expect(html).toContain('Uma citação de verdade.');
    expect(html).toContain('Antes.');
    expect(html).toContain('Depois.');
  });

  it('points links between the documents at their pages and unlinks the review files', () => {
    const { html } = renderLegal('# T\n\nA [Política](politica-de-privacidade.md), os [Termos](termos-de-uso.md#2-aceite), o [estudo](comparativo.md) e o [site](https://termhub.dev/).\n');
    expect(html).toContain('<a href="/privacidade/">Política</a>');
    expect(html).toContain('<a href="/termos/">Termos</a>');
    expect(html).toContain('o estudo e');
    expect(html).toContain('<a href="https://termhub.dev/">site</a>');
    expect(html).not.toContain('.md');
  });

  it('keeps single line breaks, as in the Versão / Vigência lines', () => {
    const { html } = renderLegal('# T\n\n**Versão:** 1\n**Vigência:** hoje\n');
    expect(html).toContain('<strong>Versão:</strong> 1<br><strong>Vigência:</strong> hoje');
  });

  it('anchors headings and wraps tables so they scroll on their own', () => {
    const { html } = renderLegal('# T\n\n### 3.1 Conta e autenticação\n\n| Dado | Para quê |\n|---|---|\n| E-mail | login |\n');
    expect(html).toContain('<h3 id="3-1-conta-e-autenticacao">3.1 Conta e autenticação</h3>');
    expect(html).toMatch(/<div class="legal-table"><table>[\s\S]*<\/table><\/div>/);
  });

  it.each(['termos-de-uso.md', 'politica-de-privacidade.md'])('renders %s without review material or links to private files', (file) => {
    const { title, html } = renderLegal(read(file));
    expect(title).toMatch(/termhub/);
    expect(html).not.toMatch(/Nota:|RASCUNHO PARA REVISÃO|Não publicar/);
    expect(html).not.toMatch(/href="[^"]*\.md/);
    expect(html).toMatch(/<h2 id="1-/);
  });
});

describe('slugify', () => {
  it('strips accents, markup and punctuation', () => {
    expect(slugify('2. Quem é o <em>controlador</em>?')).toBe('2-quem-e-o-controlador');
  });
});
