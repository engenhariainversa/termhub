import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from './api';
import { useAuth } from './auth';
import { entersNeedsYou, optimisticSeenAt, shouldMarkSeen, tabNeedsYou } from './needs-you';
import { applyOpenTabFrame, type OpenTabFrame } from './open-tabs';
import { reconnectDelay } from './reconnect';
import type { MonitorItem, Tab } from './types';

/** Called when a push moves a tab into a waiting state (never for the snapshot on load). */
export type NeedsYouListener = (tab: Tab, projectId: string) => void;

interface MonitorState {
  /** every tab in the scope with a reported state, newest change first */
  items: MonitorItem[];
  /** tabs that need you: waiting and not seen since */
  needsYou: MonitorItem[];
  /** every open terminal tab in the scope, reported a state or not (the sidebar's agents); live */
  openTabs: Tab[];
  /** false until one open-tabs snapshot was read: an empty list before then means "not known yet" */
  openTabsLoaded: boolean;
  /** a snapshot attempt failed and none has succeeded yet (the WS reconnect and the resync retry it) */
  openTabsFailed: boolean;
  /** monitor state of one tab (live), or undefined when it never reported */
  tabState: (tabId: string) => Tab | undefined;
  /** types the text into the tab (Enter included) and marks it working */
  reply: (tabId: string, text: string) => Promise<void>;
  /** the user just looked at this tab: optimistically clears its "needs you" dot, then confirms with the server */
  markSeen: (tabId: string) => Promise<void>;
  reload: () => Promise<void>;
  connected: boolean;
  /** counts the `automation` frames received: a pause or resume somewhere re-reads the pause state */
  automationSeq: number;
  /** subscribes to tabs that start needing you; returns the unsubscribe */
  onNeedsYou: (listener: NeedsYouListener) => () => void;
}

const MonitorContext = createContext<MonitorState | null>(null);

const RECONNECT_MS = 5_000;
/** the snapshot is re-read on reconnect and every few minutes, in case a push was missed */
const RESYNC_MS = 3 * 60_000;

/**
 * Snapshot over REST + pushes over /ws/monitor. Feeds the home "precisando de você" list and
 * the tab bar dots. Only the tool's own message travels here, never terminal content.
 */
