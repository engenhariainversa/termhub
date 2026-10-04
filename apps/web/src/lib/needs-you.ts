import { NEEDS_YOU, type Machine, type MonitorItem, type Tab } from './types';

/** The tab fields the "needs you" rule reads (see server monitor/state.ts needsYou — same rule). */
type NeedsYouTab = Pick<Tab, 'state' | 'state_at' | 'state_seen_at'>;

/**
 * A tab "needs you" when its tool is waiting and it has not been seen since that state began:
 * `state_seen_at` is null or earlier than `state_at`. A new hook event bumps `state_at`, so a
 * seen tab needs you again automatically — no reset code needed.
 */
export function tabNeedsYou(tab: NeedsYouTab): boolean {
  if (!tab.state || !NEEDS_YOU.includes(tab.state) || !tab.state_at) return false;
  return !tab.state_seen_at || tab.state_seen_at < tab.state_at;
}

/** The tab just started needing you (the moment to alert, once); a re-armed tab (seen → new event) fires too. */
export function entersNeedsYou(prev: NeedsYouTab | null | undefined, next: NeedsYouTab | null | undefined): boolean {
  return !(prev && tabNeedsYou(prev)) && !!next && tabNeedsYou(next);
}

/** How many tabs of each project need you; projects with none are absent. */
export function needsYouByProject(items: MonitorItem[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const { tab } of items) {
    if (tabNeedsYou(tab)) counts.set(tab.project_id, (counts.get(tab.project_id) ?? 0) + 1);
  }
  return counts;
}

/** Colour of the tab's status dot: orange while the tab needs you (waiting and not seen yet). */
export function tabDotClass(alive: boolean, tab: NeedsYouTab | null | undefined): string {
  if (tab && tabNeedsYou(tab)) return 'animate-pulse bg-attention';
  if (tab?.state === 'error') return 'bg-danger';
  // waiting on its own background work (TER-644): neutral, not the "needs you" orange
  if (tab?.state === 'waiting_background') return alive ? 'bg-fg-muted' : 'bg-fg-dim';
  return alive ? 'bg-ok' : 'bg-fg-dim';
}

/** What the alert says: the tool's own message, or a line for the state. */
export function needsYouText(tab: Tab): string {
  if (tab.state_text) return tab.state_text;
  return tab.state === 'waiting_permission' ? 'está pedindo permissão' : 'terminou e está esperando você';
}

/**
 * Whether to tell the server the person just looked at this tab: the user can (`terminals:update`
 * — a 403 loop is not worth an optimistic clear), it needs you, and both the terminals view (this
 * tab focused, on screen) and the browser window are actually visible. Pure so the effect
 * (useMarkSeenOnFocus, in monitor.tsx/TerminalsView) stays a thin wrapper.
 */
export function shouldMarkSeen(tab: NeedsYouTab, opts: { viewVisible: boolean; windowActive: boolean; canMark: boolean }): boolean {
  return opts.canMark && opts.viewVisible && opts.windowActive && tabNeedsYou(tab);
}

/**
 * The optimistic `state_seen_at` written to the client's own copy of the tab right before the
 * server confirms it: never earlier than the tab's `state_at`, so a browser clock running behind
 * the server can't write a seen time that still reads as "before the wait started" — which would
 * leave `tabNeedsYou` true and the dot stuck on. The server's own write (its clock) is what
 * actually lands in the database; this only has to look right until that push arrives.
 */
export function optimisticSeenAt(tab: Pick<Tab, 'state_at'>, now: Date = new Date()): string {
  const nowIso = now.toISOString();
  return tab.state_at && tab.state_at > nowIso ? tab.state_at : nowIso;
}

/**
 * What to say when the monitor has nothing to show. An empty list means "no tab ever reported a
 * state", which is not the same as "nothing is waiting": a machine whose monitor hooks were never
 * installed reports nothing at all, and that used to render as a blank page with no hint. Null =
 * stay quiet (no machine yet, or the hooks are in place and there is simply nothing happening).
 */
export function emptyMonitorHint(machines: Machine[]): string | null {
  const agents = machines.filter((m) => m.type === 'agent');
  if (agents.length === 0) return null;
  const withoutHooks = agents.filter((m) => m.hooks_installed_at === null);
  if (withoutHooks.length === 0) return null;
  return `Nenhuma tab reportou estado ainda. Instale os hooks do monitor em ${withoutHooks.map((m) => m.name).join(', ')} (✎ na máquina, na página Máquinas) para que as tabs apareçam aqui.`;
}
