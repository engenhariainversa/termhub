import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../lib/api';
import { PROVIDER_LABEL, type ConnectionInfo, type Integration, type IntegrationProvider } from '../lib/types';
import { ConfirmDialog, Modal } from './Modal';
import { PageFrame } from './PageHeader';
import { formatDate } from '../lib/format';
import { Trans, tk, useTranslation } from '../i18n';

const PROVIDERS: { id: IntegrationProvider; secretLabel: string; help: string; fields: { key: string; label: string; placeholder: string }[] }[] = [
  {
    id: 'github',
    secretLabel: tk('Personal access token'),
    help: tk('github.com → Settings → Developer settings → Tokens. Escopos: repo (issues, PRs) e read:user. Dica: "gh auth token" no terminal mostra o token do gh.'),
    fields: [],
  },
  {
    id: 'linear',
    secretLabel: tk('API key'),
    help: tk('linear.app → Settings → Security & access → Personal API keys.'),
    fields: [],
  },
  {
    id: 'jira',
    secretLabel: tk('API token'),
    help: tk('id.atlassian.com → Security → API tokens. Informe também a URL do site e o e-mail da conta.'),
    fields: [
      { key: 'baseUrl', label: tk('URL do Jira'), placeholder: tk('https://empresa.atlassian.net') },
      { key: 'email', label: tk('E-mail da conta'), placeholder: tk('voce@empresa.com') },
    ],
  },
];

