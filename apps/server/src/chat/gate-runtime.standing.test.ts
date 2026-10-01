import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ControlContext } from '../control/context.js';
import { readScreen } from '../control/screen.js';
import type { ChatAction, InsertApprovedInput, InsertPendingInput } from '../db/repositories/chat-actions.js';
import type { StandingGrantKind } from '../db/repositories/chat-standing-grants.js';
import { chatBus } from './bus.js';
import { applyGate } from './gate-runtime.js';
import { idempotencyKeyFor, STANDING_GRANT_KINDS, DEFAULT_ALLOW_KINDS } from './gate.js';
import { DIALOG_FOOTER } from './permission-dialog.js';

vi.mock('../control/screen.js', () => ({ readScreen: vi.fn(async () => ({ text: '$ ', lines: 40, tab_id: 't1', styled: false })) }));

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
    // Across conversations: a standing grant's budget is the user's, not one chat's.
    countByGrantSince: vi.fn(async (g: string, since: Date) => rows.filter((r) => r.grant_id === g && Date.parse(r.created_at) > since.getTime()).length),
  };
}

type StandingGrant = { id: string; user_id: string; project_id: string; kind: StandingGrantKind; revoked_at: string | null };
type ProjectGrant = { id: string; conversation_id: string; project_id: string; scope: 'board' | 'all'; expires_at: string; revoked_at: string | null };
type FakeTab = { id: string; project_id: string; state: string | null; state_at: string | null };

let actions: ReturnType<typeof fakeActions>;
let standing: StandingGrant[];
let projectGrants: ProjectGrant[];
let tabs: Map<string, FakeTab>;
let tabsFind: ReturnType<typeof vi.fn>;
let ctx: ControlContext;
const run = vi.fn(async () => ({ ok: 1 }));
const call = (tool: string, args: Record<string, unknown>) => applyGate(ctx, { token: { gated: true, chat_conversation_id: C }, tool, args, run });

const seedStanding = (kind: StandingGrantKind, o: { projectId?: string; revoked?: boolean; id?: string } = {}) =>
  standing.push({ id: o.id ?? 'sg1', user_id: 'u1', project_id: o.projectId ?? 'p1', kind, revoked_at: o.revoked ? new Date().toISOString() : null });
const tab = (id: string, state: string | null, projectId = 'p1'): FakeTab => ({ id, project_id: projectId, state, state_at: null });
/** A past audit row already charged to a grant — in another conversation, which the budget still counts. */
const fakeRow = (o: { grant_id: string; tool: string }): ChatAction => ({
  id: `old${actions.rows.length + 1}`, conversation_id: 'c-other', message_id: null, tool: o.tool, args: {}, class: 'write', status: 'executed',
  idempotency_key: null, machine_id: null, project_id: null, tab_id: null, grant_id: o.grant_id, error_code: null, duration_ms: null,
  decided_by: 'u1', decided_at: new Date().toISOString(), injected_at: null, created_at: new Date().toISOString(),
});

/** "asks": a pending question, nothing ran, nothing was approved behind the user's back. */
async function expectAsks(tool: string, args: Record<string, unknown>) {
  expect(await call(tool, args)).toMatchObject({ ok: false, code: 'CONFIRMATION_PENDING' });
  expect(actions.rows.at(-1)).toMatchObject({ tool, status: 'pending', grant_id: null });
  expect(run).not.toHaveBeenCalled();
  expect(actions.insertApproved).not.toHaveBeenCalled();
}

/** "runs": the tool's own value, and an executed audit row charged to `grantId`. */
async function expectRuns(tool: string, args: Record<string, unknown>, grantId = 'sg1') {
  expect(await call(tool, args)).toEqual({ ok: true, value: { ok: 1 } });
  expect(actions.rows.at(-1)).toMatchObject({ tool, status: 'executed', grant_id: grantId });
}

