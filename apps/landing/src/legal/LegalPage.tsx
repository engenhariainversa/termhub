import { useLang, type Dict } from '../i18n';
import { Site, SiteFooter, SiteHeader } from '../Site';
import { LEGAL_DOCS, type LegalSlug } from './documents';
import type { RenderedLegal } from './render';

/**
 * /termos/ and /privacidade/: one legal document, rendered at build time from apps/landing/legal/
 * (see render.ts). The text is Portuguese only; the language switch changes the page chrome and
 * says so. A draft carries a banner that it is not in force.
 */

const OTHER: Record<LegalSlug, LegalSlug> = { termos: 'privacidade', privacidade: 'termos' };

function formatDate(iso: string, lang: 'pt' | 'en') {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString(lang === 'pt' ? 'pt-BR' : 'en-US', { day: 'numeric', month: 'long', year: 'numeric' });
}

function Page({ slug, doc }: { slug: LegalSlug; doc: RenderedLegal }) {
  const { t, lang } = useLang();
  const l = t.legal;
  const meta = LEGAL_DOCS[slug];
  const other = OTHER[slug];
  return (
    <div className="min-h-full">
      <SiteHeader
        nav={
          <>
            <a href="/" className="nav-link">
              ‹ {l.back}
            </a>
            <a href={LEGAL_DOCS[other].path} className="nav-link">
              {l[other].nav}
            </a>
          </>
        }
      />

      <main className="mx-auto max-w-page px-4 pb-20 md:px-6">
        {/* running text: the article keeps a readable line length */}
        <article className="mx-auto max-w-3xl pt-14 md:pt-20">
          {meta.status === 'draft' && (
            <div role="note" className="mb-8 rounded-card border border-amber-400/40 bg-amber-400/10 p-5">
              <p className="text-caption font-semibold uppercase tracking-wide text-amber-300">{l.draft_badge}</p>
              <p className="mt-1 text-body text-white">{l.draft_title}</p>
              <p className="mt-1 text-body-sm text-frost">{l.draft_text}</p>
            </div>
          )}
          <h1 className="text-heading-lg [text-wrap:balance] md:text-display">{doc.title}</h1>
          {lang !== 'pt' && <p className="mt-3 text-body-sm text-muted">{l.pt_only}</p>}

          <div className="legal-doc mt-10" lang="pt-BR" dangerouslySetInnerHTML={{ __html: doc.html }} />

          <section id="historico" className="mt-16 border-t border-border-2 pt-10">
            <h2 className="text-heading-sm">{l.history_title}</h2>
            {meta.history.length === 0 ? (
              <p className="mt-3 text-body-sm text-frost">{l.history_empty}</p>
            ) : (
              <ol className="mt-4 space-y-3 text-body-sm">
                {meta.history.map((v) => (
                  <li key={v.version} className="flex flex-col gap-0.5 md:flex-row md:gap-4">
                    <span className="shrink-0 font-medium text-white md:w-48">
                      {l.version} {v.version} · {formatDate(v.date, lang)}
                    </span>
                    <span className="text-frost" lang="pt-BR">
                      {v.summary}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </article>
      </main>

      <SiteFooter />
    </div>
  );
}

export function LegalPage({ slug, doc }: { slug: LegalSlug; doc: RenderedLegal }) {
  const meta = (t: Dict) => t.legal[slug].meta;
  return (
    <Site meta={meta}>
      <Page slug={slug} doc={doc} />
    </Site>
  );
}
