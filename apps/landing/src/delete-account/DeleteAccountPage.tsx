import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useLang, type Dict } from '../i18n';
import { Site, SiteFooter, SiteHeader } from '../Site';
import { useReveal } from '../useReveal';

/**
 * /excluir-conta/ — deleting a termhub account without the app (TER-728, a Google Play requirement).
 * The page asks the server to e-mail a confirmation link (POST /api/account/deletion/link) and,
 * when opened from that link (`?token=`), spends it (POST /api/account/deletion/confirm). The
 * landing host forwards both paths to the app (deploy/nginx/termhub.dev.conf.tmpl). What is
 * deleted, kept and when must match apps/server/src/account/deletion.ts.
 */

/** Basic shape, mirroring the server's `.email()` guard. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Desaturated red, for form semantics only — it is not part of the page palette. */
const FORM_RED = '#d98b8b';

type LinkState =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'sent' }
  | { kind: 'error'; reason: 'email' | 'rate_limited' | 'generic' };

type ConfirmState =
  | { kind: 'ask' }
  | { kind: 'sending' }
  | { kind: 'done'; scheduledAt: string }
  | { kind: 'invalid' }
  | { kind: 'error'; reason: 'last_admin' | 'rate_limited' | 'generic' };

/**
 * Reads the e-mailed token once and takes it out of the address bar right away, so it does not
 * linger in the history, in a shared screenshot or in a bookmark. Other query params stay.
 */
function useTokenFromUrl(): string | null {
  const [token] = useState(() => new URLSearchParams(window.location.search).get('token'));
  useEffect(() => {
    if (!token) return;
    const url = new URL(window.location.href);
    url.searchParams.delete('token');
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  }, [token]);
  return token;
}

async function postJson(path: string, body: unknown) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { res, data };
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

function Notice({ title, children, tone = 'ok' }: { title: string; children?: ReactNode; tone?: 'ok' | 'warn' }) {
  return (
    <div role="status" className={`rounded-card border bg-surface p-5 ${tone === 'ok' ? 'border-accent/40' : 'border-border-2'}`}>
      <p className="font-medium text-white">
        <span className="mr-2" aria-hidden="true" style={tone === 'warn' ? { color: FORM_RED } : undefined}>
          {tone === 'ok' ? <span className="text-accent">✓</span> : '!'}
        </span>
        {title}
      </p>
      {children}
    </div>
  );
}

/** Asks for the confirmation link. The answer is the same whether or not the address has an account. */
function LinkForm() {
  const { t } = useLang();
  const f = t.deleteAccount.form;
  const [email, setEmail] = useState('');
  const [touched, setTouched] = useState(false);
  const [website, setWebsite] = useState(''); // honeypot
  const [state, setState] = useState<LinkState>({ kind: 'idle' });

  const emailOk = EMAIL_RE.test(email.trim());
  const showEmailError = touched && email.trim() !== '' && !emailOk;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!emailOk) return;
    setState({ kind: 'sending' });
    try {
      const { res } = await postJson('/api/account/deletion/link', { email: email.trim(), website });
      if (res.ok) setState({ kind: 'sent' });
      else if (res.status === 429) setState({ kind: 'error', reason: 'rate_limited' });
      else if (res.status === 400) setState({ kind: 'error', reason: 'email' });
      else setState({ kind: 'error', reason: 'generic' });
    } catch {
      setState({ kind: 'error', reason: 'generic' });
    }
  };

  if (state.kind === 'sent') {
    return (
      <Notice title={f.sent_title}>
        <p className="mt-1 text-body-sm text-frost">{f.sent_text}</p>
        <button
          type="button"
          className="btn-ghost mt-4 px-4 py-1.5 text-body-sm"
          onClick={() => {
            setEmail('');
            setTouched(false);
            setState({ kind: 'idle' });
          }}
        >
          {f.again}
        </button>
      </Notice>
    );
  }

  const sending = state.kind === 'sending';
  const errorText = state.kind === 'error' ? (state.reason === 'email' ? f.email_invalid : state.reason === 'rate_limited' ? f.rate_limited : f.error) : null;

  return (
    <form onSubmit={submit} className="space-y-3" noValidate>
      <div>
        <label className="mb-1 block text-caption font-medium uppercase tracking-wide text-muted" htmlFor="da-email">
          {f.email}
        </label>
        <input
          id="da-email"
          className="field"
          type="email"
          inputMode="email"
          placeholder={f.email_placeholder}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onBlur={() => setTouched(true)}
          aria-invalid={showEmailError}
          aria-describedby={showEmailError ? 'da-email-error' : undefined}
          required
          maxLength={254}
          autoComplete="email"
        />
        {showEmailError && (
          <p id="da-email-error" role="alert" className="mt-1 text-caption" style={{ color: FORM_RED }}>
            {f.email_invalid}
          </p>
        )}
      </div>
      {/* honeypot: hidden from people, filled by bots */}
      <div className="absolute -left-[9999px] top-auto h-px w-px overflow-hidden" aria-hidden="true">
        <input tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} name="website" />
      </div>
      {errorText && (
        <p role="alert" className="text-body-sm" style={{ color: FORM_RED }}>
          {errorText}
        </p>
      )}
      <div className="pt-1">
        <button
          type="submit"
          className="btn-primary px-4 py-2 text-body-sm disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:brightness-100"
          disabled={sending || !emailOk}
        >
          {sending ? f.sending : f.submit}
        </button>
      </div>
    </form>
  );
}