beforeEach(() => {
  run.mockClear();
  vi.mocked(readScreen).mockClear();
  vi.spyOn(chatBus, 'publish').mockImplementation(() => {});
  actions = fakeActions();
  standing = [];
  projectGrants = [];
  tabs = new Map([
    ['t1', tab('t1', 'waiting_input')],
    ['t2', tab('t2', 'waiting_input', 'p2')],
  ]);
  tabsFind = vi.fn(async (ids: string[], o: string) => (o === 'u1' ? ids.flatMap((i) => (tabs.has(i) ? [{ ...tabs.get(i)! }] : [])) : []));
  const repos = {
    chat: { getOrCreateForUser: vi.fn(), lastTypedAt: vi.fn(async () => null) },
    chatActions: actions,
    chatGrants: { findActive: vi.fn(async () => undefined) },
    chatProjectGrants: { findActive: vi.fn(async (c: string, p: string) => projectGrants.find((g) => g.conversation_id === c && g.project_id === p && !g.revoked_at && Date.parse(g.expires_at) > Date.now())) },
    // Every default allowance (TER-627) restricted: these tests are about the person's own grants.
    chatDefaultRestrictions: { listForUser: vi.fn(async () => new Set(DEFAULT_ALLOW_KINDS)) },
    chatStandingGrants: { findActive: vi.fn(async (u: string, p: string, k: StandingGrantKind) => standing.find((g) => g.user_id === u && g.project_id === p && g.kind === k && !g.revoked_at)) },
    projects: { findByIdsForOwner: vi.fn(async (ids: string[], o: string) => (o === 'u1' ? ids.filter((i) => i === 'p1' || i === 'p2').map((id) => ({ id, name: id })) : [])) },
    tasks: { findByIdsForOwner: vi.fn(async (ids: string[], o: string) => (o === 'u1' ? ids.filter((i) => i === 'k1').map((id) => ({ id, project_id: 'p1', ref: 'APP-1', title: 't' })) : [])) },
    tabs: { findByIdsForOwner: tabsFind },
    machines: { findByIdsForOwner: vi.fn(async () => []) },
    integrations: { list: vi.fn(async () => []) },
  };
  ctx = { repos, scope: { user: { id: 'u1' }, ownerId: 'u1' } } as unknown as ControlContext;
});

