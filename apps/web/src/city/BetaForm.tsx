import { useState, type FormEvent } from 'react';
import { currentLocale, tk, useTranslation } from '../i18n';

/**
 * The beta sign-up, on the street. It is the landing's waitlist form (apps/landing/src/WaitlistForm.tsx)
 * written again for this bundle, which may import neither the landing nor the app: the same fields,
 * the same checks before sending and the same answers after, laid out small enough to sit over the
 * city. It posts to the same route, `POST /api/waitlist` (apps/server/src/routes/waitlist.ts), which
 * is public and answers on this origin too.
 */

type Field = 'first_name' | 'last_name' | 'email' | 'phone_country' | 'phone_area' | 'phone_number' | 'linkedin' | 'github';

type State =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'done'; already: boolean }
  /** `fields` are the inputs the server pointed at; an error with none of them is the generic one */
  | { kind: 'error'; fields: Partial<Record<Field, string>> };

const onlyDigits = (s: string) => s.replace(/\D+/g, '');

/** Basic shape, mirroring the server's `.email()` guard that runs before the Gmail rule. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Cloudflare Access signs people in with Google, so only Gmail addresses can be invited. */
const GMAIL_RE = /^[^@\s]+@gmail\.com$/i;

const GMAIL_ONLY = tk('Use um endereço @gmail.com (o acesso é pelo login do Google).');
const CHECK_FIELD = tk('Confira este campo.');
const GENERIC = tk('Não foi possível enviar agora. Tente de novo em instantes.');
const FIELDS: readonly Field[] = ['first_name', 'last_name', 'email', 'phone_country', 'phone_area', 'phone_number', 'linkedin', 'github'];

/** What a failed answer says about the inputs: the two e-mail codes, or zod's issues pointing at fields. */
function fieldErrors(status: number, data: { code?: string; issues?: Array<{ path?: unknown[] }> }): Partial<Record<Field, string>> {
  if (status !== 400) return {};
  if (data.code === 'gmail_only' || data.code === 'invalid_email') return { email: GMAIL_ONLY };
  const out: Partial<Record<Field, string>> = {};
  for (const issue of data.issues ?? []) {
    const field = issue.path?.[0];
    if (typeof field === 'string' && (FIELDS as readonly string[]).includes(field)) out[field as Field] = field === 'email' ? GMAIL_ONLY : CHECK_FIELD;
  }
  // the route also refuses an unreadable LinkedIn/GitHub handle with a bare VALIDATION and no issues
  return out;
}

