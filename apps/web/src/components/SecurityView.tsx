import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from '../i18n';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDateTime } from '../lib/format';
import type { WebSession } from '../lib/types';
import { ConfirmDialog } from './Modal';

/** Same floor as the server (auth/service.ts PASSWORD_MIN) and the create-user CLI. */
const PASSWORD_MIN = 8;

/** "Chrome · macOS" out of a user agent; null when neither is recognised. Product names, not copy. */
export function describeUserAgent(ua: string | null): string | null {
  if (!ua) return null;
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\//.test(ua)
      ? 'Opera'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : null;
  const os = /iPhone|iPad/.test(ua)
    ? 'iOS'
    : /Android/.test(ua)
      ? 'Android'
      : /Mac OS X|Macintosh/.test(ua)
        ? 'macOS'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Linux/.test(ua)
            ? 'Linux'
            : null;
  const parts = [browser, os].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

/** Configurações → Segurança (TER-580): change the password and see or end the web sessions. */
export function SecurityView() {
  return (
    <div className="space-y-6">
      <PasswordSection />
      <SessionsSection />
    </div>
  );
}

function PasswordSection() {
  const { t } = useTranslation();
  const { user, refresh } = useAuth();
  const hasPassword = !!user?.has_password;
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setDone(null);
    if (next.length < PASSWORD_MIN) return setError(t('A nova senha precisa ter ao menos {{min}} caracteres.', { min: PASSWORD_MIN }));
    if (next !== confirm) return setError(t('As senhas não conferem.'));
    setBusy(true);
    try {
      const r = await api.auth.changePassword(hasPassword ? current : null, next);
      setCurrent('');
      setNext('');
      setConfirm('');
      setDone(r.revoked > 0 ? t('Senha salva. {{count}} outras sessões foram encerradas.', { count: r.revoked }) : t('Senha salva.'));
      if (!hasPassword) void refresh().catch(() => {});
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('Erro ao salvar a senha'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="security-password" className="space-y-3 rounded-lg border border-line bg-bg-2 p-4">
      <div>
        <h3 id="security-password" className="text-sm font-semibold">
          {hasPassword ? t('Trocar senha') : t('Definir senha')}
        </h3>
        <p className="mt-1 text-xs text-fg-muted">
          {hasPassword
            ? t('Ao trocar a senha, as outras sessões abertas são encerradas.')
            : t('Sua conta entra por Google ou código por e-mail. Para definir uma senha, entre de novo e volte aqui em até 10 minutos.')}
        </p>
      </div>
      <form onSubmit={submit} className="grid gap-3 sm:grid-cols-3">
        {hasPassword && (
          <div>
            <label className="label" htmlFor="security-current">
              {t('Senha atual')}
            </label>
            <input id="security-current" type="password" className="input" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
          </div>
        )}
        <div>
          <label className="label" htmlFor="security-new">
            {t('Nova senha')}
          </label>
          <input id="security-new" type="password" className="input" autoComplete="new-password" minLength={PASSWORD_MIN} maxLength={1024} value={next} onChange={(e) => setNext(e.target.value)} required />
        </div>
        <div>
          <label className="label" htmlFor="security-confirm">
            {t('Repita a nova senha')}
          </label>
          <input id="security-confirm" type="password" className="input" autoComplete="new-password" maxLength={1024} value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
        </div>
        <div className="sm:col-span-3 flex flex-wrap items-center gap-3">
          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? t('Salvando…') : t('Salvar senha')}
          </button>
          {error && <p className="text-sm text-danger">{error}</p>}
          {done && <p className="text-sm text-fg-muted">{done}</p>}
        </div>
      </form>
    </section>
  );
}

function SessionsSection() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { logout } = useAuth();
  const [sessions, setSessions] = useState<WebSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [ending, setEnding] = useState<WebSession | null>(null);
  const [endingOthers, setEndingOthers] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setSessions((await api.auth.sessions()).sessions);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('Erro ao carregar as sessões'));
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const endOne = async () => {
    const s = ending;
    setEnding(null);
    if (!s) return;
    setError(null);
    setNotice(null);
    try {
      const r = await api.auth.revokeSession(s.id);
      if (r.current) {
        await logout();
        navigate('/login');
        return;
      }
      setSessions((list) => (list ?? []).filter((x) => x.id !== s.id));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('Erro ao encerrar a sessão'));
    }
  };

  const endOthers = async () => {
    setEndingOthers(false);
    setError(null);
    setNotice(null);
    try {
      const r = await api.auth.revokeOtherSessions();
      setNotice(t('{{count}} sessões encerradas.', { count: r.revoked }));
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('Erro ao encerrar as sessões'));
    }
  };

  const others = (sessions ?? []).filter((s) => !s.current).length;

  return (
    <section aria-labelledby="security-sessions" className="space-y-3">
      <div className="flex flex-wrap items-start gap-4">
        <div className="flex-1">
          <h3 id="security-sessions" className="text-sm font-semibold">
            {t('Sessões ativas')}
          </h3>
          <p className="mt-1 text-xs text-fg-muted">{t('Navegadores onde sua conta está aberta. Encerre as que você não reconhece.')}</p>
        </div>
        <button type="button" className="btn-ghost shrink-0 text-danger" disabled={others === 0} onClick={() => setEndingOthers(true)}>
          {t('Sair de todos os outros aparelhos')}
        </button>
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
      {notice && <p className="text-sm text-fg-muted">{notice}</p>}
      {sessions === null ? (
        <p className="text-sm text-fg-dim">{t('Carregando…')}</p>
      ) : sessions.length === 0 ? (
        <p className="text-sm text-fg-dim">{t('Nenhuma sessão ativa.')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-fg-dim">
              <tr>
                <th className="py-1 pr-3 font-normal">{t('Navegador')}</th>
                <th className="py-1 pr-3 font-normal">{t('IP')}</th>
                <th className="py-1 pr-3 font-normal">{t('Criada em')}</th>
                <th className="py-1 pr-3 font-normal">{t('Último uso')}</th>
                <th className="py-1 font-normal" />
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.id} className="border-t border-line">
                  <td className="py-1.5 pr-3" title={s.user_agent ?? undefined}>
                    {describeUserAgent(s.user_agent) ?? t('Navegador desconhecido')}
                    {s.current && <span className="ml-2 rounded bg-accent/15 px-1.5 py-0.5 text-xs text-accent">{t('esta sessão')}</span>}
                  </td>
                  <td className="py-1.5 pr-3 font-mono text-xs">{s.ip ?? '—'}</td>
                  <td className="py-1.5 pr-3">{formatDateTime(s.created_at)}</td>
                  <td className="py-1.5 pr-3">{formatDateTime(s.last_used_at)}</td>
                  <td className="py-1.5 text-right">
                    <button type="button" className="btn-ghost px-2 py-0.5 text-xs text-danger" onClick={() => setEnding(s)}>
                      {s.current ? t('Sair') : t('Encerrar')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ConfirmDialog
        open={!!ending}
        title={t('Encerrar sessão')}
        message={ending?.current ? t('Esta é a sessão deste navegador: você sai agora.') : t('Esse navegador sai da sua conta na próxima ação.')}
        confirmLabel={t('Encerrar')}
        danger
        onConfirm={endOne}
        onCancel={() => setEnding(null)}
      />
      <ConfirmDialog
        open={endingOthers}
        title={t('Sair de todos os outros aparelhos')}
        message={t('Todas as sessões, menos a deste navegador, são encerradas. Aparelhos do app mobile não são afetados: revogue-os em Aparelhos.')}
        confirmLabel={t('Sair dos outros')}
        danger
        onConfirm={endOthers}
        onCancel={() => setEndingOthers(false)}
      />
    </section>
  );
}
