import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ControlContext } from '../control/context.js';
import { readScreen } from '../control/screen.js';
import type { ChatAction, InsertApprovedInput, InsertPendingInput } from '../db/repositories/chat-actions.js';
import type { StandingGrantKind } from '../db/repositories/chat-standing-grants.js';
import { chatBus } from './bus.js';
import { applyGate } from './gate-runtime.js';
import { DEFAULT_ALLOW_KINDS, defaultGrantId, idempotencyKeyFor, type DefaultAllowKind } from './gate.js';
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
type FakeTab = { id: string; project_id: string; state: string | null; state_at: string | null; state_tool?: string | null };

let actions: ReturnType<typeof fakeActions>;
let standing: StandingGrant[];
let restricted: Set<DefaultAllowKind>;
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
async function expectRuns(tool: string, args: Record<string, unknown>, grantId: string) {
  expect(await call(tool, args)).toEqual({ ok: true, value: { ok: 1 } });
  expect(actions.rows.at(-1)).toMatchObject({ tool, status: 'executed', grant_id: grantId });
}

beforeEach(() => {
  run.mockClear();
  vi.mocked(readScreen).mockClear();
  vi.spyOn(chatBus, 'publish').mockImplementation(() => {});
  actions = fakeActions();
  standing = [];
  restricted = new Set();
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
    chatDefaultRestrictions: { listForUser: vi.fn(async (u: string) => (u === 'u1' ? new Set(restricted) : new Set())) },
    chatStandingGrants: { findActive: vi.fn(async (u: string, p: string, k: StandingGrantKind) => standing.find((g) => g.user_id === u && g.project_id === p && g.kind === k && !g.revoked_at)) },
    projects: { findByIdsForOwner: vi.fn(async (ids: string[], o: string) => (o === 'u1' ? ids.filter((i) => i === 'p1' || i === 'p2').map((id) => ({ id, name: id })) : [])) },
    tasks: { findByIdsForOwner: vi.fn(async (ids: string[], o: string) => (o === 'u1' ? ids.filter((i) => i === 'k1').map((id) => ({ id, project_id: 'p1', ref: 'APP-1', title: 't' })) : [])) },
    tabs: { findByIdsForOwner: tabsFind },
    machines: { findByIdsForOwner: vi.fn(async () => []) },
    integrations: { list: vi.fn(async () => []) },
  };
  ctx = { repos, scope: { user: { id: 'u1' }, ownerId: 'u1' } } as unknown as ControlContext;
});


const D = (kind: DefaultAllowKind) => defaultGrantId('u1', kind);
/** Claude Code back at its input box, no spinner: what the TER-615 sweeper reads as a wait for input. */
const IDLE_SCREEN = '● Pronto.\n\n────────────────────────────────────────\n❯ \n────────────────────────────────────────\n  ? for shortcuts';
const BUSY_SCREEN = '✢ Catapulting… (14s · ↓ 145 tokens)\n\n────────────────────────────────────────\n❯ \n────────────────────────────────────────';
const staleAt = () => new Date(Date.now() - 10 * 60_000).toISOString();