export function BetaForm() {
  const { t } = useTranslation();
  const [first, setFirst] = useState('');
  const [last, setLast] = useState('');
  const [email, setEmail] = useState('');
  const [emailTouched, setEmailTouched] = useState(false);
  const [ddi, setDdi] = useState('55');
  const [ddd, setDdd] = useState('');
  const [number, setNumber] = useState('');
  const [linkedin, setLinkedin] = useState('');
  const [github, setGithub] = useState('');
  const [website, setWebsite] = useState(''); // honeypot
  const [state, setState] = useState<State>({ kind: 'idle' });

  const emailOk = EMAIL_RE.test(email.trim()) && GMAIL_RE.test(email.trim());
  const errors = state.kind === 'error' ? state.fields : {};
  // the address is checked as soon as the person leaves the field, before the server is ever asked
  const emailError = errors.email ?? (emailTouched && email.trim() !== '' && !emailOk ? GMAIL_ONLY : undefined);
  const generic = state.kind === 'error' && Object.keys(state.fields).length === 0;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setState({ kind: 'sending' });
    try {
      const res = await fetch('/api/waitlist', {
        method: 'POST',
        // a public form: nothing of a visitor who happens to have a session goes with it
        credentials: 'omit',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          first_name: first,
          last_name: last,
          email,
          phone_country: ddi,
          phone_area: ddd,
          phone_number: number,
          linkedin: linkedin || null,
          github: github || null,
          // the e-mails that follow go out in the language the visitor is reading
          locale: currentLocale() === 'pt-BR' ? 'pt' : currentLocale(),
          website,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; already?: boolean; code?: string; issues?: Array<{ path?: unknown[] }> };
      if (!res.ok || !data.ok) {
        setState({ kind: 'error', fields: fieldErrors(res.status, data) });
        return;
      }
      setState({ kind: 'done', already: !!data.already });
    } catch {
      setState({ kind: 'error', fields: {} });
    }
  };

  if (state.kind === 'done') {
    return (
      <div className="rounded-md border border-accent/40 bg-bg-3 p-3 text-sm" role="status">
        <p className="font-medium text-fg">
          <span className="mr-1.5 text-accent" aria-hidden="true">
            ✓
          </span>
          {state.already ? t('Este e-mail já está inscrito no beta.') : t('Inscrição recebida!')}
        </p>
        {!state.already && <p className="mt-1 text-xs text-fg-muted">{t('Avisamos por e-mail quando o seu acesso ao beta sair.')}</p>}
      </div>
    );
  }

  const sending = state.kind === 'sending';
  const field = (bad: boolean) =>
    `w-full min-w-0 rounded-md border bg-bg px-2 py-1.5 text-sm text-fg placeholder:text-fg-dim focus:outline-none focus:ring-1 ${
      bad ? 'border-danger focus:ring-danger' : 'border-line focus:border-accent focus:ring-accent'
    }`;
  const label = 'mb-0.5 block text-[11px] font-medium uppercase tracking-wide text-fg-muted';
  /** `text` is one of the keys above (GMAIL_ONLY, CHECK_FIELD), translated here, where it is shown */
  const hint = (id: string, text: string | undefined) =>
    text ? (
      <p id={id} role="alert" className="mt-0.5 text-[11px] text-danger">
        {t(text)}
      </p>
    ) : null;

  return (
    <form onSubmit={submit} className="relative space-y-2" noValidate>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className={label} htmlFor="beta-first">
            {t('Nome')}
          </label>
          <input id="beta-first" className={field(!!errors.first_name)} aria-invalid={!!errors.first_name} value={first} onChange={(e) => setFirst(e.target.value)} required maxLength={80} autoComplete="given-name" />
        </div>
        <div>
          <label className={label} htmlFor="beta-last">
            {t('Sobrenome')}
          </label>
          <input id="beta-last" className={field(!!errors.last_name)} aria-invalid={!!errors.last_name} value={last} onChange={(e) => setLast(e.target.value)} required maxLength={80} autoComplete="family-name" />
        </div>
      </div>
      <div>
        <label className={label} htmlFor="beta-email">
          {t('E-mail (Gmail)')}
        </label>
        <input
          id="beta-email"
          className={field(!!emailError)}
          type="email"
          inputMode="email"
          placeholder={t('voce@gmail.com')}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onBlur={() => setEmailTouched(true)}
          aria-invalid={!!emailError}
          aria-describedby={emailError ? 'beta-email-error' : undefined}
          required
          maxLength={200}
          autoComplete="email"
        />
        {hint('beta-email-error', emailError)}
      </div>
      <div>
        <span className={label}>{t('Telefone')}</span>
        <div className="grid grid-cols-[3.5rem_3.5rem_1fr] gap-2">
          <div className="relative">
            <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-sm text-fg-dim">+</span>
            <input className={`${field(!!errors.phone_country)} pl-4`} inputMode="numeric" placeholder={t('DDI')} aria-label={t('DDI')} aria-invalid={!!errors.phone_country} value={ddi} onChange={(e) => setDdi(onlyDigits(e.target.value).slice(0, 4))} required autoComplete="tel-country-code" />
          </div>
          <input className={field(!!errors.phone_area)} inputMode="numeric" placeholder={t('DDD')} aria-label={t('DDD')} aria-invalid={!!errors.phone_area} value={ddd} onChange={(e) => setDdd(onlyDigits(e.target.value).slice(0, 5))} required autoComplete="tel-area-code" />
          <input className={field(!!errors.phone_number)} inputMode="numeric" placeholder={t('número')} aria-label={t('número')} aria-invalid={!!errors.phone_number} value={number} onChange={(e) => setNumber(onlyDigits(e.target.value).slice(0, 12))} required autoComplete="tel-local" />
        </div>
        {hint('beta-phone-error', errors.phone_country ?? errors.phone_area ?? errors.phone_number)}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className={label} htmlFor="beta-linkedin">
            {t('LinkedIn (opcional)')}
          </label>
          <input id="beta-linkedin" className={field(!!errors.linkedin)} aria-invalid={!!errors.linkedin} value={linkedin} onChange={(e) => setLinkedin(e.target.value)} placeholder={t('usuário ou URL')} maxLength={200} />
        </div>
        <div>
          <label className={label} htmlFor="beta-github">
            {t('GitHub (opcional)')}
          </label>
          <input id="beta-github" className={field(!!errors.github)} aria-invalid={!!errors.github} value={github} onChange={(e) => setGithub(e.target.value)} placeholder={t('usuário ou URL')} maxLength={200} />
        </div>
      </div>
      {/* honeypot: hidden from people, filled by bots */}
      <div className="absolute -left-[9999px] top-auto h-px w-px overflow-hidden" aria-hidden="true">
        <input tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} name="website" />
      </div>
      {generic && (
        <p role="alert" className="text-xs text-danger">
          {t(GENERIC)}
        </p>
      )}
      <button
        type="submit"
        className="w-full rounded-md bg-accent px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-accent"
        disabled={sending || !first.trim() || !last.trim() || !emailOk || !ddi || !ddd || number.length < 6}
      >
        {sending ? t('Enviando…') : t('Entrar no beta gratuito')}
      </button>
      <p className="text-[11px] text-fg-dim">{t('Usamos seus dados só para o acesso ao beta do termhub.')}</p>
    </form>
  );
}
