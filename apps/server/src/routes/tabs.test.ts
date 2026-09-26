import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import type { Machine, Tab } from '../db/repositories/types.js';
import { applyErrorHandler, forbidden } from '../lib/errors.js';
import { actionForMethod } from '../auth/permissions.js';
import { monitorBus, type TabLifecycle } from '../monitor/bus.js';
import { ControlError } from '../control/context.js';

const { sendKeysToSession, swapAccount, canAccess } = vi.hoisted(() => ({
  sendKeysToSession: vi.fn(),
  swapAccount: vi.fn(),
  canAccess: vi.fn(),
}));
vi.mock('../monitor/send-keys.js', () => ({ INPUT_MAX_CHARS: 4000, sendKeysToSession }));
vi.mock('../control/account-swap.js', () => ({ swapAccount }));
vi.mock('../auth/permissions.js', async (orig) => ({ ...(await orig<typeof import('../auth/permissions.js')>()), canAccess }));

import { tabRoutes } from './tabs.js';

const tab = (over: Partial<Tab> & { id: string; project_id?: string }): Tab => ({
  project_id: 'p1',
  machine_id: 'm1',
  name: 'claude',
  kind: 'terminal',
  tmux_session: `th-${over.id}`,
  simulator_udid: null,
  position: 0,
  state: null,
  state_text: null,
  state_tool: null,
  state_at: null,
  state_seen_at: null,
  created_at: '2026-09-19T00:00:00.000Z',
  ...over,
});

/** Routes over stubbed repos and a fixed request scope, like tasks.test.ts / machines.test.ts. */
function buildApp(tabs: Record<string, Tab>, ownerId: string | null = null, machine: Partial<Machine> & { id: string } = { id: 'm1', type: 'local' as Machine['type'] }) {
  const app = Fastify();
  applyErrorHandler(app);
  // Mirrors guarded()'s onRoute hook in app.ts (route.config.resource/action) plus the auth hook's
  // grant check, just enough to exercise 403 without wiring the whole app.
  app.addHook('onRoute', (route) => {
    const cfg = (route.config ?? {}) as { public?: boolean; resource?: string; action?: string };
    if (cfg.public) return;
    route.config = { ...cfg, resource: cfg.resource ?? 'terminals', action: cfg.action ?? actionForMethod(String(route.method)) };
  });
  app.addHook('preHandler', async (request) => {
    request.scope = { user: { id: 'u1' } as never, viewAs: { kind: 'self' }, ownerId, createAs: 'u1' };
    request.user = { id: 'u1' } as never;
    const cfg = (request.routeOptions?.config ?? {}) as { resource?: string; action?: string };
    if (cfg.resource && !(await canAccess({} as never, request.user, cfg.resource, cfg.action))) {
      throw forbidden(`Sem permissão: ${cfg.resource}:${cfg.action}`);
    }
  });

  const markSeen = vi.fn(async (id: string) => {
    const t = tabs[id];
    if (!t || !t.state || !['waiting_input', 'waiting_permission'].includes(t.state)) return undefined;
    if (t.state_seen_at && t.state_at && t.state_seen_at >= t.state_at) return undefined;
    tabs[id] = { ...t, state_seen_at: new Date().toISOString() };
    return tabs[id];
  });

  const tabsRepo = {
    findById: vi.fn(async (id: string) => tabs[id]),
    markSeen,
    delete: vi.fn(async (id: string) => delete tabs[id]),
    update: vi.fn(async (id: string, patch: { name?: string }) => (tabs[id] = { ...tabs[id], ...patch })),
  };
  const repos = {
    tabs: tabsRepo,
    projects: { findById: vi.fn(async (id: string) => (id === 'p1' ? { id: 'p1', owner_id: 'u1' } : undefined)) },
    projectMachines: { find: vi.fn(async (p: string, m: string) => (p === 'p1' && m === machine.id ? { id: 'l1', project_id: 'p1', machine_id: m, cwd: '/tmp', position: 0, created_at: '' } : undefined)) },
    machines: { findById: vi.fn(async (id: string) => (id === machine.id ? { owner_id: 'u1', ...machine } : undefined)) },
  } as unknown as Repositories;
  const deps = { simulators: {} as never, closeSimulatorTab: vi.fn() };
  app.register((a) => tabRoutes(a, repos, deps), { prefix: '/tabs' });
  return { app, markSeen, repos };
}

