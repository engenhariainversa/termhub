import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ControlContext } from '../control/context.js';
import type { ChatAction, InsertApprovedInput, InsertPendingInput } from '../db/repositories/chat-actions.js';
import { chatBus } from './bus.js';
import { applyGate } from './gate-runtime.js';
import { idempotencyKeyFor, DEFAULT_ALLOW_KINDS } from './gate.js';

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
    findDeniedByKey: vi.fn(async (c: string, k: string) => [...rows].reverse().find((r) => r.conversation_id === c && r.idempotency_key === k && r.status === 'denied')),
    findByIdForUser: vi.fn(async (id: string) => rows.find((r) => r.id === id)),
    insertPending: vi.fn(async (i: InsertPendingInput) => { const r = make(i, 'pending'); rows.push(r); return r; }),
    insertApproved: vi.fn(async (i: InsertApprovedInput) => { const r = make(i, 'approved', { grant_id: i.grant_id, decided_by: i.decided_by, decided_at: new Date().toISOString() }); rows.push(r); return r; }),
    claimApproved: vi.fn(async (id: string) => { const r = rows.find((x) => x.id === id && x.status === 'approved'); if (!r) return false; r.status = 'executed'; return true; }),
    expireApproved: vi.fn(async () => false),
    markExecuted: vi.fn(async (id: string, ok: boolean, code?: string | null) => { const r = rows.find((x) => x.id === id)!; r.status = ok ? 'executed' : 'failed'; r.error_code = code ?? null; }),
    countForGrantSince: vi.fn(async (c: string, g: string, since: Date, tools?: readonly string[]) =>
      rows.filter((r) => r.conversation_id === c && r.grant_id === g && Date.parse(r.created_at) > since.getTime() && (!tools || tools.includes(r.tool))).length),
  };
}

let actions: ReturnType<typeof fakeActions>;
let projectGrants: { id: string; conversation_id: string; project_id: string; scope: 'board' | 'all'; expires_at: string; revoked_at: string | null }[];
let ctx: ControlContext;
const run = vi.fn(async () => ({ ok: 1 }));
const call = (tool: string, args: Record<string, unknown>) => applyGate(ctx, { token: { gated: true, chat_conversation_id: C }, tool, args, run });
const seedGrant = (projectId = 'p1', o: { minutes?: number; revoked?: boolean; id?: string } = {}) =>
  projectGrants.push({ id: o.id ?? `pg${projectGrants.length + 1}`, conversation_id: C, project_id: projectId, scope: 'board', expires_at: new Date(Date.now() + (o.minutes ?? 60) * 60_000).toISOString(), revoked_at: o.revoked ? new Date().toISOString() : null });

beforeEach(() => {
  run.mockClear();
  vi.spyOn(chatBus, 'publish').mockImplementation(() => {});
  actions = fakeActions();
  projectGrants = [];
  const repos = {
    chat: { getOrCreateForUser: vi.fn(), lastTypedAt: vi.fn(async () => null) },
    chatActions: actions,
    chatGrants: { findActive: vi.fn(async () => undefined) },
    chatProjectGrants: { findActive: vi.fn(async (c: string, p: string) => projectGrants.find((g) => g.conversation_id === c && g.project_id === p && !g.revoked_at && Date.parse(g.expires_at) > Date.now())) },
    // No standing grant (TER-386): these tests are about the conversation-bound ones.
    // Every default allowance (TER-627) restricted: these tests are about the person's own grants.
    chatDefaultRestrictions: { listForUser: vi.fn(async () => new Set(DEFAULT_ALLOW_KINDS)) },
    chatStandingGrants: { findActive: vi.fn(async () => undefined) },
    projects: { findByIdsForOwner: vi.fn(async (ids: string[], o: string) => (o === 'u1' ? ids.filter((i) => i === 'p1' || i === 'p2').map((id) => ({ id, name: id })) : [])) },
    tasks: { findByIdsForOwner: vi.fn(async (ids: string[], o: string) => (o === 'u1' ? ids.filter((i) => i === 'k1').map((id) => ({ id, project_id: 'p1', ref: 'APP-1', title: 't' })) : [])) },
    tabs: { findByIdsForOwner: vi.fn(async () => []) },
    machines: { findByIdsForOwner: vi.fn(async () => []) },
  };
  ctx = { repos, scope: { user: { id: 'u1' }, ownerId: 'u1' } } as unknown as ControlContext;
});

