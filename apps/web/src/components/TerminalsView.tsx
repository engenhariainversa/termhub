import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useFocusTabFromParam } from '../lib/tab-param';
import { api, ApiError } from '../lib/api';
import {
  cellRects,
  emptyLayout,
  ensureVisibleTab,
  initialFloatingRect,
  loadLayout,
  placeOf,
  reduce,
  sanitize,
  saveLayout,
  type Action,
  type Layout,
  type Preset,
  type Rect,
  type Size,
} from '../lib/layout';
import type { Project, Tab, TabKind } from '../lib/types';
import { TabBar } from './TabBar';
import { TerminalView } from './Terminal';
import { SimulatorView } from './SimulatorView';
import { RateLimitBanner } from './RateLimitBanner';
import { PaneLayer, PANE_HEADER_HEIGHT } from './PaneLayer';
import { FloatingWindow, FLOATING_TITLE_HEIGHT } from './FloatingWindow';
import { ConfirmDialog } from './Modal';
import { MachinePicker } from './MachinePicker';
import { useAuth } from '../lib/auth';
import { useData } from '../lib/data';
import { useMarkSeenOnFocus, useMonitor } from '../lib/monitor';
import { setTabsOnScreen } from '../lib/visible-tabs';
import { writeLastMachine } from '../lib/last-machine';

interface Props {
  project: Project;
  visible: boolean;
}

