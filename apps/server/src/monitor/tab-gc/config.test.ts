import { describe, expect, it } from 'vitest';
import { parseLevel, resolveGcConfig, TAB_GC_DEFAULTS } from './config.js';

describe('resolveGcConfig (TER-1171)', () => {
  it('is on with the defaults when no level says anything', () => {
    expect(resolveGcConfig({})).toEqual({ enabled: true, ...TAB_GC_DEFAULTS });
    expect(TAB_GC_DEFAULTS).toMatchObject({ idle_hours: 24, error_hours: 6, grace_minutes: 30, max_agent_tabs: null });
  });

  it('is off as soon as any level turns it off', () => {
    expect(resolveGcConfig({ user: { enabled: false } }).enabled).toBe(false);
    expect(resolveGcConfig({ project: { enabled: false }, machine: { enabled: true } }).enabled).toBe(false);
    expect(resolveGcConfig({ machine: { enabled: false } }).enabled).toBe(false);
  });

  it('takes each number from the machine, else the project, else the person', () => {
    const c = resolveGcConfig({ user: { idle_hours: 48, error_hours: 12, grace_minutes: 60 }, project: { idle_hours: 36, max_agent_tabs: 10 }, machine: { idle_hours: 8 } });
    expect(c).toMatchObject({ idle_hours: 8, error_hours: 12, grace_minutes: 60, max_agent_tabs: 10 });
  });

  it('a level may say "no cap" over a lower one', () => {
    expect(resolveGcConfig({ user: { max_agent_tabs: 5 }, machine: { max_agent_tabs: null } }).max_agent_tabs).toBeNull();
  });

  it("uses the machine's TER-1138 hours as its X when its own is unset", () => {
    expect(resolveGcConfig({ project: { idle_hours: 36 }, machineIdleHours: 6 }).idle_hours).toBe(6);
    expect(resolveGcConfig({ machine: { idle_hours: 12 }, machineIdleHours: 6 }).idle_hours).toBe(12);
    expect(resolveGcConfig({ machineIdleHours: null }).idle_hours).toBe(24);
  });

  it('reads a malformed stored level as unset, field by field', () => {
    expect(parseLevel({ idle_hours: 1, error_hours: 'x', grace_minutes: 45, other: 1 })).toEqual({ grace_minutes: 45 });
    expect(parseLevel(null)).toEqual({});
    expect(parseLevel([1])).toEqual({});
  });
});
