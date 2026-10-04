import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { ApiError } from '../lib/api';
import { deletionDate, takeDeletionNotice } from '../lib/account-deletion';

const OAUTH_ERRORS: Record<string, string> = {
  google_denied: 'Login com Google cancelado.',
  state_mismatch: 'Sessão de login expirou. Tente novamente.',
  google_exchange: 'Falha ao validar o login com o Google.',
  email_not_allowed: 'Este e-mail do Google não está cadastrado no termhub.',
};

type Step = 'email' | 'code' | 'password';

export function LoginPage() {
  const { user, loading, login, sendCode, verifyCode, config } = useAuth();
  const [params] = useSearchParams();
  const [step, setStep] = useState<Step>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [ttl, setTtl] = useState(10);
  const [error, setError] = useState<string | null>(() => {
    const e = params.get('error');
    return e ? (OAUTH_ERRORS[e] ?? 'Falha no login.') : null;
  });
  const [info, setInfo] = useState<string | null>(null);
  // set by Perfil → Excluir minha conta, whose request ended the session (TER-720)
  const [deletionNotice] = useState(takeDeletionNotice);
  const [busy, setBusy] = useState(false);
  const codeRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (step === 'code') codeRef.current?.focus();
  }, [step]);

  if (loading) return null;
  if (user) return <Navigate to="/" replace />;

  const appMode = !config || config.modes.includes('app');
  const allowPassword = config?.password ?? true;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível continuar.');
    } finally {
      setBusy(false);
    }
  };

  const submitEmail = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const minutes = await sendCode(email);
      setTtl(minutes);
      setCode('');
      setStep('code');
      setInfo(`Se este e-mail estiver cadastrado, você receberá um código de 6 dígitos (vale ${minutes} min).`);
    });
  };

  const submitCode = (e: FormEvent) => {
    e.preventDefault();
    void run(() => verifyCode(email, code));
  };

  const submitPassword = (e: FormEvent) => {
    e.preventDefault();
    void run(() => login(email, password));
  };

  const resend = () =>
    void run(async () => {
      const minutes = await sendCode(email);
      setTtl(minutes);
      setInfo(`Novo código enviado (vale ${minutes} min).`);
    });

  return (
    <div className="flex h-full items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-xl border border-line bg-bg-2 p-6 shadow-2xl">
        <h1 className="mb-1 text-lg font-semibold tracking-tight">
          <span className="text-accent">▮</span> termhub
        </h1>
        <p className="mb-6 text-sm text-fg-muted">Terminais das suas máquinas, no navegador.</p>
        {deletionNotice && (
          <p role="status" className="mb-4 rounded border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn">
            Sua conta foi desativada e será excluída em {deletionDate(deletionNotice)}. Para cancelar, entre de novo antes dessa data.
          </p>
        )}

        {!appMode ? (
          <p className="text-sm text-fg-muted">Este servidor não usa login próprio. Acesse pelo endereço protegido pelo Cloudflare Access.</p>
        ) : step === 'email' ? (
          <form onSubmit={submitEmail} className="space-y-3">
            <div>
              <label className="label" htmlFor="email">
                E-mail
              </label>
              <input id="email" className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
            </div>
            {error && <p className="text-sm text-danger">{error}</p>}
            <button className="btn-primary w-full justify-center" type="submit" disabled={busy}>
              {busy ? 'Enviando…' : 'Receber código por e-mail'}
            </button>
            {allowPassword && (
              <button type="button" className="w-full text-center text-xs text-fg-dim hover:text-fg" onClick={() => setStep('password')}>
                Entrar com senha
              </button>
            )}
            {config?.google && (
              <>
                <div className="flex items-center gap-2 py-1 text-xs text-fg-dim">
                  <span className="h-px flex-1 bg-line" />
                  ou
                  <span className="h-px flex-1 bg-line" />
                </div>
                <a className="btn w-full justify-center border border-line text-fg hover:bg-bg-3" href="/api/auth/google">
                  <GoogleIcon /> Entrar com Google
                </a>
              </>
            )}
          </form>
        ) : step === 'code' ? (
          <form onSubmit={submitCode} className="space-y-3">
            <p className="text-sm text-fg-muted">
              Código enviado para <strong className="text-fg">{email}</strong>.
            </p>
            <div>
              <label className="label" htmlFor="code">
                Código de 6 dígitos
              </label>
              <input
                id="code"
                ref={codeRef}
                className="input text-center font-mono text-2xl tracking-[0.5em]"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="\d{6}"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                required
              />
            </div>
            {info && !error && <p className="text-xs text-fg-dim">{info}</p>}
            {error && <p className="text-sm text-danger">{error}</p>}
            <button className="btn-primary w-full justify-center" type="submit" disabled={busy || code.length !== 6}>
              {busy ? 'Verificando…' : 'Entrar'}
            </button>
            <div className="flex justify-between text-xs text-fg-dim">
              <button type="button" className="hover:text-fg" onClick={() => setStep('email')}>
                ← trocar e-mail
              </button>
              <button type="button" className="hover:text-fg" onClick={resend} disabled={busy}>
                reenviar código ({ttl} min)
              </button>
            </div>
          </form>
        ) : (
          <form onSubmit={submitPassword} className="space-y-3">
            <div>
              <label className="label" htmlFor="email2">
                E-mail
              </label>
              <input id="email2" className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus={!email} />
            </div>
            <div>
              <label className="label" htmlFor="password">
                Senha
              </label>
              <input id="password" className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus={!!email} />
            </div>
            {error && <p className="text-sm text-danger">{error}</p>}
            <button className="btn-primary w-full justify-center" type="submit" disabled={busy}>
              {busy ? 'Entrando…' : 'Entrar'}
            </button>
            <button type="button" className="w-full text-center text-xs text-fg-dim hover:text-fg" onClick={() => setStep('email')}>
              ← entrar com código por e-mail
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.5 5.4 2.6 13.3l7.9 6.1C12.4 13.6 17.7 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v8.5h12.7c-.5 2.8-2.2 5.2-4.6 6.8l7.4 5.7c4.3-4 6.9-9.9 6.9-16.5z" />
      <path fill="#FBBC05" d="M10.5 28.6c-.5-1.5-.8-3-.8-4.6s.3-3.1.8-4.6l-7.9-6.1C.9 16.6 0 20.2 0 24s.9 7.4 2.6 10.7l7.9-6.1z" />
      <path fill="#34A853" d="M24 48c6.3 0 11.6-2.1 15.5-5.7l-7.4-5.7c-2.1 1.4-4.8 2.2-8.1 2.2-6.3 0-11.6-4.1-13.5-9.8l-7.9 6.1C6.5 42.6 14.6 48 24 48z" />
    </svg>
  );
}
