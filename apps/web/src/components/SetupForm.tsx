import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, ApiError } from '../lib/api';
import { useData } from '../lib/data';
import { machineLabel } from '../lib/machine-labels';
import { AutomationSetup } from './AutomationSetup';
import { ProjectAiCard } from './ProjectAiCard';
import {
  APPROVAL_LABEL,
  PROVIDER_LABEL,
  type ConnectionInfo,
  type Integration,
  type IntegrationProvider,
  type Project,
  type ProjectSetupData,
  type TicketSource,
} from '../lib/types';

interface Props {
  project: Project;
}

const SCOPE_LABEL: Record<IntegrationProvider, { label: string; placeholder: string; optionsKey: string; filterLabel: string; filterHint: string }> = {
  linear: { label: 'Time (key)', placeholder: 'EI', optionsKey: 'teams', filterLabel: 'Estados', filterHint: 'nomes separados por vírgula (ex.: Todo, In Progress). Vazio = todos os abertos' },
  jira: { label: 'Projeto (key)', placeholder: 'PROJ', optionsKey: 'projects', filterLabel: 'JQL extra', filterHint: 'ex.: assignee = currentUser()' },
  github: { label: 'Repositório', placeholder: 'owner/repo', optionsKey: 'repos', filterLabel: 'Labels', filterHint: 'separadas por vírgula' },
};

