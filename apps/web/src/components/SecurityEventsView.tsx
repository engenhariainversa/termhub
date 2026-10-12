import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../lib/api';
import type { SecurityEvent, SecurityEventFilter } from '../lib/types';
import { formatDateTime } from '../lib/format';
import { tk, useTranslation } from '../i18n';

/** Each action the trail records, in pt-BR; one a newer server adds shows as its raw name. */
export const SECURITY_ACTION_LABELS: Record<string, string> = {
  'auth.login': tk('Entrou'),
  'auth.login_failed': tk('Falha ao entrar'),
  'auth.logout': tk('Saiu'),
  'auth.view_as': tk('Começou a ver como outra pessoa'),
  'auth.view_as_end': tk('Parou de ver como outra pessoa'),
  'user.invite': tk('Convidou usuário'),
  'user.role_change': tk('Mudou a role de usuário'),
  'user.delete': tk('Excluiu usuário'),
  'user.deletion_requested': tk('Pediu a exclusão da própria conta'),
  'user.deletion_canceled': tk('Cancelou a exclusão da própria conta'),
  'role.create': tk('Criou role'),
  'role.update': tk('Editou role'),
  'role.delete': tk('Excluiu role'),
  'role.permission_toggle': tk('Mudou uma permissão'),
  'machine.create': tk('Adicionou máquina'),
  'machine.delete': tk('Excluiu máquina'),
  'machine.transfer': tk('Transferiu máquina'),
  'machine.agent_token_rotate': tk('Gerou novo token do agente'),
  'api_token.create': tk('Criou token de API'),
  'api_token.revoke': tk('Revogou token de API'),
  'integration.create': tk('Adicionou integração'),
  'integration.delete': tk('Excluiu integração'),
  'terminal.input': tk('Digitou num terminal pela API'),
  'terminal.view_as_open': tk('Abriu o terminal de outra pessoa'),
  'audit.export': tk('Exportou a auditoria'),
  'feature_flag.update': tk('Ligou ou desligou um recurso em teste'),
  'feature_flag.override': tk('Mudou um recurso em teste para uma pessoa'),
};

const GROUP_LABELS: Record<string, string> = {
  auth: tk('Acesso'),
  user: tk('Usuários'),
  role: tk('Roles e permissões'),
  machine: tk('Máquinas'),
  api_token: tk('Tokens de API'),
  integration: tk('Integrações'),
  terminal: tk('Terminais'),
  audit: tk('Auditoria'),
  feature_flag: tk('Recursos em teste'),
};

/** A local calendar day (`2026-10-07`) as the instant it starts; `plusDays` 1 gives the exclusive end of the day. */
export function dayStart(day: string, plusDays = 0): string | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return undefined;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + plusDays).toISOString();
}

/** `meta` as short `key: value` pairs; values are server data, shown as is. */
export function metaText(meta: Record<string, unknown>): string {
  return Object.entries(meta)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' · ');
}

interface Draft {
  action: string;
  q: string;
  from: string;
  to: string;
}

const EMPTY: Draft = { action: '', q: '', from: '', to: '' };

const filterOf = (d: Draft): SecurityEventFilter => ({ action: d.action || undefined, q: d.q.trim() || undefined, from: dayStart(d.from), to: dayStart(d.to, 1) });