describe('project grant in the gate', () => {
  it.each([
    ['create_task', { project_id: 'p1', title: 'x' }],
    ['add_subtasks', { task_id: 'k1', subtasks: [{ title: 's' }] }],
    ['update_task', { task_id: 'k1', status: 'done' }],
    ['move_task', { task_id: 'k1', status: 'doing' }],
  ])('%s runs at once and is audited with the grant id', async (tool, args) => {
    seedGrant();
    expect(await call(tool, args)).toEqual({ ok: true, value: { ok: 1 } });
    expect(run).toHaveBeenCalledTimes(1);
    expect(actions.rows[0]).toMatchObject({ status: 'executed', grant_id: 'pg1' });
  });

  it('delete_task and start_agent still ask', async () => {
    seedGrant();
    expect(await call('delete_task', { task_id: 'k1', confirm: true })).toMatchObject({ ok: false, code: 'CONFIRMATION_PENDING' });
    expect(await call('start_agent', { project_id: 'p1', account_id: 'a', prompt: 'x', task_id: 'k1' })).toMatchObject({ ok: false, code: 'CONFIRMATION_PENDING' });
    expect(run).not.toHaveBeenCalled();
  });

  it('another project asks', async () => {
    seedGrant('p1');
    expect(await call('create_task', { project_id: 'p2', title: 'x' })).toMatchObject({ code: 'CONFIRMATION_PENDING' });
    expect(run).not.toHaveBeenCalled();
  });

  it('foreign task asks', async () => {
    seedGrant('p1');
    expect(await call('move_task', { task_id: 'k-foreign', status: 'done' })).toMatchObject({ code: 'CONFIRMATION_PENDING' });
    expect(run).not.toHaveBeenCalled();
  });

  it('expired or revoked grant asks', async () => {
    seedGrant('p1', { minutes: -1 });
    seedGrant('p1', { revoked: true });
    expect(await call('move_task', { task_id: 'k1', status: 'done' })).toMatchObject({ code: 'CONFIRMATION_PENDING' });
    expect(run).not.toHaveBeenCalled();
  });

  it('a pending row for the same call waits even with an active project grant', async () => {
    seedGrant();
    const args = { task_id: 'k1', status: 'done' };
    await actions.insertPending({ conversation_id: C, tool: 'move_task', args, class: 'write', idempotency_key: idempotencyKeyFor(C, 'move_task', args) });
    expect(await call('move_task', args)).toMatchObject({ ok: false, code: 'CONFIRMATION_WAITING' });
    expect(run).not.toHaveBeenCalled();
    expect(actions.insertApproved).not.toHaveBeenCalled();
    expect(actions.rows).toHaveLength(1);
    expect(actions.rows[0]).toMatchObject({ status: 'pending', grant_id: null });
  });

  it('31st call asks', async () => {
    seedGrant();
    for (let i = 0; i < 30; i++) expect((await call('update_task', { task_id: 'k1', title: `t${i}` })).ok).toBe(true);
    expect(await call('update_task', { task_id: 'k1', title: 't30' })).toMatchObject({ code: 'CONFIRMATION_PENDING' });
    expect(run).toHaveBeenCalledTimes(30);
  });

  it('re-grant resets the budget', async () => {
    seedGrant('p1', { id: 'old' });
    for (let i = 0; i < 30; i++) await call('update_task', { task_id: 'k1', title: `t${i}` });
    projectGrants[0]!.revoked_at = new Date().toISOString();
    seedGrant('p1', { id: 'new' });
    expect((await call('update_task', { task_id: 'k1', title: 'fresh' })).ok).toBe(true);
  });

  it('a denial in force still refuses', async () => {
    seedGrant();
    const args = { task_id: 'k1', status: 'done' };
    const key = idempotencyKeyFor(C, 'move_task', args);
    const denied = await actions.insertPending({ conversation_id: C, tool: 'move_task', args, class: 'write', idempotency_key: key });
    Object.assign(denied, { status: 'denied', decided_at: new Date().toISOString() });
    expect(await call('move_task', args)).toMatchObject({ code: 'CONFIRMATION_DENIED' });
    expect(run).not.toHaveBeenCalled();
    expect(actions.insertApproved).not.toHaveBeenCalled();
  });
});
