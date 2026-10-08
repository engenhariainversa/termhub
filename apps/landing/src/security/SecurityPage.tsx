import type { ReactNode } from 'react';
import { useLang, type Dict } from '../i18n';
import { Chevron, REPO_URL, Site, SiteFooter, SiteHeader, trackCta } from '../Site';
import { useReveal } from '../useReveal';

/**
 * /security/ — termhub's security posture as a feature, for IT teams asked to allow it on a
 * corporate network. The technical source of truth is docs/security-and-network.md: every claim on
 * this page must be backed there (and by the code), and what does not exist yet goes under
 * "limits", never among the highlights.
 */

export const SECURITY_DOC_URL = `${REPO_URL}/blob/main/docs/security-and-network.md`;

/** Commands the IT checklist asks the person to run on the machine; not translated. */
const TEST_COMMANDS = [
  'npm i -g @termhub/agent',
  'termhub-agent connect --url https://app.termhub.dev --token <token>',
  'termhub-agent doctor',
  'termhub-agent status',
];

const HIGHLIGHT_ICONS = ['↗', '⊘', '≡', '✓', '⏻', '#', '◉', '▯', '⌁'];

/** Tiles fade up in sequence, capped so the last one never feels late. */
const revealDelay = (index: number) => ({ transitionDelay: `${Math.min(index * 60, 300)}ms` });

function Tile({ icon, title, text, index }: { icon: string; title: string; text: string; index: number }) {
  const ref = useReveal<HTMLLIElement>();
  return (
    <li ref={ref} style={revealDelay(index)} className="reveal rounded-card border border-border-2 bg-surface p-5 hover:border-border/40">
      <span aria-hidden="true" className="mb-3 inline-flex h-9 w-9 items-center justify-center rounded-field bg-border-2 font-mono text-body-sm text-accent">
        {icon}
      </span>
      <h3 className="text-body">{title}</h3>
      <p className="mt-1.5 text-body-sm text-frost">{text}</p>
    </li>
  );
}

function Section({ id, title, lead, children }: { id?: string; title: string; lead?: string; children: ReactNode }) {
  const ref = useReveal<HTMLElement>();
  return (
    <section id={id} ref={ref} className="reveal scroll-mt-20 border-t border-border-2 py-16">
      <h2 className="text-heading-sm md:text-heading-lg">{title}</h2>
      {lead && <p className="mt-3 max-w-2xl text-body text-frost">{lead}</p>}
      <div className="mt-8">{children}</div>
    </section>
  );
}

