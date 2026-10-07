import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
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
import { TabBar, type BarTab } from './TabBar';
import { FileView } from './FileView';
import { TerminalView } from './Terminal';
import { SimulatorView } from './SimulatorView';
import { TabChatView } from './tab-chat/TabChatView';
import { RateLimitBanner } from './RateLimitBanner';
import { PaneLayer, PANE_HEADER_HEIGHT } from './PaneLayer';
import { FloatingWindow, FLOATING_TITLE_HEIGHT } from './FloatingWindow';
import { MachinePicker } from './MachinePicker';
import { OfficeEmptyState } from './OfficeEmptyState';
import { i18n, Trans, useTranslation } from '../i18n';
import { useAuth } from '../lib/auth';
import { useData } from '../lib/data';
import { useMarkSeenOnFocus, useMonitor } from '../lib/monitor';
import { setTabsOnScreen } from '../lib/visible-tabs';
import { writeLastMachine } from '../lib/last-machine';
import { setTabView, useTabViews } from '../lib/tab-view';
import {
  chatTabId,
  closeEditorTab,
  filePathOf,
  fileTabId,
  getEditorTabs,
  isChatTabId,
  isFileTabId,
  onTerminalEnded,
  pinTab,
  previewTab,
  pruneEditorTabs,
  seedEditorTabs,
  terminalOfChat,
  updateEditorTabs,
  useEditorTabs,
} from '../lib/editor-tabs';

interface Props {
  project: Project;
  visible: boolean;
}

