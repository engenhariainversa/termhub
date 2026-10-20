import { Marked, type Token, type Tokens } from 'marked';

/**
 * Turns one of the documents in apps/landing/legal/ into the HTML of its page, at build time (the
 * Vite plugin in vite.config.ts calls this; nothing here ships to the browser).
 *
 * The files are kept as the lawyer reviews them, so what only makes sense in review is dropped here:
 * the "RASCUNHO PARA REVISÃO JURÍDICA" header (the page shows its own draft banner) and the
 * `> Nota:` blocks, which the drafts themselves say leave the published version. Links between the
 * two documents point at their pages; links to the other review files (comparativo.md,
 * duvidas-advogado.md) are not public and become plain text.
 */

export interface RenderedLegal {
  /** text of the document's `# ` heading, which the page shows in its own header */
  title: string;
  html: string;
}

/** Each document's file name → its public page. */
export const LEGAL_PAGES: Record<string, string> = {
  'termos-de-uso.md': '/termos/',
  'politica-de-privacidade.md': '/privacidade/',
};

const REVIEW_ONLY = /^\s*(Nota:|\*\*RASCUNHO PARA REVISÃO)/;

const isReviewOnly = (t: Token) => t.type === 'blockquote' && REVIEW_ONLY.test((t as Tokens.Blockquote).text);

/** "3.1 Conta e autenticação" → "3-1-conta-e-autenticacao": stable anchors for linking a section. */
export function slugify(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function renderLegal(markdown: string): RenderedLegal {
  const marked = new Marked({
    gfm: true,
    // the drafts put one line per field ("**Versão:** …" then "**Vigência:** …"): keep them apart
    breaks: true,
    renderer: {
      heading({ tokens, depth }) {
        const inner = this.parser.parseInline(tokens);
        return `<h${depth} id="${slugify(inner)}">${inner}</h${depth}>\n`;
      },
      link({ href, title, tokens }) {
        const inner = this.parser.parseInline(tokens);
        if (/^(https?:|mailto:|#)/.test(href)) {
          return `<a href="${href}"${title ? ` title="${title}"` : ''}>${inner}</a>`;
        }
        const page = LEGAL_PAGES[href.split('#')[0]];
        return page ? `<a href="${page}">${inner}</a>` : inner;
      },
    },
  });

  const tokens = marked.lexer(markdown);
  const h1 = tokens.findIndex((t) => t.type === 'heading' && (t as Tokens.Heading).depth === 1);
  const title = h1 >= 0 ? (tokens[h1] as Tokens.Heading).text : '';
  const kept = tokens.filter((t, i) => i !== h1 && !isReviewOnly(t));
  // `links` carries reference-style link definitions; filter() drops it, so put it back
  const body = Object.assign(kept, { links: tokens.links });
  // wide tables scroll on their own instead of widening the page on phones
  const html = marked
    .parser(body)
    .replace(/<table>/g, '<div class="legal-table"><table>')
    .replace(/<\/table>/g, '</table></div>');
  return { title, html };
}
