import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useData } from '../lib/data';
import { epicsInProgress, type EpicSummary } from '../lib/epic-summary';
import { useMonitor } from '../lib/monitor';
import { useNarrowWindow } from '../lib/narrow-window';
import { stateLabel } from '../lib/progress';
import { useProjectChat } from '../lib/project-chat';
import type { AgentOnCard, EpicProgress, Machine, Project, Tab } from '../lib/types';
import { buildCityModel, type CityModel } from '../office/model';
import { projectCity } from '../office/project-office';
import { OfficeScene } from '../office/scene/OfficeScene';
import { PROGRESS_REFRESH_MS } from './ProgressPanel';
import { i18n, useTranslation } from '../i18n';

/** Two taps on the same agent within this window pin its tab instead of previewing it. */
export const DOUBLE_TAP_MS = 300;

type OpenMode = 'preview' | 'pin';

/**
 * A tap opens the terminal in the preview tab, two quick taps pin it — like the sidebar's click and
 * double click. The preview waits for the double-tap window to pass: opening it at once would replace
 * this whole empty state with the terminal, and the second tap would land on the terminal instead
 * (the scene has no dblclick of its own). `immediate` (a keyboard Enter or Space, whose click has
 * `detail === 0`) previews at once: nobody double-presses a key to pin.
 */
