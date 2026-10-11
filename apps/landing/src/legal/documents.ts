/**
 * The legal documents published on termhub.dev and where each one stands. The text lives in
 * apps/landing/legal/*.md; this file says whether it is in force.
 *
 * - `draft`: the page shows a "Rascunho" banner and the HTML entry carries `noindex` (render.test.ts
 *   holds the two together). Nothing in it is in force.
 * - `published`: the text was approved (lawyer + Pedro). Add the version to `history`, newest first.
 *   See apps/landing/legal/README.md for the release steps.
 */

export type LegalSlug = 'termos' | 'privacidade';

export interface LegalVersion {
  /** "1", "1.1"… as printed in the document's "Versão" line */
  version: string;
  /** ISO date the version took effect */
  date: string;
  /** what changed, in pt-BR (the documents are written in Portuguese only) */
  summary: string;
}

export interface LegalDoc {
  path: `/${LegalSlug}/`;
  /** the HTML entry of the page, relative to apps/landing */
  entry: string;
  /** the Markdown source, relative to apps/landing */
  source: string;
  status: 'draft' | 'published';
  history: LegalVersion[];
}

export const LEGAL_DOCS: Record<LegalSlug, LegalDoc> = {
  termos: { path: '/termos/', entry: 'termos/index.html', source: 'legal/termos-de-uso.md', status: 'draft', history: [] },
  privacidade: { path: '/privacidade/', entry: 'privacidade/index.html', source: 'legal/politica-de-privacidade.md', status: 'draft', history: [] },
};
