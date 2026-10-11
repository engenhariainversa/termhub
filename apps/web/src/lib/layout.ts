// Pane layout for the terminals area: fixed presets, tab-per-cell assignment,
// one optional floating window. Pure module; persistence helpers at the bottom.

import { tk } from '../i18n';

export type Preset = 'single' | 'columns' | 'rows' | 'stack-left' | 'grid';

export const PRESETS: readonly { key: Preset; label: string; cells: number }[] = [
  { key: 'single', label: tk('Um painel'), cells: 1 },
  { key: 'columns', label: tk('Duas colunas'), cells: 2 },
  { key: 'rows', label: tk('Duas linhas'), cells: 2 },
  { key: 'stack-left', label: tk('Dois empilhados + um ao lado'), cells: 3 },
  { key: 'grid', label: tk('Quatro (2x2)'), cells: 4 },
];

export function cellCount(preset: Preset): number {
  return PRESETS.find((p) => p.key === preset)?.cells ?? 1;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Size {
  width: number;
  height: number;
}

/** Splits `total` in two halves with `gap` between them: [first size, second offset, second size]. */
function halves(total: number, gap: number): [number, number, number] {
  const first = Math.max(0, Math.floor((total - gap) / 2));
  const secondStart = Math.min(total, first + gap);
  return [first, secondStart, Math.max(0, total - secondStart)];
}

/** Cell rectangles for a preset inside a width×height area, in the spec's cell order. */
export function cellRects(preset: Preset, width: number, height: number, gap = 1): Rect[] {
  const [lw, rx, rw] = halves(width, gap);
  const [th, by, bh] = halves(height, gap);
  switch (preset) {
    case 'single':
      return [{ x: 0, y: 0, w: width, h: height }];
    case 'columns':
      return [
        { x: 0, y: 0, w: lw, h: height },
        { x: rx, y: 0, w: rw, h: height },
      ];
    case 'rows':
      return [
        { x: 0, y: 0, w: width, h: th },
        { x: 0, y: by, w: width, h: bh },
      ];
    case 'stack-left':
      return [
        { x: 0, y: 0, w: lw, h: th },
        { x: 0, y: by, w: lw, h: bh },
        { x: rx, y: 0, w: rw, h: height },
      ];
    case 'grid':
      return [
        { x: 0, y: 0, w: lw, h: th },
        { x: 0, y: by, w: lw, h: bh },
        { x: rx, y: 0, w: rw, h: th },
        { x: rx, y: by, w: rw, h: bh },
      ];
  }
}

export interface Floating extends Rect {
  tabId: string;
}

export interface Layout {
  preset: Preset;
  cells: (string | null)[];
  focusedCell: number;
  floating: Floating | null;
}

export const FLOATING_MIN = { w: 200, h: 300 } as const;
export const FLOATING_MARGIN = 16;

const PRESET_KEYS = new Set<string>(PRESETS.map((p) => p.key));
const isPreset = (p: unknown): p is Preset => typeof p === 'string' && PRESET_KEYS.has(p);

export function emptyLayout(preset: Preset = 'single'): Layout {
  return { preset, cells: Array.from({ length: cellCount(preset) }, () => null), focusedCell: 0, floating: null };
}

export type Action =
  | { type: 'assign'; tabId: string }
  | { type: 'assignTo'; cell: number; tabId: string }
  | { type: 'focus'; cell: number }
  | { type: 'clearCell'; cell: number }
  | { type: 'setPreset'; preset: Preset }
  | { type: 'closeTab'; tabId: string }
  | { type: 'detach'; tabId: string; rect: Rect }
  | { type: 'dock' }
  | { type: 'moveFloating'; x: number; y: number }
  | { type: 'resizeFloating'; w: number; h: number };

export function placeOf(layout: Layout, tabId: string): { kind: 'cell'; cell: number } | { kind: 'floating' } | null {
  if (layout.floating?.tabId === tabId) return { kind: 'floating' };
  const cell = layout.cells.indexOf(tabId);
  return cell === -1 ? null : { kind: 'cell', cell };
}

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), Math.max(lo, hi));

/** Keeps the floating window inside the area and above the minimum size. */
export function clampFloating(f: Floating, area: Size): Floating {
  const w = clamp(Math.round(f.w), Math.min(FLOATING_MIN.w, area.width), area.width);
  const h = clamp(Math.round(f.h), Math.min(FLOATING_MIN.h, area.height), area.height);
  const x = clamp(Math.round(f.x), 0, area.width - w);
  const y = clamp(Math.round(f.y), 0, area.height - h);
  return { tabId: f.tabId, x, y, w, h };
}

/** First position when detaching: 60% of the area height, device aspect, bottom-right corner. */
export function initialFloatingRect(area: Size, aspect: number): Rect {
  const h = Math.max(FLOATING_MIN.h, Math.round(area.height * 0.6));
  const w = Math.max(FLOATING_MIN.w, Math.round(h * aspect));
  const f = clampFloating({ tabId: '', x: area.width - w - FLOATING_MARGIN, y: area.height - h - FLOATING_MARGIN, w, h }, area);
  return { x: f.x, y: f.y, w: f.w, h: f.h };
}

function withCell(cells: (string | null)[], index: number, value: string | null): (string | null)[] {
  return cells.map((c, i) => (i === index ? value : c));
}

/**
 * Fallback so the area is never blank: if nothing is on screen (no cell occupied, no
 * floating window) but at least one tab exists, assigns the first tab to cell 0. Used
 * after `sanitize`/`loadLayout` so migration, tab deletion and a fresh area never leave
 * every cell empty when there is something to show.
 */