export function TerminalsView({ project, visible }: Props) {
  const { t } = useTranslation();
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
  // Every terminal of the project is listed in the sidebar; only the open tabs (TER-904) are mounted and
  // hold a terminal connection, so the layout works on those alone.
  const editorTabs = useEditorTabs(project.id);
  // File previews (spec 2026-10-04 file preview D14) share the list: they are open whatever the terminal list says.
  // A conversation tab (TER-1003) is open while its terminal is one of the project's.
  const openIds = (editorTabs?.open ?? []).filter((id) => isFileTabId(id) || (tabs ?? []).some((t) => t.id === (isChatTabId(id) ? terminalOfChat(id) : id)));
  const openKey = JSON.stringify(openIds);
  const tabIds = useMemo(() => JSON.parse(openKey) as string[], [openKey]);
  const openTabs = useMemo(() => tabIds.map((id) => (tabs ?? []).find((t) => t.id === id)).filter((t): t is Tab => !!t), [tabIds, tabs]);
  /** What the bar shows, in its order: terminals, file previews and terminals' conversations. */
  const barTabs = useMemo<BarTab[]>(
    () =>
      tabIds.flatMap((id): BarTab[] => {
        if (isFileTabId(id)) {
          const path = filePathOf(id);
          return [{ id, kind: 'file', path, name: path.split('/').pop() || path }];
        }
        if (isChatTabId(id)) {
          const terminal = (tabs ?? []).find((x) => x.id === terminalOfChat(id));
          return terminal ? [{ id, kind: 'chat', terminalId: terminal.id, machineId: terminal.machine_id, name: terminal.name }] : [];
        }
        const t = openTabs.find((x) => x.id === id);
        return t ? [t] : [];
      }),
    [tabIds, openTabs, tabs],
  );
  /** Terminal tabs switched to their conversation (TER-1003), by id. */
  const tabViews = useTabViews();
  /** The terminal a bar tab is about: itself, or the one a conversation tab reads; null for a file. */
  const terminalIdOf = (id: string | null): string | null => (!id || isFileTabId(id) ? null : isChatTabId(id) ? terminalOfChat(id) : id);
  const previewId = editorTabs?.preview ?? null;

  // Tabs in a cell or floating while this section is shown: the "needs you" toasts skip them.
  useEffect(() => {
    setTabsOnScreen(project.id, visible ? tabIds.filter((id) => placeOf(layout, id) !== null).map((id) => (isChatTabId(id) ? terminalOfChat(id) : id)) : []);
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

  // Re-sanitize whenever the open tabs or the area change (closed tabs, smaller window), and
  // fall back to showing the first open tab if that leaves nothing on screen.
  useEffect(() => {
    if (!tabs) return;
    setLayout((l) => ensureVisibleTab(sanitize(l, tabIds, area), tabIds));
  }, [tabs, tabIds, area]);

  // First load with the real tab list: pick up the stored layout (or migrate the old active-tab key).
  // A layout effect, so the stored layout lands in the same commit that first shows the tabs: as a
  // passive effect it ran a moment later and replaced whatever layout change came in between (a
  // preset or a pane picked right as the tabs appeared was lost — TER-911).
  const loadedFor = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!tabs || loadedFor.current === project.id) return;
    loadedFor.current = project.id;
    const all = tabs.map((t) => t.id);
    // The first visit after TER-904 opens what the saved layout had on screen (or the first terminal),
    // so nobody lands on an empty area; from then on the open tabs are remembered per project.
    const saved = loadLayout(project.id, all, area);
    let open = getEditorTabs(project.id)?.open.filter((id) => all.includes(id) || isFileTabId(id));
    if (!open) {
      const onScreen = [...saved.cells, saved.floating?.tabId ?? null].filter((id): id is string => !!id);
      open = seedEditorTabs(project.id, onScreen.length > 0 ? { open: onScreen, preview: null } : { open: all.slice(0, 1), preview: all[0] ?? null }).open;
    }
    setLayout(ensureVisibleTab(sanitize(saved, open, area), open));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per project, with the first tab list
  }, [tabs, project.id]);

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

  // Clears the focused tab's "needs you" dot as soon as the person actually looks at it (a file has none).
  useMarkSeenOnFocus(terminalIdOf(focusedTabId), visible);

  // The focused tab's live state (rate_limited_at, state) comes from the monitor push; the REST row
  // (loaded below) is the fallback until a snapshot/push for it arrives.
  const focusedTerminalId = terminalIdOf(focusedTabId);
  const focusedLiveTab = monitorItems.find((i) => i.tab.id === focusedTerminalId)?.tab ?? (tabs ?? []).find((t) => t.id === focusedTerminalId);

  // --- Data -----------------------------------------------------------------
  const load = useCallback(async () => {
    try {
      const r = await api.projects.tabs(project.id);
      setTabs(r.tabs);
      const known = new Set(r.tabs.map((t) => t.id));
      if (getEditorTabs(project.id)) updateEditorTabs(project.id, (s) => pruneEditorTabs(s, known));
      setReachable(r.reachable);
      setError(null);
    } catch (e) {
      // Keep `tabs` as-is (usually still null on the first load): a fake `[]` would make the
      // layout effects sanitize away — and then persist — an empty layout over whatever was saved.
      setError(e instanceof ApiError ? e.message : i18n.t('Erro ao carregar tabs'));
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
  /**
   * Shows a terminal: a single click opens it in the preview tab (in the cell the old preview had), a
   * double click or the pin button pins it. An open tab just gets the focus.
   */
  const openTab = useCallback(
    (tabId: string, mode: 'preview' | 'pin') => {
      const before = getEditorTabs(project.id);
      const after = updateEditorTabs(project.id, (s) => (mode === 'pin' ? pinTab(s, tabId) : previewTab(s, tabId)));
      const replaced = before?.preview && before.preview !== tabId && !after.open.includes(before.preview) ? before.preview : null;
      setLayout((l) => {
        const cell = replaced ? l.cells.indexOf(replaced) : -1;
        if (cell !== -1) return reduce(l, { type: 'assignTo', cell, tabId }, area);
        const swapped = replaced && l.floating?.tabId === replaced ? reduce(l, { type: 'closeTab', tabId: replaced }, area) : l;
        return ensureVisibleTab(reduce(swapped, { type: 'assign', tabId }, area), after.open);
      });
      setFloatingFocused(false);
    },
    [project.id, area],
  );
  const focusTab = useCallback((tabId: string) => openTab(tabId, 'preview'), [openTab]);
  useFocusTabFromParam(tabs, load, focusTab);

  // ?file=<path> (a path linked in the chat, spec 2026-10-04 file preview): opens it as the preview tab,
  // once the stored tabs and layout are loaded so they do not replace it.
  const [searchParams, setSearchParams] = useSearchParams();
  const wantedFile = searchParams.get('file');
  const wantedPin = searchParams.get('pin') === '1';
  const ready = tabs !== null && loadedFor.current === project.id;
  useEffect(() => {
    if (!wantedFile || !ready) return;
    setSearchParams(
      (p) => {
        p.delete('file');
        p.delete('pin');
        p.delete('machine');
        return p;
      },
      { replace: true },
    );
    openTab(fileTabId(wantedFile), wantedPin ? 'pin' : 'preview');
  }, [wantedFile, wantedPin, ready, openTab, setSearchParams]);
  const openFile = useCallback((path: string, mode: 'preview' | 'pin') => openTab(fileTabId(path), mode), [openTab]);

  /** A terminal's conversation in a tab of its own (TER-1003); the terminal's own tab goes back to the terminal. */
  const openChatTab = useCallback(
    (terminalId: string) => {
      setTabView(terminalId, 'terminal');
      openTab(chatTabId(terminalId), 'pin');
    },
    [openTab],
  );

  /**
   * The conversation in a pane next to its terminal: a single pane becomes two columns, the terminal
   * keeps (or takes) its pane and the conversation takes another, an empty one first.
   */
  const openChatBeside = useCallback(
    (terminalId: string) => {
      const id = chatTabId(terminalId);
      setTabView(terminalId, 'terminal');
      const after = updateEditorTabs(project.id, (s) => pinTab(pinTab(s, terminalId), id));
      setLayout((l) => {
        let next = l.preset === 'single' ? reduce(l, { type: 'setPreset', preset: 'columns' }, area) : l;
        if (next.cells.indexOf(terminalId) === -1) next = reduce(next, { type: 'assignTo', cell: 0, tabId: terminalId }, area);
        const terminalCell = next.cells.indexOf(terminalId);
        const empty = next.cells.findIndex((c, i) => i !== terminalCell && c === null);
        const target = empty !== -1 ? empty : next.cells.findIndex((_, i) => i !== terminalCell);
        return ensureVisibleTab(reduce(next, { type: 'assignTo', cell: target, tabId: id }, area), after.open);
      });
      setFloatingFocused(false);
    },
    [project.id, area],
  );

  /** The tab's ✕ (and ⌘W): only the tab closes; the terminal, its tmux session and its agent keep going. */
  const closeTab = useCallback(
    (tabId: string) => {
      const after = updateEditorTabs(project.id, (s) => closeEditorTab(s, tabId));
      setLayout((l) => ensureVisibleTab(reduce(l, { type: 'closeTab', tabId }, area), after.open));
    },
    [project.id, area],
  );

  // A terminal ended from the sidebar: drop it from the list (its tab is already closed).
  useEffect(
    () =>
      onTerminalEnded((projectId, tabId) => {
        if (projectId !== project.id) return;
        setTabs((t) => (t ? t.filter((x) => x.id !== tabId) : t));
        dispatch({ type: 'closeTab', tabId });
      }),
    [project.id, dispatch],
  );

  const newTab = useCallback(
    async (kind: TabKind = 'terminal', cell?: number, machineId?: string) => {
      // A simulator only runs on a machine with its WDA prepared; a plain terminal runs on any linked one.
      const candidates = kind === 'simulator' ? projectMachines.filter((m) => m.capabilities.includes('wda')) : projectMachines;
      if (candidates.length === 0) {
        setError(
          kind === 'simulator'
            ? i18n.t('Nenhuma máquina vinculada tem o WDA preparado para simuladores.')
            : i18n.t('Vincule uma máquina ao projeto em Setup → Máquinas para abrir terminais.'),
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
        updateEditorTabs(project.id, (s) => pinTab(s, tab.id));
        setLayout((l) => {
          const target = cell ?? (l.cells.indexOf(null) === -1 ? l.focusedCell : l.cells.indexOf(null));
          return reduce(l, { type: 'assignTo', cell: target, tabId: tab.id }, area);
        });
      } catch (e) {
        setError(e instanceof ApiError ? e.message : i18n.t('Erro ao criar tab'));
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
      const list = barTabs;
      const meta = e.metaKey && !e.ctrlKey && !e.altKey;
      const ctrlShift = e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey;
      if ((meta && e.key === 't') || (ctrlShift && e.key === 'T')) {
        e.preventDefault();
        void newTab();
      } else if ((meta && e.key === 'w') || (ctrlShift && e.key === 'W')) {
        e.preventDefault();
        if (focusedTabId) closeTab(focusedTabId);
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
  }, [visible, barTabs, focusedTabId, newTab, closeTab, dispatch, layout.floating]);

  const floatingTab = layout.floating ? openTabs.find((t) => t.id === layout.floating?.tabId) : undefined;

  return (
    <div className={`absolute inset-0 flex flex-col ${visible ? '' : 'hidden'}`}>
      <TabBar
        tabs={barTabs}
        activeId={focusedTabId}
        previewId={previewId}
        onPin={(id) => openTab(id, 'pin')}
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
        onClose={closeTab}
        views={tabViews}
        onToggleView={(id) => setTabView(id, tabViews[id] === 'chat' ? 'terminal' : 'chat')}
        badges={
          projectMachines.length > 1
            ? Object.fromEntries(openTabs.map((t) => [t.id, machineById(t.machine_id)?.name ?? '']))
            : undefined
        }
      />
      {focusedLiveTab && (
        // Keyed on the tab id + rate_limited_at: a new focused tab, or the same tab hitting the
        // limit again (a fresh rate_limited_at), must remount the banner — otherwise its local
        // busy/done/error state survives and shows a stale "Retomando em …" with no button back.
        <RateLimitBanner
          key={`${focusedLiveTab.id}:${focusedLiveTab.rate_limited_at ?? ''}`}
          tab={focusedLiveTab}
          canSwap={can('terminals', 'update')}
          autoSwap={machineById(focusedLiveTab.machine_id)?.claude_auto_swap ?? true}
        />
      )}
      {projectMachines.length === 0 && (
        <div className="border-b border-warn/30 bg-warn/10 px-3 py-1 text-xs text-warn">
          {t('Este projeto não tem máquina vinculada.')}{' '}
          <Link to={`/projects/${project.id}/settings`} className="underline">
            {t('Vincular em Setup → Máquinas')}
          </Link>
          .
        </div>
      )}
      {noTmux && (
        <div className="border-b border-warn/30 bg-warn/10 px-3 py-1 text-xs text-warn">
          <Trans
            i18nKey="<0>{{machines}}</0> está online mas não tem <1>tmux</1> instalado. Instale (ex.: <2>sudo apt install tmux</2>) para abrir terminais."
            values={{ machines: projectMachines.filter((m) => missingTmux[m.id]).map((m) => m.name).join(', ') }}
            components={[<strong key="m" />, <code key="t" className="font-mono" />, <code key="c" className="font-mono" />]}
          />
        </div>
      )}
      {!reachable && (
        <div className="border-b border-warn/30 bg-warn/10 px-3 py-1 text-xs text-warn">
          {t('Não foi possível consultar as sessões tmux nesta máquina (offline?). Os terminais podem não conectar.')}
        </div>
      )}
      {error && (
        <div className="border-b border-danger/30 bg-danger/10 px-3 py-1 text-xs text-danger">
          {error}{' '}
          <button className="underline" onClick={() => void load()}>
            {t('Tentar de novo')}
          </button>{' '}
          <button className="underline" onClick={() => setError(null)}>
            {t('fechar')}
          </button>
        </div>
      )}
      <div ref={areaRef} className="relative min-h-0 flex-1 overflow-hidden">
        {tabs === null ? (
          <div className="flex h-full items-center justify-center text-sm text-fg-dim">{t('Carregando tabs…')}</div>
        ) : barTabs.length === 0 && (tabs.length === 0 || layout.preset === 'single') ? (
          // Nothing open (or no terminal yet): the project's office, with its epics in progress and a
          // plain list of the terminals — the sidebar can be collapsed, or hidden in focus mode (TER-912). An open
          // file preview (TER-941) counts as an open tab.
          <OfficeEmptyState project={project} tabs={tabs} machines={projectMachines} reachable={reachable} visible={visible} onOpen={openTab} onNewTerminal={() => void newTab()} />
        ) : shown && area ? (
          <>
            {barTabs.map((t) => {
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
                  {t.kind === 'file' ? (
                    <FileView projectId={project.id} path={t.path} active={active} onOpenFile={openFile} />
                  ) : t.kind === 'chat' ? (
                    <TabChatView
                      tabId={t.terminalId}
                      projectId={project.id}
                      machineId={t.machineId}
                      active={active}
                      onShowTerminal={() => openTab(t.terminalId, 'pin')}
                      onOpenBeside={() => openChatBeside(t.terminalId)}
                    />
                  ) : t.kind === 'simulator' ? (
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
                  ) : tabViews[t.id] === 'chat' ? (
                    // The conversation in place of the terminal (TER-1003): the terminal stays mounted, hidden,
                    // so its connection and screen are there when the person switches back.
                    <>
                      <div className="invisible absolute inset-0" aria-hidden>
                        <TerminalView tabId={t.id} active={false} focused={false} onConnected={() => markAlive(t.id)} />
                      </div>
                      <div className="absolute inset-0">
                        <TabChatView
                          tabId={t.id}
                          projectId={project.id}
                          machineId={t.machine_id}
                          active={active}
                          onShowTerminal={() => setTabView(t.id, 'terminal')}
                          onOpenBeside={() => openChatBeside(t.id)}
                          onOpenTab={() => openChatTab(t.id)}
                        />
                      </div>
                    </>
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
              tabs={[...tabs, ...barTabs.filter((t) => t.kind === 'file' || t.kind === 'chat')]}
              onFocus={(cell) => {
                dispatch({ type: 'focus', cell });
                setFloatingFocused(false);
              }}
              onAssign={(cell, tabId) => {
                // picking a terminal for a pane opens its tab, pinned
                updateEditorTabs(project.id, (s) => pinTab(s, tabId));
                dispatch({ type: 'assignTo', cell, tabId });
              }}
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