export function MonitorProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<MonitorItem[]>([]);
  const [openTabs, setOpenTabs] = useState<Tab[]>([]);
  const [openTabsLoaded, setOpenTabsLoaded] = useState(false);
  const [openTabsFailed, setOpenTabsFailed] = useState(false);
  const openTabsRead = useRef(false);
  const [connected, setConnected] = useState(false);
  const [automationSeq, setAutomationSeq] = useState(0);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const listeners = useRef(new Set<NeedsYouListener>());
  const onNeedsYou = useCallback((listener: NeedsYouListener) => {
    listeners.current.add(listener);
    return () => void listeners.current.delete(listener);
  }, []);

  /**
   * Open-tab pushes received while a snapshot is in flight: the snapshot may have been read before
   * them (a closed tab would come back until the next resync), so they are re-applied on top of it.
   * Numbered so overlapping reloads each replay only what came after they started.
   */
  const openFrames = useRef({ seq: 0, inFlight: 0, log: [] as Array<{ seq: number; frame: OpenTabFrame }> });
  const applyOpenFrame = useCallback((frame: OpenTabFrame) => {
    const f = openFrames.current;
    f.seq += 1;
    if (f.inFlight > 0) f.log.push({ seq: f.seq, frame });
    setOpenTabs((list) => applyOpenTabFrame(list, frame));
  }, []);

  const reload = useCallback(async () => {
    const f = openFrames.current;
    const startedAt = f.seq;
    f.inFlight += 1;
    try {
      // each snapshot on its own: a failure keeps that one's last copy; the next resync retries
      const [state, open] = await Promise.allSettled([api.monitor.tabs(), api.monitor.openTabs()]);
      if (state.status === 'fulfilled') setItems(state.value.items);
      if (open.status === 'fulfilled') {
        const later = f.log.filter((e) => e.seq > startedAt).map((e) => e.frame);
        setOpenTabs(later.reduce(applyOpenTabFrame, open.value.items.map((i) => i.tab)));
        openTabsRead.current = true;
        setOpenTabsLoaded(true);
        setOpenTabsFailed(false);
      } else if (!openTabsRead.current) {
        // only "failed" while nothing was ever read: a later failure keeps the last good list
        setOpenTabsFailed(true);
      }
    } finally {
      f.inFlight -= 1;
      if (f.inFlight === 0) f.log = [];
    }
  }, []);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    const open = () => {
      if (stopped) return;
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/ws/monitor`);
      ws.onopen = () => {
        setConnected(true);
        void reload();
      };
      ws.onmessage = (ev) => {
        let msg: { type?: string; tab?: Tab; tab_id?: string; project_id?: string; machine_id?: string };
        try {
          msg = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        // automation events (pauses, runs, PRs): only a tick, the pause switch re-reads its own state
        if (msg.type === 'automation') {
          setAutomationSeq((n) => n + 1);
          return;
        }
        // tabs opened, renamed and closed only move the open-tab list (the sidebar's agents)
        if (msg.type === 'tab_upsert' && msg.tab) {
          applyOpenFrame({ type: 'tab_upsert', tab: msg.tab });
          return;
        }
        if (msg.type === 'tab_removed' && msg.tab_id) {
          applyOpenFrame({ type: 'tab_removed', tab_id: msg.tab_id });
          return;
        }
        if (msg.type !== 'tab' || !msg.tab) return;
        applyOpenFrame({ type: 'tab', tab: msg.tab });
        const tab = msg.tab;
        // compared with what was on screen before this push (a tab never seen counts as not needing you)
        const prev = itemsRef.current.find((i) => i.tab.id === tab.id)?.tab;
        if (entersNeedsYou(prev, tab)) {
          const projectId = msg.project_id ?? tab.project_id;
          listeners.current.forEach((l) => l(tab, projectId));
        }
        setItems((list) => {
          const idx = list.findIndex((i) => i.tab.id === tab.id);
          if (idx === -1) {
            // a tab we had not seen (created after the snapshot): the resync fills project/machine
            void reload();
            return list;
          }
          const next = list.slice();
          next[idx] = { ...list[idx], tab: { ...list[idx].tab, ...tab } };
          next.sort((a, b) => (b.tab.state_at ?? '').localeCompare(a.tab.state_at ?? ''));
          return next;
        });
      };
      ws.onclose = (ev) => {
        setConnected(false);
        ws = null;
        if (!stopped) timer = setTimeout(open, reconnectDelay(ev.code, RECONNECT_MS));
      };
      ws.onerror = () => ws?.close();
    };
    void reload();
    open();
    const resync = setInterval(() => void reload(), RESYNC_MS);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      clearInterval(resync);
      ws?.close();
    };
  }, [reload, applyOpenFrame]);

  const value = useMemo<MonitorState>(
    () => ({
      items,
      needsYou: items.filter((i) => tabNeedsYou(i.tab)),
      openTabs,
      openTabsLoaded,
      openTabsFailed,
      tabState: (tabId) => itemsRef.current.find((i) => i.tab.id === tabId)?.tab,
      async reply(tabId, text) {
        const r = await api.tabs.input(tabId, text, true);
        setItems((list) => list.map((i) => (i.tab.id === tabId ? { ...i, tab: { ...i.tab, ...r.tab } } : i)));
      },
      async markSeen(tabId) {
        // Optimistic: the WS push from the server confirms it (and syncs every other device).
        // optimisticSeenAt never goes earlier than the tab's own state_at, so a browser clock
        // running behind the server can't write a seen time that still reads as "unseen".
        const current = itemsRef.current.find((i) => i.tab.id === tabId)?.tab;
        const seenAt = optimisticSeenAt({ state_at: current?.state_at ?? null });
        setItems((list) => list.map((i) => (i.tab.id === tabId ? { ...i, tab: { ...i.tab, state_seen_at: seenAt } } : i)));
        // the sidebar's per-agent dot reads the open-tab list, not the state items
        setOpenTabs((list) => (list.some((t) => t.id === tabId) ? list.map((t) => (t.id === tabId ? { ...t, state_seen_at: seenAt } : t)) : list));
        try {
          await api.tabs.seen(tabId);
        } catch {
          void reload(); // never leave a stale optimistic write on screen
        }
      },
      reload,
      connected,
      automationSeq,
      onNeedsYou,
    }),
    [items, openTabs, openTabsLoaded, openTabsFailed, reload, connected, automationSeq, onNeedsYou],
  );

  return <MonitorContext.Provider value={value}>{children}</MonitorContext.Provider>;
}

export function useMonitor(): MonitorState {
  const ctx = useContext(MonitorContext);
  if (!ctx) throw new Error('useMonitor fora do MonitorProvider');
  return ctx;
}

/**
 * Marks the focused tab seen (clears its "needs you" dot) as soon as the person is actually
 * looking at it: they can (`terminals:update` — no point in an optimistic clear that just 403s
 * and bounces back on reload), the terminals view is visible, this tab is focused, and the
 * browser window itself is visible and focused (not just another app on top). Re-checks on focus
 * changes, on a monitor push for this tab (a new needs-you event while looking at it re-arms it),
 * and on the window regaining focus/visibility — `shouldMarkSeen` (needs-you.ts) makes the call;
 * `markSeen` (above) fires at most once per (tab id, state_at) via its own dedupe below.
 */
export function useMarkSeenOnFocus(tabId: string | null, viewVisible: boolean): void {
  const { tabState, markSeen } = useMonitor();
  const { can } = useAuth();
  const canMark = can('terminals', 'update');
  const askedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!tabId || !canMark) return;
    const check = () => {
      const tab = tabState(tabId);
      if (!tab) return;
      const windowActive = document.visibilityState === 'visible' && document.hasFocus();
      if (!shouldMarkSeen(tab, { viewVisible, windowActive, canMark })) return;
      const key = `${tabId}:${tab.state_at}`;
      if (askedRef.current === key) return;
      askedRef.current = key;
      void markSeen(tabId);
    };
    check();
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    return () => {
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', check);
    };
  }, [tabId, viewVisible, canMark, tabState, markSeen]);
}