/** A two- or three-column table; cells wrap on phones (the mono first column breaks long hosts). */
function Table({ head, rows }: { head: string[]; rows: string[][] }) {
  return (
    <div className="overflow-x-auto rounded-card border border-border-2">
      <table className="w-full text-left text-body-sm">
        <thead className="bg-surface text-caption uppercase tracking-wide text-muted">
          <tr>
            {head.map((h) => (
              <th key={h} scope="col" className="px-4 py-3 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row[0]} className="border-t border-border-2">
              {row.map((cell, i) => (
                <td key={i} className={`px-3 py-3 align-top md:px-4 ${i === 0 ? 'w-2/5 break-words font-mono text-white' : 'text-frost'}`}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Bullets({ items, mark = '›' }: { items: string[]; mark?: string }) {
  return (
    <ul className="space-y-2.5 text-body-sm">
      {items.map((item) => (
        <li key={item} className="flex gap-2.5">
          <span aria-hidden="true" className="text-accent">
            {mark}
          </span>
          <span className="text-frost">{item}</span>
        </li>
      ))}
    </ul>
  );
}

function Page() {
  const { t } = useLang();
  const s = t.security;
  return (
    <div className="min-h-full">
      <SiteHeader
        nav={
          <>
            <a href="/" className="nav-link">
              ‹ {s.back}
            </a>
            <a href="#destaques" className="nav-link">{s.nav.highlights}</a>
            <a href="#arquitetura" className="nav-link">{s.nav.how}</a>
            <a href="#dominios" className="nav-link">{s.nav.domains}</a>
            <a href="#checklist" className="nav-link hidden lg:inline-flex">{s.nav.checklist}</a>
          </>
        }
      />

      <main className="mx-auto max-w-page px-4 md:px-6">
        {/* hero */}
        <section className="pb-16 pt-14 md:pt-20">
          <p className="mb-4 inline-flex items-center gap-2 rounded-field border border-border-2 bg-canvas px-3 py-1 text-caption text-frost">
            <span className="h-1.5 w-1.5 rounded-full bg-accent" /> {s.badge}
          </p>
          <h1 className="max-w-3xl text-heading-lg [text-wrap:balance] md:text-display">
            {s.title_a}
            <span className="text-accent">{s.title_b}</span>.
          </h1>
          <p className="mt-5 max-w-2xl text-subheading text-frost">{s.lead}</p>
          <div className="mt-7 flex flex-wrap gap-3">
            <a href={SECURITY_DOC_URL} className="btn-primary" onClick={trackCta('security_doc', 'security_hero')}>
              {s.cta_doc} <Chevron />
            </a>
            <a href="/#cloud" className="btn-ghost" onClick={trackCta('waitlist', 'security_hero')}>
              {s.cta_cloud}
            </a>
          </div>
        </section>

        <Section id="destaques" title={s.highlights.title} lead={s.highlights.lead}>
          <ul className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {s.highlights.items.map((h, i) => (
              <Tile key={h.title} icon={HIGHLIGHT_ICONS[i]} title={h.title} text={h.text} index={i} />
            ))}
          </ul>
        </Section>

        <Section id="arquitetura" title={s.how.title} lead={s.how.lead}>
          <ol className="grid gap-5 md:grid-cols-3">
            {s.how.nodes.map((n, i) => (
              <li key={n.name} className="relative rounded-card border border-border-2 bg-surface p-5">
                <p className="text-caption uppercase tracking-wide text-muted">{i + 1}</p>
                <h3 className="mt-1 text-body">{n.name}</h3>
                <p className="mt-1 break-all font-mono text-caption text-accent">{n.host}</p>
                <p className="mt-3 text-body-sm text-frost">{n.text}</p>
              </li>
            ))}
          </ol>
          <p className="mt-5 max-w-3xl text-body-sm text-frost">{s.how.note}</p>
        </Section>

        <Section title={s.ports.title}>
          <Table head={s.ports.head} rows={s.ports.rows.map((r) => [r.where, r.inbound, r.outbound])} />
          <div className="mt-6">
            <Bullets items={s.ports.notes} />
          </div>
        </Section>

        <Section id="dominios" title={s.domains.title} lead={s.domains.lead}>
          <h3 className="mb-3 text-body">{s.domains.required_label}</h3>
          <Table head={s.domains.head} rows={s.domains.required.map((d) => [d.host, d.why])} />
          <h3 className="mb-3 mt-8 text-body">{s.domains.optional_label}</h3>
          <Table head={s.domains.head} rows={s.domains.optional.map((d) => [d.host, d.why])} />
        </Section>

        <Section title={s.agent.title}>
          <Bullets items={s.agent.items} />
        </Section>

        <Section id="checklist" title={s.checklist.title}>
          <div className="grid gap-8 md:grid-cols-2">
            <ol className="min-w-0 space-y-3 text-body-sm">
              {s.checklist.items.map((item, i) => (
                <li key={item} className="flex gap-3">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-border-2 text-caption font-medium text-accent">{i + 1}</span>
                  <span className="text-frost">{item}</span>
                </li>
              ))}
            </ol>
            {/* min-w-0: the command block scrolls on its own instead of widening the page on phones */}
            <div className="min-w-0">
              <p className="mb-2 text-caption uppercase tracking-wide text-muted">{s.checklist.test_label}</p>
              <pre className="overflow-x-auto rounded-card border border-border-2 bg-canvas p-4 font-mono text-caption leading-relaxed text-frost">
                {TEST_COMMANDS.map((c) => `$ ${c}`).join('\n')}
              </pre>
              <p className="mt-3 text-body-sm text-frost">{s.checklist.test_hint}</p>
            </div>
          </div>
        </Section>

        <Section title={s.limits.title} lead={s.limits.lead}>
          <Bullets items={s.limits.items} mark="○" />
        </Section>

        <section className="pb-20 pt-4">
          <div className="flex flex-col gap-5 rounded-card border border-border-2 bg-surface p-7 md:flex-row md:items-center md:p-9">
            <div>
              <h2 className="text-heading-sm">{s.cta.title}</h2>
              <p className="mt-1 max-w-2xl text-body text-frost">{s.cta.lead}</p>
            </div>
            <div className="flex flex-wrap gap-3 md:ml-auto md:shrink-0">
              <a href={SECURITY_DOC_URL} className="btn-primary" onClick={trackCta('security_doc', 'security_cta')}>
                {s.cta_doc}
              </a>
              <a href="/#cloud" className="btn-ghost" onClick={trackCta('waitlist', 'security_cta')}>
                {s.cta_cloud}
              </a>
            </div>
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}

const meta = (t: Dict) => t.security.meta;

export function SecurityPage() {
  return (
    <Site meta={meta}>
      <Page />
    </Site>
  );
}
