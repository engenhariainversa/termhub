import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useFeatureFlag } from '../lib/feature-flags';
import type { ApiToken, ApiTokenEvent, ApiTokenFacets, ApiTokenFilter, ApiTokenOrigin, ApiTokenScope, ApiTokensPage, CreatedApiToken } from '../lib/types';
import { ConfirmDialog, Modal } from './Modal';
import { formatDate, formatDateTime, formatNumber } from '../lib/format';
import { tk, useTranslation } from '../i18n';
import { dayStart } from './SecurityEventsView';

const SCOPES: { key: ApiTokenScope; label: string; short: string; hint: string }[] = [
  { key: 'read', label: tk('Ler'), short: tk('ler'), hint: tk('máquinas, projetos, abas, contas de IA e a tela dos terminais') },
  { key: 'tasks', label: tk('Tarefas'), short: tk('tarefas'), hint: tk('criar, editar, mover e excluir tarefas e subtarefas') },
  { key: 'terminals', label: tk('Terminais'), short: tk('terminais'), hint: tk('abrir abas, digitar e iniciar agentes nas suas máquinas') },
  { key: 'memory', label: tk('Memória (gravar anotações)'), short: tk('memória'), hint: tk('anotar decisões no chat, para consultar depois') },
  // Personal runs API (TER-1176): offered only while `runs_api` is on; the server refuses it otherwise.
  { key: 'runs', label: tk('Runs'), short: tk('runs'), hint: tk('Executar prompts nas suas contas e máquinas') },
];
/** Scopes offered only behind a feature flag (the list of existing tokens still names them). */
const FLAGGED_SCOPES: ApiTokenScope[] = ['runs'];
const EXPIRY: { value: string; label: string }[] = [
  { value: '30', label: tk('30 dias') },
  { value: '90', label: tk('90 dias') },
  { value: '365', label: tk('1 ano') },
  { value: '', label: tk('Sem validade') },
];

/** Where each token came from (TER-1191), as the table and the origin filter name it. */
export const ORIGIN_LABELS: Record<ApiTokenOrigin, string> = {
  person: tk('Criado por você'),
  concierge: tk('Chat (concierge)'),
  tab: tk('Aba de agente'),
  automation: tk('Automação'),
};

const ORIGIN_OPTIONS: { value: string; label: string }[] = [
  { value: 'person', label: tk('Criados por mim') },
  { value: 'system', label: tk('Gerados pelo sistema') },
  { value: 'concierge', label: tk('Chat (concierge)') },
  { value: 'tab', label: tk('Aba de agente') },
  { value: 'automation', label: tk('Automação') },
  { value: '', label: tk('Todas as origens') },
];

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: 'active', label: tk('Ativos') },
  { value: 'expired', label: tk('Expirados') },
  { value: 'revoked', label: tk('Revogados') },
  { value: '', label: tk('Todos os estados') },
];

export type TokenStatus = 'active' | 'expired' | 'revoked';

export function tokenStatus(t: ApiToken, now = new Date()): TokenStatus {
  if (t.revoked_at) return 'revoked';
  if (t.expires_at && new Date(t.expires_at) <= now) return 'expired';
  return 'active';
}

export function mcpAddCommand(url: string, token: string): string {
  return `claude mcp add --transport http termhub ${url} --header "Authorization: Bearer ${token}"`;
}

const fmtDate = (iso: string | null, empty: string) => (iso ? formatDate(iso) : empty);

/** The filter form as typed: dates are local calendar days (`2026-11-16`), empty strings mean "any". */
export interface TokenDraft {
  origin: string;
  status: string;
  project_id: string;
  machine_id: string;
  scope: string;
  created_from: string;
  created_to: string;
  used_from: string;
  used_to: string;
  q: string;
}

/** The screen opens on "criados por mim · ativos" (TER-1191). */
export const DEFAULT_DRAFT: TokenDraft = { origin: 'person', status: 'active', project_id: '', machine_id: '', scope: '', created_from: '', created_to: '', used_from: '', used_to: '', q: '' };

