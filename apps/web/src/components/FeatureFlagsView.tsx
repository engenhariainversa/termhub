import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import type { FeatureFlagInfo, FeatureFlagKey } from '../lib/types';
import { tk, useTranslation } from '../i18n';

/** What each flag gates, in pt-BR; a flag a newer server adds shows as its raw key. */
const FLAG_COPY: Record<FeatureFlagKey, { label: string; description: string }> = {
  subscriptions: {
    label: tk('Assinaturas'),
    description: tk('Planos, checkout, paywall e limites do período de teste. Desligado, nada disso aparece na web, no app nem na landing, as rotas de cobrança não existem e os webhooks do provedor de pagamento são ignorados.'),
  },
};

function Switch({ on, label, disabled, onChange }: { on: boolean; label: string; disabled?: boolean; onChange: (next: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${on ? 'bg-accent' : 'bg-fg-dim/40'}`}
    >
      <span className={`absolute left-0 top-0.5 h-4 w-4 rounded-full transition-transform ${on ? 'translate-x-[18px] bg-white' : 'translate-x-0.5 bg-fg-muted'}`} />
    </button>
  );
}

/**
 * Configurações → Recursos em teste (TER-1040): features that ship dark. The instance switch turns one
 * on for everyone, without a deploy; a person added below gets their own value (to test it before the
 * release, or to keep it off for them once it is on).
 */
export function FeatureFlagsView() {
  const { t } = useTranslation();
  const { can, refresh } = useAuth();
  const [flags, setFlags] = useState<FeatureFlagInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [emails, setEmails] = useState<Record<string, string>>({});
  const editable = can('feature_flags', 'update');

  const load = useCallback(async () => {
    try {
      setFlags((await api.featureFlags.list()).flags);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('Erro ao carregar'));
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Runs a change, reloads the list and the signed-in person's own flags (the admin may be a tester). */
  const run = async (key: string, change: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await change();
      await Promise.all([load(), refresh().catch(() => {})]);
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('Erro ao alterar'));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const addTester = async (e: FormEvent, flag: FeatureFlagKey) => {
    e.preventDefault();
    const email = (emails[flag] ?? '').trim();
    if (!email) return;
    if (await run(`${flag}:add`, () => api.featureFlags.setOverride(flag, email, true))) setEmails((m) => ({ ...m, [flag]: '' }));
  };

  if (!flags) return error ? <p className="text-sm text-danger">{error}</p> : <p className="text-sm text-fg-muted">{t('Carregando…')}</p>;

  return (
    <div className="space-y-4">
      <p className="text-sm text-fg-muted">{t('Recursos que ainda não foram liberados. Ligue para todos aqui, sem deploy, ou só para algumas pessoas testarem antes.')}</p>
      {error && <p className="text-sm text-danger">{error}</p>}
      {flags.map((flag) => {
        const copy = FLAG_COPY[flag.key];
        const name = copy ? t(copy.label) : flag.key;
        return (
          <section key={flag.key} className="rounded-lg border border-line bg-bg-2 p-4">
            <div className="flex items-start gap-3">
              <Switch on={flag.enabled} label={t('{{name}} para todos', { name })} disabled={!editable || busy !== null} onChange={(next) => void run(flag.key, () => api.featureFlags.set(flag.key, next))} />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">
                  {name} <span className="font-mono text-[11px] text-fg-dim">{flag.key}</span>
                </p>
                {copy && <p className="mt-1 text-xs text-fg-muted">{t(copy.description)}</p>}
                <p className="mt-1 text-xs text-fg-dim">{flag.enabled ? t('Ligado para todos.') : t('Desligado para todos, exceto quem estiver na lista abaixo.')}</p>
              </div>
            </div>

            <div className="mt-4">
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-fg-dim">{t('Valor próprio por pessoa')}</p>
              {flag.overrides.length === 0 ? (
                <p className="text-xs text-fg-muted">{t('Ninguém tem um valor próprio.')}</p>
              ) : (
                <ul className="divide-y divide-line rounded-md border border-line">
                  {flag.overrides.map((o) => (
                    <li key={o.user_id} className="flex items-center gap-3 px-3 py-2 text-sm">
                      <Switch
                        on={o.enabled}
                        label={t('{{name}} para {{email}}', { name, email: o.email })}
                        disabled={!editable || busy !== null}
                        onChange={(next) => void run(`${flag.key}:${o.user_id}`, () => api.featureFlags.setOverride(flag.key, o.email, next))}
                      />
                      <span className="min-w-0 flex-1 truncate">
                        {o.name} <span className="text-fg-dim">{o.email}</span>
                      </span>
                      {editable && (
                        <button type="button" className="text-xs text-fg-muted hover:text-danger" disabled={busy !== null} onClick={() => void run(`${flag.key}:${o.user_id}`, () => api.featureFlags.removeOverride(flag.key, o.user_id))}>
                          {t('Remover')}
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {editable && (
                <form className="mt-2 flex gap-2" onSubmit={(e) => void addTester(e, flag.key)}>
                  <input
                    type="email"
                    className="input flex-1 py-1 text-sm"
                    placeholder={t('E-mail de quem vai testar')}
                    aria-label={t('E-mail de quem vai testar')}
                    value={emails[flag.key] ?? ''}
                    onChange={(e) => setEmails((m) => ({ ...m, [flag.key]: e.target.value }))}
                  />
                  <button type="submit" className="btn-primary" disabled={busy !== null || !(emails[flag.key] ?? '').trim()}>
                    {t('Ligar para essa pessoa')}
                  </button>
                </form>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}
