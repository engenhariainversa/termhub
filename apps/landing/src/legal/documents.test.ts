import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LEGAL_DOCS } from './documents';

const read = (file: string) => readFileSync(fileURLToPath(new URL(`../../${file}`, import.meta.url)), 'utf8');

// The status in documents.ts drives the banner; the HTML entry and the sitemap are static files that
// must follow it by hand. These tests keep a draft out of search engines and a published text in.
describe.each(Object.entries(LEGAL_DOCS))('%s', (slug, doc) => {
  it('has its source, its entry and a Vite input', () => {
    expect(existsSync(fileURLToPath(new URL(`../../${doc.source}`, import.meta.url)))).toBe(true);
    expect(read(doc.entry)).toContain(`/src/legal/${slug}.tsx`);
    expect(read('vite.config.ts')).toContain(`'${doc.entry}'`);
  });

  it('is indexed and in the sitemap only once published', () => {
    const html = read(doc.entry);
    const sitemap = read('public/sitemap.xml');
    if (doc.status === 'draft') {
      expect(html).toMatch(/<meta name="robots" content="noindex/);
      expect(sitemap).not.toContain(`https://termhub.dev${doc.path}`);
    } else {
      expect(html).not.toContain('noindex');
      expect(sitemap).toContain(`https://termhub.dev${doc.path}`);
      expect(doc.history.length).toBeGreaterThan(0);
    }
  });
});
