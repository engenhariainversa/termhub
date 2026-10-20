import { useSyncExternalStore } from 'react';

/**
 * Which terminals of a project have a tab open in the tab bar, as in a code editor (TER-904).
 *
 * Every terminal of the project is listed in the sidebar under its machine; only the ones with an open
 * tab are mounted, and so only those hold a terminal WebSocket (the rest get just their state from the
 * monitor). A single click opens a terminal in the preview tab, which the next single click reuses; a
 * double click (or the pin button) pins it. Closing a tab never touches the terminal: ending a terminal
 * is the sidebar's ✕.
 */
export interface EditorTabs {
  /** open tabs, in tab-bar order; the preview tab, if any, is one of them */
  open: string[];
  /** the preview tab (italic), replaced by the next single click; null = every open tab is pinned */
  preview: string | null;
}

export const EMPTY_EDITOR_TABS: EditorTabs = { open: [], preview: null };

/**
 * A file preview tab (spec 2026-10-04 file preview D14): the same list, the same preview and pin, keyed by
 * the path as the answer wrote it. Its id never collides with a terminal's (`[a-z0-9]` ids).
 *
 * A file read on a given machine (`?machine=`, TER-973) carries it: `file@<machineId>:<path>`, so the same
 * `~/relatorio.md` on two machines of the project is two tabs. `file:<path>` is a file with no machine (the
 * server looks for it on the project's machines), which is also what every id stored before TER-973 reads as.
 */
export const FILE_TAB_PREFIX = 'file:';
const FILE_ON_MACHINE_PREFIX = 'file@';
export const fileTabId = (path: string, machineId?: string | null) =>
  machineId ? `${FILE_ON_MACHINE_PREFIX}${machineId}:${path}` : `${FILE_TAB_PREFIX}${path}`;
export const isFileTabId = (id: string) => id.startsWith(FILE_TAB_PREFIX) || id.startsWith(FILE_ON_MACHINE_PREFIX);
/** The path and machine of a file tab id; machineId null = any machine of the project. */
export function fileOfTab(id: string): { path: string; machineId: string | null } {
  if (id.startsWith(FILE_ON_MACHINE_PREFIX)) {
    const sep = id.indexOf(':', FILE_ON_MACHINE_PREFIX.length);
    if (sep > FILE_ON_MACHINE_PREFIX.length) return { path: id.slice(sep + 1), machineId: id.slice(FILE_ON_MACHINE_PREFIX.length, sep) };
  }
  return { path: id.slice(FILE_TAB_PREFIX.length), machineId: null };
}
export const filePathOf = (id: string) => fileOfTab(id).path;

/**
 * A terminal's conversation in a tab of its own (TER-1003): a Claude Code tab read from its transcript,
 * so it can sit in a pane next to its terminal. Keyed by the terminal's id; it goes when the terminal goes.
 */
export const CHAT_TAB_PREFIX = 'chat:';
export const chatTabId = (terminalId: string) => `${CHAT_TAB_PREFIX}${terminalId}`;
export const isChatTabId = (id: string) => id.startsWith(CHAT_TAB_PREFIX);
export const terminalOfChat = (id: string) => id.slice(CHAT_TAB_PREFIX.length);

/** Opens `id` as the preview tab, in place of the current preview; an already open tab keeps its state. */
export function previewTab(s: EditorTabs, id: string): EditorTabs {
  if (s.open.includes(id)) return s;
  if (s.preview && s.open.includes(s.preview)) return { open: s.open.map((x) => (x === s.preview ? id : x)), preview: id };
  return { open: [...s.open, id], preview: id };
}

/** Pins `id`: a preview tab stops being one, a closed one opens pinned at the end. */
export function pinTab(s: EditorTabs, id: string): EditorTabs {
  if (s.open.includes(id)) return s.preview === id ? { ...s, preview: null } : s;
  return { ...s, open: [...s.open, id] };
}

export function closeEditorTab(s: EditorTabs, id: string): EditorTabs {
  if (!s.open.includes(id)) return s;
  return { open: s.open.filter((x) => x !== id), preview: s.preview === id ? null : s.preview };
}

/** Drops the ids that are not terminals of the project any more (ended elsewhere, a machine unlinked).
 *  File tabs stay: a file is not a terminal of the list. A conversation goes with its terminal. */
export function pruneEditorTabs(s: EditorTabs, known: ReadonlySet<string>): EditorTabs {
  const keep = (id: string) => known.has(id) || isFileTabId(id) || (isChatTabId(id) && known.has(terminalOfChat(id)));
  if (s.open.every(keep)) return s;
  const open = s.open.filter(keep);
  return { open, preview: s.preview && keep(s.preview) ? s.preview : null };
}

function sanitize(raw: unknown): EditorTabs | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<EditorTabs>;
  if (!Array.isArray(r.open)) return null;
  const open = [...new Set(r.open.filter((x): x is string => typeof x === 'string'))];
  const preview = typeof r.preview === 'string' && open.includes(r.preview) ? r.preview : null;
  return { open, preview };
}

// --- Store: one entry per project, persisted in localStorage -----------------

export const editorTabsKey = (projectId: string) => `termhub:editor-tabs:${projectId}`;

/** undefined = not read yet; null = never stored (the first visit seeds it from the saved layout) */
const cache = new Map<string, EditorTabs | null>();
const listeners = new Set<() => void>();

function read(projectId: string): EditorTabs | null {
  if (cache.has(projectId)) return cache.get(projectId)!;
  let value: EditorTabs | null = null;
  try {
    const text = localStorage.getItem(editorTabsKey(projectId));
    value = text ? sanitize(JSON.parse(text)) : null;
  } catch {
    value = null;
  }
  cache.set(projectId, value);
  return value;
}

function write(projectId: string, value: EditorTabs) {
  if (read(projectId) === value) return;
  cache.set(projectId, value);
  try {
    localStorage.setItem(editorTabsKey(projectId), JSON.stringify(value));
  } catch {
    /* storage full or blocked: the tabs stay in memory only */
  }
  for (const l of listeners) l();
}

/** The project's open tabs; null until the first visit seeds them (see `seedEditorTabs`). */
export function getEditorTabs(projectId: string): EditorTabs | null {
  return read(projectId);
}

export function updateEditorTabs(projectId: string, fn: (s: EditorTabs) => EditorTabs): EditorTabs {
  const next = fn(read(projectId) ?? EMPTY_EDITOR_TABS);
  write(projectId, next);
  return next;
}

/** First visit after this change: open what was on screen, so nobody lands on an empty area. */
export function seedEditorTabs(projectId: string, value: EditorTabs): EditorTabs {
  const current = read(projectId);
  if (current) return current;
  write(projectId, value);
  return value;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useEditorTabs(projectId: string): EditorTabs | null {
  return useSyncExternalStore(
    subscribe,
    () => read(projectId),
    () => read(projectId),
  );
}

// --- A terminal ended from the sidebar ----------------------------------------

const endedListeners = new Set<(projectId: string, tabId: string) => void>();

/** The sidebar ended a terminal: its tab closes, and the project's terminal view drops it. */
export function announceTerminalEnded(projectId: string, tabId: string) {
  updateEditorTabs(projectId, (s) => closeEditorTab(closeEditorTab(s, tabId), chatTabId(tabId)));
  for (const l of endedListeners) l(projectId, tabId);
}

export function onTerminalEnded(listener: (projectId: string, tabId: string) => void): () => void {
  endedListeners.add(listener);
  return () => endedListeners.delete(listener);
}

/** Tests only: forget what was read from storage. */
export function resetEditorTabsCache() {
  cache.clear();
}