/**
 * Spends the e-mailed token, but only on a click: mail scanners prefetch links, so opening the
 * page must never confirm anything by itself.
 */
function ConfirmStep({ token, onAbandon }: { token: string; onAbandon: () => void }) {
  const { t, lang } = useLang();
  const c = t.deleteAccount.confirm;
  const [state, setState] = useState<ConfirmState>({ kind: 'ask' });

  const confirm = async () => {
    setState({ kind: 'sending' });
    try {
      const { res, data } = await postJson('/api/account/deletion/confirm', { token });
      if (res.ok && typeof data.scheduled_at === 'string') setState({ kind: 'done', scheduledAt: data.scheduled_at });
      // a token of the wrong shape fails validation with a plain 400: the same dead link to the person
      else if (res.status === 400) setState({ kind: 'invalid' });
      else if (res.status === 409 && data.code === 'LAST_ADMIN') setState({ kind: 'error', reason: 'last_admin' });
      else if (res.status === 429) setState({ kind: 'error', reason: 'rate_limited' });
      else setState({ kind: 'error', reason: 'generic' });
    } catch {
      setState({ kind: 'error', reason: 'generic' });
    }
  };

  if (state.kind === 'done') {
    const date = new Date(state.scheduledAt).toLocaleDateString(lang === 'pt' ? 'pt-BR' : 'en-US', { day: 'numeric', month: 'long', year: 'numeric' });
    return (
      <Notice title={c.done_title}>
        <p className="mt-1 text-body-sm text-frost">{c.done_text(date)}</p>
        <p className="mt-2 text-body-sm text-frost">{c.done_email}</p>
      </Notice>
    );
  }

  if (state.kind === 'invalid') {
    return (
      <div className="space-y-6">
        <Notice title={c.invalid_title} tone="warn">
          <p className="mt-1 text-body-sm text-frost">{c.invalid_text}</p>
        </Notice>
        <LinkForm />
      </div>
    );
  }

  const sending = state.kind === 'sending';
  const errorText = state.kind === 'error' ? (state.reason === 'last_admin' ? c.last_admin : state.reason === 'rate_limited' ? c.rate_limited : c.error) : null;

  return (
    <div className="rounded-card border border-border-2 bg-surface p-6 md:p-7">
      <h2 className="text-heading-sm">{c.title}</h2>
      <p className="mt-2 text-body-sm text-frost">{c.lead}</p>
      {errorText && (
        <p role="alert" className="mt-4 text-body-sm" style={{ color: FORM_RED }}>
          {errorText}
        </p>
      )}
      <div className="mt-5 flex flex-wrap gap-3">
        <button
          type="button"
          className="btn-primary px-4 py-2 text-body-sm disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:brightness-100"
          onClick={confirm}
          disabled={sending}
        >
          {sending ? c.sending : c.submit}
        </button>
        <button type="button" className="btn-ghost px-4 py-2 text-body-sm" onClick={onAbandon} disabled={sending}>
          {c.cancel}
        </button>
      </div>
    </div>
  );
}

