import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import type { ApiToken, ApiTokenScope, CreatedApiToken } from '../lib/types';
import { ConfirmDialog, Modal } from './Modal';
import { formatDate } from '../lib/format';

const SCOPES: { key: ApiTokenScope; label: string; short: string; hint: string }[] = [
  { key: 'read', label: 'Ler', short: 'ler', hint: 'máquinas, projetos, abas, contas de IA e a tela dos terminais' },
  { key: 'tasks', label: 'Tarefas', short: 'tarefas', hint: 'criar, editar, mover e excluir tarefas e subtarefas' },
  { key: 'terminals', label: 'Terminais', short: 'terminais', hint: 'abrir abas, digitar e iniciar agentes nas suas máquinas' },
  { key: 'memory', label: 'Memória (gravar anotações)', short: 'memória', hint: 'anotar decisões no chat, para consultar depois' },
];
const EXPIRY: { value: string; label: string }[] = [
  { value: '30', label: '30 dias' },
  { value: '90', label: '90 dias' },
  { value: '365', label: '1 ano' },
  { value: '', label: 'Sem validade' },
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
  const { can } = useAuth();
  const [tokens, setTokens] = useState<ApiToken[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedApiToken | null>(null);
  const [revoking, setRevoking] = useState<ApiToken | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setTokens((await api.apiTokens.list()).tokens);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Erro ao carregar tokens');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const revoke = async () => {
    const t = revoking;
    setRevoking(null);
    if (!t) return;
    setError(null);
    try {
      const r = await api.apiTokens.revoke(t.id);
      setTokens((list) => (list ?? []).map((x) => (x.id === t.id ? r.api_token : x)));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Erro ao revogar token');
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-4">
        <p className="flex-1 text-sm text-fg-muted">
          Tokens pessoais para o terminal global (MCP): um Claude Code com o token consegue agir nas suas máquinas dentro dos escopos escolhidos, nunca além das suas próprias permissões. Trate como senha.
        </p>
        {can('api_tokens', 'create') && (
          <button className="btn-primary shrink-0" onClick={() => setCreating(true)}>
            Novo token
          </button>
        )}
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
      {tokens === null ? (
        <p className="text-sm text-fg-dim">Carregando…</p>
      ) : tokens.length === 0 ? (
        <p className="text-sm text-fg-dim">Nenhum token ainda.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-fg-dim">
              <tr>
                <th className="py-1 pr-3 font-normal">Nome</th>
                <th className="py-1 pr-3 font-normal">Escopos</th>
                <th className="py-1 pr-3 font-normal">Criado</th>
                <th className="py-1 pr-3 font-normal">Último uso</th>
                <th className="py-1 pr-3 font-normal">Validade</th>
                <th className="py-1 font-normal" />
              </tr>
            </thead>
            <tbody>
              {tokens.map((t) => {
                const status = tokenStatus(t);
                return (
                  <tr key={t.id} className={`border-t border-line ${status === 'active' ? '' : 'text-fg-dim'}`}>
                    <td className="py-1.5 pr-3">{t.name}</td>
                    <td className="py-1.5 pr-3">{t.scopes.map((s) => SCOPES.find((x) => x.key === s)?.short ?? s).join(', ')}</td>
                    <td className="py-1.5 pr-3">{fmtDate(t.created_at, '—')}</td>
                    <td className="py-1.5 pr-3">{fmtDate(t.last_used_at, 'nunca')}</td>
                    <td className="py-1.5 pr-3">
                      {status === 'revoked' ? 'revogado' : status === 'expired' ? 'expirado' : fmtDate(t.expires_at, 'sem validade')}
                    </td>
                    <td className="py-1.5 text-right">
                      {status !== 'revoked' && can('api_tokens', 'delete') && (
                        <button className="btn-ghost px-2 py-0.5 text-xs text-danger" aria-label={`Revogar ${t.name}`} onClick={() => setRevoking(t)}>
                          Revogar
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
      <ConfirmDialog
        open={!!revoking}
        title="Revogar token"
        message={`O token "${revoking?.name ?? ''}" para de funcionar na hora. Isso não pode ser desfeito.`}
        confirmLabel="Revogar"
        danger
        onConfirm={revoke}
        onCancel={() => setRevoking(null)}
      />
    </div>
  );
}

function CreateTokenModal({ onClose, onCreated }: { onClose: () => void; onCreated: (c: CreatedApiToken) => void }) {
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
      setError(err instanceof ApiError ? err.message : 'Erro ao criar token');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Novo token de API" open onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <div>
          <label className="label" htmlFor="api-token-name">
            Nome
          </label>
          <input id="api-token-name" className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus placeholder="ex.: Claude Code no jarvis" />
        </div>
        <fieldset className="space-y-1.5">
          <legend className="label">Escopos</legend>
          {SCOPES.map((s) => (
            <label key={s.key} className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1" checked={scopes.includes(s.key)} onChange={() => toggle(s.key)} />
              <span>
                <strong>{s.label}</strong> <span className="text-fg-muted">— {s.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <div>
          <label className="label" htmlFor="api-token-expiry">
            Validade
          </label>
          <select id="api-token-expiry" className="input" value={expiry} onChange={(e) => setExpiry(e.target.value)}>
            {EXPIRY.map((o) => (
              <option key={o.label} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        {error && <p className="text-sm text-danger">{error}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="btn-primary" disabled={busy || !name.trim() || scopes.length === 0}>
            {busy ? 'Criando…' : 'Criar token'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

type CopyState = 'idle' | 'copied' | 'failed';

function CopyField({ label, value }: { label: string; value: string }) {
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
          {state === 'copied' ? 'Copiado' : state === 'failed' ? 'Selecione e copie' : 'Copiar'}
        </button>
      </div>
    </div>
  );
}

function CreatedTokenModal({ created, onClose }: { created: CreatedApiToken; onClose: () => void }) {
  return (
    <Modal title="Token criado" open onClose={onClose} width="max-w-2xl" dismissible={false}>
      <div className="space-y-3">
        <p className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn">Copie agora: este token não aparece de novo. Se perder, revogue e crie outro.</p>
        <CopyField label="Token" value={created.token} />
        {created.mcp_url && (
          <>
            <CopyField label="Conectar o Claude Code" value={mcpAddCommand(created.mcp_url, created.token)} />
            <p className="text-xs text-fg-dim">Rode no terminal da máquina onde está o Claude Code que vai ser o terminal global.</p>
          </>
        )}
        <div className="flex justify-end pt-2">
          <button className="btn-primary" onClick={onClose}>
            Concluído
          </button>
        </div>
      </div>
    </Modal>
  );
}
