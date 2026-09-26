import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../lib/api';
import { useData } from '../lib/data';
import { AI_PROVIDER_LABEL, type AiAccount, type AiAccountUsage, type AiProvider, type AiUsageWindow } from '../lib/types';
import { AutoSwapSettings } from './AutoSwapSettings';
import { ConfirmDialog, Modal } from './Modal';

const PROVIDERS: AiProvider[] = ['claude', 'chatgpt', 'gemini', 'antigravity'];

const PROVIDER_HINT: Record<AiProvider, string> = {
  claude: 'Lê o login do Claude Code na máquina (~/.claude). Para uma segunda conta (ex.: a da empresa), faça login com CLAUDE_CONFIG_DIR=~/.claude-work claude e informe o diretório aqui.',
  chatgpt: 'Lê o login do Codex CLI na máquina (~/.codex). Entre com "Sign in with ChatGPT" — login por API key não tem limite de plano.',
  gemini: 'Lê o login do Gemini CLI na máquina (~/.gemini). Entre com a conta Google — login por API key não tem cota de plano.',
  antigravity: 'Lê o login do Antigravity CLI na máquina (~/.gemini/antigravity-cli/antigravity-oauth-token; o diretório de config é ~/.gemini). Rode `agy` e entre com a conta Google do plano AI Pro/Ultra — login por API key não tem cota de plano.',
};

const PROVIDER_STYLE: Record<AiProvider, string> = {
  claude: 'bg-[#d97757]/15 text-[#e8956f]',
  chatgpt: 'bg-[#10a37f]/15 text-[#3fcfa5]',
  gemini: 'bg-[#4f8cff]/15 text-[#79c0ff]',
  antigravity: 'bg-[#a78bfa]/15 text-[#c4b5fd]',
};

const PROVIDER_DIR: Record<AiProvider, string> = {
  claude: '~/.claude',
  chatgpt: '~/.codex',
  gemini: '~/.gemini',
  antigravity: '~/.gemini',
};

function countdown(iso: string | null, now: number): string | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - now;
  if (ms <= 0) return 'agora';
  const m = Math.ceil(ms / 60000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${m % 60 ? `${m % 60} min` : ''}`.trim();
  const d = Math.floor(h / 24);
  return `${d} d ${h % 24} h`;
}

function relative(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 5) return 'agora';
  if (s < 60) return `há ${s} s`;
  return `há ${Math.round(s / 60)} min`;
}

function barColor(pct: number): string {
  if (pct >= 90) return 'bg-danger';
  if (pct >= 70) return 'bg-warn';
  return 'bg-ok';
}

function WindowBar({ w, now }: { w: AiUsageWindow; now: number }) {
  const pct = Math.round(w.utilization);
  const reset = countdown(w.resets_at, now);
  return (
    <li>
      <div className="mb-1 flex items-baseline justify-between text-xs">
        <span className="text-fg-muted">{w.label}</span>
        <span className="tabular-nums">
          <span className={pct >= 90 ? 'text-danger' : pct >= 70 ? 'text-warn' : 'text-fg'}>{pct}%</span>
          {reset && <span className="text-fg-dim"> · reseta em {reset}</span>}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-bg-4">
        <div className={`h-full rounded-full transition-[width] ${barColor(pct)}`} style={{ width: `${Math.min(100, Math.max(2, pct))}%` }} />
      </div>
    </li>
  );
}

function AccountCard({
  account,
  usage,
  now,
  machineName,
  onRefresh,
  onEdit,
  onDelete,
}: {
  account: AiAccount;
  usage: AiAccountUsage | undefined;
  now: number;
  machineName: string;
  onRefresh: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [refreshing, setRefreshing] = useState(false);
  const worst = usage?.ok ? Math.max(...usage.windows.map((w) => w.utilization)) : null;
  return (
    <li className={`flex flex-col rounded-lg border bg-bg-2 p-4 ${worst !== null && worst >= 90 ? 'border-danger/50' : 'border-line'}`}>
      <div className="flex items-center gap-2">
        <span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${PROVIDER_STYLE[account.provider]}`}>{AI_PROVIDER_LABEL[account.provider]}</span>
        <span className="truncate font-medium">{account.label}</span>
        {usage?.plan && <span className="rounded bg-bg-4 px-1.5 text-[10px] uppercase tracking-wide text-fg-muted">{usage.plan}</span>}
        <span className="ml-auto flex shrink-0 items-center gap-0.5">
          <button
            className="rounded px-1 text-xs text-fg-dim hover:bg-bg-3 hover:text-fg disabled:opacity-50"
            title="Atualizar agora"
            disabled={refreshing}
            onClick={() => {
              setRefreshing(true);
              Promise.resolve(onRefresh()).finally(() => setRefreshing(false));
            }}
          >
            {refreshing ? '…' : '↻'}
          </button>
          <button className="rounded px-1 text-xs text-fg-dim hover:bg-bg-3 hover:text-fg" title="Editar" onClick={onEdit}>
            ✎
          </button>
          <button className="rounded px-1 text-xs text-fg-dim hover:bg-bg-3 hover:text-danger" title="Remover" onClick={onDelete}>
            ✕
          </button>
        </span>
      </div>
      <div className="mt-0.5 truncate font-mono text-[11px] text-fg-dim" title={account.config_dir ?? undefined}>
        {machineName}
        {account.config_dir ? ` · ${account.config_dir}` : ''}
      </div>

      <div className="mt-3 flex-1">
        {!usage && <p className="text-xs text-fg-dim">Consultando…</p>}
        {usage && !usage.ok && (
          <div className="rounded border border-danger/40 bg-danger/10 p-2 text-xs">
            <p className="text-danger">{usage.error}</p>
            {usage.hint && <p className="mt-1 break-all text-fg-muted">{usage.hint}</p>}
          </div>
        )}
        {usage?.ok && (
          <ul className="space-y-2.5">
            {usage.windows.map((w) => (
              <WindowBar key={w.key} w={w} now={now} />
            ))}
          </ul>
        )}
      </div>

      {usage && (
        <div className="mt-3 border-t border-line pt-2 text-[11px] text-fg-dim">
          atualizado {relative(usage.fetched_at, now)}
          {usage.stale && <span className="text-warn"> · limite de consultas do provedor; mostrando a última leitura</span>}
        </div>
      )}
    </li>
  );
}

