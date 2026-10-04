import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useMonitor } from '../lib/monitor';
import { BASIS_LABEL, ciLabel, epicCiLine, formatEstimate, needsYouAgents, stateLabel, withLiveTab } from '../lib/progress';
import { relativeTime } from '../lib/time';
import type { AgentOnCard, CardProgress, EpicProgress, ProgressEstimate, ProgressResponse, ProgressScope, PullRequestBadge } from '../lib/types';

/** Percentages move at subtask pace; tab states come live from the monitor (spec D9). */
export const PROGRESS_REFRESH_MS = 15_000;

const STATE_DOT: Record<string, string> = {
  working: 'bg-emerald-500',
  waiting_input: 'bg-amber-500',
  waiting_permission: 'bg-amber-500',
  idle: 'bg-zinc-400',
  error: 'bg-red-500',
  // waiting on its own background work: neutral, never the colour of "esperando você" (TER-644)
  background: 'bg-sky-400',
};

function Bar({ percent, label }: { percent: number; label: string }) {
  return (
    <div role="progressbar" aria-label={label} aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} className="h-1.5 w-full rounded bg-zinc-200 dark:bg-zinc-800">
      <div className="h-1.5 rounded bg-indigo-500" style={{ width: `${percent}%` }} />
    </div>
  );
}

function EstimateLine({ estimate }: { estimate: ProgressEstimate }) {
  return (
    <span className="text-xs text-zinc-500">
      {formatEstimate(estimate)}
      {estimate.kind === 'range' && <span title={BASIS_LABEL[estimate.basis]}> · {BASIS_LABEL[estimate.basis]}</span>}
    </span>
  );
}

