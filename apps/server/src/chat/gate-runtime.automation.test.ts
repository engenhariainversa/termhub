import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Scoped } from '../auth/scope.js';
import type { ControlContext } from '../control/context.js';
import type { ChatAction, InsertApprovedInput, InsertPendingInput } from '../db/repositories/chat-actions.js';
import { setupSchema, type ProjectSetupData } from '../setup/schema.js';
import { chatBus } from './bus.js';
import { applyGate } from './gate-runtime.js';

/**
 * TER-975: the gate on the automation Setup and the machine switch. Turning automatic work on, raising its
 * level or widening it always asks the person — no grant or default covers it; a brake never asks.
 */

const C = 'c1';
function fakeActions() {
  const rows: ChatAction[] = [];
  const open = (r: ChatAction) => r.status === 'pending' || r.status === 'approved';
  const make = (input: InsertPendingInput, status: ChatAction['status'], extra: Partial<ChatAction> = {}): ChatAction => ({
    id: `a${rows.length + 1}`, conversation_id: input.conversation_id, message_id: null, tool: input.tool, args: input.args, class: input.class, status,
    idempotency_key: input.idempotency_key ?? null, machine_id: input.machine_id ?? null, project_id: input.project_id ?? null, tab_id: input.tab_id ?? null,
    grant_id: null, error_code: null, duration_ms: null, decided_by: null, decided_at: null, injected_at: null, created_at: new Date().toISOString(), ...extra,
  });
  return {
    rows,
    findOpenByKey: vi.fn(async (c: string, k: string) => rows.find((r) => r.conversation_id === c && r.idempotency_key === k && open(r))),
    findDeniedByKey: vi.fn(async () => undefined),
    findByIdForUser: vi.fn(async (id: string) => rows.find((r) => r.id === id)),
    insertPending: vi.fn(async (i: InsertPendingInput) => { const r = make(i, 'pending'); rows.push(r); return r; }),
    insertApproved: vi.fn(async (i: InsertApprovedInput) => { const r = make(i, 'approved', { grant_id: i.grant_id }); rows.push(r); return r; }),
    claimApproved: vi.fn(async (id: string) => { const r = rows.find((x) => x.id === id && x.status === 'approved'); if (!r) return false; r.status = 'executed'; return true; }),
    expireApproved: vi.fn(async () => false),
    markExecuted: vi.fn(async (id: string, ok: boolean, code?: string | null) => { const r = rows.find((x) => x.id === id)!; r.status = ok ? 'executed' : 'failed'; r.error_code = code ?? null; }),
    countForGrantSince: vi.fn(async () => 0),
    countByGrantSince: vi.fn(async () => 0),
  };
}

let actions: ReturnType<typeof fakeActions>;
let stored: ProjectSetupData;
let ctx: ControlContext;
const run = vi.fn(async (_approval?: { actionId: string; approvedAt: Date }) => ({ ok: 1 }));
const call = (tool: string, args: Record<string, unknown>, gated = true) => applyGate(ctx, { token: { gated, chat_conversation_id: C }, tool, args, run });
const approve = (row: ChatAction) => Object.assign(row, { status: 'approved', decided_at: new Date().toISOString(), decided_by: 'u1' });

beforeEach(() => {
  run.mockClear();
  vi.spyOn(chatBus, 'publish').mockImplementation(() => {});
  actions = fakeActions();
  stored = setupSchema.parse({ automation: { enabled: true, autonomy: 'deploy', max_parallel: 2 } });
  const project = { id: 'p1', owner_id: 'u1', name: 'termhub' };
  const repos = {
    chat: { getOrCreateForUser: vi.fn(), lastTypedAt: vi.fn(async () => null) },
    chatActions: actions,
    // Every grant and default would say yes if it were asked: none may cover these tools.
    chatGrants: { findActive: vi.fn(async () => ({ id: 'g1' })) },
    chatProjectGrants: { findActive: vi.fn(async () => ({ id: 'pg1', scope: 'all', expires_at: new Date(Date.now() + 3600_000).toISOString(), revoked_at: null })) },
    chatStandingGrants: { findActive: vi.fn(async () => ({ id: 'sg1' })) },
    chatDefaultRestrictions: { listForUser: vi.fn(async () => new Set()) },
    projects: { findById: vi.fn(async (id: string) => (id === 'p1' ? project : undefined)), findByIdsForOwner: vi.fn(async (ids: string[]) => (ids.includes('p1') ? [project] : [])) },
    projectSetup: { get: vi.fn(async () => ({ project_id: 'p1', version: 1, data: stored, updated_at: null })) },
    tasks: { findByIdsForOwner: vi.fn(async () => []) },
    tabs: { findByIdsForOwner: vi.fn(async () => []) },
    machines: { findByIdsForOwner: vi.fn(async () => []) },
  };
  const scope = { user: { id: 'u1' } as never, viewAs: { kind: 'self' } as const, ownerId: 'u1', createAs: 'u1' };
  ctx = { repos, scope, scoped: new Scoped(repos as never, scope), can: async () => true } as unknown as ControlContext;
});