/** The query the server gets for a draft: a day's end is the start of the next one (exclusive). */
export function filterOfDraft(d: TokenDraft): ApiTokenFilter {
  return {
    origin: (d.origin || undefined) as ApiTokenFilter['origin'],
    status: (d.status || undefined) as ApiTokenFilter['status'],
    project_id: d.project_id || undefined,
    machine_id: d.machine_id || undefined,
    scope: (d.scope || undefined) as ApiTokenScope | undefined,
    created_from: dayStart(d.created_from),
    created_to: dayStart(d.created_to, 1),
    used_from: dayStart(d.used_from),
    used_to: dayStart(d.used_to, 1),
    q: d.q.trim() || undefined,
  };
}

/** Where a token acts, by name when the server still knows it, else by id; empty for a person's own. */
export function tokenPlace(tok: ApiToken): string {
  return [tok.project_name ?? tok.project_id, tok.machine_name ?? tok.machine_id].filter(Boolean).join(' · ');
}

/** One server-paged list of tokens: the first page for a filter, then "Carregar mais" (TER-1191). */
function useTokenPages(filter: ApiTokenFilter | null, onError: (message: string) => void) {
  const { t } = useTranslation();
  const [tokens, setTokens] = useState<ApiToken[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [meta, setMeta] = useState<Pick<ApiTokensPage, 'system' | 'retention'> | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  // a slow answer for an older filter never overwrites the current one
  const seq = useRef(0);

  const load = useCallback(
    async (f: ApiTokenFilter, before: string | null) => {
      const mine = before ? seq.current : ++seq.current;
      try {
        const page = await api.apiTokens.list(f, before);
        if (mine !== seq.current) return;
        setTokens((cur) => (before ? [...(cur ?? []), ...page.tokens] : page.tokens));
        setNext(page.next);
        setMeta({ system: page.system, retention: page.retention });
      } catch (e) {
        if (mine === seq.current) onError(e instanceof ApiError ? e.message : t('Erro ao carregar tokens'));
      }
    },
    [onError],
  );

  useEffect(() => {
    if (!filter) return;
    setTokens(null);
    setNext(null);
    void load(filter, null);
  }, [filter, load]);

  const more = async () => {
    if (!filter || !next) return;
    setLoadingMore(true);
    await load(filter, next);
    setLoadingMore(false);
  };
  const reload = () => filter && void load(filter, null);
  const replace = (tok: ApiToken) => setTokens((list) => (list ?? []).map((x) => (x.id === tok.id ? { ...x, ...tok } : x)));
  const prepend = (tok: ApiToken) => setTokens((list) => [tok, ...(list ?? [])]);
  return { tokens, next, meta, loadingMore, more, reload, replace, prepend };
}

/** Settings → Tokens de API: the signed-in user's tokens for the MCP endpoint, paged and filtered on the server (TER-1191). */
export function ApiTokensView() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const [draft, setDraft] = useState<TokenDraft>(DEFAULT_DRAFT);
  const [filter, setFilter] = useState<ApiTokenFilter>(() => filterOfDraft(DEFAULT_DRAFT));
  const [facets, setFacets] = useState<ApiTokenFacets>({ projects: [], machines: [] });
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedApiToken | null>(null);
  const [revoking, setRevoking] = useState<ApiToken | null>(null);
  const [activity, setActivity] = useState<ApiToken | null>(null);
  const [systemOpen, setSystemOpen] = useState(false);
  const [confirmIdle, setConfirmIdle] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const onError = useCallback((message: string) => setError(message), []);
  const main = useTokenPages(filter, onError);
  // The system group: its own list, loaded only once someone opens it, so the default screen stays light.
  const systemFilter = useRef<ApiTokenFilter>({ origin: 'system', status: 'active' });
  const system = useTokenPages(systemOpen ? systemFilter.current : null, onError);
  const summary = main.meta?.system ?? null;
  const retention = main.meta?.retention ?? null;
  const ownView = filter.origin === 'person';

  useEffect(() => {
    void api.apiTokens
      .facets()
      .then(setFacets)
      .catch(() => {});
  }, []);

  const apply = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setFilter(filterOfDraft(draft));
  };

  const clear = () => {
    setDraft(DEFAULT_DRAFT);
    setFilter(filterOfDraft(DEFAULT_DRAFT));
  };

  const revoke = async () => {
    const tok = revoking;
    setRevoking(null);
    if (!tok) return;
    setError(null);
    try {
      const r = await api.apiTokens.revoke(tok.id);
      main.replace(r.api_token);
      system.replace(r.api_token);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('Erro ao revogar token'));
    }
  };

  const revokeIdle = async () => {
    setConfirmIdle(false);
    setError(null);
    try {
      const { revoked } = await api.apiTokens.revokeIdle();
      setNotice(t('{{count}} tokens do sistema revogados.', { count: revoked }));
      main.reload();
      if (systemOpen) system.reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('Erro ao revogar token'));
    }
  };

  const field = (key: keyof TokenDraft) => ({ value: draft[key], onChange: (e: { target: { value: string } }) => setDraft({ ...draft, [key]: e.target.value }) });
  const facetName = (x: { id: string; name: string | null }) => x.name ?? x.id;

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-4">
        <p className="flex-1 text-sm text-fg-muted">
          {t('Tokens pessoais para o terminal global (MCP): um Claude Code com o token consegue agir nas suas máquinas dentro dos escopos escolhidos, nunca além das suas próprias permissões. Trate como senha.')}
        </p>
        {can('api_tokens', 'create') && (
          <button className="btn-primary shrink-0" onClick={() => setCreating(true)}>
            {t('Novo token')}
          </button>
        )}
      </div>

      <form onSubmit={apply} className="flex flex-wrap items-end gap-3" aria-label={t('Filtros de tokens')}>
        <div>
          <label className="label" htmlFor="tokens-origin">
            {t('Origem')}
          </label>
          <select id="tokens-origin" className="input w-auto py-1 text-sm" {...field('origin')}>
            {ORIGIN_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {t(o.label)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="tokens-status">
            {t('Estado')}
          </label>
          <select id="tokens-status" className="input w-auto py-1 text-sm" {...field('status')}>
            {STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {t(o.label)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="tokens-project">
            {t('Projeto')}
          </label>
          <select id="tokens-project" className="input w-auto max-w-48 py-1 text-sm" {...field('project_id')}>
            <option value="">{t('Todos')}</option>
            {facets.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {facetName(p)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="tokens-machine">
            {t('Máquina')}
          </label>
          <select id="tokens-machine" className="input w-auto max-w-48 py-1 text-sm" {...field('machine_id')}>
            <option value="">{t('Todas')}</option>
            {facets.machines.map((m) => (
              <option key={m.id} value={m.id}>
                {facetName(m)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="tokens-scope">
            {t('Escopo')}
          </label>
          <select id="tokens-scope" className="input w-auto py-1 text-sm" {...field('scope')}>
            <option value="">{t('Todos')}</option>
            {SCOPES.map((s) => (
              <option key={s.key} value={s.key}>
                {t(s.label)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <span className="label">{t('Criado')}</span>
          <div className="flex gap-1">
            <input type="date" className="input py-1 text-sm" aria-label={t('Criado de')} {...field('created_from')} />
            <input type="date" className="input py-1 text-sm" aria-label={t('Criado até')} {...field('created_to')} />
          </div>
        </div>
        <div>
          <span className="label">{t('Último uso')}</span>
          <div className="flex gap-1">
            <input type="date" className="input py-1 text-sm" aria-label={t('Último uso de')} {...field('used_from')} />
            <input type="date" className="input py-1 text-sm" aria-label={t('Último uso até')} {...field('used_to')} />
          </div>
        </div>
        <div className="min-w-48 flex-1">
          <label className="label" htmlFor="tokens-q">
            {t('Buscar pelo nome')}
          </label>
          <input id="tokens-q" className="input py-1 text-sm" maxLength={80} {...field('q')} />
        </div>
        <button type="submit" className="btn-primary py-1">
          {t('Filtrar')}
        </button>
        <button type="button" className="btn-ghost border border-line py-1" onClick={clear}>
          {t('Limpar')}
        </button>
      </form>

      {error && <p className="text-sm text-danger">{error}</p>}
      {notice && <p className="text-sm text-fg-muted">{notice}</p>}

      <TokenTable
        tokens={main.tokens}
        empty={ownView && filter.status === 'active' ? t('Nenhum token seu ativo.') : t('Nenhum token com esses filtros.')}
        showOrigin={!ownView}
        onActivity={setActivity}
        onRevoke={can('api_tokens', 'delete') ? setRevoking : undefined}
      />
      {main.next && (
        <button className="btn-ghost border border-line py-1 text-sm" disabled={main.loadingMore} onClick={() => void main.more()}>
          {main.loadingMore ? t('Carregando…') : t('Carregar mais')}
        </button>
      )}

      {ownView && summary && (
        <section className="rounded border border-line">
          <div className="flex flex-wrap items-center gap-3 px-3 py-2">
            <button type="button" className="flex-1 text-left text-sm" aria-expanded={systemOpen} onClick={() => setSystemOpen((o) => !o)}>
              <span aria-hidden className="mr-1 inline-block w-3">{systemOpen ? '▾' : '▸'}</span>
              {t('Gerados pelo sistema')} <span className="text-fg-dim">· {t('{{count}} ativos', { count: summary.active })}</span>
            </button>
            {can('api_tokens', 'delete') && summary.idle > 0 && (
              <button className="btn-ghost px-2 py-0.5 text-xs text-danger" onClick={() => setConfirmIdle(true)}>
                {t('Revogar inativos ({{count}})', { count: summary.idle })}
              </button>
            )}
          </div>
          {systemOpen && (
            <div className="space-y-3 border-t border-line px-3 py-2">
              <p className="text-xs text-fg-dim">
                {t('O termhub gera um token para cada execução do chat e para cada aba de agente, com escopo mínimo e vida curta, e revoga quando a conversa ou a aba acaba.')}
                {retention && <> {t('Revogados e expirados somem depois de {{days}} dias.', { days: retention.system_days })}</>}
                {' '}
                {t('Use a origem "Gerados pelo sistema" nos filtros para ver também os revogados.')}
              </p>
              <TokenTable tokens={system.tokens} empty={t('Nenhum token do sistema ativo.')} showOrigin onActivity={setActivity} onRevoke={can('api_tokens', 'delete') ? setRevoking : undefined} />
              {system.next && (
                <button className="btn-ghost border border-line py-1 text-sm" disabled={system.loadingMore} onClick={() => void system.more()}>
                  {system.loadingMore ? t('Carregando…') : t('Carregar mais')}
                </button>
              )}
            </div>
          )}
        </section>
      )}
      {retention && (
        <p className="text-xs text-fg-dim">{t('Os tokens que você revoga somem da lista depois de {{days}} dias.', { days: retention.person_revoked_days })}</p>
      )}

      {creating && (
        <CreateTokenModal
          onClose={() => setCreating(false)}
          onCreated={(c) => {
            setCreating(false);
            setCreated(c);
            if (ownView) main.prepend(c.api_token);
          }}
        />
      )}
      {created && <CreatedTokenModal created={created} onClose={() => setCreated(null)} />}
      {activity && <TokenActivityModal token={activity} onClose={() => setActivity(null)} />}
      <ConfirmDialog
        open={!!revoking}
        title={t('Revogar token')}
        message={t('O token "{{name}}" para de funcionar na hora. Isso não pode ser desfeito.', { name: revoking?.name ?? '' })}
        confirmLabel={t('Revogar')}
        danger
        onConfirm={revoke}
        onCancel={() => setRevoking(null)}
      />
      <ConfirmDialog
        open={confirmIdle}
        title={t('Revogar inativos')}
        message={t('Revoga os {{count}} tokens do sistema sem uso há {{days}} dias. Uma aba de agente ainda aberta perde o acesso à memória até o agente ser reiniciado. Os seus tokens não são tocados.', {
          count: summary?.idle ?? 0,
          days: retention?.idle_days ?? 7,
        })}
        confirmLabel={t('Revogar')}
        danger
        onConfirm={revokeIdle}
        onCancel={() => setConfirmIdle(false)}
      />
    </div>
  );
}

function TokenTable({
  tokens,
  empty,
  showOrigin,
  onActivity,
  onRevoke,
}: {
  tokens: ApiToken[] | null;
  empty: string;
  showOrigin: boolean;
  onActivity: (tok: ApiToken) => void;
  onRevoke?: (tok: ApiToken) => void;
}) {
  const { t } = useTranslation();
  if (tokens === null) return <p className="text-sm text-fg-dim">{t('Carregando…')}</p>;
  if (tokens.length === 0) return <p className="text-sm text-fg-dim">{empty}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-fg-dim">
          <tr>
            <th className="py-1 pr-3 font-normal">{t('Nome')}</th>
            {showOrigin && <th className="py-1 pr-3 font-normal">{t('Origem')}</th>}
            {showOrigin && <th className="py-1 pr-3 font-normal">{t('Projeto · máquina')}</th>}
            <th className="py-1 pr-3 font-normal">{t('Escopos')}</th>
            <th className="py-1 pr-3 font-normal">{t('Criado')}</th>
            <th className="py-1 pr-3 font-normal">{t('Último uso')}</th>
            <th className="py-1 pr-3 font-normal">{t('Validade')}</th>
            <th className="py-1 font-normal" />
          </tr>
        </thead>
        <tbody>
          {tokens.map((tok) => {
            const status = tokenStatus(tok);
            return (
              <tr key={tok.id} className={`border-t border-line ${status === 'active' ? '' : 'text-fg-dim'}`}>
                <td className="py-1.5 pr-3">{tok.name}</td>
                {showOrigin && <td className="py-1.5 pr-3">{t(ORIGIN_LABELS[tok.origin] ?? tok.origin)}</td>}
                {showOrigin && <td className="py-1.5 pr-3">{tokenPlace(tok) || '—'}</td>}
                <td className="py-1.5 pr-3">{tok.scopes.map((s) => { const short = SCOPES.find((x) => x.key === s)?.short; return short ? t(short) : s; }).join(', ')}</td>
                <td className="py-1.5 pr-3">{fmtDate(tok.created_at, '—')}</td>
                <td className="py-1.5 pr-3">{fmtDate(tok.last_used_at, t('nunca'))}</td>
                <td className="py-1.5 pr-3">{status === 'revoked' ? t('revogado') : status === 'expired' ? t('expirado') : fmtDate(tok.expires_at, t('sem validade'))}</td>
                <td className="whitespace-nowrap py-1.5 text-right">
                  <button className="btn-ghost px-2 py-0.5 text-xs" aria-label={t('Atividade de {{name}}', { name: tok.name })} onClick={() => onActivity(tok)}>
                    {t('Atividade')}
                  </button>
                  {status !== 'revoked' && onRevoke && (
                    <button className="btn-ghost px-2 py-0.5 text-xs text-danger" aria-label={t('Revogar {{name}}', { name: tok.name })} onClick={() => onRevoke(tok)}>
                      {t('Revogar')}
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function CreateTokenModal({ onClose, onCreated }: { onClose: () => void; onCreated: (c: CreatedApiToken) => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<ApiTokenScope[]>([]);
  const [expiry, setExpiry] = useState('90');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const runsApi = useFeatureFlag('runs_api');
  const offered = SCOPES.filter((s) => runsApi || !FLAGGED_SCOPES.includes(s.key));

  const toggle = (s: ApiTokenScope) => setScopes((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const ordered = offered.map((s) => s.key).filter((k) => scopes.includes(k));
      onCreated(await api.apiTokens.create({ name: name.trim(), scopes: ordered, expires_in_days: expiry ? Number(expiry) : null }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('Erro ao criar token'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={t('Novo token de API')} open onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <div>
          <label className="label" htmlFor="api-token-name">
            {t('Nome')}
          </label>
          <input id="api-token-name" className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus placeholder={t('ex.: Claude Code no jarvis')} />
        </div>
        <fieldset className="space-y-1.5">
          <legend className="label">{t('Escopos')}</legend>
          {offered.map((s) => (
            <label key={s.key} className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1" checked={scopes.includes(s.key)} onChange={() => toggle(s.key)} />
              <span>
                <strong>{t(s.label)}</strong> <span className="text-fg-muted">— {t(s.hint)}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <div>
          <label className="label" htmlFor="api-token-expiry">
            {t('Validade')}
          </label>
          <select id="api-token-expiry" className="input" value={expiry} onChange={(e) => setExpiry(e.target.value)}>
            {EXPIRY.map((o) => (
              <option key={o.label} value={o.value}>
                {t(o.label)}
              </option>
            ))}
          </select>
        </div>
        {error && <p className="text-sm text-danger">{error}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            {t('Cancelar')}
          </button>
          <button type="submit" className="btn-primary" disabled={busy || !name.trim() || scopes.length === 0}>
            {busy ? t('Criando…') : t('Criar token')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Where a call acted, by the names the rows have now. */
export function eventPlace(e: ApiTokenEvent): string {
  return [e.machine_name ?? e.machine_id, e.project_name ?? e.project_id, e.tab_name ?? e.tab_id].filter(Boolean).join(' · ');
}

/** The token's MCP calls (TER-577): what it did, where, whether it worked. Metadata only. */
function TokenActivityModal({ token, onClose }: { token: ApiToken; onClose: () => void }) {
  const { t } = useTranslation();
  const [events, setEvents] = useState<ApiTokenEvent[] | null>(null);
  const [retention, setRetention] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.apiTokens
      .events(token.id)
      .then((r) => {
        if (!live) return;
        setEvents(r.events);
        setRetention(r.retention_days);
      })
      .catch((e: unknown) => live && setError(e instanceof ApiError ? e.message : t('Erro ao carregar a atividade')));
    return () => {
      live = false;
    };
  }, [token.id]);

  return (
    <Modal title={t('Atividade de {{name}}', { name: token.name })} open onClose={onClose} width="max-w-3xl">
      <div className="space-y-3">
        {retention !== null && <p className="text-xs text-fg-dim">{t('Chamadas ao MCP dos últimos {{days}} dias, as mais recentes primeiro.', { days: retention })}</p>}
        {error && <p className="text-sm text-danger">{error}</p>}
        {events === null ? (
          !error && <p className="text-sm text-fg-dim">{t('Carregando…')}</p>
        ) : events.length === 0 ? (
          <p className="text-sm text-fg-dim">{t('Nenhuma chamada registrada.')}</p>
        ) : (
          <div className="max-h-[60vh] overflow-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-fg-dim">
                <tr>
                  <th className="py-1 pr-3 font-normal">{t('Quando')}</th>
                  <th className="py-1 pr-3 font-normal">{t('Ferramenta')}</th>
                  <th className="py-1 pr-3 font-normal">{t('Onde')}</th>
                  <th className="py-1 pr-3 font-normal">{t('Resultado')}</th>
                  <th className="py-1 text-right font-normal">{t('Duração')}</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e) => (
                  <tr key={e.id} className="border-t border-line">
                    <td className="whitespace-nowrap py-1.5 pr-3">{formatDateTime(e.created_at)}</td>
                    <td className="py-1.5 pr-3 font-mono text-xs">{e.tool}</td>
                    <td className="py-1.5 pr-3">{eventPlace(e) || '—'}</td>
                    <td className={`py-1.5 pr-3 ${e.ok ? '' : 'text-danger'}`}>{e.ok ? t('ok') : (e.error_code ?? t('erro'))}</td>
                    <td className="whitespace-nowrap py-1.5 text-right">{t('{{ms}} ms', { ms: formatNumber(e.duration_ms) })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="flex justify-end pt-2">
          <button className="btn-primary" onClick={onClose}>
            {t('Fechar')}
          </button>
        </div>
      </div>
    </Modal>
  );
}

type CopyState = 'idle' | 'copied' | 'failed';

function CopyField({ label, value }: { label: string; value: string }) {
  const { t } = useTranslation();
  const [state, setState] = useState<CopyState>('idle');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (state !== 'copied') return;
    const id = setTimeout(() => setState('idle'), 2000);
    return () => clearTimeout(id);
  }, [state]);

  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('no clipboard API');
      await navigator.clipboard.writeText(value);
      setState('copied');
    } catch {
      inputRef.current?.select();
      setState('failed');
    }
  };

  return (
    <div>
      <label className="label">{label}</label>
      <div className="flex gap-2">
        <input ref={inputRef} className="input font-mono text-xs" readOnly value={value} onFocus={(e) => e.currentTarget.select()} />
        <button type="button" className="btn-ghost shrink-0 border border-line" onClick={() => void copy()}>
          {state === 'copied' ? t('Copiado') : state === 'failed' ? t('Selecione e copie') : t('Copiar')}
        </button>
      </div>
    </div>
  );
}

function CreatedTokenModal({ created, onClose }: { created: CreatedApiToken; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <Modal title={t('Token criado')} open onClose={onClose} width="max-w-2xl" dismissible={false}>
      <div className="space-y-3">
        <p className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn">{t('Copie agora: este token não aparece de novo. Se perder, revogue e crie outro.')}</p>
        <CopyField label={t('Token')} value={created.token} />
        {created.mcp_url && (
          <>
            <CopyField label={t('Conectar o Claude Code')} value={mcpAddCommand(created.mcp_url, created.token)} />
            <p className="text-xs text-fg-dim">{t('Rode no terminal da máquina onde está o Claude Code que vai ser o terminal global.')}</p>
          </>
        )}
        <div className="flex justify-end pt-2">
          <button className="btn-primary" onClick={onClose}>
            {t('Concluído')}
          </button>
        </div>
      </div>
    </Modal>
  );
}