export function useTapToOpen(onOpen: (tabId: string, mode: OpenMode) => void): (tabId: string, immediate?: boolean) => void {
  const open = useRef(onOpen);
  open.current = onOpen;
  const pending = useRef<{ tabId: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  useEffect(
    () => () => {
      if (pending.current) clearTimeout(pending.current.timer);
    },
    [],
  );
  return useCallback((tabId: string, immediate = false) => {
    const before = pending.current;
    if (before) {
      clearTimeout(before.timer);
      pending.current = null;
      if (before.tabId === tabId) return open.current(tabId, 'pin');
    }
    if (immediate) return open.current(tabId, 'preview');
    pending.current = {
      tabId,
      timer: setTimeout(() => {
        pending.current = null;
        open.current(tabId, 'preview');
      }, DOUBLE_TAP_MS),
    };
  }, []);
}

interface Props {
  project: Project;
  /** every terminal of the project (none open) */
  tabs: Tab[];
  /** the machines linked to the project */
  machines: Machine[];
  /** false = the tab list came back without being able to ask tmux */
  reachable: boolean;
  /** false while the project shows another section: no scene is drawn behind it */
  visible: boolean;
  onOpen: (tabId: string, mode: OpenMode) => void;
  onNewTerminal: () => void;
}

/**
 * The terminal area with no tab open (TER-912): the project's office — the /office building, one
 * person per terminal in the state its agent reports, live — beside the epics in progress and a
 * plain list of the terminals (for screen readers, keyboards and phones, where the scene is not drawn).
 * Only the monitor's state stream is used: no terminal connection is opened from here.
 */
export function OfficeEmptyState({ project, tabs, machines, reachable, visible, onOpen, onNewTerminal }: Props) {
  const { t } = useTranslation();
  const { statuses } = useData();
  const { can } = useAuth();
  const { items, tabState } = useMonitor();
  const narrow = useNarrowWindow();
  const tap = useTapToOpen(onOpen);
  const [scene, setScene] = useState<OfficeScene | null>(null);

  // `tabState` reads a ref and never changes identity; `items` is what changes on a live push
  const model = useMemo<CityModel>(
    () => buildCityModel(projectCity(project, tabs, machines, statuses, reachable), tabState),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `items` stands for the monitor's live state (see above)
    [project, tabs, machines, statuses, reachable, tabState, items],
  );
  const live = (tab: Tab) => ({ ...tab, ...pickState(tabState(tab.id)) });

  const highlight = (tabId: string | null) => scene?.debugHover(tabId);
  const epics = useEpicsInProgress(project.id, can('tasks', 'read'));
  // nothing beside the scene (no terminal, no epic going on): the office takes the whole width
  const aside = narrow || tabs.length > 0 || epics.length > 0;

  return (
    <div className="flex h-full flex-col md:flex-row" data-testid="office-empty-state">
      {!narrow && (
        <div className="relative min-h-0 flex-1">
          {visible && <ProjectOffice model={model} projectId={project.id} onPickDesk={(id) => tap(id)} onScene={setScene} />}
          {tabs.length === 0 && (
            <div className="pointer-events-none absolute inset-x-0 top-6 flex justify-center px-4">
              <Invite projectId={project.id} onNewTerminal={onNewTerminal} />
            </div>
          )}
        </div>
      )}
      {aside && (
        <aside
          className={`min-h-0 space-y-5 overflow-y-auto p-4 text-sm ${narrow ? 'flex-1' : 'w-80 shrink-0 border-l border-line'}`}
          aria-label={t('Resumo do projeto')}
        >
          {narrow && tabs.length === 0 && <Invite projectId={project.id} onNewTerminal={onNewTerminal} />}
          <EpicsSection epics={epics} onOpenAgent={(id) => tap(id, true)} onHighlight={highlight} />
          {tabs.length > 0 && (
            <section className="space-y-2">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">{t('Terminais')}</h2>
              <p className="text-xs text-fg-dim">{t('Nenhuma aba aberta. Clique num terminal para ver, dois cliques para fixar a aba.')}</p>
              <ul className="space-y-1" aria-label={t('Terminais do projeto')}>
                {tabs.map((tab) => (
                  <li key={tab.id}>
                    <button
                      type="button"
                      className="flex w-full items-baseline gap-2 rounded px-2 py-1 text-left hover:bg-bg-3"
                      onClick={(e) => tap(tab.id, e.detail === 0)}
                      onMouseEnter={() => highlight(tab.id)}
                      onMouseLeave={() => highlight(null)}
                      onFocus={() => highlight(tab.id)}
                      onBlur={() => highlight(null)}
                    >
                      <StateDot tab={live(tab)} />
                      <span className="min-w-0 flex-1 truncate">
                        {tab.name}
                        {machines.length > 1 && <span className="text-fg-dim"> · {machines.find((m) => m.id === tab.machine_id)?.name ?? ''}</span>}
                      </span>
                      <span className="shrink-0 text-xs text-fg-muted">{tabStateText(live(tab))}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </aside>
      )}
    </div>
  );
}

function pickState(t: Tab | undefined): Partial<Tab> {
  return t ? { state: t.state, state_seen_at: t.state_seen_at, state_at: t.state_at, alive: t.alive } : {};
}

/** The words the office's figures stand for: trabalhando, esperando você, aguardando segundo plano, concluído, parado. */
export function tabStateText(t: Pick<Tab, 'kind' | 'alive' | 'state'>): string {
  if (t.kind === 'simulator') return t.alive ? i18n.t('simulador ligado') : i18n.t('simulador desligado');
  if (!t.alive) return i18n.t('sem sessão');
  return stateLabel(t.state);
}

const DOT: Record<string, string> = {
  working: 'bg-emerald-500',
  waiting_input: 'bg-amber-500',
  waiting_permission: 'bg-amber-500',
  idle: 'bg-zinc-400',
  error: 'bg-red-500',
  waiting_background: 'bg-sky-400',
  // done with a report, asking nothing (TER-972): green, never the "esperando você" amber
  finished: 'bg-emerald-500',
};

function StateDot({ tab }: { tab: Pick<Tab, 'alive' | 'state'> }) {
  const tone = tab.alive && tab.state ? DOT[tab.state] : 'bg-bg-4';
  return <span className={`h-2 w-2 shrink-0 self-center rounded-full ${tone}`} aria-hidden="true" />;
}

function Invite({ projectId, onNewTerminal }: { projectId: string; onNewTerminal: () => void }) {
  const { can } = useAuth();
  const chat = useProjectChat();
  const { t } = useTranslation();
  return (
    <div className="pointer-events-auto flex flex-col items-center gap-2 rounded-lg border border-line bg-bg-2/90 px-4 py-3 text-center text-sm text-fg-muted">
      <p>{t('Ninguém trabalhando aqui ainda.')}</p>
      <div className="flex flex-wrap justify-center gap-2">
        <button className="btn-primary" onClick={onNewTerminal}>
          {t('Abrir terminal')} <kbd className="ml-1 rounded bg-black/30 px-1 text-[10px]">⌘T</kbd>{/* i18n-ignore */}
        </button>
        {can('chat') && (
          <button className="btn-ghost" onClick={() => chat.setOpen(projectId, true)}>
            {t('Pedir um agente ao concierge')}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * The project's building, framed. One scene per mount, fed every model change; a desk tap goes to
 * the caller. When neither WebGL nor canvas starts, the scene is dropped and the list beside it is
 * what is left — the same list the screen reader and the phone get.
 */
function ProjectOffice({ model, projectId, onPickDesk, onScene }: { model: CityModel; projectId: string; onPickDesk: (tabId: string) => void; onScene: (scene: OfficeScene | null) => void }) {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const sceneRef = useRef<OfficeScene | null>(null);
  const { t } = useTranslation();
  const modelRef = useRef(model);
  const pick = useRef(onPickDesk);
  pick.current = onPickDesk;
  const report = useRef(onScene);
  report.current = onScene;

  useEffect(() => {
    modelRef.current = model;
    sceneRef.current?.setModel(model);
  }, [model]);

  useEffect(() => {
    if (!host) return;
    const scene = new OfficeScene({
      onPickDesk: (tabId) => pick.current(tabId),
      // one building and nowhere to go: its floor, its sign and a zoom out do nothing here
      onPickBuilding: () => {},
      onPickSign: () => {},
      onGoUp: () => {},
    });
    sceneRef.current = scene;
    scene.setModel(modelRef.current);
    scene.focus({ kind: 'building', projectId }, true);
    scene.mount(host).catch(() => setFailed(true));
    report.current(scene);
    return () => {
      report.current(null);
      scene.destroy();
      sceneRef.current = null;
    };
  }, [host, projectId]);

  if (failed) return null;
  return <div ref={setHost} className="absolute inset-0 overflow-hidden" role="img" aria-label={t('Escritório do projeto: um boneco por terminal, no estado do agente')} />;
}

/**
 * The epics with a card in progress or an agent at work, from the progress panel's own read, kept
 * fresh at its pace (a card that moved shows up within PROGRESS_REFRESH_MS) and with the agents' state
 * live from the monitor. Empty without access to the board, or when the read fails.
 */
function useEpicsInProgress(projectId: string, enabled: boolean): EpicSummary[] {
  const { items, tabState } = useMonitor();
  const [epics, setEpics] = useState<EpicProgress[] | null>(null);

  useEffect(() => {
    setEpics(null);
    if (!enabled) return;
    let alive = true;
    const load = () => {
      api.progress({ project_id: projectId, scope: 'all' }).then(
        (r) => alive && setEpics(r.epics),
        () => {},
      );
    };
    load();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') load();
    }, PROGRESS_REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [projectId, enabled]);

  // eslint-disable-next-line react-hooks/exhaustive-deps -- `items` stands for the monitor's live state
  return useMemo(() => (epics ? epicsInProgress(epics, tabState) : []), [epics, tabState, items]);
}

function EpicsSection({ epics, onOpenAgent, onHighlight }: { epics: EpicSummary[]; onOpenAgent: (tabId: string) => void; onHighlight: (tabId: string | null) => void }) {
  const { t } = useTranslation();
  if (epics.length === 0) return null;
  return (
    <section className="space-y-3">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">{t('Épicos em andamento')}</h2>
      <ul className="space-y-3" aria-label={t('Épicos em andamento')}>
        {epics.map((e) => (
          <EpicRow key={e.id} epic={e} onOpenAgent={onOpenAgent} onHighlight={onHighlight} />
        ))}
      </ul>
    </section>
  );
}

function EpicRow({ epic, onOpenAgent, onHighlight }: { epic: EpicSummary; onOpenAgent: (tabId: string) => void; onHighlight: (tabId: string | null) => void }) {
  const { t } = useTranslation();
  return (
    <li className="space-y-1.5 rounded-lg border border-line p-3">
      <div className="flex items-baseline gap-2">
        <Link to={`/project/${epic.ref}`} className="min-w-0 flex-1 truncate font-medium text-fg hover:underline" title={`${epic.ref} ${epic.title}`}>
          {epic.title}
        </Link>
        <span className="shrink-0 text-xs tabular-nums text-fg-muted">
          {epic.cards.done}/{epic.cards.total}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={t('{{title}}: {{done}} de {{total}} cards feitos', { title: epic.title, done: epic.cards.done, total: epic.cards.total })}
        aria-valuenow={epic.percent}
        aria-valuemin={0}
        aria-valuemax={100}
        className="h-1.5 w-full rounded bg-bg-4"
      >
        <div className="h-1.5 rounded bg-accent" style={{ width: `${epic.percent}%` }} />
      </div>
      <p className="text-xs text-fg-muted">
        {t('{{n}} em andamento', { n: epic.doing })}
        {epic.waiting > 0 && <span className="text-warn"> · {t('{{n}} esperando você', { n: epic.waiting })}</span>}
      </p>
      {epic.agents.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {epic.agents.map((a) => (
            <AgentChip key={a.tab_id} agent={a} onOpen={() => onOpenAgent(a.tab_id)} onHighlight={onHighlight} />
          ))}
        </div>
      )}
    </li>
  );
}

/** An agent on the epic: hovering lights up its figure in the office, a click opens its terminal. */
function AgentChip({ agent, onOpen, onHighlight }: { agent: AgentOnCard; onOpen: () => void; onHighlight: (tabId: string | null) => void }) {
  const { t } = useTranslation();
  const label = stateLabel(agent.state, agent.background, agent.finished);
  const tone = agent.needs_you ? DOT.waiting_input : agent.background ? DOT.waiting_background : agent.finished ? DOT.finished : DOT.working;
  return (
    <button
      type="button"
      className={`inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-xs hover:bg-bg-3 ${agent.needs_you ? 'border-amber-500' : 'border-line'}`}
      title={`${agent.tab_name} · ${label}`}
      aria-label={t('Abrir {{name}} ({{state}})', { name: agent.tab_name, state: label })}
      onClick={onOpen}
      onMouseEnter={() => onHighlight(agent.tab_id)}
      onMouseLeave={() => onHighlight(null)}
      onFocus={() => onHighlight(agent.tab_id)}
      onBlur={() => onHighlight(null)}
    >
      <span className={`h-2 w-2 shrink-0 rounded-full ${tone}`} aria-hidden="true" />
      <span className="truncate">{agent.tab_name}</span>
    </button>
  );
}
