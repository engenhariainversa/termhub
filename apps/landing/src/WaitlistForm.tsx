import { useState, type FormEvent, type KeyboardEvent } from 'react';
import { track } from './analytics';
import { useLang, type Lang } from './i18n';

/** The country code the phone field starts with: Brazil for pt, the US for en; Spanish is spoken in too many countries to guess. */
const DEFAULT_DDI: Record<Lang, string> = { pt: '55', en: '1', es: '' };

/** The failure is stored as a reason, not as a string, so switching language re-renders it. */
type State =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'done'; already: boolean }
  | { kind: 'error'; reason: 'email' | 'generic' };

const onlyDigits = (s: string) => s.replace(/\D+/g, '');

/** Basic shape, mirroring the server's `.email()` guard that runs before the Gmail rule. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Cloudflare Access signs people in with Google, so only Gmail addresses can be invited. */
const GMAIL_RE = /^[^@\s]+@gmail\.com$/i;

/** Error codes the waitlist route answers with when the address itself is the problem. */
const EMAIL_ERROR_CODES = ['gmail_only', 'invalid_email'];

/** Desaturated red, for form semantics only — it is not part of the page palette. */
const FORM_RED = '#d98b8b';

/** Posts to /api/waitlist on the same origin (nginx forwards termhub.dev/api/waitlist to the app). */
export function WaitlistForm() {
  const { t, lang } = useLang();
  const f = t.cloud.form;
  const [first, setFirst] = useState('');
  const [last, setLast] = useState('');
  const [email, setEmail] = useState('');
  const [emailTouched, setEmailTouched] = useState(false);
  const [tipOpen, setTipOpen] = useState(false);
  const [tipDismissed, setTipDismissed] = useState(false);
  const [ddi, setDdi] = useState(DEFAULT_DDI[lang]);
  const [ddd, setDdd] = useState('');
  const [number, setNumber] = useState('');
  const [linkedin, setLinkedin] = useState('');
  const [github, setGithub] = useState('');
  const [website, setWebsite] = useState(''); // honeypot
  const [state, setState] = useState<State>({ kind: 'idle' });

  const emailOk = EMAIL_RE.test(email.trim()) && GMAIL_RE.test(email.trim());
  const showEmailError = emailTouched && email.trim() !== '' && !emailOk;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setState({ kind: 'sending' });
    try {
      const res = await fetch('/api/waitlist', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          first_name: first, last_name: last, email, phone_country: ddi, phone_area: ddd, phone_number: number,
          linkedin: linkedin || null, github: github || null, locale: lang, website,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; already?: boolean; code?: string };
      if (!res.ok || !data.ok) {
        // the route answers with `gmail_only` or `invalid_email` when the address is the problem
        const badEmail = res.status === 400 && EMAIL_ERROR_CODES.includes(data.code ?? '');
        throw new Error(badEmail ? 'email' : 'generic');
      }
      setState({ kind: 'done', already: !!data.already });
      // only new sign-ups count; the locale is the whole payload, never the person's data
      if (!data.already) track('waitlist_submit', { locale: lang });
    } catch (err) {
      const badEmail = err instanceof Error && err.message === 'email';
      setState({ kind: 'error', reason: badEmail ? 'email' : 'generic' });
    }
  };

  if (state.kind === 'done') {
    return (
      <div className="rounded-card border border-accent/40 bg-surface p-5">
        <p className="font-medium text-white">
          <span className="mr-2 text-accent" aria-hidden="true">✓</span>
          {state.already ? f.already : f.done_title}
        </p>
        {!state.already && <p className="mt-1 text-body-sm text-frost">{f.done_text}</p>}
      </div>
    );
  }

  const label = 'mb-1 block text-caption font-medium uppercase tracking-wide text-muted';
  const sending = state.kind === 'sending';
  const tipVisible = tipOpen && !tipDismissed;
  const openTip = () => {
    setTipDismissed(false);
    setTipOpen(true);
  };
  const closeTip = () => {
    setTipDismissed(false);
    setTipOpen(false);
  };
  // WCAG 2.1.4: Escape hides the tooltip without moving focus away from the button
  const onTipKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    setTipDismissed(true);
  };

  return (
    <form onSubmit={submit} className="space-y-3" noValidate>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className={label} htmlFor="wl-first">{f.first}</label>
          <input id="wl-first" className="field" value={first} onChange={(e) => setFirst(e.target.value)} required maxLength={80} autoComplete="given-name" />
        </div>
        <div>
          <label className={label} htmlFor="wl-last">{f.last}</label>
          <input id="wl-last" className="field" value={last} onChange={(e) => setLast(e.target.value)} required maxLength={80} autoComplete="family-name" />
        </div>
      </div>
      <div className="relative">
        <div className="mb-1 flex items-center gap-1">
          <label className="text-caption font-medium uppercase tracking-wide text-muted" htmlFor="wl-email">{f.email}</label>
          <button
            type="button"
            className="peer tap-icon rounded-tint text-[16px] leading-none text-muted transition duration-150 hover:text-frost focus-visible:text-frost focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
            aria-label={f.email_why}
            aria-describedby="wl-email-tip"
            onMouseEnter={openTip}
            onMouseLeave={closeTip}
            onFocus={openTip}
            onBlur={closeTip}
            onKeyDown={onTipKeyDown}
          >
            <span aria-hidden="true">ⓘ</span>
          </button>
          <span
            id="wl-email-tip"
            role="tooltip"
            className={`pointer-events-none absolute bottom-full left-0 z-20 mb-2 w-full max-w-[280px] rounded-field border border-border-2 bg-surface px-3 py-2 text-caption font-normal normal-case tracking-normal text-frost transition-opacity duration-150 ${
              tipVisible ? 'opacity-100' : 'opacity-0'
            } ${tipDismissed ? '' : 'peer-hover:opacity-100 peer-focus:opacity-100'}`}
          >
            {f.email_tooltip}
          </span>
        </div>
        <input
          id="wl-email"
          className="field"
          type="email"
          inputMode="email"
          placeholder={f.email_placeholder}
          pattern="[^@\s]+@gmail\.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onBlur={() => setEmailTouched(true)}
          aria-invalid={showEmailError}
          aria-describedby={showEmailError ? 'wl-email-tip wl-email-error' : 'wl-email-tip'}
          required
          maxLength={200}
          autoComplete="email"
        />
        {showEmailError && (
          <p id="wl-email-error" role="alert" className="mt-1 text-caption" style={{ color: FORM_RED }}>
            {f.email_invalid}
          </p>
        )}
      </div>
      <div>
        <span className={label}>{f.phone}</span>
        <div className="grid grid-cols-[5rem_5rem_1fr] gap-2">
          <div className="relative">
            <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-body-sm text-muted">+</span>
            <input className="field pl-6" inputMode="numeric" placeholder={f.ddi} aria-label={f.ddi} value={ddi} onChange={(e) => setDdi(onlyDigits(e.target.value).slice(0, 4))} required autoComplete="tel-country-code" />
          </div>
          <input className="field" inputMode="numeric" placeholder={f.ddd} aria-label={f.ddd} value={ddd} onChange={(e) => setDdd(onlyDigits(e.target.value).slice(0, 5))} required autoComplete="tel-area-code" />
          <input className="field" inputMode="numeric" placeholder={f.number} aria-label={f.number} value={number} onChange={(e) => setNumber(onlyDigits(e.target.value).slice(0, 12))} required autoComplete="tel-local" />
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className={label} htmlFor="wl-linkedin">{f.linkedin}</label>
          <input id="wl-linkedin" className="field" value={linkedin} onChange={(e) => setLinkedin(e.target.value)} placeholder={f.handle_hint} maxLength={200} />
        </div>
        <div>
          <label className={label} htmlFor="wl-github">{f.github}</label>
          <input id="wl-github" className="field" value={github} onChange={(e) => setGithub(e.target.value)} placeholder={f.handle_hint} maxLength={200} />
        </div>
      </div>
      {/* honeypot: hidden from people, filled by bots */}
      <div className="absolute -left-[9999px] top-auto h-px w-px overflow-hidden" aria-hidden="true">
        <input tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} name="website" />
      </div>
      {state.kind === 'error' && (
        <p role="alert" className="text-body-sm" style={{ color: FORM_RED }}>
          {state.reason === 'email' ? f.email_invalid : f.error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3 pt-1">
        <button
          type="submit"
          className="btn-primary px-4 py-2 text-body-sm disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:brightness-100"
          disabled={sending || !first || !last || !emailOk || !ddi || !ddd || number.length < 6}
        >
          {sending ? f.sending : f.submit}
        </button>
        <span className="text-caption text-muted">{f.privacy}</span>
      </div>
    </form>
  );
}