export function TerminalsView({ project, visible }: Props) {
  const { machines, machinesOf, missingTmux } = useData();
  const { can } = useAuth();
  const { items: monitorItems } = useMonitor();
  // `machinesOf` itself is not stable: it lives on `useData()`'s value, whose memo also depends on
  // `statuses` (updated on every status poll), so its identity changes far more often than the
  // machine list. Key on the actual inputs instead so this doesn't re-run `newTab`'s effects on
  // every poll.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `machinesOf` itself is unstable (see above); the real inputs are `project.machines` and `machines`.
  const projectMachines = useMemo(() => machinesOf(project), [project.machines, machines]);
  const machineById = (id: string) => projectMachines.find((m) => m.id === id);
  const noTmux = projectMachines.some((m) => missingTmux[m.id]);
  const canSimulator = projectMachines.some((m) => m.capabilities.includes('wda'));
  const [picking, setPicking] = useState<{ kind: TabKind; cell?: number } | null>(null);
  const [tabs, setTabs] = useState<Tab[] | null>(null);
  const [reachable, setReachable] = useState(true);
  const [closing, setClosing] = useState<Tab | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Tabs mount only after the section was visible once (xterm cannot initialize inside display:none).
  const [shown, setShown] = useState(visible);
  useEffect(() => {
    if (visible) setShown(true);
  }, [visible]);

  // --- Layout state -------------------------------------------------------
  const areaRef = useRef<HTMLDivElement>(null);
  const [area, setArea] = useState<Size | null>(null);
  // Starts empty: loading with the real tab list (below) picks up the stored layout, and
  // `loadLayout`/`sanitize` need the actual tab ids to keep anything — calling them here with an
  // empty list would consume the legacy migration key and sanitize away any saved layout.
  const [layout, setLayout] = useState<Layout>(() => emptyLayout('single'));
  const [floatingFocused, setFloatingFocused] = useState(false);
  const tabIds = useMemo(() => (tabs ?? []).map((t) => t.id), [tabs]);

  // Tabs in a cell or floating while this section is shown: the "needs you" toasts skip them.
  useEffect(() => {
    setTabsOnScreen(project.id, visible ? tabIds.filter((id) => placeOf(layout, id) !== null) : []);
  }, [project.id, visible, tabIds, layout]);
  useEffect(() => () => setTabsOnScreen(project.id, []), [project.id]);

  useLayoutEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      // The section can be `display:none` while hidden (0×0): ignore that reading and keep the
      // last real size, or the floating window (and everything else) gets clamped to nothing
      // and that gets persisted.
      if (r.width === 0 || r.height === 0) return;
      setArea({ width: Math.floor(r.width), height: Math.floor(r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Re-sanitize whenever the tab list or the area changes (deleted tabs, smaller window), and
  // fall back to showing the first tab if that leaves nothing on screen.
  useEffect(() => {
    if (!tabs) return;
    setLayout((l) => ensureVisibleTab(sanitize(l, tabIds, area), tabIds));
  }, [tabs, tabIds, area]);

  // First load with the real tab list: pick up the stored layout (or migrate the old active-tab key).
  const loadedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!tabs || loadedFor.current === project.id) return;
    loadedFor.current = project.id;
    setLayout(ensureVisibleTab(loadLayout(project.id, tabIds, area), tabIds));
  }, [tabs, tabIds, area, project.id]);

  useEffect(() => {
    if (loadedFor.current === project.id) saveLayout(project.id, layout);
  }, [layout, project.id]);

  // `tabIds` is read inside the updater (not a dep) so `dispatch`'s identity stays stable across
  // tab list changes; ensureVisibleTab keeps every dispatch from leaving the area blank (e.g.
  // switching `columns [null, 'b']` to `single` would otherwise strand `cells: [null]`).
  const tabIdsRef = useRef(tabIds);
  tabIdsRef.current = tabIds;
  const dispatch = useCallback((action: Action) => setLayout((l) => ensureVisibleTab(reduce(l, action, area), tabIdsRef.current)), [area]);

  const rects = useMemo(() => (area ? cellRects(layout.preset, area.width, area.height) : []), [area, layout.preset]);
  const headerH = layout.preset === 'single' ? 0 : PANE_HEADER_HEIGHT;

  /** Where a tab is drawn: its cell (minus the header) or the floating body; null = hidden. */
  const rectOf = (tabId: string): Rect | null => {
    const place = placeOf(layout, tabId);
    if (!place) return null;
    if (place.kind === 'floating' && layout.floating) {
      const f = layout.floating;
      return { x: f.x, y: f.y + FLOATING_TITLE_HEIGHT, w: f.w, h: Math.max(0, f.h - FLOATING_TITLE_HEIGHT) };
    }
    if (place.kind === 'cell') {
      const r = rects[place.cell];
      return r ? { x: r.x, y: r.y + headerH, w: r.w, h: Math.max(0, r.h - headerH) } : null;
    }
    return null;
  };

  const focusedTabId = layout.floating && floatingFocused ? layout.floating.tabId : layout.cells[layout.focusedCell] ?? null;

  // Clears the focused tab's "needs you" dot as soon as the person actually looks at it.
  useMarkSeenOnFocus(focusedTabId, visible);

  // The focused tab's live state (rate_limited_at, state) comes from the monitor push; the REST row
  // (loaded below) is the fallback until a snapshot/push for it arrives.
  const focusedLiveTab = monitorItems.find((i) => i.tab.id === focusedTabId)?.tab ?? (tabs ?? []).find((t) => t.id === focusedTabId);

  // --- Data -----------------------------------------------------------------
  const load = useCallback(async () => {
    try {
      const r = await api.projects.tabs(project.id);
      setTabs(r.tabs);
      setReachable(r.reachable);
      setError(null);
    } catch (e) {
      // Keep `tabs` as-is (usually still null on the first load): a fake `[]` would make the
      // layout effects sanitize away — and then persist — an empty layout over whatever was saved.
      setError(e instanceof ApiError ? e.message : 'Erro ao carregar tabs');
    }
  }, [project.id]);

  useEffect(() => {
    void load();
  }, [load]);

  // An unlink (in this tab or another) must not leave that machine's tabs on screen until the next
  // reload: prune them from state (and the layout, like `onClose` does) right away, then re-fetch to
  // pick up whatever the server did (e.g. tabs it already closed on unlink).
  const linkedMachineIds = project.machines.map((l) => l.machine_id).join(',');
  const linkedMachineIdsMounted = useRef(false);
  useEffect(() => {
    if (!linkedMachineIdsMounted.current) {
      // first run: the mount effect above already loads the tabs for the initial link set.
      linkedMachineIdsMounted.current = true;
      return;
    }
    const allowed = new Set(linkedMachineIds ? linkedMachineIds.split(',') : []);
    // `setTabs`'s updater must stay pure: compute the stale ids from `tabs` (in scope — this effect's
    // closure holds the value from the render that changed `linkedMachineIds`) and dispatch for each
    // in a plain loop, outside the updater.
    const stale = (tabs ?? []).filter((x) => !allowed.has(x.machine_id));
    for (const s of stale) dispatch({ type: 'closeTab', tabId: s.id });
    if (stale.length > 0) setTabs((t) => (t ?? []).filter((x) => allowed.has(x.machine_id)));
    void load();
    // `dispatch`/`load` are effectively stable for this purpose (see the `machinesOf` note above);
    // this must only re-run when the set of linked machine ids actually changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkedMachineIds]);

  // ?tab=<id> (from a task card or a sidebar agent) shows the tab in the focused cell; a tab this
  // view does not know yet is waited for across one reload (see useFocusTabFromParam).
  const focusTab = useCallback((tabId: string) => dispatch({ type: 'assign', tabId }), [dispatch]);
  useFocusTabFromParam(tabs, load, focusTab);

  const newTab = useCallback(
    async (kind: TabKind = 'terminal', cell?: number, machineId?: string) => {
      // A simulator only runs on a machine with its WDA prepared; a plain terminal runs on any linked one.
      const candidates = kind === 'simulator' ? projectMachines.filter((m) => m.capabilities.includes('wda')) : projectMachines;
      if (candidates.length === 0) {
        setError(
          kind === 'simulator'
            ? 'Nenhuma máquina vinculada tem o WDA preparado para simuladores.'
            : 'Vincule uma máquina ao projeto em Setup → Máquinas para abrir terminais.',
        );
        return;
      }
      const chosen = machineId ?? (candidates.length === 1 ? candidates[0].id : undefined);
      if (!chosen) {
        setPicking({ kind, cell });
        return;
      }
      try {
        const { tab } = await api.projects.createTab(project.id, { kind, machine_id: chosen });
        writeLastMachine(project.id, chosen);
        setTabs((t) => [...(t ?? []), tab]);
        setLayout((l) => {
          const target = cell ?? (l.cells.indexOf(null) === -1 ? l.focusedCell : l.cells.indexOf(null));
          return reduce(l, { type: 'assignTo', cell: target, tabId: tab.id }, area);
        });
      } catch (e) {
        setError(e instanceof ApiError ? e.message : 'Erro ao criar tab');
      }
    },
    [project.id, area, projectMachines],
  );

  const rename = useCallback(
    async (id: string, name: string) => {
      setTabs((t) => (t ?? []).map((x) => (x.id === id ? { ...x, name } : x)));
      try {
        await api.tabs.rename(id, name);
      } catch {
        void load();
      }
    },
    [load],
  );

  const closeTab = useCallback(
    async (tab: Tab) => {
      setClosing(null);
      setTabs((t) => (t ?? []).filter((x) => x.id !== tab.id));
      dispatch({ type: 'closeTab', tabId: tab.id });
      try {
        await api.tabs.remove(tab.id);
      } catch (e) {
        setError(e instanceof ApiError ? e.message : 'Erro ao fechar tab');
        void load();
      }
    },
    [dispatch, load],
  );

  // Mark the session alive as soon as the tab connects (no need to wait for the next load).
  const markAlive = useCallback((id: string) => {
    setTabs((t) => (t ?? []).map((x) => (x.id === id && !x.alive ? { ...x, alive: true } : x)));
  }, []);

  const detach = useCallback(
    (tab: Tab, aspect: number) => {
      if (!area || tab.kind !== 'simulator') return;
      dispatch({ type: 'detach', tabId: tab.id, rect: initialFloatingRect(area, aspect) });
      setFloatingFocused(true);
    },
    [area, dispatch],
  );

  // Shortcuts: ⌘T new tab, ⌘W close focused, ⌘1..9 assign (ctrl+shift+T/W as alternatives).
  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      const list = tabs ?? [];
      const meta = e.metaKey && !e.ctrlKey && !e.altKey;
      const ctrlShift = e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey;
      if ((meta && e.key === 't') || (ctrlShift && e.key === 'T')) {
        e.preventDefault();
        void newTab();
      } else if ((meta && e.key === 'w') || (ctrlShift && e.key === 'W')) {
        e.preventDefault();
        const t = list.find((x) => x.id === focusedTabId);
        if (t) setClosing(t);
      } else if (meta && /^[1-9]$/.test(e.key)) {
        const t = list[Number(e.key) - 1];
        if (t) {
          e.preventDefault();
          dispatch({ type: 'assign', tabId: t.id });
          setFloatingFocused(layout.floating?.tabId === t.id);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, tabs, focusedTabId, newTab, dispatch, layout.floating]);

  const floatingTab = layout.floating ? (tabs ?? []).find((t) => t.id === layout.floating?.tabId) : undefined;

  return (
    <div className={`absolute inset-0 flex flex-col ${visible ? '' : 'hidden'}`}>
      <TabBar
        tabs={tabs ?? []}
        activeId={focusedTabId}
        onScreen={(id) => placeOf(layout, id) !== null}
        preset={layout.preset}
        onPreset={(p: Preset) => dispatch({ type: 'setPreset', preset: p })}
        onSelect={(id) => {
          dispatch({ type: 'assign', tabId: id });
          setFloatingFocused(layout.floating?.tabId === id);
        }}
        onNew={() => void newTab()}
        onNewSimulator={() => void newTab('simulator')}
        canSimulator={canSimulator}
        onRename={(id, name) => void rename(id, name)}
        onClose={(id) => {
          const t = (tabs ?? []).find((x) => x.id === id);
          if (t) setClosing(t);
        }}
        badges={
          projectMachines.length > 1
            ? Object.fromEntries((tabs ?? []).map((t) => [t.id, machineById(t.machine_id)?.name ?? '']))
            : undefined
        }
      />
      {focusedLiveTab && (
        // Keyed on the tab id + rate_limited_at: a new focused tab, or the same tab hitting the
        // limit again (a fresh rate_limited_at), must remount the banner — otherwise its local
        // busy/done/error state survives and shows a stale "Retomando em …" with no button back.
        <RateLimitBanner key={`${focusedLiveTab.id}:${focusedLiveTab.rate_limited_at ?? ''}`} tab={focusedLiveTab} canSwap={can('terminals', 'update')} />
      )}
      {projectMachines.length === 0 && (
        <div className="border-b border-warn/30 bg-warn/10 px-3 py-1 text-xs text-warn">
          Este projeto não tem máquina vinculada.{' '}
          <Link to={`/projects/${project.id}/settings`} className="underline">
            Vincular em Setup → Máquinas
          </Link>
          .
        </div>
      )}
      {noTmux && (
        <div className="border-b border-warn/30 bg-warn/10 px-3 py-1 text-xs text-warn">
          <strong>{projectMachines.filter((m) => missingTmux[m.id]).map((m) => m.name).join(', ')}</strong> está online mas não tem{' '}
          <code className="font-mono">tmux</code> instalado. Instale (ex.: <code className="font-mono">sudo apt install tmux</code>) para abrir
          terminais.
        </div>
      )}
      {!reachable && (
        <div className="border-b border-warn/30 bg-warn/10 px-3 py-1 text-xs text-warn">
          Não foi possível consultar as sessões tmux nesta máquina (offline?). Os terminais podem não conectar.
        </div>
      )}
      {error && (
        <div className="border-b border-danger/30 bg-danger/10 px-3 py-1 text-xs text-danger">
          {error}{' '}
          <button className="underline" onClick={() => void load()}>
            Tentar de novo
          </button>{' '}
          <button className="underline" onClick={() => setError(null)}>
            fechar
          </button>
        </div>
      )}
      <div ref={areaRef} className="relative min-h-0 flex-1 overflow-hidden">
        {tabs === null ? (
          <div className="flex h-full items-center justify-center text-sm text-fg-dim">Carregando tabs…</div>
        ) : tabs.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-fg-muted">
            <p>Nenhum terminal aberto neste projeto.</p>
            <button className="btn-primary" onClick={() => void newTab()}>
              Abrir terminal <kbd className="ml-1 rounded bg-black/30 px-1 text-[10px]">⌘T</kbd>
            </button>
          </div>
        ) : shown && area ? (
          <>
            {tabs.map((t) => {
              const r = rectOf(t.id);
              const place = placeOf(layout, t.id);
              const isFloating = place?.kind === 'floating';
              const active = visible && r !== null;
              const focused = visible && t.id === focusedTabId;
              return (
                <div
                  key={t.id}
                  className="absolute"
                  style={
                    r
                      ? { left: r.x, top: r.y, width: r.w, height: r.h, zIndex: isFloating ? 21 : 1 }
                      : { left: 0, top: 0, width: area.width, height: area.height, visibility: 'hidden', pointerEvents: 'none' }
                  }
                  onPointerDownCapture={() => {
                    if (place?.kind === 'cell') {
                      dispatch({ type: 'focus', cell: place.cell });
                      setFloatingFocused(false);
                    } else if (isFloating) setFloatingFocused(true);
                  }}
                >
                  {t.kind === 'simulator' ? (
                    <SimulatorView
                      tab={t}
                      machineId={t.machine_id}
                      active={active}
                      focused={focused}
                      floating={isFloating}
                      onDetach={(aspect) => detach(t, aspect)}
                      onDock={() => {
                        dispatch({ type: 'dock' });
                        setFloatingFocused(false);
                      }}
                      onTabChange={(updated) => setTabs((list) => (list ?? []).map((x) => (x.id === updated.id ? { ...updated, alive: x.alive } : x)))}
                      onConnected={() => markAlive(t.id)}
                    />
                  ) : (
                    <TerminalView tabId={t.id} active={active} focused={focused} onConnected={() => markAlive(t.id)} />
                  )}
                </div>
              );
            })}
            <PaneLayer
              preset={layout.preset}
              rects={rects}
              cells={layout.cells}
              focusedCell={layout.focusedCell}
              tabs={tabs}
              onFocus={(cell) => {
                dispatch({ type: 'focus', cell });
                setFloatingFocused(false);
              }}
              onAssign={(cell, tabId) => dispatch({ type: 'assignTo', cell, tabId })}
              onClear={(cell) => dispatch({ type: 'clearCell', cell })}
              onNewTerminal={(cell) => void newTab('terminal', cell)}
            />
            {layout.floating && floatingTab && (
              <FloatingWindow
                rect={layout.floating}
                title={floatingTab.name}
                onMove={(x, y) => dispatch({ type: 'moveFloating', x, y })}
                onResize={(w, h) => dispatch({ type: 'resizeFloating', w, h })}
                onDock={() => {
                  dispatch({ type: 'dock' });
                  setFloatingFocused(false);
                }}
                onFocus={() => setFloatingFocused(true)}
              >
                {null}
              </FloatingWindow>
            )}
          </>
        ) : null}
      </div>
      <ConfirmDialog
        open={!!closing}
        title="Fechar tab"
        message={
          closing?.kind === 'simulator' ? (
            <>
              Fechar <strong>{closing?.name}</strong>? O simulador continua ligado na máquina; só a aba é removida.
            </>
          ) : (
            <>
              Fechar <strong>{closing?.name}</strong>? A sessão tmux <code className="font-mono text-xs">{closing?.tmux_session}</code> será
              encerrada na máquina e o que estiver rodando nela será interrompido.
            </>
          )
        }
        confirmLabel="Fechar tab"
        danger
        onCancel={() => setClosing(null)}
        onConfirm={() => {
          if (closing) void closeTab(closing);
        }}
      />
      <MachinePicker
        open={!!picking}
        project={project}
        machines={picking?.kind === 'simulator' ? projectMachines.filter((m) => m.capabilities.includes('wda')) : projectMachines}
        onPick={(machineId) => {
          const p = picking!;
          setPicking(null);
          void newTab(p.kind, p.cell, machineId);
        }}
        onClose={() => setPicking(null)}
      />
    </div>
  );
}
