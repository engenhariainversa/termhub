import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { api, ApiError } from '../lib/api';
import { useData } from '../lib/data';
import { STATUS_DOT, STATUS_LABEL } from '../lib/machine-status';
import { KeyRound } from 'lucide-react';
import { useAiLoginStatus } from '../lib/ai-login-status';
import { AI_PROVIDER_LABEL, type AiAccount, type AiAccountUsage, type AiLoginStatusRow, type AiProvider, type AiUsageWindow, type Machine } from '../lib/types';
import { AiLoginDialog, type AiLoginTarget } from './AiLoginDialog';
import { AutoSwapSettings } from './AutoSwapSettings';
import { AiUsageQuerySettings } from './AiUsageQueryCard';
import { ConfirmDialog, Modal } from './Modal';
import { i18n, tk, Trans, useTranslation } from '../i18n';

const PROVIDERS: AiProvider[] = ['claude', 'chatgpt', 'gemini', 'antigravity'];

const PROVIDER_HINT: Record<AiProvider, string> = {
  claude: tk('Lê o login do Claude Code na máquina (~/.claude). Para uma segunda conta (ex.: a da empresa), faça login com CLAUDE_CONFIG_DIR=~/.claude-work claude e escolha "Outro diretório de config" abaixo.'),
  chatgpt: tk('Lê o login do Codex CLI na máquina (~/.codex). Entre com "Sign in with ChatGPT" — login por API key não tem limite de plano.'),
  gemini: tk('Lê o login do Gemini CLI na máquina (~/.gemini). Entre com a conta Google — login por API key não tem cota de plano.'),
  antigravity: tk('Lê o login do Antigravity CLI na máquina (~/.gemini/antigravity-cli/antigravity-oauth-token; o diretório de config é ~/.gemini). Rode `agy` e entre com a conta Google do plano AI Pro/Ultra — login por API key não tem cota de plano.'),
};

const PROVIDER_STYLE: Record<AiProvider, string> = {
  claude: 'bg-[#d97757]/15 text-[#e8956f]',
  chatgpt: 'bg-[#10a37f]/15 text-[#3fcfa5]',
  gemini: 'bg-[#4f8cff]/15 text-[#79c0ff]',
  antigravity: 'bg-[#a78bfa]/15 text-[#c4b5fd]',
};

/** An example of a second login's config dir, never the CLI's own default: that one is "Conta padrão da máquina". */
const OTHER_DIR_EXAMPLE: Record<AiProvider, string> = {
  claude: '~/.claude-work',
  chatgpt: '~/.codex-work',
  gemini: '~/.gemini-work',
  antigravity: '~/.gemini-work',
};

function countdown(iso: string | null, now: number): string | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - now;
  if (ms <= 0) return i18n.t('agora');
  const m = Math.ceil(ms / 60000);
  if (m < 60) return i18n.t('{{m}} min', { m });
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? i18n.t('{{h}} h {{m}} min', { h, m: m % 60 }) : i18n.t('{{h}} h', { h });
  const d = Math.floor(h / 24);
  return i18n.t('{{d}} d {{h}} h', { d, h: h % 24 });
}

function relative(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 5) return i18n.t('agora');
  if (s < 60) return i18n.t('há {{n}} s', { n: s });
  return i18n.t('há {{n}} min', { n: Math.round(s / 60) });
}

function barColor(pct: number): string {
  if (pct >= 90) return 'bg-danger';
  if (pct >= 70) return 'bg-warn';
  return 'bg-ok';
}

function WindowBar({ w, now }: { w: AiUsageWindow; now: number }) {
  const { t } = useTranslation();
  const pct = Math.round(w.utilization);
  const reset = countdown(w.resets_at, now);
  return (
    <li>
      <div className="mb-1 flex items-baseline justify-between text-xs">
        <span className="text-fg-muted">{w.label}</span>
        <span className="tabular-nums">
          <span className={pct >= 90 ? 'text-danger' : pct >= 70 ? 'text-warn' : 'text-fg'}>{pct}%</span>
          {reset && <span className="text-fg-dim">{t(' · reseta em {{time}}', { time: reset })}</span>}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-bg-4">
        <div className={`h-full rounded-full transition-[width] ${barColor(pct)}`} style={{ width: `${Math.min(100, Math.max(2, pct))}%` }} />
      </div>
    </li>
  );
}