describe('set_automation_policy in the gate', () => {
  it('reading (only project_id) runs at once', async () => {
    expect(await call('set_automation_policy', { project_id: 'p1' })).toEqual({ ok: true, value: { ok: 1 } });
    expect(actions.rows).toHaveLength(0);
  });

  it.each([
    ['turning it on', { enabled: true }, { enabled: false }],
    ['raising the level', { autonomy: 'release' }, {}],
    ['raising pr to merge', { autonomy: 'merge' }, { autonomy: 'pr' }],
    ['raising the level while it is off', { autonomy: 'release' }, { enabled: false }],
    ['changing release_paths', { release_paths: [] }, { release_paths: ['apps/agent/package.json'] }],
    ['changing store_paths', { store_paths: ['apps/mobile/app.json'] }, {}],
    ['changing release_workflows', { release_workflows: ['Publish @termhub/agent'] }, {}],
    ['changing required_checks', { required_checks: ['CI e Deploy'] }, {}],
    ['raising max_parallel', { max_parallel: 5 }, {}],
    ['lifting the max_parallel cap', { max_parallel: null }, {}],
    ['a brake with a widening in the same call', { enabled: false, release_paths: ['x'] }, {}],
  ])('%s asks the person, even with every grant and default on', async (_name, args, current) => {
    stored = { ...stored, automation: { ...stored.automation, ...current } };
    expect(await call('set_automation_policy', { project_id: 'p1', ...args })).toMatchObject({ ok: false, code: 'CONFIRMATION_PENDING' });
    expect(run).not.toHaveBeenCalled();
    expect(actions.rows[0]).toMatchObject({ tool: 'set_automation_policy', status: 'pending', class: 'write', project_id: 'p1' });
  });

  it.each([
    ['turning it off', { enabled: false }],
    ['lowering the level', { autonomy: 'pr' }],
    ['lowering max_parallel', { max_parallel: 1 }],
    ['off, lower and fewer at once', { enabled: false, autonomy: 'merge', max_parallel: 1 }],
    ['the values it already has', { enabled: true, autonomy: 'deploy' }],
  ])('%s is a brake: it runs at once, with no card', async (_name, args) => {
    expect(await call('set_automation_policy', { project_id: 'p1', ...args })).toEqual({ ok: true, value: { ok: 1 } });
    expect(run).toHaveBeenCalledWith();
    expect(actions.rows).toHaveLength(0);
  });

  it('once the person approves the card, the repeated call runs with the approval', async () => {
    await call('set_automation_policy', { project_id: 'p1', autonomy: 'release' });
    approve(actions.rows[0]);
    expect(await call('set_automation_policy', { project_id: 'p1', autonomy: 'release' })).toEqual({ ok: true, value: { ok: 1 } });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ actionId: 'a1' }));
  });

  it("a person's own MCP session is never asked", async () => {
    expect(await call('set_automation_policy', { project_id: 'p1', enabled: true, autonomy: 'release' }, false)).toEqual({ ok: true, value: { ok: 1 } });
  });
});

describe('set_machine_automation in the gate', () => {
  it('accepting automatic work asks, even with every grant and default on', async () => {
    expect(await call('set_machine_automation', { machine_id: 'm1', accept: true })).toMatchObject({ ok: false, code: 'CONFIRMATION_PENDING' });
    expect(run).not.toHaveBeenCalled();
    expect(actions.rows[0]).toMatchObject({ tool: 'set_machine_automation', machine_id: 'm1', status: 'pending' });
  });

  it('refusing it is a brake and runs at once', async () => {
    expect(await call('set_machine_automation', { machine_id: 'm1', accept: false })).toEqual({ ok: true, value: { ok: 1 } });
    expect(actions.rows).toHaveLength(0);
  });
});