beforeEach(() => {
  canAccess.mockReset().mockResolvedValue(true);
  swapAccount.mockReset();
});

describe('POST /tabs/:id/seen', () => {
  let store: Record<string, Tab>;
  beforeEach(() => {
    store = { t1: tab({ id: 't1', state: 'waiting_input', state_at: '2026-09-19T10:00:00.000Z' }) };
  });

  it('404s for a tab outside the scope', async () => {
    const { app } = buildApp(store, 'someone-else');
    const r = await app.inject({ method: 'POST', url: '/tabs/t1/seen' });
    expect(r.statusCode).toBe(404);
  });

  it('404s for a missing tab', async () => {
    const { app } = buildApp(store);
    const r = await app.inject({ method: 'POST', url: '/tabs/missing/seen' });
    expect(r.statusCode).toBe(404);
  });

  it('marks the tab seen, publishes on monitorBus, and returns 200 with the tab', async () => {
    const { app } = buildApp(store);
    const published: unknown[] = [];
    const off = monitorBus.subscribe((c) => published.push(c));
    const r = await app.inject({ method: 'POST', url: '/tabs/t1/seen' });
    off();
    expect(r.statusCode).toBe(200);
    expect(r.json().tab.state_seen_at).toBeTruthy();
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ project_id: 'p1', machine_id: 'm1', owner_id: 'u1' });
  });

  it('is idempotent: 200 with the tab, no publish, when the tab was already seen (or not waiting)', async () => {
    store.t2 = tab({ id: 't2', project_id: 'p1', state: 'idle' });
    const { app } = buildApp(store);
    const published: unknown[] = [];
    const off = monitorBus.subscribe((c) => published.push(c));
    const r = await app.inject({ method: 'POST', url: '/tabs/t2/seen' });
    off();
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ tab: store.t2 });
    expect(published).toHaveLength(0);
  });
});

describe('POST /tabs/:id/input', () => {
  let store: Record<string, Tab>;
  beforeEach(() => {
    store = { t1: tab({ id: 't1' }) };
    sendKeysToSession.mockReset();
  });

  it('sends text through for an agent machine — no more 409 (session-ops covers agent RPCs too)', async () => {
    sendKeysToSession.mockResolvedValue({ ok: true, error: null });
    const { app } = buildApp(store, null, { id: 'm1', type: 'agent' });
    const r = await app.inject({ method: 'POST', url: '/tabs/t1/input', payload: { text: 'echo oi', enter: true } });
    expect(r.statusCode).toBe(200);
    expect(sendKeysToSession).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1', type: 'agent' }), 'th-t1', 'echo oi', true);
  });

  it('still reports a failure from sendKeysToSession as 409', async () => {
    sendKeysToSession.mockResolvedValue({ ok: false, error: 'tmux não respondeu' });
    const { app } = buildApp(store, null, { id: 'm1', type: 'local' });
    const r = await app.inject({ method: 'POST', url: '/tabs/t1/input', payload: { text: 'oi', enter: false } });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe('tmux não respondeu');
  });
});

describe('DELETE /tabs/:id', () => {
  // A visitor watching a published room must see the robot leave, not sit there until a reload.
  it('tells the public channel the tab is gone', async () => {
    const { publicBus } = await import('../public/bus.js');
    const gone: unknown[] = [];
    const off = publicBus.subscribeTabRemoved((c) => gone.push(c));
    try {
      const store = { t1: tab({ id: 't1', tmux_session: null }) };
      const { app } = buildApp(store);
      const res = await app.inject({ method: 'DELETE', url: '/tabs/t1' });
      expect(res.statusCode).toBe(200);
      expect(gone).toEqual([{ tab_id: 't1', project_id: 'p1', machine_id: 'm1' }]);
    } finally {
      off();
    }
  });
});

/** Collects the monitor's tab lifecycle events (the sidebar's open tabs) while `work` runs. */
async function lifecycleDuring(work: () => Promise<unknown>): Promise<TabLifecycle[]> {
  const events: TabLifecycle[] = [];
  const off = monitorBus.subscribeLifecycle((e) => events.push(e));
  try {
    await work();
  } finally {
    off();
  }
  return events;
}

