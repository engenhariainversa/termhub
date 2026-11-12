import { describe, expect, it, vi } from 'vitest';
import type { ControlContext } from './context.js';
import { listFeatureFlags, setFeatureFlag } from './feature-flags.js';
import { MCP_FLAG_KEYS } from '../features/flags.js';

function ctxWith(opts: { overrides?: Record<string, boolean>; instance?: Record<string, boolean>; tab?: boolean } = {}) {
  const overrides = new Map(Object.entries(opts.overrides ?? {}));
  const instance = opts.instance ?? {};
  const events: Record<string, unknown>[] = [];
  const repos = {
    featureFlags: {
      overrideFor: vi.fn(async (key: string) => overrides.get(key) ?? null),
      instanceValue: vi.fn(async (key: string) => instance[key] ?? null),
      setOverride: vi.fn(async (key: string, _user: string, enabled: boolean) => void overrides.set(key, enabled)),
      removeOverride: vi.fn(async (key: string) => overrides.delete(key)),
      setInstance: vi.fn(),
    },
    securityEvents: { record: vi.fn(async (e: Record<string, unknown>) => void events.push(e)) },
  };
  const token = opts.tab ? { id: 'k1', scopes: ['read'], tab: { id: 't1', project_id: 'p1' } } : { id: 'k1', scopes: ['read', 'terminals'], gated: true, chat_conversation_id: 'c1' };
  const ctx = { repos, scope: { user: { id: 'u1', email: 'pessoa@example.com' } }, token } as unknown as ControlContext;
  return { ctx, repos, events, overrides };
}

describe('feature flag tools (TER-1186)', () => {
  it('list_feature_flags resolves every chat-visible flag for the person and says where the value comes from', async () => {
    const { ctx } = ctxWith({ overrides: { chat_open_permissions: true }, instance: { tab_gc: true } });
    const { flags } = await listFeatureFlags(ctx);
    expect(flags.map((f) => f.key)).toEqual([...MCP_FLAG_KEYS]);
    expect(flags.map((f) => f.key)).not.toContain('subscriptions');
    expect(flags.find((f) => f.key === 'chat_open_permissions')).toMatchObject({ name: 'Chat: liberado por padrão', enabled: true, source: 'override', instance: false, override: true });
    expect(flags.find((f) => f.key === 'tab_gc')).toMatchObject({ enabled: true, source: 'instance', instance: true, override: null });
    expect(flags.find((f) => f.key === 'runs_api')).toMatchObject({ enabled: false, source: 'default', override: null });
  });

  it('set_feature_flag turns one on for the person only, audited as an override via MCP', async () => {
    const { ctx, repos, events } = ctxWith();
    const r = await setFeatureFlag(ctx, { flag: 'chat_open_permissions', enabled: true });
    expect(r).toMatchObject({ changed: true, flag: { key: 'chat_open_permissions', enabled: true, source: 'override' } });
    expect(repos.featureFlags.setOverride).toHaveBeenCalledWith('chat_open_permissions', 'u1', true, 'u1');
    expect(repos.featureFlags.setInstance).not.toHaveBeenCalled();
    expect(events).toEqual([
      expect.objectContaining({ action: 'feature_flag.override', actor_id: 'u1', target_type: 'user', target_id: 'u1', meta: { flag: 'chat_open_permissions', enabled: true, via: 'mcp', conversation_id: 'c1' } }),
    ]);
  });

  it('set_feature_flag turns one off, and null goes back to the value for everyone', async () => {
    const { ctx, repos, events } = ctxWith({ overrides: { tab_gc: true }, instance: { tab_gc: true } });
    expect(await setFeatureFlag(ctx, { flag: 'tab_gc', enabled: false })).toMatchObject({ changed: true, flag: { enabled: false, source: 'override' } });
    expect(await setFeatureFlag(ctx, { flag: 'tab_gc', enabled: null })).toMatchObject({ changed: true, flag: { enabled: true, source: 'instance', override: null } });
    expect(repos.featureFlags.removeOverride).toHaveBeenCalledWith('tab_gc', 'u1');
    expect(events.map((e) => (e.meta as { enabled: unknown }).enabled)).toEqual([false, null]);
  });

  it('the same value again changes nothing and writes no trail row', async () => {
    const { ctx, repos, events } = ctxWith({ overrides: { runs_api: true } });
    expect(await setFeatureFlag(ctx, { flag: 'runs_api', enabled: true })).toMatchObject({ changed: false });
    expect(await setFeatureFlag(ctx, { flag: 'sequential_epics', enabled: null })).toMatchObject({ changed: false });
    expect(repos.featureFlags.setOverride).not.toHaveBeenCalled();
    expect(repos.featureFlags.removeOverride).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it('refuses a hidden or unknown flag', async () => {
    const { ctx, repos } = ctxWith();
    await expect(setFeatureFlag(ctx, { flag: 'subscriptions', enabled: true })).rejects.toMatchObject({ code: 'FLAG_NOT_ALLOWED' });
    await expect(setFeatureFlag(ctx, { flag: 'nope', enabled: false })).rejects.toMatchObject({ code: 'FLAG_NOT_ALLOWED' });
    expect(repos.featureFlags.setOverride).not.toHaveBeenCalled();
  });

  it('refuses an agent tab', async () => {
    const { ctx, repos } = ctxWith({ tab: true });
    await expect(listFeatureFlags(ctx)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(setFeatureFlag(ctx, { flag: 'tab_gc', enabled: false })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(repos.featureFlags.setOverride).not.toHaveBeenCalled();
  });
});