function AgentChip({ agent, projectId }: { agent: AgentOnCard; projectId: string }) {
  const since = agent.state_at ? ` · ${relativeTime(agent.state_at)}` : '';
  return (
    <Link
      to={`/projects/${projectId}?tab=${agent.tab_id}`}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${agent.needs_you ? 'border-amber-500 bg-amber-50 dark:bg-amber-950' : 'border-zinc-300 dark:border-zinc-700'}`}
    >
      <span className={`h-2 w-2 rounded-full ${agent.background ? STATE_DOT.background : agent.state ? STATE_DOT[agent.state] : 'bg-zinc-300'}`} aria-hidden />
      <span>{agent.tab_name}</span>
      <span>
        {stateLabel(agent.state, agent.background)}
        {agent.state === 'working' && !agent.background && agent.activity_verb ? ` (${agent.activity_verb})` : ''}
        {since}
      </span>
      {agent.subtask_ref && <span className="text-zinc-500">{agent.subtask_ref}</span>}
      {agent.rate_limited && <span className="text-red-600">limite de uso</span>}
    </Link>
  );
}

const CI_TONE: Record<string, string> = { passed: 'text-emerald-600', running: 'text-amber-600', failed: 'text-red-600', none: 'text-zinc-500' };

export function PullRequestBadges({ pulls }: { pulls: PullRequestBadge[] }) {
  if (pulls.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {pulls.map((p) => {
        const tone = p.state === 'merged' ? CI_TONE[p.deploy_state] : p.state === 'open' ? CI_TONE[p.ci_state] : CI_TONE.none;
        return (
          <span key={p.number} className="inline-flex items-center gap-1 text-xs">
            <a href={p.url} target="_blank" rel="noreferrer" className="rounded border border-zinc-300 px-1.5 py-0.5 hover:underline dark:border-zinc-700" title={p.title}>
              PR #{p.number}
              {p.draft ? ' · rascunho' : ''}
            </a>
            {p.state === 'merged' && p.deploy_url ? (
              <a href={p.deploy_url} target="_blank" rel="noreferrer" className={tone}>
                {ciLabel(p)}
              </a>
            ) : (
              <span className={tone}>{ciLabel(p)}</span>
            )}
          </span>
        );
      })}
    </div>
  );
}

function CardRow({ card, projectId }: { card: CardProgress; projectId: string }) {
  return (
    <li className="space-y-1 py-2">
      <div className="flex items-baseline gap-2">
        <Link to={`/project/${card.ref}`} className="font-medium hover:underline">
          {card.ref} {card.title}
        </Link>
        <span className="text-xs text-zinc-500">{card.column_name ?? 'Backlog'}</span>
        <span className="ml-auto text-xs tabular-nums">
          {card.units.done}/{card.units.total} · {card.percent}%
        </span>
      </div>
      <Bar percent={card.percent} label={`${card.ref} ${card.percent}%`} />
      <EstimateLine estimate={card.estimate} />
      <PullRequestBadges pulls={card.pull_requests} />
      {card.agents && card.agents.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {card.agents.map((a) => (
            <AgentChip key={a.tab_id} agent={a} projectId={projectId} />
          ))}
        </div>
      )}
    </li>
  );
}

function EpicBlock({ epic, projectId }: { epic: EpicProgress; projectId: string }) {
  return (
    <section className="space-y-2 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <header className="flex items-baseline gap-2">
        <h2 className="text-base font-semibold">{epic.title}</h2>
        <span className="text-xs text-zinc-500">{epic.ref}</span>
        <span className="ml-auto text-lg font-semibold tabular-nums">{epic.percent}%</span>
      </header>
      <Bar percent={epic.percent} label={`${epic.ref} ${epic.percent}%`} />
      <div className="flex flex-wrap gap-3 text-xs text-zinc-500">
        <span>
          {epic.units.done}/{epic.units.total}
          {epic.units.backlog_total > 0 ? ` · backlog: ${epic.units.backlog_total}` : ''}
        </span>
        <EstimateLine estimate={epic.estimate} />
        {epic.cards_without_estimate > 0 && <span>{epic.cards_without_estimate} cards sem estimativa</span>}
        {epic.agents && (
          <span>
            {epic.agents.working} trabalhando · {epic.agents.needs_you} esperando você · {epic.agents.idle} parados
          </span>
        )}
        {epic.ci && <span>{epicCiLine(epic.ci)}</span>}
      </div>
      {epic.ci_error && <p className="text-xs text-red-600">{epic.ci_error}</p>}
      <ul className="divide-y divide-zinc-100 dark:divide-zinc-900">
        {epic.cards.map((c) => (
          <CardRow key={c.id} card={c} projectId={projectId} />
        ))}
      </ul>
    </section>
  );
}

/** Project section "Progresso" (spec 2026-09-26 progress-panel §4.6). Read-only. */
export function ProgressPanel({ projectId }: { projectId: string }) {
  const [scope, setScope] = useState<ProgressScope>('active');
  const [data, setData] = useState<ProgressResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { tabState } = useMonitor();
  // Only the latest request may write: a "Só ativos"/"Todos" toggle or a poll can overtake one in flight.
  const latest = useRef(0);

  const load = useCallback(async () => {
    const mine = ++latest.current;
    try {
      const res = await api.progress({ project_id: projectId, scope });
      if (mine !== latest.current) return;
      setData(res);
      setError(null);
    } catch {
      if (mine !== latest.current) return;
      setError('Não foi possível carregar o progresso.');
    }
  }, [projectId, scope]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, PROGRESS_REFRESH_MS);
    return () => {
      clearInterval(timer);
      latest.current++;
    };
  }, [load]);

  const epics = (data?.epics ?? []).map((e) => ({
    ...e,
    cards: e.cards.map((c) => ({ ...c, agents: c.agents?.map((a) => withLiveTab(a, tabState(a.tab_id))) ?? null })),
  }));
  const waiting = needsYouAgents(epics);

  // Own scroller like the other project tabs: the layout row clips anything that leaks past it (TER-385).
  return (
    <div className="h-full space-y-4 overflow-y-auto p-4">
      <div className="flex items-center gap-2">
        <h1 className="text-lg font-semibold">Progresso</h1>
        <div className="ml-auto flex gap-1">
          {(['active', 'all'] as const).map((s) => (
            <button key={s} type="button" aria-pressed={scope === s} onClick={() => setScope(s)} className={`rounded px-2 py-1 text-sm ${scope === s ? 'bg-indigo-600 text-white' : 'border border-zinc-300 dark:border-zinc-700'}`}>
              {s === 'active' ? 'Só ativos' : 'Todos'}
            </button>
          ))}
        </div>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      {waiting.length > 0 && (
        <div className="rounded-lg border border-amber-500 bg-amber-50 p-3 dark:bg-amber-950">
          <p className="text-sm font-medium">{waiting.length === 1 ? '1 agente esperando você' : `${waiting.length} agentes esperando você`}</p>
          <div className="mt-2 flex flex-wrap gap-1">
            {waiting.map((a) => (
              <AgentChip key={a.tab_id} agent={a} projectId={projectId} />
            ))}
          </div>
        </div>
      )}
      {data && epics.length === 0 && <p className="text-sm text-zinc-500">Nenhum épico em andamento</p>}
      {epics.map((e) => (
        <EpicBlock key={e.id} epic={e} projectId={projectId} />
      ))}
    </div>
  );
}