describe('tab lifecycle on the monitor bus', () => {
  it('PATCH (rename) publishes the renamed tab, scoped by its machine owner', async () => {
    const store = { t1: tab({ id: 't1' }) };
    const { app } = buildApp(store);
    const events = await lifecycleDuring(() => app.inject({ method: 'PATCH', url: '/tabs/t1', payload: { name: 'Ana' } }));
    expect(events).toEqual([{ kind: 'upsert', tab: expect.objectContaining({ id: 't1', name: 'Ana' }), project_id: 'p1', machine_id: 'm1', owner_id: 'u1' }]);
  });

  it('DELETE publishes the removal', async () => {
    const store = { t1: tab({ id: 't1', tmux_session: null }) };
    const { app } = buildApp(store);
    const events = await lifecycleDuring(() => app.inject({ method: 'DELETE', url: '/tabs/t1' }));
    expect(events).toEqual([{ kind: 'removed', tab_id: 't1', project_id: 'p1', machine_id: 'm1', owner_id: 'u1' }]);
  });

  it('publishes nothing for a tab outside the scope', async () => {
    const store = { t1: tab({ id: 't1', tmux_session: null }) };
    const { app } = buildApp(store, 'someone-else');
    const events = await lifecycleDuring(async () => {
      await app.inject({ method: 'PATCH', url: '/tabs/t1', payload: { name: 'Ana' } });
      await app.inject({ method: 'DELETE', url: '/tabs/t1' });
    });
    expect(events).toEqual([]);
  });
});

describe('POST /tabs/:id/account-swap', () => {
  let store: Record<string, Tab>;
  beforeEach(() => {
    store = { t1: tab({ id: 't1' }) };
  });

  it('calls swapAccount with the tab and machine and answers its result', async () => {
    const result = { from: { id: 'a1', label: 'a1' }, to: { id: 'a2', label: 'a2' } };
    swapAccount.mockResolvedValue(result);
    const { app, repos } = buildApp(store);
    const res = await app.inject({ method: 'POST', url: '/tabs/t1/account-swap', payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(result);
    expect(swapAccount).toHaveBeenCalledWith(
      repos,
      expect.anything(),
      expect.objectContaining({ id: 't1' }),
      expect.objectContaining({ id: 'm1' }),
      { accountId: undefined, auto: false },
    );
  });

  it('passes the chosen account_id through', async () => {
    swapAccount.mockResolvedValue({ from: null, to: { id: 'a2', label: 'a2' } });
    const { app } = buildApp(store);
    const res = await app.inject({ method: 'POST', url: '/tabs/t1/account-swap', payload: { account_id: 'a2' } });
    expect(res.statusCode).toBe(200);
    expect(swapAccount).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), expect.anything(), { accountId: 'a2', auto: false });
  });

  it('400s on a non-string account_id', async () => {
    const { app } = buildApp(store);
    const res = await app.inject({ method: 'POST', url: '/tabs/t1/account-swap', payload: { account_id: 42 } });
    expect(res.statusCode).toBe(400);
    expect(swapAccount).not.toHaveBeenCalled();
  });

  it('404s for a tab outside the scope, without calling swapAccount', async () => {
    const { app } = buildApp(store, 'someone-else');
    const res = await app.inject({ method: 'POST', url: '/tabs/t1/account-swap', payload: {} });
    expect(res.statusCode).toBe(404);
    expect(swapAccount).not.toHaveBeenCalled();
  });

  it('409s with the ControlError message when swapAccount rejects', async () => {
    swapAccount.mockRejectedValue(new ControlError('NO_CANDIDATE', 'msg'));
    const { app } = buildApp(store);
    const res = await app.inject({ method: 'POST', url: '/tabs/t1/account-swap', payload: {} });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('msg');
  });

  it('403s for a role without terminals:update', async () => {
    canAccess.mockResolvedValue(false);
    const { app } = buildApp(store);
    const res = await app.inject({ method: 'POST', url: '/tabs/t1/account-swap', payload: {} });
    expect(res.statusCode).toBe(403);
    expect(swapAccount).not.toHaveBeenCalled();
  });
});