function AccountForm({ account, onClose, onSaved }: { account: AiAccount | null; onClose: () => void; onSaved: (a: AiAccount) => void }) {
  const { machines } = useData();
  const [provider, setProvider] = useState<AiProvider>(account?.provider ?? 'claude');
  const [label, setLabel] = useState(account?.label ?? '');
  const [machineId, setMachineId] = useState(account?.machine_id ?? machines[0]?.id ?? '');
  const [configDir, setConfigDir] = useState(account?.config_dir ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const input = { label: label || AI_PROVIDER_LABEL[provider], machine_id: machineId, config_dir: configDir.trim() || null };
      const r = account ? await api.aiAccounts.update(account.id, input) : await api.aiAccounts.create({ provider, ...input });
      onSaved(r.account);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Erro ao salvar');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={account ? 'Editar conta de IA' : 'Nova conta de IA'} open onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <div>
          <label className="label">Provedor</label>
          <div className="flex gap-1 rounded-md border border-line bg-bg p-1">
            {PROVIDERS.map((p) => (
              <button
                key={p}
                type="button"
                disabled={!!account}
                onClick={() => setProvider(p)}
                className={`flex-1 rounded px-2 py-1 text-sm disabled:opacity-60 ${provider === p ? 'bg-accent/20 text-fg' : 'text-fg-muted hover:bg-bg-3'}`}
              >
                {AI_PROVIDER_LABEL[p]}
              </button>
            ))}
          </div>
          <p className="mt-1 text-xs text-fg-dim">{PROVIDER_HINT[provider]}</p>
        </div>
        <div>
          <label className="label">Nome</label>
          <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder={`ex.: ${AI_PROVIDER_LABEL[provider]} pessoal`} autoFocus />
        </div>
        <div>
          <label className="label">Máquina onde o CLI está logado</label>
          <select className="input" value={machineId} onChange={(e) => setMachineId(e.target.value)} required>
            {machines.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Diretório de config (opcional)</label>
          <input className="input font-mono" value={configDir} onChange={(e) => setConfigDir(e.target.value)} placeholder={PROVIDER_DIR[provider]} />
        </div>
        {error && <p className="text-sm text-danger">{error}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="btn-primary" disabled={busy || !machineId}>
            {account ? 'Salvar' : 'Adicionar'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// the server caches each account for 5 min and backs off on 429, so polling faster only re-reads the cache
const POLL_MS = 5 * 60_000;

export function AiAccountsView() {
  const { machines } = useData();
  const [accounts, setAccounts] = useState<AiAccount[] | null>(null);
  const [usage, setUsage] = useState<Record<string, AiAccountUsage>>({});
  const [form, setForm] = useState<{ open: boolean; account: AiAccount | null }>({ open: false, account: null });
  const [deleting, setDeleting] = useState<AiAccount | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const loadUsage = useCallback(async (refresh = false) => {
    try {
      const r = await api.aiAccounts.usage(refresh);
      setUsage(Object.fromEntries(r.usage.map((u) => [u.account_id, u])));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Erro ao consultar os limites');
    }
  }, []);

  const loadAccounts = useCallback(async () => {
    try {
      const r = await api.aiAccounts.list();
      setAccounts(r.accounts);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Erro ao carregar as contas');
    }
  }, []);

  useEffect(() => {
    void loadAccounts().then(() => loadUsage());
    const poll = window.setInterval(() => void loadUsage(), POLL_MS);
    const tick = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      window.clearInterval(poll);
      window.clearInterval(tick);
    };
  }, [loadAccounts, loadUsage]);

  const refreshOne = async (id: string) => {
    try {
      const r = await api.aiAccounts.usageOf(id, true);
      setUsage((u) => ({ ...u, [id]: r.usage }));
      setNow(Date.now());
    } catch {
      /* card keeps the previous state */
    }
  };

  const machineName = (id: string) => machines.find((m) => m.id === id)?.name ?? '—';

  return (
    <div>
      <div className="mb-5 flex items-end gap-4">
        <div>
          <h2 className="text-lg font-semibold">Contas de IA</h2>
          <p className="text-sm text-fg-muted">Limites de uso das suas assinaturas, lidos do login dos CLIs nas máquinas. Atualiza a cada minuto.</p>
        </div>
        <span className="ml-auto flex gap-2">
          <button className="btn-ghost text-xs" onClick={() => void loadUsage(true)} title="Consultar todas agora">
            ↻ atualizar
          </button>
          <button className="btn-primary text-xs" onClick={() => setForm({ open: true, account: null })}>
            + conta
          </button>
        </span>
      </div>

      {error && <p className="mb-3 text-sm text-danger">{error}</p>}
      {accounts && accounts.length === 0 && (
        <p className="text-sm text-fg-dim">Nenhuma conta cadastrada. Adicione uma conta apontando para a máquina onde o Claude Code, Codex, Gemini CLI ou Antigravity CLI está logado.</p>
      )}

      <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {accounts?.map((a) => (
          <AccountCard
            key={a.id}
            account={a}
            usage={usage[a.id]}
            now={now}
            machineName={machineName(a.machine_id)}
            onRefresh={() => refreshOne(a.id)}
            onEdit={() => setForm({ open: true, account: a })}
            onDelete={() => setDeleting(a)}
          />
        ))}
      </ul>

      {accounts && <AutoSwapSettings machines={machines} accounts={accounts} />}

      {form.open && (
        <AccountForm
          key={form.account?.id ?? 'new'}
          account={form.account}
          onClose={() => setForm({ open: false, account: null })}
          onSaved={(saved) => {
            setForm({ open: false, account: null });
            setAccounts((list) => {
              const l = list ?? [];
              return l.some((x) => x.id === saved.id) ? l.map((x) => (x.id === saved.id ? saved : x)) : [...l, saved];
            });
            void refreshOne(saved.id);
          }}
        />
      )}
      <ConfirmDialog
        open={!!deleting}
        title="Remover conta"
        message={
          <>
            Remover <strong>{deleting?.label}</strong> da lista? O login na máquina não é alterado.
          </>
        }
        confirmLabel="Remover"
        danger
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await api.aiAccounts.remove(deleting.id);
            setAccounts((l) => (l ?? []).filter((x) => x.id !== deleting.id));
          } catch (err) {
            setError(err instanceof ApiError ? err.message : 'Erro ao remover');
          }
          setDeleting(null);
        }}
      />
    </div>
  );
}