describe('default allowances in the gate (TER-627): run with no card for a user who restricted nothing', () => {
  it.each([
    ['list_tab_questions', {}],
    ['list_tabs', {}],
    ['read_screen', { tab_id: 't1' }],
    ['read_last_answer', { tab_id: 't1' }],
    ['search_memory', { query: 'x' }],
    ['find', { query: 'x' }],
    ['get_ticket', { key: 'X-1' }],
    ['get_project_setup', { project_id: 'p1' }],
  ])('read %s runs, unaudited', async (tool, args) => {
    expect(await call(tool, args)).toEqual({ ok: true, value: { ok: 1 } });
    expect(actions.rows).toHaveLength(0);
  });

  it('open_tab runs, audited under the default and told live', async () => {
    await expectRuns('open_tab', { project_id: 'p1', machine_id: 'm1' }, D('open_tab'));
    expect(chatBus.publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'granted_action', conversation_id: C }));
  });

  it('start_agent runs', async () => {
    await expectRuns('start_agent', { project_id: 'p1', prompt: 'x' }, D('start_agent'));
  });

  it('link_tab_task runs', async () => {
    await expectRuns('link_tab_task', { tab_id: 't1', task_id: 'k1' }, D('link_tab_task'));
  });

  it.each([
    ['create_task', { project_id: 'p1', title: 'x' }],
    ['add_subtasks', { task_id: 'k1', subtasks: [{ title: 's' }] }],
    ['update_task', { task_id: 'k1', status: 'done' }],
    ['move_task', { task_id: 'k1', status: 'doing' }],
  ])('board tool %s runs', async (tool, args) => {
    await expectRuns(tool, args, D('board'));
  });

  it.each(['working', 'waiting_input'])('send_input to an agent tab in state %s runs', async (state) => {
    tabs.set('t1', tab('t1', state));
    await expectRuns('send_input', { tab_id: 't1', text: 'continue com o plano' }, D('terminal'));
  });

  it.each(['Enter', '1', 'Up'])('send_key %s runs', async (key) => {
    await expectRuns('send_key', { tab_id: 't1', key }, D('terminal'));
  });

  it.each(['waiting_input', 'idle', 'error'])('close_tab of a stopped tab (%s) runs', async (state) => {
    tabs.set('t1', tab('t1', state));
    await expectRuns('close_tab', { tab_id: 't1' }, D('close_tab'));
  });

  it('close_tab of a Claude tab left "working" for long, whose screen shows it idle, runs', async () => {
    tabs.set('t1', { ...tab('t1', 'working'), state_at: staleAt(), state_tool: 'claude' });
    vi.mocked(readScreen).mockResolvedValueOnce({ tab_id: 't1', lines: 50, styled: false, text: IDLE_SCREEN });
    await expectRuns('close_tab', { tab_id: 't1' }, D('close_tab'));
  });

  it('the person’s own grant is used before the default', async () => {
    standing.push({ id: 'sg1', user_id: 'u1', project_id: 'p1', kind: 'open_tab', revoked_at: null });
    await expectRuns('open_tab', { project_id: 'p1', machine_id: 'm1' }, 'sg1');
  });
});

