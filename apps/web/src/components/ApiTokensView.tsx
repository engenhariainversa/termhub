import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import type { ApiToken, ApiTokenEvent, ApiTokenScope, CreatedApiToken } from '../lib/types';
import { ConfirmDialog, Modal } from './Modal';
import { formatDate, formatDateTime, formatNumber } from '../lib/format';
import { tk, useTranslation } from '../i18n';

const SCOPES: { key: ApiTokenScope; label: string; short: string; hint: string }[] = [
  { key: 'read', label: tk('Ler'), short: tk('ler'), hint: tk('máquinas, projetos, abas, contas de IA e a tela dos terminais') },
  { key: 'tasks', label: tk('Tarefas'), short: tk('tarefas'), hint: tk('criar, editar, mover e excluir tarefas e subtarefas') },
  { key: 'terminals', label: tk('Terminais'), short: tk('terminais'), hint: tk('abrir abas, digitar e iniciar agentes nas suas máquinas') },
  { key: 'memory', label: tk('Memória (gravar anotações)'), short: tk('memória'), hint: tk('anotar decisões no chat, para consultar depois') },
];
const EXPIRY: { value: string; label: string }[] = [
  { value: '30', label: tk('30 dias') },
  { value: '90', label: tk('90 dias') },
  { value: '365', label: tk('1 ano') },
  { value: '', label: tk('Sem validade') },
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

/** Settings → Tokens de API: the signed-in user's own tokens for the MCP endpoint. */
export function ApiTokensView() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const [tokens, setTokens] = useState<ApiToken[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedApiToken | null>(null);
  const [revoking, setRevoking] = useState<ApiToken | null>(null);
  const [activity, setActivity] = useState<ApiToken | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setTokens((await api.apiTokens.list()).tokens);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('Erro ao carregar tokens'));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const revoke = async () => {
    const tok = revoking;
    setRevoking(null);
    if (!tok) return;
    setError(null);
    try {
      const r = await api.apiTokens.revoke(tok.id);
      setTokens((list) => (list ?? []).map((x) => (x.id === tok.id ? r.api_token : x)));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('Erro ao revogar token'));
    }
  };

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
      {error && <p className="text-sm text-danger">{error}</p>}
      {tokens === null ? (
        <p className="text-sm text-fg-dim">{t('Carregando…')}</p>
      ) : tokens.length === 0 ? (
        <p className="text-sm text-fg-dim">{t('Nenhum token ainda.')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-fg-dim">
              <tr>
                <th className="py-1 pr-3 font-normal">{t('Nome')}</th>
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
                    <td className="py-1.5 pr-3">{tok.scopes.map((s) => { const short = SCOPES.find((x) => x.key === s)?.short; return short ? t(short) : s; }).join(', ')}</td>
                    <td className="py-1.5 pr-3">{fmtDate(tok.created_at, '—')}</td>
                    <td className="py-1.5 pr-3">{fmtDate(tok.last_used_at, t('nunca'))}</td>
                    <td className="py-1.5 pr-3">
                      {status === 'revoked' ? t('revogado') : status === 'expired' ? t('expirado') : fmtDate(tok.expires_at, t('sem validade'))}
                    </td>
                    <td className="whitespace-nowrap py-1.5 text-right">
                      <button className="btn-ghost px-2 py-0.5 text-xs" aria-label={t('Atividade de {{name}}', { name: tok.name })} onClick={() => setActivity(tok)}>
                        {t('Atividade')}
                      </button>
                      {status !== 'revoked' && can('api_tokens', 'delete') && (
                        <button className="btn-ghost px-2 py-0.5 text-xs text-danger" aria-label={t('Revogar {{name}}', { name: tok.name })} onClick={() => setRevoking(tok)}>
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
      )}

      {creating && (
        <CreateTokenModal
          onClose={() => setCreating(false)}
          onCreated={(c) => {
            setCreating(false);
            setCreated(c);
            setTokens((list) => [c.api_token, ...(list ?? [])]);
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

  const toggle = (s: ApiTokenScope) => setScopes((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const ordered = SCOPES.map((s) => s.key).filter((k) => scopes.includes(k));
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
          {SCOPES.map((s) => (
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