/** TER-990: the account runs only in this project. */
export function ExclusiveBadge({ name }: { name: string }) {
  const { t } = useTranslation();
  return (
    <span className="shrink-0 truncate rounded bg-warn/15 px-1.5 py-0.5 text-[10px] font-medium text-warn" title={t('Só roda no projeto {{project}}; nenhum outro projeto pode usá-la', { project: name })}>
      {t('Exclusiva: {{project}}', { project: name })}
    </span>
  );
}

function AccountCard({
  account,
  machineName,
  usage,
  login,
  now,
  onRefresh,
  onRelogin,
  onEdit,
  onDelete,
}: {
  account: AiAccount;
  /** the account's machine, for the "turn it on in Máquinas" pointer; null when the machine is out of view */
  machineName: string | null;
  usage: AiAccountUsage | undefined;
  /** TER-1047: whether its CLI is still logged in; undefined until the first read */
  login: AiLoginStatusRow | undefined;
  now: number;
  onRefresh: () => void;
  onRelogin: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const [refreshing, setRefreshing] = useState(false);
  const worst = usage?.ok ? Math.max(...usage.windows.map((w) => w.utilization)) : null;
  const loginRequired = login?.state === 'login_required';
  return (
    <li className={`flex flex-col rounded-lg border bg-bg-2 p-4 ${loginRequired || (worst !== null && worst >= 90) ? 'border-danger/50' : 'border-line'}`}>
      <div className="flex items-center gap-2">
        <span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${PROVIDER_STYLE[account.provider]}`}>{AI_PROVIDER_LABEL[account.provider]}</span>
        <span className="truncate font-medium">{account.label}</span>
        {account.exclusive_project && <ExclusiveBadge name={account.exclusive_project.name} />}
        {usage?.plan && <span className="rounded bg-bg-4 px-1.5 text-[10px] uppercase tracking-wide text-fg-muted">{usage.plan}</span>}
        {loginRequired && <span className="shrink-0 rounded bg-danger/15 px-1.5 py-0.5 text-[10px] font-medium text-danger">{t('Login necessário')}</span>}
        <span className="ml-auto flex shrink-0 items-center gap-0.5">
          {login?.supported && !loginRequired && (
            <button className="rounded px-1 text-xs text-fg-dim hover:bg-bg-3 hover:text-fg" title={t('Refazer login')} aria-label={t('Refazer login')} onClick={onRelogin}>
              <KeyRound size={12} aria-hidden="true" />
            </button>
          )}
          <button
            className="rounded px-1 text-xs text-fg-dim hover:bg-bg-3 hover:text-fg disabled:opacity-50"
            title={t('Atualizar agora')}
            disabled={refreshing}
            onClick={() => {
              setRefreshing(true);
              Promise.resolve(onRefresh()).finally(() => setRefreshing(false));
            }}
          >
            {refreshing ? '…' : '↻'}
          </button>
          <button className="rounded px-1 text-xs text-fg-dim hover:bg-bg-3 hover:text-fg" title={t('Editar')} onClick={onEdit}>
            ✎
          </button>
          <button className="rounded px-1 text-xs text-fg-dim hover:bg-bg-3 hover:text-danger" title={t('Remover')} onClick={onDelete}>
            ✕
          </button>
        </span>
      </div>
      <div className="mt-0.5 truncate font-mono text-[11px] text-fg-dim" title={account.config_dir ?? undefined}>
        {account.config_dir ?? t('login padrão')}
      </div>

      {loginRequired && (
        <div className="mt-3 flex items-center gap-2 rounded border border-danger/40 bg-danger/10 p-2 text-xs">
          <p className="flex-1 text-danger">{t('O login do CLI expirou nesta máquina.')}</p>
          <button type="button" className="btn-danger shrink-0 px-2 py-1 text-xs" onClick={onRelogin}>
            {t('Refazer login')}
          </button>
        </div>
      )}

      <div className="mt-3 flex-1">
        {!usage && <p className="text-xs text-fg-dim">{t('Consultando…')}</p>}
        {usage && !usage.ok && usage.reason && (
          <div className="rounded border border-line bg-bg p-2 text-xs text-fg-muted">
            <p>{usage.reason === 'disabled' ? t('Consulta de uso desligada nesta máquina') : t('Atualize o agente desta máquina para ver o uso')}</p>
            {usage.reason === 'disabled' && machineName && (
              <p className="mt-1 text-fg-dim">{t('Ligue em Máquinas › {{machine}}', { machine: machineName })}</p>
            )}
          </div>
        )}
        {usage && !usage.ok && !usage.reason && (
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
          {t('atualizado {{when}}', { when: relative(usage.fetched_at, now) })}
          {usage.stale && <span className="text-warn">{t(' · limite de consultas do provedor; mostrando a última leitura')}</span>}
        </div>
      )}
    </li>
  );
}

function AccountForm({
  account,
  machineId: initialMachineId,
  onClose,
  onSaved,
}: {
  account: AiAccount | null;
  /** the machine a new account starts on (the section it was added from) */
  machineId?: string;
  onClose: () => void;
  onSaved: (a: AiAccount) => void;
}) {
  const { t } = useTranslation();
  const { machines, projects } = useData();
  const [provider, setProvider] = useState<AiProvider>(account?.provider ?? 'claude');
  const [label, setLabel] = useState(account?.label ?? '');
  const [machineId, setMachineId] = useState(account?.machine_id ?? initialMachineId ?? machines[0]?.id ?? '');
  // Which login the account is (TER-499): the machine's default one (no config dir, stored as null) or
  // another one kept in its own config dir.
  const [custom, setCustom] = useState(!!account?.config_dir);
  const [configDir, setConfigDir] = useState(account?.config_dir ?? '');
  // TER-990: the only project the account may run in ('' = any project)
  const [exclusive, setExclusive] = useState(account?.exclusive_project?.id ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const input = { label: label || AI_PROVIDER_LABEL[provider], machine_id: machineId, config_dir: custom ? configDir.trim() : null };
      const exclusiveId = exclusive || null;
      const changed = exclusiveId !== (account?.exclusive_project?.id ?? null);
      let r = account ? await api.aiAccounts.update(account.id, { ...input, ...(changed ? { exclusive_project_id: exclusiveId } : {}) }) : await api.aiAccounts.create({ provider, ...input });
      // an account is created free; its exclusivity is a change of its own (audited as one)
      if (!account && exclusiveId) r = await api.aiAccounts.update(r.account.id, { exclusive_project_id: exclusiveId });
      onSaved(r.account);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('Erro ao salvar'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={account ? t('Editar conta de IA') : t('Nova conta de IA')} open onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <div>
          <label className="label">{t('Provedor')}</label>
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
          <p className="mt-1 text-xs text-fg-dim">{t(PROVIDER_HINT[provider])}</p>
        </div>
        <div>
          <label className="label">{t('Nome')}</label>
          <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t('ex.: {{provider}} pessoal', { provider: AI_PROVIDER_LABEL[provider] })} autoFocus />
        </div>
        <div>
          <label className="label" htmlFor="ai-account-machine">
            {t('Máquina onde o CLI está logado')}
          </label>
          <select id="ai-account-machine" className="input" value={machineId} onChange={(e) => setMachineId(e.target.value)} required>
            {machines.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </div>
        <fieldset>
          <legend className="label">{t('Login')}</legend>
          <label className="flex items-start gap-2 text-sm">
            <input type="radio" name="ai-account-login" className="mt-1" checked={!custom} onChange={() => setCustom(false)} />
            <span>
              {t('Conta padrão da máquina')}
              <span className="block text-xs text-fg-dim">{t('O login que o CLI usa quando nenhum diretório de config é definido.')}</span>
            </span>
          </label>
          <label className="mt-2 flex items-start gap-2 text-sm">
            <input type="radio" name="ai-account-login" className="mt-1" checked={custom} onChange={() => setCustom(true)} />
            <span>
              {t('Outro diretório de config')}
              <span className="block text-xs text-fg-dim">{t('Uma segunda conta do mesmo CLI, logada em um diretório próprio.')}</span>
            </span>
          </label>
          {custom && (
            <input
              className="input mt-2 font-mono"
              aria-label={t('Diretório de config')}
              value={configDir}
              onChange={(e) => setConfigDir(e.target.value)}
              placeholder={OTHER_DIR_EXAMPLE[provider]}
            />
          )}
        </fieldset>
        <div>
          <label className="label" htmlFor="ai-account-exclusive">
            {t('Exclusiva de um projeto')}
          </label>
          <select id="ai-account-exclusive" className="input" value={exclusive} onChange={(e) => setExclusive(e.target.value)}>
            <option value="">{t('Não: qualquer projeto pode usar')}</option>
            {account?.exclusive_project && !projects.some((p) => p.id === account.exclusive_project!.id) && <option value={account.exclusive_project.id}>{account.exclusive_project.name}</option>}
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-fg-dim">{t('Para a conta de um cliente ou empresa: ela só roda nesse projeto, e nenhum outro projeto, troca automática ou chat pode usá-la.')}</p>
        </div>
        {error && <p className="text-sm text-danger">{error}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            {t('Cancelar')}
          </button>
          <button type="submit" className="btn-primary" disabled={busy || !machineId || (custom && !configDir.trim())}>
            {account ? t('Salvar') : t('Adicionar')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export interface MachineAccounts {
  /** null: accounts whose machine is not in the list (deleted, or outside the scope) */
  machine: Machine | null;
  accounts: AiAccount[];
}

/** One group per machine that has accounts, in the order of the Máquinas page; unknown machines last. Pure. */
export function groupAccountsByMachine(machines: Machine[], accounts: AiAccount[]): MachineAccounts[] {
  const groups: MachineAccounts[] = machines.map((machine) => ({ machine, accounts: accounts.filter((a) => a.machine_id === machine.id) }));
  const known = new Set(machines.map((m) => m.id));
  groups.push({ machine: null, accounts: accounts.filter((a) => !known.has(a.machine_id)) });
  return groups.filter((g) => g.accounts.length > 0);
}

const OPEN_KEY = 'termhub:ai-accounts-open';

function readOpen(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(OPEN_KEY) ?? '{}') as Record<string, boolean>;
  } catch {
    return {};
  }
}

function MachineSection({ machine, count, open, onToggle, onAdd, children }: { machine: Machine | null; count: number; open: boolean; onToggle: () => void; onAdd?: () => void; children: ReactNode }) {
  const { t } = useTranslation();
  const { statuses } = useData();
  const name = machine?.name ?? t('Máquina desconhecida');
  const status = machine ? (statuses[machine.id] ?? 'checking') : null;
  return (
    <section aria-label={name} className="rounded-lg border border-line bg-bg-2">
      <div className="flex items-center gap-2 pr-2">
        <button type="button" className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5 rounded-lg px-3 py-2 text-left text-sm hover:bg-bg-3" onClick={onToggle} aria-expanded={open}>
          <span className={`text-[10px] text-fg-dim transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden>
            ▶
          </span>
          {status && <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[status]}`} title={t(STATUS_LABEL[status])} />}
          <span className="truncate font-medium">{name}</span>
          {machine?.subtitle && <span className="truncate text-xs text-fg-muted">{machine.subtitle}</span>}
          <span className="text-xs text-fg-dim">{t('{{count}} contas', { count })}</span>
        </button>
        {onAdd && (
          <button type="button" className="btn-ghost shrink-0 text-xs" aria-label={t('Adicionar conta em {{name}}', { name })} title={t('Adicionar conta em {{name}}', { name })} onClick={onAdd}>
            {t('+ conta')}
          </button>
        )}
      </div>
      {open && <div className="border-t border-line p-3">{children}</div>}
    </section>
  );
}

// the server caches each account for 5 min and backs off on 429, so polling faster only re-reads the cache
const POLL_MS = 5 * 60_000;

export function AiAccountsView() {
  const { t } = useTranslation();
  const { machines } = useData();
  const [accounts, setAccounts] = useState<AiAccount[] | null>(null);
  const [usage, setUsage] = useState<Record<string, AiAccountUsage>>({});
  const [form, setForm] = useState<{ open: boolean; account: AiAccount | null; machineId?: string }>({ open: false, account: null });
  const [open, setOpen] = useState<Record<string, boolean>>(readOpen);
  const [deleting, setDeleting] = useState<AiAccount | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const { accounts: loginRows } = useAiLoginStatus();
  const loginOf = useMemo(() => new Map((loginRows ?? []).map((r) => [r.account_id, r])), [loginRows]);
  const [relogin, setRelogin] = useState<AiLoginTarget | null>(null);

  const loadUsage = useCallback(async (refresh = false) => {
    try {
      const r = await api.aiAccounts.usage(refresh);
      setUsage(Object.fromEntries(r.usage.map((u) => [u.account_id, u])));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('Erro ao consultar os limites'));
    }
  }, []);

  const loadAccounts = useCallback(async () => {
    try {
      const r = await api.aiAccounts.list();
      setAccounts(r.accounts);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('Erro ao carregar as contas'));
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

  const groups = useMemo(() => groupAccountsByMachine(machines, accounts ?? []), [machines, accounts]);
  const groupKey = (g: MachineAccounts) => g.machine?.id ?? '';
  // open unless the person closed it
  const isOpen = (g: MachineAccounts) => open[groupKey(g)] ?? true;
  const toggle = (g: MachineAccounts) => {
    const next = { ...open, [groupKey(g)]: !isOpen(g) };
    setOpen(next);
    try {
      localStorage.setItem(OPEN_KEY, JSON.stringify(next));
    } catch {
      /* private mode: the choice just does not persist */
    }
  };

  return (
    <div>
      <div className="mb-5 flex items-end gap-4">
        <div>
          <h2 className="text-lg font-semibold">{t('Contas de IA')}</h2>
          <p className="text-sm text-fg-muted">{t('Limites de uso das suas assinaturas, lidos do login dos CLIs nas máquinas. Atualiza a cada minuto.')}</p>
        </div>
        <span className="ml-auto flex gap-2">
          <button className="btn-ghost text-xs" onClick={() => void loadUsage(true)} title={t('Consultar todas agora')}>
            {t('↻ atualizar')}
          </button>
          <button className="btn-primary text-xs" onClick={() => setForm({ open: true, account: null })}>
            {t('+ conta')}
          </button>
        </span>
      </div>

      {error && <p className="mb-3 text-sm text-danger">{error}</p>}
      {accounts && accounts.length === 0 && (
        <p className="text-sm text-fg-dim">{t('Nenhuma conta cadastrada. Adicione uma conta apontando para a máquina onde o Claude Code, Codex, Gemini CLI ou Antigravity CLI está logado.')}</p>
      )}

      <div className="space-y-3">
        {groups.map((g) => {
          const m = g.machine;
          return (
          <MachineSection
            key={groupKey(g)}
            machine={m}
            count={g.accounts.length}
            open={isOpen(g)}
            onToggle={() => toggle(g)}
            onAdd={m ? () => setForm({ open: true, account: null, machineId: m.id }) : undefined}
          >
            <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {g.accounts.map((a) => (
                <AccountCard
                  key={a.id}
                  account={a}
                  machineName={m?.name ?? null}
                  usage={usage[a.id]}
                  login={loginOf.get(a.id)}
                  now={now}
                  onRefresh={() => refreshOne(a.id)}
                  onRelogin={() =>
                    setRelogin({ account_id: a.id, label: a.label, provider: a.provider, machine_name: m?.name ?? null, supported: loginOf.get(a.id)?.supported ?? false })
                  }
                  onEdit={() => setForm({ open: true, account: a })}
                  onDelete={() => setDeleting(a)}
                />
              ))}
            </ul>
          </MachineSection>
          );
        })}
      </div>

      {accounts && <AutoSwapSettings machines={machines} accounts={accounts} />}
      {accounts && <AiUsageQuerySettings machines={machines} accounts={accounts} />}

      {form.open && (
        <AccountForm
          key={form.account?.id ?? 'new'}
          account={form.account}
          machineId={form.machineId}
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
      {relogin && <AiLoginDialog account={relogin} onClose={() => setRelogin(null)} onLoggedIn={() => void refreshOne(relogin.account_id)} />}
      <ConfirmDialog
        open={!!deleting}
        title={t('Remover conta')}
        message={
          <Trans
            i18nKey="Remover <0>{{label}}</0> da lista? O login na máquina não é alterado."
            values={{ label: deleting?.label ?? '' }}
            components={[<strong key="l" />]}
          />
        }
        confirmLabel={t('Remover')}
        danger
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await api.aiAccounts.remove(deleting.id);
            setAccounts((l) => (l ?? []).filter((x) => x.id !== deleting.id));
          } catch (err) {
            setError(err instanceof ApiError ? err.message : t('Erro ao remover'));
          }
          setDeleting(null);
        }}
      />
    </div>
  );
}