/** Configurações → Integrações: GitHub, Linear and Jira credentials (was the `/integrations` page). */
export function IntegrationsView() {
  const { t } = useTranslation();
  const [items, setItems] = useState<Integration[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Integration | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Integration | null>(null);
  const [testing, setTesting] = useState<Record<string, ConnectionInfo | 'loading'>>({});

  const load = () =>
    api.integrations
      .list()
      .then((r) => setItems(r.integrations))
      .catch((e) => setError(e instanceof ApiError ? e.message : t('Erro ao carregar')));

  useEffect(() => {
    void load();
  }, []);

  const test = async (i: Integration) => {
    setTesting((s) => ({ ...s, [i.id]: 'loading' }));
    try {
      const r = await api.integrations.test({ provider: i.provider, config: i.config, integration_id: i.id });
      setTesting((s) => ({ ...s, [i.id]: r }));
    } catch (e) {
      setTesting((s) => ({ ...s, [i.id]: { ok: false, error: e instanceof ApiError ? e.message : t('falha') } }));
    }
  };

  return (
    <PageFrame
      title={t('Integrações')}
      actions={
        <button className="btn-primary text-xs" onClick={() => setEditing('new')}>
          {t('+ integração')}
        </button>
      }
    >
      <p className="mb-5 text-sm text-fg-muted">{t('Credenciais de GitHub, Linear e Jira. Os segredos ficam criptografados no banco; cada projeto escolhe qual usar no Setup.')}</p>
      {error && <p className="mb-3 text-sm text-danger">{error}</p>}
      {items && items.length === 0 && <p className="text-sm text-fg-dim">{t('Nenhuma integração ainda.')}</p>}
      <ul className="space-y-2">
        {items?.map((i) => {
          const res = testing[i.id];
          return (
            <li key={i.id} className="flex items-center gap-3 rounded-lg border border-line bg-bg-2 px-4 py-3">
              <span className="rounded bg-bg-4 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-fg-muted">{PROVIDER_LABEL[i.provider]}</span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{i.name}</div>
                <div className="truncate text-xs text-fg-dim">
                  {i.provider === 'jira' ? `${i.config.baseUrl ?? ''} · ${i.config.email ?? ''}` : i.config.login ? String(i.config.login) : t('criada em {{date}}', { date: formatDate(i.created_at) })}
                  {res && res !== 'loading' && (
                    <span className={`ml-2 ${res.ok ? 'text-ok' : 'text-danger'}`}>{res.ok ? (res.account ? `✓ ${res.account}` : t('✓ ok')) : `✗ ${res.error}`}</span>
                  )}
                  {res === 'loading' && <span className="ml-2 text-warn">{t('testando…')}</span>}
                </div>
              </div>
              <button className="btn-ghost text-xs" onClick={() => void test(i)}>
                {t('Testar')}
              </button>
              <button className="btn-ghost text-xs" onClick={() => setEditing(i)}>
                {t('Editar')}
              </button>
              <button className="btn-ghost text-xs text-danger" onClick={() => setDeleting(i)}>
                {t('Excluir')}
              </button>
            </li>
          );
        })}
      </ul>

      {editing && (
        <IntegrationForm
          integration={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}
      <ConfirmDialog
        open={!!deleting}
        title={t('Excluir integração')}
        message={
          <Trans
            i18nKey="Excluir <0>{{name}}</0>? Projetos que a usam no Setup vão parar de sincronizar."
            values={{ name: deleting?.name ?? '' }}
            components={[<strong key="n" />]}
          />
        }
        confirmLabel={t('Excluir')}
        danger
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          if (deleting) await api.integrations.remove(deleting.id).catch(() => {});
          setDeleting(null);
          void load();
        }}
      />
    </PageFrame>
  );
}

function IntegrationForm({ integration, onClose, onSaved }: { integration: Integration | null; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation();
  const [provider, setProvider] = useState<IntegrationProvider>(integration?.provider ?? 'linear');
  const [name, setName] = useState(integration?.name ?? '');
  const [config, setConfig] = useState<Record<string, string>>(
    Object.fromEntries(Object.entries(integration?.config ?? {}).map(([k, v]) => [k, String(v ?? '')])),
  );
  const [secret, setSecret] = useState('');
  const [result, setResult] = useState<ConnectionInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const def = PROVIDERS.find((p) => p.id === provider)!;

  const test = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.integrations.test({ provider, config, secret: secret || undefined, integration_id: integration?.id });
      setResult(r);
      if (r.ok && !name) setName(`${PROVIDER_LABEL[provider]} ${r.account ?? ''}`.trim());
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('Falha ao testar'));
    } finally {
      setBusy(false);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const cfg: Record<string, unknown> = { ...config };
      if (result?.ok && result.account) cfg.login = result.account;
      if (integration) await api.integrations.update(integration.id, { name, config: cfg, ...(secret ? { secret } : {}) });
      else await api.integrations.create({ provider, name: name || PROVIDER_LABEL[provider], config: cfg, secret });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('Erro ao salvar'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={integration ? t('Editar integração') : t('Nova integração')} open onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        {!integration && (
          <div>
            <label className="label">{t('Serviço')}</label>
            <div className="flex gap-2">
              {PROVIDERS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => {
                    setProvider(p.id);
                    setResult(null);
                  }}
                  className={`btn flex-1 border ${provider === p.id ? 'border-accent bg-accent/15 text-fg' : 'border-line text-fg-muted hover:bg-bg-3'}`}
                >
                  {PROVIDER_LABEL[p.id]}
                </button>
              ))}
            </div>
          </div>
        )}
        {def.fields.map((f) => (
          <div key={f.key}>
            <label className="label">{t(f.label)}</label>
            <input className="input" value={config[f.key] ?? ''} onChange={(e) => setConfig((c) => ({ ...c, [f.key]: e.target.value }))} placeholder={t(f.placeholder)} required />
          </div>
        ))}
        <div>
          <label className="label">{t(def.secretLabel)}</label>
          <input
            className="input font-mono"
            type="password"
            autoComplete="off"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder={integration ? t('(manter o atual)') : ''}
            required={!integration}
          />
          <p className="mt-1 text-xs text-fg-dim">{t(def.help)}</p>
        </div>
        <div>
          <label className="label">{t('Nome')}</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('{{provider}} pessoal', { provider: PROVIDER_LABEL[provider] })} />
        </div>
        {result && (
          <p className={`text-sm ${result.ok ? 'text-ok' : 'text-danger'}`}>
            {result.ok ? t('Conectado como {{account}}', { account: result.account }) : t('Falha: {{error}}', { error: result.error })}
            {result.ok && result.options && (
              <span className="text-fg-dim"> · {Object.entries(result.options).map(([k, v]) => `${v.length} ${k}`).join(', ')}</span>
            )}
          </p>
        )}
        {error && <p className="text-sm text-danger">{error}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            {t('Cancelar')}
          </button>
          <button type="button" className="btn-ghost" onClick={() => void test()} disabled={busy || (!secret && !integration)}>
            {t('Testar conexão')}
          </button>
          <button type="submit" className="btn-primary" disabled={busy}>
            {t('Salvar')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
