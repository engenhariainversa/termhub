import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useData } from '../lib/data';
import { taskStatusLabel } from '../lib/board';
import { Trans, useTranslation } from '../i18n';
import { PROVIDER_LABEL, type Integration, type Project, type ProjectSetup, type SourceSync, type TaskStatus, type Ticket } from '../lib/types';

interface Props {
  project: Project;
}

/** Lista dos tickets sincronizados das integrações; o usuário escolhe quais vão para o backlog. */
export function TicketsView({ project }: Props) {
  const { t } = useTranslation();
  const { refresh } = useData();
  const [tickets, setTickets] = useState<Ticket[] | null>(null);
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [setup, setSetup] = useState<ProjectSetup | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<TaskStatus | 'all'>('all');
  const [source, setSource] = useState<string>('all');
  const [hideImported, setHideImported] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [truncated, setTruncated] = useState<SourceSync[]>([]);

  const load = useCallback(async () => {
    const [ticketList, i, s] = await Promise.all([
      api.tickets.list(project.id),
      api.integrations.list().catch(() => ({ integrations: [] })),
      api.setup.get(project.id),
    ]);
    setTickets(ticketList.tickets);
    setIntegrations(i.integrations);
    setSetup(s.setup);
  }, [project.id]);

  useEffect(() => {
    void load().catch((e) => setMsg(e instanceof ApiError ? e.message : t('Erro ao carregar')));
  }, [load]);

  const sources = setup?.data.ticket_sources ?? [];

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (tickets ?? []).filter(
      (t) =>
        (status === 'all' || t.status === status) &&
        (source === 'all' || t.scope === source) &&
        (!hideImported || !t.task_id) &&
        (!q || t.key.toLowerCase().includes(q) || t.title.toLowerCase().includes(q) || (t.meta.labels ?? []).some((l) => l.toLowerCase().includes(q))),
    );
  }, [tickets, query, status, source, hideImported]);

  const bySource = useMemo(() => {
    const groups = new Map<string, Ticket[]>();
    for (const t of filtered) {
      const k = `${t.integration_id}\u0000${t.scope ?? ''}`;
      const list = groups.get(k) ?? [];
      list.push(t);
      groups.set(k, list);
    }
    return [...groups.entries()].map(([key, list]) => {
      const [integrationId, scope] = key.split('\u0000');
      return { key, integrationId, scope: scope || null, list };
    });
  }, [filtered]);

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const selectable = filtered.filter((t) => !t.task_id);

  const sync = async () => {
    setBusy(true);
    setMsg(t('sincronizando…'));
    try {
      const r = await api.setup.syncTickets(project.id);
      const ok = r.sources.filter((s) => !s.error);
      const sum = (k: 'fetched' | 'created' | 'updated' | 'removed') => ok.reduce((n, s) => n + (s[k] ?? 0), 0);
      const errors = r.sources.filter((s) => s.error).map((s) => `${s.scope}: ${s.error}`);
      setMsg(
        [
          t('{{fetched}} ticket(s) nas fontes · {{created}} novo(s) · {{updated}} atualizado(s) · {{removed}} removido(s)', {
            fetched: sum('fetched'),
            created: sum('created'),
            updated: sum('updated'),
            removed: sum('removed'),
          }),
          ...errors,
        ].join(' · '),
      );
      setTruncated(r.sources.filter((s) => s.truncated));
      await load();
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : t('falha no sync'));
    } finally {
      setBusy(false);
    }
  };

  const importSelected = async () => {
    const ids = [...selected].filter((id) => selectable.some((t) => t.id === id));
    if (ids.length === 0) return;
    setBusy(true);
    try {
      const r = await api.tickets.import(project.id, ids);
      setMsg(t('{{count}} tickets enviados para o backlog', { count: r.tasks.length }));
      setSelected(new Set());
      await load();
      void refresh();
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : t('falha ao importar'));
    } finally {
      setBusy(false);
    }
  };

  if (tickets === null) return <div className="flex h-full items-center justify-center text-sm text-fg-dim">{t('Carregando tickets…')}</div>;

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-2 border-b border-line bg-bg-2 px-3 py-1.5 text-xs">
        <input className="input w-56 py-1" placeholder={t('filtrar por id, título, label')} value={query} onChange={(e) => setQuery(e.target.value)} />
        <select className="input w-auto py-1" value={status} onChange={(e) => setStatus(e.target.value as TaskStatus | 'all')}>
          <option value="all">{t('todos os estados')}</option>
          {(['backlog', 'todo', 'doing', 'done'] as TaskStatus[]).map((s) => (
            <option key={s} value={s}>
              {taskStatusLabel(s)}
            </option>
          ))}
        </select>
        {sources.length > 1 && (
          <select className="input w-auto py-1" value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="all">{t('todas as fontes')}</option>
            {sources.map((s) => (
              <option key={`${s.integration_id}:${s.scope}`} value={s.scope}>
                {s.scope}
              </option>
            ))}
          </select>
        )}
        <label className="flex items-center gap-1 text-fg-muted">
          <input type="checkbox" checked={hideImported} onChange={(e) => setHideImported(e.target.checked)} className="accent-accent" /> {t('ocultar já no board')}
        </label>
        <span className="ml-auto text-fg-dim">{msg}</span>
        <button className="btn-ghost border border-line" onClick={() => void sync()} disabled={busy || sources.length === 0} title={sources.length > 0 ? '' : t('configure uma fonte no Setup')}>
          {t('Sincronizar')}
        </button>
        <button className="btn-primary" onClick={() => void importSelected()} disabled={busy || selected.size === 0}>
          {selected.size > 0 ? t('Enviar {{n}} para o backlog', { n: selected.size }) : t('Enviar para o backlog')}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {truncated.map((s) => (
          <p key={s.scope} className="mb-2 rounded border border-warn/40 bg-warn/10 px-2 py-1 text-xs text-warn">
            {t('{{source}} tem mais de 500 tickets abertos; a lista está incompleta.', { source: s.scope })}
          </p>
        ))}
        {sources.length === 0 && (
          <p className="text-sm text-fg-dim">
            <Trans
              i18nKey="Nenhuma fonte de tickets configurada. Vá em <0>Setup → Tickets</0>."
              components={[<Link key="setup" to={`/projects/${project.id}/settings`} className="text-accent underline" />]}
            />
          </p>
        )}
        {sources.length > 0 && tickets.length === 0 && <p className="text-sm text-fg-dim">{t('Nada sincronizado ainda. Clique em "Sincronizar".')}</p>}
        {bySource.map(({ key, integrationId, scope, list }) => {
          const integ = integrations.find((i) => i.id === integrationId);
          const selectableGroup = list.filter((t) => !t.task_id);
          const allSelectedGroup = selectableGroup.length > 0 && selectableGroup.every((t) => selected.has(t.id));
          return (
            <section key={key} className="mb-4">
              <header className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-fg-muted">
                <input
                  type="checkbox"
                  className="accent-accent"
                  checked={allSelectedGroup}
                  onChange={(e) =>
                    setSelected((s) => {
                      const n = new Set(s);
                      for (const t of selectableGroup) {
                        if (e.target.checked) n.add(t.id);
                        else n.delete(t.id);
                      }
                      return n;
                    })
                  }
                  title={t('selecionar todos os não importados')}
                />
                {integ ? `${PROVIDER_LABEL[integ.provider]} · ${integ.name}` : t('fonte removida')}
                {scope && <span className="font-mono normal-case text-fg-dim">{scope}</span>}
                <span className="ml-auto font-normal normal-case text-fg-dim">{list.length}</span>
              </header>
              <ul className="divide-y divide-line rounded-lg border border-line bg-bg-2">
                {list.map((ticket) => (
                  <li key={ticket.id} className={`flex items-start gap-3 px-3 py-2 text-sm ${ticket.task_id ? 'opacity-60' : ''}`}>
                    <input type="checkbox" className="mt-1 accent-accent" disabled={!!ticket.task_id} checked={selected.has(ticket.id)} onChange={() => toggle(ticket.id)} />
                    <div className="min-w-0 flex-1">
                      <span className="block truncate">{ticket.title}</span>
                      <div className="mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-fg-dim">
                        <a href={ticket.url} target="_blank" rel="noreferrer" className="font-mono text-accent hover:underline">
                          {ticket.key}
                        </a>
                        <span>{ticket.state}</span>
                        {ticket.meta.assignee && <span>{String(ticket.meta.assignee)}</span>}
                        {(ticket.meta.labels ?? []).map((l) => (
                          <span key={l} className="rounded bg-bg-4 px-1">
                            {l}
                          </span>
                        ))}
                        {ticket.task_id && (
                          <Link to={`/projects/${project.id}/tasks`} className="text-ok hover:underline">
                            {t('no board →')}
                          </Link>
                        )}
                      </div>
                    </div>
                    <span className="shrink-0 rounded bg-bg-4 px-1.5 text-[10px] text-fg-muted">{taskStatusLabel(ticket.status)}</span>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}