/** Settings → Auditoria (TER-577): who signed in, changed roles, viewed as someone, minted tokens… */
export function SecurityEventsView() {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [filter, setFilter] = useState<SecurityEventFilter>({});
  const [events, setEvents] = useState<SecurityEvent[] | null>(null);
  const [actions, setActions] = useState<string[]>(Object.keys(SECURITY_ACTION_LABELS));
  const [next, setNext] = useState<string | null>(null);
  const [retention, setRetention] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(async (f: SecurityEventFilter, before: string | null) => {
    setError(null);
    try {
      const page = await api.securityEvents.list(f, before);
      setEvents((cur) => (before ? [...(cur ?? []), ...page.events] : page.events));
      setNext(page.next);
      setActions(page.actions);
      setRetention(page.retention_days);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('Erro ao carregar a auditoria'));
    }
  }, []);

  useEffect(() => {
    setEvents(null);
    void load(filter, null);
  }, [filter, load]);

  const apply = (e: FormEvent) => {
    e.preventDefault();
    setFilter(filterOf(draft));
  };

  const more = async () => {
    setLoadingMore(true);
    await load(filter, next);
    setLoadingMore(false);
  };

  const groups = [...new Set(actions.map((a) => a.split('.')[0]!))];
  const label = (action: string) => (SECURITY_ACTION_LABELS[action] ? t(SECURITY_ACTION_LABELS[action]) : action);

  return (
    <div className="space-y-4">
      <p className="text-sm text-fg-muted">
        {t('Entradas e falhas de login, convites, mudanças de role e de permissão, "ver como", tokens, máquinas e integrações. Só metadados: nada do que é digitado nos terminais é gravado.')}
        {retention !== null && <> {t('Cada registro fica guardado por {{days}} dias.', { days: retention })}</>}
      </p>
      <form onSubmit={apply} className="flex flex-wrap items-end gap-3">
        <div>
          <label className="label" htmlFor="security-action">
            {t('Ação')}
          </label>
          <select id="security-action" className="input w-auto py-1 text-sm" value={draft.action} onChange={(e) => setDraft({ ...draft, action: e.target.value })}>
            <option value="">{t('Todas')}</option>
            {groups.map((g) => (
              <optgroup key={g} label={GROUP_LABELS[g] ? t(GROUP_LABELS[g]) : g}>
                <option value={g}>{t('Tudo em {{group}}', { group: GROUP_LABELS[g] ? t(GROUP_LABELS[g]) : g })}</option>
                {actions
                  .filter((a) => a.startsWith(`${g}.`))
                  .map((a) => (
                    <option key={a} value={a}>
                      {label(a)}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
        </div>
        <div className="min-w-48 flex-1">
          <label className="label" htmlFor="security-q">
            {t('Pessoa, alvo ou IP')}
          </label>
          <input id="security-q" className="input py-1 text-sm" value={draft.q} onChange={(e) => setDraft({ ...draft, q: e.target.value })} maxLength={200} placeholder={t('ex.: pessoa@exemplo.com')} />
        </div>
        <div>
          <label className="label" htmlFor="security-from">
            {t('De')}
          </label>
          <input id="security-from" type="date" className="input py-1 text-sm" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
        </div>
        <div>
          <label className="label" htmlFor="security-to">
            {t('Até')}
          </label>
          <input id="security-to" type="date" className="input py-1 text-sm" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
        </div>
        <button type="submit" className="btn-primary py-1">
          {t('Filtrar')}
        </button>
        <div className="ml-auto flex gap-2">
          <a className="btn-ghost border border-line py-1" href={api.securityEvents.exportUrl(filter, 'csv')} download>
            {t('Exportar CSV')}
          </a>
          <a className="btn-ghost border border-line py-1" href={api.securityEvents.exportUrl(filter, 'json')} download>
            {t('Exportar JSON')}
          </a>
        </div>
      </form>
      {error && <p className="text-sm text-danger">{error}</p>}
      {events === null ? (
        !error && <p className="text-sm text-fg-dim">{t('Carregando…')}</p>
      ) : events.length === 0 ? (
        <p className="text-sm text-fg-dim">{t('Nenhum registro com esses filtros.')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-fg-dim">
              <tr>
                <th className="py-1 pr-3 font-normal">{t('Quando')}</th>
                <th className="py-1 pr-3 font-normal">{t('Quem')}</th>
                <th className="py-1 pr-3 font-normal">{t('Ação')}</th>
                <th className="py-1 pr-3 font-normal">{t('Alvo')}</th>
                <th className="py-1 pr-3 font-normal">{t('IP')}</th>
                <th className="py-1 font-normal">{t('Detalhes')}</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id} className="border-t border-line align-top">
                  <td className="whitespace-nowrap py-1.5 pr-3">{formatDateTime(e.created_at)}</td>
                  <td className="py-1.5 pr-3">
                    {e.actor_email ?? <span className="text-fg-dim">{t('desconhecido')}</span>}
                    {e.view_as_id && (
                      <div className="text-xs text-warn">{e.view_as_id === '*' ? t('vendo como todos') : t('vendo como {{id}}', { id: e.view_as_id })}</div>
                    )}
                  </td>
                  <td className={`py-1.5 pr-3 ${e.action === 'auth.login_failed' ? 'text-danger' : ''}`}>{label(e.action)}</td>
                  <td className="py-1.5 pr-3">{e.target_label ?? e.target_id ?? '—'}</td>
                  <td className="whitespace-nowrap py-1.5 pr-3 font-mono text-xs">{e.ip ?? '—'}</td>
                  <td className="py-1.5 text-xs text-fg-muted">{metaText(e.meta)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {next && (
        <button className="btn-ghost border border-line" onClick={() => void more()} disabled={loadingMore}>
          {loadingMore ? t('Carregando…') : t('Carregar mais')}
        </button>
      )}
    </div>
  );
}