export function SetupForm({ project }: Props) {
  const { machines, refresh } = useData();
  const [data, setData] = useState<ProjectSetupData | null>(null);
  const [saved, setSaved] = useState<string>('');
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [conn, setConn] = useState<Record<string, ConnectionInfo | 'loading'>>({});
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.setup.get(project.id), api.integrations.list().catch(() => ({ integrations: [] }))]).then(([s, i]) => {
      if (cancelled) return;
      setData(s.setup.data);
      setSaved(JSON.stringify(s.setup.data));
      setIntegrations(i.integrations);
    });
    return () => {
      cancelled = true;
    };
  }, [project.id]);

  const dirty = data !== null && JSON.stringify(data) !== saved;
  const runnerMachine = useMemo(
    () => machines.find((m) => m.id === (data?.runner.machine_id ?? project.machines[0]?.machine_id)),
    [machines, data?.runner.machine_id, project.machines],
  );

  if (!data) return <p className="text-sm text-fg-dim">Carregando setup…</p>;

  const patch = <K extends keyof ProjectSetupData>(key: K, value: ProjectSetupData[K]) => setData((d) => (d ? { ...d, [key]: value } : d));

  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.setup.save(project.id, data);
      setData(r.setup.data);
      setSaved(JSON.stringify(r.setup.data));
      setMsg({ ok: true, text: 'Setup salvo.' });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError ? (e.issues ? `Dados inválidos: ${JSON.stringify(e.issues).slice(0, 200)}` : e.message) : 'Erro ao salvar' });
    } finally {
      setBusy(false);
    }
  };

  const loadOptions = async (integrationId: string) => {
    const i = integrations.find((x) => x.id === integrationId);
    if (!i) return;
    setConn((c) => ({ ...c, [integrationId]: 'loading' }));
    try {
      const r = await api.integrations.test({ provider: i.provider, config: i.config, integration_id: i.id });
      setConn((c) => ({ ...c, [integrationId]: r }));
    } catch (e) {
      setConn((c) => ({ ...c, [integrationId]: { ok: false, error: e instanceof ApiError ? e.message : 'falha' } }));
    }
  };

  const sync = async () => {
    setSyncMsg('sincronizando…');
    try {
      const r = await api.setup.syncTickets(project.id);
      const ok = r.sources.filter((s) => !s.error);
      const sum = (k: 'fetched' | 'created' | 'updated' | 'removed') => ok.reduce((n, s) => n + (s[k] ?? 0), 0);
      const errors = r.sources.filter((s) => s.error).map((s) => `${s.scope}: ${s.error}`);
      setSyncMsg([`${sum('fetched')} ticket(s) nas fontes · ${sum('created')} novo(s) · ${sum('updated')} atualizado(s) · ${sum('removed')} removido(s)`, ...errors].join(' · '));
      void refresh();
    } catch (e) {
      setSyncMsg(e instanceof ApiError ? e.message : 'falha no sync');
    }
  };

  const byProvider = (p: IntegrationProvider) => integrations.filter((i) => i.provider === p);
  const caps = runnerMachine?.capabilities ?? [];

  const sources = data.ticket_sources;
  const setSources = (next: TicketSource[]) => patch('ticket_sources', next);
  const updateSource = (i: number, p: Partial<TicketSource>) => setSources(sources.map((s, j) => (j === i ? { ...s, ...p } : s)));
  const identity = (s: TicketSource) => `${s.integration_id}\u0000${s.scope.trim()}`;
  const duplicate = (i: number) => sources.some((s, j) => j < i && identity(s) === identity(sources[i]) && sources[i].scope.trim() !== '');
  const anyDuplicate = sources.some((_, i) => duplicate(i));

  return (
    <div className="space-y-5">
      <Card title="Repositório" hint="Onde o agente cria branch e abre PR.">
        {byProvider('github').length === 0 ? (
          <Empty>Cadastre uma integração GitHub em Integrações.</Empty>
        ) : (
          <>
            <Row label="Integração">
              <select
                className="input"
                value={data.repo?.integration_id ?? ''}
                onChange={(e) =>
                  patch('repo', e.target.value ? { ...(data.repo ?? { full_name: null, base_branch: 'main', branch_pattern: '{ticket}-{slug}', draft_pr: true, deploy_workflow: null }), integration_id: e.target.value } : null)
                }
              >
                <option value="">— sem repositório —</option>
                {byProvider('github').map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                  </option>
                ))}
              </select>
            </Row>
            {data.repo && (
              <>
                <Row label="Repositório (owner/repo)">
                  <div className="flex gap-2">
                    <input className="input font-mono" list={`repos-${project.id}`} value={data.repo.full_name ?? ''} onChange={(e) => patch('repo', { ...data.repo!, full_name: e.target.value || null })} placeholder="engenhariainversa/app" />
                    <button type="button" className="btn-ghost shrink-0 text-xs" onClick={() => void loadOptions(data.repo!.integration_id!)}>
                      {conn[data.repo.integration_id!] === 'loading' ? '…' : 'listar'}
                    </button>
                  </div>
                  <datalist id={`repos-${project.id}`}>
                    {(() => {
                      const c = conn[data.repo.integration_id!];
                      return c && c !== 'loading' && c.ok ? c.options?.repos?.map((r) => <option key={r.id} value={r.id} />) : null;
                    })()}
                  </datalist>
                </Row>
                <div className="grid grid-cols-2 gap-3">
                  <Row label="Branch base">
                    <input className="input font-mono" value={data.repo.base_branch} onChange={(e) => patch('repo', { ...data.repo!, base_branch: e.target.value })} />
                  </Row>
                  <Row label="Padrão da branch">
                    <input className="input font-mono" value={data.repo.branch_pattern} onChange={(e) => patch('repo', { ...data.repo!, branch_pattern: e.target.value })} />
                  </Row>
                </div>
                <Row label="Workflow de deploy">
                  <input
                    className="input font-mono"
                    placeholder="deploy.yml"
                    value={data.repo.deploy_workflow ?? ''}
                    onChange={(e) => patch('repo', { ...data.repo!, deploy_workflow: e.target.value.trim() ? e.target.value : null })}
                  />
                </Row>
                <Check checked={data.repo.draft_pr} onChange={(v) => patch('repo', { ...data.repo!, draft_pr: v })}>
                  Abrir PR como rascunho até a aprovação
                </Check>
              </>
            )}
          </>
        )}
      </Card>

      <Card title="Tickets" hint="Fontes das tarefas: tickets abertos de cada fonte aparecem em Tickets; os que você escolher entram no backlog do épico padrão.">
        {sources.map((s, i) => {
          const scopeDef = SCOPE_LABEL[s.provider];
          const scopeOptions = conn[s.integration_id];
          return (
            <div key={i} className="space-y-2 rounded-md border border-line p-3">
              <Row label="Integração">
                <select
                  className="input"
                  value={s.integration_id}
                  onChange={(e) => {
                    const integ = integrations.find((x) => x.id === e.target.value);
                    if (integ) updateSource(i, { provider: integ.provider, integration_id: integ.id, scope: '' });
                  }}
                >
                  {integrations.map((integ) => (
                    <option key={integ.id} value={integ.id}>
                      {PROVIDER_LABEL[integ.provider]} · {integ.name}
                    </option>
                  ))}
                </select>
              </Row>
              <Row label={scopeDef.label}>
                <div className="flex gap-2">
                  <input
                    className="input font-mono"
                    list={`scope-${project.id}-${i}`}
                    value={s.scope}
                    onChange={(e) => updateSource(i, { scope: e.target.value })}
                    placeholder={scopeDef.placeholder}
                  />
                  <button type="button" className="btn-ghost shrink-0 text-xs" onClick={() => void loadOptions(s.integration_id)}>
                    {scopeOptions === 'loading' ? '…' : 'listar'}
                  </button>
                </div>
                <datalist id={`scope-${project.id}-${i}`}>
                  {scopeOptions && scopeOptions !== 'loading' && scopeOptions.ok
                    ? scopeOptions.options?.[scopeDef.optionsKey]?.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)
                    : null}
                </datalist>
                {scopeOptions && scopeOptions !== 'loading' && !scopeOptions.ok && <p className="mt-1 text-xs text-danger">{scopeOptions.error}</p>}
                {duplicate(i) && <p className="mt-1 text-xs text-danger">Fonte repetida</p>}
              </Row>
              <Row label={scopeDef.filterLabel} hint={scopeDef.filterHint}>
                <input className="input" value={s.filter ?? ''} onChange={(e) => updateSource(i, { filter: e.target.value || null })} />
              </Row>
              <div className="flex flex-wrap items-center gap-4">
                <label className="flex items-center gap-2 text-sm text-fg-muted">
                  Sync automático a cada
                  <input
                    className="input w-16 py-1 text-center"
                    inputMode="numeric"
                    value={s.sync_minutes}
                    onChange={(e) => updateSource(i, { sync_minutes: Math.max(0, Number(e.target.value) || 0) })}
                  />
                  min <span className="text-fg-dim">(0 = manual)</span>
                </label>
                <button type="button" className="btn-ghost text-xs text-danger" onClick={() => setSources(sources.filter((_, j) => j !== i))}>
                  Remover
                </button>
              </div>
            </div>
          );
        })}
        {integrations.length === 0 ? (
          <Empty>Cadastre uma integração em Integrações.</Empty>
        ) : (
          <button
            type="button"
            className="btn-ghost border border-line text-xs"
            disabled={integrations.length === 0}
            onClick={() =>
              setSources([...sources, { provider: integrations[0].provider, integration_id: integrations[0].id, scope: '', filter: null, sync_minutes: 0 }])
            }
          >
            Adicionar fonte
          </button>
        )}
        {sources.length > 0 && (
          <div className="flex items-center gap-3">
            <button type="button" className="btn-ghost border border-line text-xs" onClick={() => void sync()} disabled={dirty}>
              Sincronizar agora
            </button>
            {dirty && <span className="text-xs text-fg-dim">salve o setup antes de sincronizar</span>}
            {syncMsg && <span className="text-xs text-fg-muted">{syncMsg}</span>}
          </div>
        )}
      </Card>

      <Card title="Runner" hint="Máquina onde a automação (Claude) roda. Pode ser diferente da máquina dos terminais — ex.: projeto mobile precisa de macOS.">
        <Row label="Máquina">
          <select className="input" value={data.runner.machine_id ?? ''} onChange={(e) => patch('runner', { ...data.runner, machine_id: e.target.value || null })}>
            <option value="">— a mesma do projeto —</option>
            {machines.map((m) => (
              <option key={m.id} value={m.id}>
                {machineLabel(m)}
                {m.os ? ` (${m.os})` : ''}
              </option>
            ))}
          </select>
          {runnerMachine && (
            <p className="mt-1 text-xs text-fg-dim">
              {runnerMachine.name}: {runnerMachine.os ?? 'SO não detectado'} ·{' '}
              {caps.length ? caps.join(', ') : 'ferramentas não detectadas (verifique o status da máquina)'}
              {caps.length > 0 && !caps.includes('claude') && <span className="text-warn"> · sem claude</span>}
            </p>
          )}
        </Row>
        <Row label="Diretório de trabalho" hint="vazio = diretório do projeto">
          <input className="input font-mono" value={data.runner.cwd ?? ''} onChange={(e) => patch('runner', { ...data.runner, cwd: e.target.value || null })} placeholder={project.machines.find((l) => l.machine_id === (data.runner.machine_id ?? project.machines[0]?.machine_id))?.cwd ?? ''} />
        </Row>
        <Row label="Comando de preparação" hint="roda antes de cada run">
          <input className="input font-mono" value={data.runner.setup_command ?? ''} onChange={(e) => patch('runner', { ...data.runner, setup_command: e.target.value || null })} placeholder="pnpm install" />
        </Row>
        <Check checked={data.runner.worktree} onChange={(v) => patch('runner', { ...data.runner, worktree: v })}>
          Usar git worktree por run (isola a branch de cada ticket)
        </Check>
      </Card>

      <ProjectAiCard project={project} />

      <Card title="Agente" hint="Como o Claude Code é iniciado na tab da run.">
        <Row label="Comando">
          <input className="input font-mono" value={data.agent.command} onChange={(e) => patch('agent', { ...data.agent, command: e.target.value })} />
        </Row>
        <Row label="Plugins/skills exigidos" hint="separados por vírgula">
          <input
            className="input font-mono"
            value={data.agent.plugins.join(', ')}
            onChange={(e) => patch('agent', { ...data.agent, plugins: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
          />
        </Row>
        <Row label="Argumentos extras">
          <input className="input font-mono" value={data.agent.extra_args ?? ''} onChange={(e) => patch('agent', { ...data.agent, extra_args: e.target.value || null })} placeholder="--permission-mode acceptEdits" />
        </Row>
      </Card>

      <Card title="Verificação" hint="Evidência anexada ao PR para você aprovar.">
        <Row label="Tipo">
          <select className="input" value={data.verify.type} onChange={(e) => patch('verify', { ...data.verify, type: e.target.value as ProjectSetupData['verify']['type'] })}>
            <option value="none">Nenhuma</option>
            <option value="ios-simulator">Screenshot do simulador iOS (macOS + Xcode)</option>
            <option value="web-screenshot">Screenshot de URL (Playwright)</option>
            <option value="command">Comando customizado</option>
          </select>
          {data.verify.type === 'ios-simulator' && runnerMachine && runnerMachine.os !== 'macos' && (
            <p className="mt-1 text-xs text-warn">O runner selecionado não é macOS.</p>
          )}
        </Row>
        {data.verify.type !== 'none' && (
          <>
            <Row label={data.verify.type === 'ios-simulator' ? 'Simulador' : data.verify.type === 'web-screenshot' ? 'URL' : 'Comando'}>
              <input
                className="input font-mono"
                value={data.verify.target ?? ''}
                onChange={(e) => patch('verify', { ...data.verify, target: e.target.value || null })}
                placeholder={data.verify.type === 'ios-simulator' ? 'iPhone 16' : data.verify.type === 'web-screenshot' ? 'http://localhost:3000' : './scripts/evidence.sh'}
              />
            </Row>
            <Row label="Comando de build" hint="opcional; roda antes da captura">
              <input className="input font-mono" value={data.verify.build_command ?? ''} onChange={(e) => patch('verify', { ...data.verify, build_command: e.target.value || null })} placeholder="pnpm build" />
            </Row>
          </>
        )}
      </Card>

      <Card title="Aprovações" hint='O que para e espera você no dashboard. "Automático" decide sozinho — comece com tudo em "Pedir" e vá liberando.'>
        <ul className="divide-y divide-line">
          {(Object.keys(APPROVAL_LABEL) as (keyof ProjectSetupData['approvals'])[]).map((k) => (
            <li key={k} className="flex items-center gap-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="text-sm">{APPROVAL_LABEL[k].label}</div>
                <div className="text-xs text-fg-dim">{APPROVAL_LABEL[k].hint}</div>
              </div>
              <div className="flex overflow-hidden rounded-md border border-line text-xs">
                {(['ask', 'auto'] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => patch('approvals', { ...data.approvals, [k]: mode })}
                    className={`px-3 py-1 ${data.approvals[k] === mode ? (mode === 'auto' ? 'bg-ok/20 text-ok' : 'bg-accent/20 text-fg') : 'text-fg-muted hover:bg-bg-3'}`}
                  >
                    {mode === 'ask' ? 'Pedir' : 'Automático'}
                  </button>
                ))}
              </div>
            </li>
          ))}
        </ul>
      </Card>

      {data.automation && <AutomationSetup value={data.automation} onChange={(next) => patch('automation', next)} />}

      <div className="sticky bottom-0 flex items-center gap-3 border-t border-line bg-bg pb-6 pt-3">
        <button type="button" className="btn-primary" onClick={() => void save()} disabled={busy || !dirty || anyDuplicate}>
          Salvar setup
        </button>
        {dirty && !msg && <span className="text-xs text-fg-dim">alterações não salvas</span>}
        {msg && <span className={`text-sm ${msg.ok ? 'text-ok' : 'text-danger'}`}>{msg.text}</span>}
      </div>
    </div>
  );
}

function Card({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-line bg-bg-2 p-4">
      <h3 className="text-sm font-semibold">{title}</h3>
      {hint && <p className="mb-3 text-xs text-fg-dim">{hint}</p>}
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <label className="label">
        {label}
        {hint && <span className="ml-1 normal-case tracking-normal text-fg-dim">— {hint}</span>}
      </label>
      {children}
    </div>
  );
}

function Check({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <label className="flex items-center gap-2 text-sm text-fg-muted">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="accent-accent" />
      {children}
    </label>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="text-xs text-fg-dim">{children}</p>;
}
