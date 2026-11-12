import { z } from 'zod';

/*
 * TER-1171: the tab GC's settings, at three levels — the person (`users.tab_gc`), the project (`setup.tab_gc`)
 * and the machine (`machines.tab_gc`) — each a partial object. Defaults decided by Pedro on 2026-11-11.
 */

export const TAB_GC_DEFAULTS = {
  /** X: hours a finished/idle agent tab (card done or no card) rests before it is a candidate */
  idle_hours: 24,
  /** Y: hours an agent tab in error rests before it is a candidate */
  error_hours: 6,
  /** the warning before a close */
  grace_minutes: 30,
  /** agent tabs a machine holds before the oldest idle ones are collected early; null = no cap */
  max_agent_tabs: null as number | null,
} as const;

export const TAB_GC_LIMITS = {
  idle_hours: { min: 2, max: 30 * 24 },
  error_hours: { min: 1, max: 30 * 24 },
  grace_minutes: { min: 10, max: 240 },
  max_agent_tabs: { min: 1, max: 200 },
} as const;

const int = (k: keyof typeof TAB_GC_LIMITS) => z.number().int().min(TAB_GC_LIMITS[k].min).max(TAB_GC_LIMITS[k].max);

/** One level's settings: every field optional (unset = the next level decides). */
export const tabGcLevelSchema = z.object({
  enabled: z.boolean().optional(),
  idle_hours: int('idle_hours').optional(),
  error_hours: int('error_hours').optional(),
  grace_minutes: int('grace_minutes').optional(),
  /** null = explicitly no cap at this level */
  max_agent_tabs: int('max_agent_tabs').nullable().optional(),
});
export type TabGcLevel = z.infer<typeof tabGcLevelSchema>;

export interface TabGcConfig {
  enabled: boolean;
  idle_hours: number;
  error_hours: number;
  grace_minutes: number;
  max_agent_tabs: number | null;
}

/** A stored level read leniently: a malformed value (hand-edited, an older shape) counts as unset, never throws. */
export function parseLevel(raw: unknown): TabGcLevel {
  if (!raw || typeof raw !== 'object') return {};
  const out: TabGcLevel = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const field = tabGcLevelSchema.shape[k as keyof TabGcLevel];
    if (!field) continue;
    const r = field.safeParse(v);
    if (r.success && r.data !== undefined) (out as Record<string, unknown>)[k] = r.data;
  }
  return out;
}

/**
 * The settings for one tab: `enabled` is off as soon as any level turns it off (on by default); each number is
 * the machine's, else the project's, else the person's, else the default. A machine's TER-1138
 * `idle_tab_close_hours` is its X when its own `tab_gc.idle_hours` is unset.
 */
export function resolveGcConfig(levels: { user?: unknown; project?: unknown; machine?: unknown; machineIdleHours?: number | null }): TabGcConfig {
  const user = parseLevel(levels.user);
  const project = parseLevel(levels.project);
  const machine = parseLevel(levels.machine);
  if (machine.idle_hours === undefined && typeof levels.machineIdleHours === 'number') {
    const legacy = int('idle_hours').safeParse(levels.machineIdleHours);
    if (legacy.success) machine.idle_hours = legacy.data;
  }
  const order = [machine, project, user];
  const pick = <K extends 'idle_hours' | 'error_hours' | 'grace_minutes' | 'max_agent_tabs'>(k: K): TabGcConfig[K] => {
    for (const level of order) if (level[k] !== undefined) return level[k] as TabGcConfig[K];
    return TAB_GC_DEFAULTS[k] as TabGcConfig[K];
  };
  return {
    enabled: order.every((l) => l.enabled !== false),
    idle_hours: pick('idle_hours'),
    error_hours: pick('error_hours'),
    grace_minutes: pick('grace_minutes'),
    max_agent_tabs: pick('max_agent_tabs'),
  };
}
