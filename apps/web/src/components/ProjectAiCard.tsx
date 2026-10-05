import { useEffect, useState, type ReactNode } from 'react';
import { api, ApiError } from '../lib/api';
import type { Project, ProjectAi, ProjectAiOption } from '../lib/types';
import { useTranslation } from '../i18n';

const PROVIDERS = [
  { key: 'claude', label: 'Claude Code', aliases: ['opus', 'sonnet', 'haiku'] },
  { key: 'chatgpt', label: 'Codex', aliases: [] },
] as const;
type ProviderKey = (typeof PROVIDERS)[number]['key'];

/** The value the server accepts (same rule as the server's MODEL_RE): no leading `-`, nothing the shell reads. */
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:\[\]\-]{0,99}$/;
const isAlias = (m: string) => /^(opus|sonnet|haiku)(\[[a-z0-9]+\])?$/.test(m);
const OTHER = '__other__';

function sameAi(a: ProjectAi, b: ProjectAi): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * "Contas de IA e modelo" in the project setup (TER-589): which accounts of the linked machines the
 * project's agents and chat use, in priority order, and the model conversations start with. Saved on
 * its own endpoint, apart from the rest of the setup.
 */
export function ProjectAiCard({ project }: { project: Project }) {
  const { t } = useTranslation();
  const [available, setAvailable] = useState<ProjectAiOption[] | null>(null);
  const [ai, setAi] = useState<ProjectAi | null>(null);
  const [saved, setSaved] = useState<ProjectAi | null>(null);
  const [other, setOther] = useState<Partial<Record<ProviderKey, boolean>>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.setup.ai.get(project.id).then(
      (r) => {
        if (cancelled) return;
        setAvailable(r.available);
        setAi(r.ai);
        setSaved(r.ai);
      },
      (e) => !cancelled && setLoadError(e instanceof ApiError ? e.message : t('Erro ao carregar as contas')),
    );
    return () => {
      cancelled = true;
    };
  }, [project.id]);

  if (loadError) return <Section><p className="text-xs text-danger">{loadError}</p></Section>;
  if (!ai || !available || !saved) return <Section><p className="text-xs text-fg-dim">{t('Carregando contas…')}</p></Section>;

  const byId = new Map(available.map((a) => [a.id, a]));
  const included = ai.accounts.filter((id) => byId.has(id));
  const excluded = available.filter((a) => !ai.accounts.includes(a.id));
  const setAccounts = (accounts: string[]) => setAi({ ...ai, accounts });
  const move = (i: number, by: -1 | 1) => {
    const next = [...included];
    [next[i], next[i + by]] = [next[i + by], next[i]];
    setAccounts(next);
  };
  const setModel = (p: ProviderKey, value: string | null) => setAi({ ...ai, models: { ...ai.models, [p]: value } });
  const providersHere = PROVIDERS.filter((p) => available.some((a) => a.provider === p.key));
  const invalid = PROVIDERS.some((p) => ai.models[p.key] !== null && !MODEL_RE.test(ai.models[p.key] ?? ''));
  const dirty = !sameAi(ai, saved);

  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.setup.ai.save(project.id, { ...ai, accounts: included });
      setAvailable(r.available);
      setAi(r.ai);
      setSaved(r.ai);
      setMsg({ ok: true, text: t('Contas e modelo salvos.') });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError ? e.message : t('Erro ao salvar') });
    } finally {
      setBusy(false);
    }
  };

  const label = (a: ProjectAiOption) => `${a.label}${a.default ? t(' (login padrão)') : ''} · ${a.provider === 'claude' ? 'Claude' : 'Codex'} · ${a.machine_name}`;

  return (
    <Section>
      {available.length === 0 ? (
        <p className="text-xs text-fg-dim">{t('Nenhuma conta do Claude ou do Codex nas máquinas deste projeto. Cadastre em Configurações → Contas de IA.')}</p>
      ) : (
        <div className="space-y-2">
          <p className="label">{t('Contas do projeto, em ordem de prioridade')}</p>
          {included.length === 0 && (
            <p className="text-xs text-fg-dim">{t('Sem contas escolhidas, cada início de agente pede a conta, como hoje.')}</p>
          )}
          <ol className="space-y-1">
            {included.map((id, i) => (
              <li key={id} className="flex items-center gap-2 text-sm">
                <span className="w-5 text-right text-xs text-fg-dim">{i + 1}.</span>
                <span className="flex-1 truncate">{label(byId.get(id)!)}</span>
                <button type="button" className="btn-ghost px-1 text-xs" aria-label={t('Subir')} disabled={i === 0} onClick={() => move(i, -1)}>
                  ↑
                </button>
                <button type="button" className="btn-ghost px-1 text-xs" aria-label={t('Descer')} disabled={i === included.length - 1} onClick={() => move(i, 1)}>
                  ↓
                </button>
                <button type="button" className="btn-ghost px-1 text-xs" onClick={() => setAccounts(included.filter((x) => x !== id))}>
                  {t('Remover')}
                </button>
              </li>
            ))}
          </ol>
          {excluded.length > 0 && (
            <div className="space-y-1 pt-1">
              {excluded.map((a) => (
                <label key={a.id} className="flex items-center gap-2 text-sm text-fg-muted">
                  <input type="checkbox" checked={false} onChange={() => setAccounts([...included, a.id])} className="accent-accent" />
                  {label(a)}
                </label>
              ))}
            </div>
          )}
          <p className="text-xs text-fg-dim">
            {t('A primeira conta com limite livre inicia os agentes e o chat do projeto; quando ela bate o limite, a troca vai para a próxima da lista.')}
          </p>
        </div>
      )}

      {providersHere.map((p) => {
        const value = ai.models[p.key];
        const custom = other[p.key] || (value !== null && !(p.aliases as readonly string[]).includes(value));
        return (
          <div key={p.key}>
            <label className="label" htmlFor={`model-${p.key}`}>
              {t('Modelo padrão — {{provider}}', { provider: p.label })}
            </label>
            <div className="flex gap-2">
              <select
                id={`model-${p.key}`}
                className="input"
                value={custom ? OTHER : value ?? ''}
                onChange={(e) => {
                  const v = e.target.value;
                  setOther((o) => ({ ...o, [p.key]: v === OTHER }));
                  if (v !== OTHER) setModel(p.key, v === '' ? null : v);
                }}
              >
                <option value="">{t('Padrão do CLI')}</option>
                {p.aliases.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
                <option value={OTHER}>{t('Outro id…')}</option>
              </select>
              {custom && (
                <input
                  className="input font-mono"
                  aria-label={t('Id do modelo — {{provider}}', { provider: p.label })}
                  value={value ?? ''}
                  onChange={(e) => setModel(p.key, e.target.value.trim() || null)}
                  // i18n-ignore: model ids
                  placeholder={p.key === 'claude' ? 'claude-opus-5-5' : 'gpt-5-codex'}
                />
              )}
            </div>
            {value !== null && !MODEL_RE.test(value) && <p className="mt-1 text-xs text-danger">{t('Use só letras, números, ponto, hífen, dois-pontos ou colchetes.')}</p>}
            {p.key === 'claude' && value !== null && MODEL_RE.test(value) && !isAlias(value) && (
              <p className="mt-1 text-xs text-warn">{t('Um CLI mais antigo numa máquina pode não reconhecer este id. Um apelido (opus, sonnet, haiku) vale em qualquer versão.')}</p>
            )}
          </div>
        );
      })}

      <div className="flex items-center gap-3">
        <button type="button" className="btn-primary" disabled={!dirty || busy || invalid} onClick={() => void save()}>
          {t('Salvar contas e modelo')}
        </button>
        {msg && <span className={`text-sm ${msg.ok ? 'text-ok' : 'text-danger'}`}>{msg.text}</span>}
      </div>
    </Section>
  );
}

function Section({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <section className="rounded-lg border border-line bg-bg-2 p-4">
      <h3 className="text-sm font-semibold">{t('Contas de IA e modelo')}</h3>
      <p className="mb-3 text-xs text-fg-dim">{t('Quais contas os agentes e o chat deste projeto usam, em que ordem, e o modelo com que as conversas começam.')}</p>
      <div className="space-y-3">{children}</div>
    </section>
  );
}
