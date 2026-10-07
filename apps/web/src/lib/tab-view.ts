import { useSyncExternalStore } from 'react';

/**
 * How a terminal tab is shown in its own tab (TER-1003): the terminal itself, or its Claude Code session
 * read as a conversation. Per tab and per browser, remembered in localStorage; a tab never switched
 * shows the terminal, as before.
 */
export type TabView = 'terminal' | 'chat';

export const TAB_VIEW_KEY = 'termhub:tab-view';

/** Only the tabs switched to the conversation are kept: the default needs no entry. */
let cache: Partial<Record<string, 'chat'>> | null = null;
const listeners = new Set<() => void>();

function read(): Partial<Record<string, 'chat'>> {
  if (cache) return cache;
  let value: Partial<Record<string, 'chat'>> = {};
  try {
    const raw = JSON.parse(localStorage.getItem(TAB_VIEW_KEY) ?? '{}') as unknown;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      value = Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter(([, v]) => v === 'chat')) as Record<string, 'chat'>;
    }
  } catch {
    value = {};
  }
  cache = value;
  return value;
}

export function getTabView(tabId: string): TabView {
  return read()[tabId] ?? 'terminal';
}

export function setTabView(tabId: string, view: TabView) {
  const current = read();
  if ((current[tabId] ?? 'terminal') === view) return;
  const next = { ...current };
  if (view === 'chat') next[tabId] = 'chat';
  else delete next[tabId];
  cache = next;
  try {
    localStorage.setItem(TAB_VIEW_KEY, JSON.stringify(next));
  } catch {
    /* storage full or blocked: the choice stays in memory only */
  }
  for (const l of listeners) l();
}

export function toggleTabView(tabId: string) {
  setTabView(tabId, getTabView(tabId) === 'chat' ? 'terminal' : 'chat');
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The views of every switched tab; a stable object between changes. */
export function useTabViews(): Readonly<Partial<Record<string, 'chat'>>> {
  return useSyncExternalStore(subscribe, read, read);
}

/** Tests only: forget what was read from storage. */
export function resetTabViewCache() {
  cache = null;
}