describe('standing grants in the gate', () => {
  it('open_tab on the granted project runs, is audited with the grant and told live', async () => {
    seedStanding('open_tab');
    await expectRuns('open_tab', { project_id: 'p1', machine_id: 'm1' });
    expect(run).toHaveBeenCalledTimes(1);
    expect(chatBus.publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'granted_action', conversation_id: C }));
  });

  it('open_tab on another project asks', async () => {
    seedStanding('open_tab');
    await expectAsks('open_tab', { project_id: 'p2', machine_id: 'm1' });
  });

  it('start_agent on the granted project runs', async () => {
    seedStanding('start_agent');
    await expectRuns('start_agent', { project_id: 'p1', prompt: 'x' });
  });

  it('the 11th start_agent in an hour asks, counted across conversations', async () => {
    seedStanding('start_agent');
    for (let i = 0; i < 10; i++) actions.rows.push(fakeRow({ grant_id: 'sg1', tool: 'start_agent' }));
    await expectAsks('start_agent', { project_id: 'p1', prompt: 'x' });
  });

  it.each(['waiting_input', 'idle', null])('close_tab of a project tab in state %s runs', async (state) => {
    seedStanding('close_tab');
    tabs.set('t1', tab('t1', state));
    await expectRuns('close_tab', { tab_id: 't1' });
  });

  it.each(['working', 'waiting_permission'])('close_tab of a project tab in state %s asks', async (state) => {
    seedStanding('close_tab');
    tabs.set('t1', tab('t1', state));
    await expectAsks('close_tab', { tab_id: 't1' });
  });

  it('close_tab of a tab of another project asks', async () => {
    seedStanding('close_tab');
    await expectAsks('close_tab', { tab_id: 't2' });
  });

  it('close_tab of a missing tab asks', async () => {
    seedStanding('close_tab');
    await expectAsks('close_tab', { tab_id: 'nope' });
  });

  it.each([
    ['create_task', { project_id: 'p1', title: 'x' }],
    ['add_subtasks', { task_id: 'k1', subtasks: [{ title: 's' }] }],
    ['update_task', { task_id: 'k1', status: 'done' }],
    ['move_task', { task_id: 'k1', status: 'doing' }],
  ])('board tool %s on the granted project runs', async (tool, args) => {
    seedStanding('board');
    await expectRuns(tool, args);
  });

  it.each([
    ['delete_task', { task_id: 'k1' }],
    ['run_command', { tab_id: 't1', command: 'ls' }],
    ['push_ticket_status', { project_id: 'p1', task_id: 'k1' }],
    ['create_integration', { provider: 'github', name: 'gh', secret_from: { machine_id: 'm1', source: 'gh_auth_token' } }],
    ['set_project_repo', { project_id: 'p1', integration_id: 'i1', full_name: 'org/repo' }],
    ['link_project_machine', { project_id: 'p1', machine_id: 'm2', cwd: '/srv/app' }],
    ['sync_tickets', { project_id: 'p1' }],
  ])('%s asks even with every kind granted', async (tool, args) => {
    STANDING_GRANT_KINDS.forEach((kind, i) => seedStanding(kind, { id: `sg${i + 1}` }));
    await expectAsks(tool, args);
  });

  it('terminal: send_key Enter on a project tab runs', async () => {
    seedStanding('terminal');
    await expectRuns('send_key', { tab_id: 't1', key: 'Enter' });
  });

  it("terminal: send_input '!ls' asks", async () => {
    seedStanding('terminal');
    await expectAsks('send_input', { tab_id: 't1', text: '!ls' });
  });

  it('terminal: a tab waiting on a permission asks', async () => {
    seedStanding('terminal');
    tabs.set('t1', tab('t1', 'waiting_permission'));
    await expectAsks('send_key', { tab_id: 't1', key: 'Enter' });
  });

  it('terminal: a permission dialog on screen asks', async () => {
    seedStanding('terminal');
    vi.mocked(readScreen).mockResolvedValueOnce({ tab_id: 't1', lines: 40, styled: false, text: `Do you want to proceed?\n ❯ 1. Yes\n${DIALOG_FOOTER}` });
    await expectAsks('send_key', { tab_id: 't1', key: '1' });
  });

  it("the conversation's project grant is used before the standing one", async () => {
    seedStanding('board');
    projectGrants.push({ id: 'pg1', conversation_id: C, project_id: 'p1', scope: 'board', expires_at: new Date(Date.now() + 3_600_000).toISOString(), revoked_at: null });
    await expectRuns('create_task', { project_id: 'p1', title: 'x' }, 'pg1');
  });

  it('a denial in force refuses', async () => {
    seedStanding('open_tab');
    const args = { project_id: 'p1', machine_id: 'm1' };
    const denied = await actions.insertPending({ conversation_id: C, tool: 'open_tab', args, class: 'write', idempotency_key: idempotencyKeyFor(C, 'open_tab', args) });
    Object.assign(denied, { status: 'denied', decided_at: new Date().toISOString() });
    expect(await call('open_tab', args)).toMatchObject({ ok: false, code: 'CONFIRMATION_DENIED' });
    expect(run).not.toHaveBeenCalled();
    expect(actions.insertApproved).not.toHaveBeenCalled();
  });

  it('a revoked standing grant asks', async () => {
    seedStanding('open_tab', { revoked: true });
    await expectAsks('open_tab', { project_id: 'p1', machine_id: 'm1' });
  });

  it('a granted close_tab whose tab turned waiting_permission before execute fails WAITING_PERMISSION', async () => {
    seedStanding('close_tab');
    // The gate reads a tab waiting for input; by the time `execute()` looks again it asks a permission.
    tabsFind.mockImplementationOnce(async () => [tab('t1', 'waiting_input')]).mockImplementationOnce(async () => [tab('t1', 'waiting_permission')]);
    const res = await call('close_tab', { tab_id: 't1' });
    expect(res).toMatchObject({ ok: false, code: 'WAITING_PERMISSION' });
    expect((res as { message: string }).message).toMatch(/antes desta ação/);
    expect(run).not.toHaveBeenCalled();
    expect(actions.rows[0]).toMatchObject({ status: 'failed', error_code: 'WAITING_PERMISSION', grant_id: 'sg1' });
  });
});