function Page() {
  const { t } = useLang();
  const d = t.deleteAccount;
  const urlToken = useTokenFromUrl();
  // "Não quero excluir" drops the token and goes back to the regular page
  const [token, setToken] = useState(urlToken);

  return (
    <div className="min-h-full">
      <SiteHeader
        nav={
          <>
            <a href="/" className="nav-link">
              ‹ {d.back}
            </a>
            <a href="#pedido" className="nav-link">{d.nav.form}</a>
            <a href="#dados" className="nav-link">{d.nav.data}</a>
            <a href="#prazos" className="nav-link">{d.nav.timeline}</a>
          </>
        }
      />

      <main className="mx-auto max-w-page px-4 md:px-6">
        <section id="pedido" className="scroll-mt-20 pb-16 pt-14 md:pt-20">
          <p className="mb-4 inline-flex items-center gap-2 rounded-field border border-border-2 bg-canvas px-3 py-1 text-caption text-frost">
            <span className="h-1.5 w-1.5 rounded-full bg-accent" /> {d.badge}
          </p>
          <h1 className="max-w-3xl text-heading-lg [text-wrap:balance] md:text-display">{d.title}</h1>
          <p className="mt-5 max-w-2xl text-subheading text-frost">{d.lead}</p>

          {token ? (
            <div className="mt-10 max-w-xl">
              <ConfirmStep token={token} onAbandon={() => setToken(null)} />
            </div>
          ) : (
            <div className="mt-10 grid gap-8 md:grid-cols-2">
              <div>
                <h2 className="text-heading-sm">{d.ways.title}</h2>
                <ol className="mt-5 space-y-4 text-body-sm">
                  {d.ways.items.map((w, i) => (
                    <li key={w.where} className="flex gap-3">
                      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-border-2 text-caption font-medium text-accent">{i + 1}</span>
                      <span>
                        <span className="block text-white">{w.where}</span>
                        <span className="text-frost">{w.how}</span>
                      </span>
                    </li>
                  ))}
                </ol>
              </div>
              <div className="min-w-0 rounded-card border border-border-2 bg-surface p-6 md:p-7">
                <h2 className="text-heading-sm">{d.form.title}</h2>
                <p className="mb-5 mt-2 text-body-sm text-frost">{d.form.lead}</p>
                <LinkForm />
              </div>
            </div>
          )}
        </section>

        <Section id="dados" title={d.deleted.title} lead={d.deleted.lead}>
          <Bullets items={d.deleted.items} />
        </Section>

        <Section title={d.kept.title}>
          <Bullets items={d.kept.items} mark="○" />
        </Section>

        <Section id="prazos" title={d.timeline.title}>
          <ol className="grid gap-5 md:grid-cols-3">
            {d.timeline.items.map((step, i) => (
              <li key={step.when} className="rounded-card border border-border-2 bg-surface p-5">
                <p className="text-caption uppercase tracking-wide text-muted">{i + 1}</p>
                <h3 className="mt-1 text-body">{step.when}</h3>
                <p className="mt-3 text-body-sm text-frost">{step.what}</p>
              </li>
            ))}
          </ol>
        </Section>
      </main>

      <SiteFooter />
    </div>
  );
}

const meta = (t: Dict) => t.deleteAccount.meta;

export function DeleteAccountPage() {
  return (
    <Site meta={meta}>
      <Page />
    </Site>
  );
}