export function ensureVisibleTab(layout: Layout, tabIds: string[]): Layout {
  if (layout.floating) return layout;
  if (layout.cells.some((c) => c !== null)) return layout;
  if (tabIds.length === 0) return layout;
  return { ...layout, cells: withCell(layout.cells, 0, tabIds[0]) };
}

export function reduce(layout: Layout, action: Action, area: Size | null): Layout {
  const n = layout.cells.length;
  switch (action.type) {
    case 'assign': {
      const place = placeOf(layout, action.tabId);
      if (place?.kind === 'floating') return layout;
      if (place?.kind === 'cell') return { ...layout, focusedCell: place.cell };
      return { ...layout, cells: withCell(layout.cells, layout.focusedCell, action.tabId) };
    }
    case 'assignTo': {
      if (action.cell < 0 || action.cell >= n) return layout;
      const cells = layout.cells.map((c) => (c === action.tabId ? null : c));
      return {
        ...layout,
        cells: withCell(cells, action.cell, action.tabId),
        focusedCell: action.cell,
        floating: layout.floating?.tabId === action.tabId ? null : layout.floating,
      };
    }
    case 'focus':
      return action.cell >= 0 && action.cell < n ? { ...layout, focusedCell: action.cell } : layout;
    case 'clearCell':
      return { ...layout, cells: withCell(layout.cells, action.cell, null) };
    case 'setPreset': {
      const count = cellCount(action.preset);
      const cells = Array.from({ length: count }, (_, i) => layout.cells[i] ?? null);
      return { ...layout, preset: action.preset, cells, focusedCell: clamp(layout.focusedCell, 0, count - 1) };
    }
    case 'closeTab':
      return {
        ...layout,
        cells: layout.cells.map((c) => (c === action.tabId ? null : c)),
        floating: layout.floating?.tabId === action.tabId ? null : layout.floating,
      };
    case 'detach': {
      const f: Floating = { tabId: action.tabId, ...action.rect };
      return {
        ...layout,
        cells: layout.cells.map((c) => (c === action.tabId ? null : c)),
        floating: area ? clampFloating(f, area) : f,
      };
    }
    case 'dock': {
      if (!layout.floating) return layout;
      return { ...layout, cells: withCell(layout.cells, layout.focusedCell, layout.floating.tabId), floating: null };
    }
    case 'moveFloating': {
      if (!layout.floating) return layout;
      const f = { ...layout.floating, x: action.x, y: action.y };
      return { ...layout, floating: area ? clampFloating(f, area) : f };
    }
    case 'resizeFloating': {
      if (!layout.floating) return layout;
      const f = { ...layout.floating, w: action.w, h: action.h };
      return { ...layout, floating: area ? clampFloating(f, area) : f };
    }
  }
}

/** Turns anything (old storage, hand-edited JSON) into a valid layout for the given tabs. */
export function sanitize(raw: unknown, tabIds: string[], area: Size | null): Layout {
  if (!raw || typeof raw !== 'object') return emptyLayout('single');
  const r = raw as Partial<Layout>;
  const preset: Preset = isPreset(r.preset) ? r.preset : 'single';
  const count = cellCount(preset);
  const known = new Set(tabIds);
  const rawFloating = r.floating && typeof r.floating === 'object' ? (r.floating as Floating) : null;
  const floatingOk = rawFloating && typeof rawFloating.tabId === 'string' && known.has(rawFloating.tabId) && [rawFloating.x, rawFloating.y, rawFloating.w, rawFloating.h].every((v) => typeof v === 'number' && Number.isFinite(v));
  const floating = floatingOk ? (area ? clampFloating(rawFloating, area) : { ...rawFloating }) : null;
  const seen = new Set<string>(floating ? [floating.tabId] : []);
  const cells = Array.from({ length: count }, (_, i) => {
    const c = Array.isArray(r.cells) ? r.cells[i] : null;
    if (typeof c !== 'string' || !known.has(c) || seen.has(c)) return null;
    seen.add(c);
    return c;
  });
  const focusedCell = typeof r.focusedCell === 'number' && Number.isFinite(r.focusedCell) ? clamp(Math.floor(r.focusedCell), 0, count - 1) : 0;
  return { preset, cells, focusedCell, floating };
}

export const layoutKey = (projectId: string) => `termhub:layout:${projectId}`;
const legacyActiveKey = (projectId: string) => `termhub:active-tab:${projectId}`;

export function loadLayout(projectId: string, tabIds: string[], area: Size | null, storage: Storage = localStorage): Layout {
  let raw: unknown;
  try {
    const text = storage.getItem(layoutKey(projectId));
    raw = text ? JSON.parse(text) : undefined;
  } catch {
    raw = undefined;
  }
  if (raw === undefined) {
    // Migrate the pre-layout "active tab" key into a single-pane layout.
    const legacy = storage.getItem(legacyActiveKey(projectId));
    if (legacy) {
      storage.removeItem(legacyActiveKey(projectId));
      raw = { preset: 'single', cells: [legacy], focusedCell: 0, floating: null };
    }
  }
  return sanitize(raw, tabIds, area);
}

export function saveLayout(projectId: string, layout: Layout, storage: Storage = localStorage): void {
  try {
    storage.setItem(layoutKey(projectId), JSON.stringify(layout));
  } catch {
    /* storage full or blocked: layout stays in memory only */
  }
}