describe('what the defaults never cover (TER-627): still a card', () => {
  it.each([
    ['delete_task', { task_id: 'k1' }],
    ['run_command', { tab_id: 't1', command: 'ls' }],
    ['push_ticket_status', { project_id: 'p1', task_id: 'k1' }],
    ['create_integration', { provider: 'github', name: 'gh', secret_from: { machine_id: 'm1', source: 'gh_auth_token' } }],
    ['set_project_repo', { project_id: 'p1', integration_id: 'i1', full_name: 'org/repo' }],
    ['link_project_machine', { project_id: 'p1', machine_id: 'm2', cwd: '/srv/app' }],
    ['set_project_machine_cwd', { project_id: 'p1', machine_id: 'm2', cwd: '/srv/app' }],
    ['unlink_project_machine', { project_id: 'p1', machine_id: 'm1', confirm: true }],
    ['sync_tickets', { project_id: 'p1' }],
    ['import_tickets', { project_id: 'p1', keys: ['X-1'] }],
    ['drop_everything', {}],
  ])('%s asks', async (tool, args) => {
    await expectAsks(tool, args);
  });

  it.each(['!rm -rf ~', '  !ls', 'oi\u0015!ls', 'a\u007f'])('send_input with %j asks', async (text) => {
    await expectAsks('send_input', { tab_id: 't1', text });
  });

  it('send_input answering a permission asks', async () => {
    tabs.set('t1', tab('t1', 'waiting_permission'));
    await expectAsks('send_input', { tab_id: 't1', text: 'sim', answering_permission: true });
  });

  it.each(['1', 'Enter'])('send_key %s on a tab waiting for a permission asks', async (key) => {
    tabs.set('t1', tab('t1', 'waiting_permission'));
    await expectAsks('send_key', { tab_id: 't1', key });
  });

  it('send_key with a permission dialog on screen asks', async () => {
    vi.mocked(readScreen).mockResolvedValueOnce({ tab_id: 't1', lines: 40, styled: false, text: `Do you want to proceed?\n ❯ 1. Yes\n${DIALOG_FOOTER}` });
    await expectAsks('send_key', { tab_id: 't1', key: '1' });
  });

  it.each(['C-c', 'Escape'])('the interrupting key %s asks', async (key) => {
    await expectAsks('send_key', { tab_id: 't1', key });
  });

  it.each([null, 'idle'])('send_input to a tab with no agent at work (%s) asks: typing into a shell is run_command', async (state) => {
    tabs.set('t1', tab('t1', state));
    await expectAsks('send_input', { tab_id: 't1', text: 'ls' });
  });

  it('close_tab of a tab really working asks', async () => {
    tabs.set('t1', { ...tab('t1', 'working'), state_at: new Date().toISOString(), state_tool: 'claude' });
    await expectAsks('close_tab', { tab_id: 't1' });
  });

  it('close_tab of a stale "working" tab whose screen shows a turn in progress asks', async () => {
    tabs.set('t1', { ...tab('t1', 'working'), state_at: staleAt(), state_tool: 'claude' });
    vi.mocked(readScreen).mockResolvedValueOnce({ tab_id: 't1', lines: 50, styled: false, text: BUSY_SCREEN });
    await expectAsks('close_tab', { tab_id: 't1' });
  });

  it('close_tab of a stale "working" tab of another tool asks, even with an idle-looking screen', async () => {
    tabs.set('t1', { ...tab('t1', 'working'), state_at: staleAt(), state_tool: 'codex' });
    vi.mocked(readScreen).mockResolvedValueOnce({ tab_id: 't1', lines: 50, styled: false, text: IDLE_SCREEN });
    await expectAsks('close_tab', { tab_id: 't1' });
  });

  it.each(['waiting_permission', null])('close_tab of a tab in state %s asks', async (state) => {
    tabs.set('t1', tab('t1', state));
    await expectAsks('close_tab', { tab_id: 't1' });
  });

  it.each([
    ['open_tab', { project_id: 'p-foreign', machine_id: 'm1' }],
    ['close_tab', { tab_id: 'nope' }],
    ['link_tab_task', { tab_id: 'nope', task_id: 'k1' }],
    ['create_task', { project_id: 'p-foreign', title: 'x' }],
  ])('%s on something that is not the user’s asks', async (tool, args) => {
    await expectAsks(tool, args);
  });

  it('the 11th start_agent in an hour asks, counted across conversations', async () => {
    for (let i = 0; i < 10; i++) actions.rows.push(fakeRow({ grant_id: D('start_agent'), tool: 'start_agent' }));
    await expectAsks('start_agent', { project_id: 'p1', prompt: 'x' });
  });

  it('a denial in force still refuses', async () => {
    const args = { project_id: 'p1', machine_id: 'm1' };
    const denied = await actions.insertPending({ conversation_id: C, tool: 'open_tab', args, class: 'write', idempotency_key: idempotencyKeyFor(C, 'open_tab', args) });
    Object.assign(denied, { status: 'denied', decided_at: new Date().toISOString() });
    expect(await call('open_tab', args)).toMatchObject({ ok: false, code: 'CONFIRMATION_DENIED' });
    expect(run).not.toHaveBeenCalled();
  });
});

describe('restricting a default in "Permissões do chat" (TER-627)', () => {
  it.each([
    ['open_tab', 'open_tab', { project_id: 'p1', machine_id: 'm1' }],
    ['start_agent', 'start_agent', { project_id: 'p1', prompt: 'x' }],
    ['link_tab_task', 'link_tab_task', { tab_id: 't1', task_id: 'k1' }],
    ['board', 'move_task', { task_id: 'k1', status: 'doing' }],
    ['terminal', 'send_key', { tab_id: 't1', key: 'Enter' }],
    ['close_tab', 'close_tab', { tab_id: 't1' }],
  ] as const)('restricted %s: %s asks again', async (kind, tool, args) => {
    restricted.add(kind);
    await expectAsks(tool, args);
  });

  it('restricting one kind leaves the others on', async () => {
    restricted.add('terminal');
    await expectRuns('open_tab', { project_id: 'p1', machine_id: 'm1' }, D('open_tab'));
  });

  it('a restricted kind still runs under a grant the person gave', async () => {
    DEFAULT_ALLOW_KINDS.forEach((k) => restricted.add(k));
    standing.push({ id: 'sg1', user_id: 'u1', project_id: 'p1', kind: 'board', revoked_at: null });
    await expectRuns('create_task', { project_id: 'p1', title: 'x' }, 'sg1');
  });
});
