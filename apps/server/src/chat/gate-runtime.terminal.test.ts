import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ControlContext } from '../control/context.js';
import { readScreen } from '../control/screen.js';
import type { ChatAction, InsertApprovedInput, InsertPendingInput } from '../db/repositories/chat-actions.js';
import { chatBus } from './bus.js';
import { applyGate } from './gate-runtime.js';
import { idempotencyKeyFor, TAB_TERMINAL_GRANT, DEFAULT_ALLOW_KINDS } from './gate.js';
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
  };
}

type Grant = { id: string; conversation_id: string; expires_at: string; revoked_at: string | null };
type TabGrant = Grant & { tab_id: string; tool: string };
type ProjectGrant = Grant & { project_id: string; scope: 'board' | 'all' };
type FakeTab = { id: string; project_id: string; state: string | null; state_at: string | null };

let actions: ReturnType<typeof fakeActions>;
let tabGrants: TabGrant[];
let projectGrants: ProjectGrant[];
let tabs: Map<string, FakeTab>;
let tabsFind: ReturnType<typeof vi.fn>;
let ctx: ControlContext;
const run = vi.fn(async () => ({ ok: 1 }));
const call = (tool: string, args: Record<string, unknown>) => applyGate(ctx, { token: { gated: true, chat_conversation_id: C }, tool, args, run });

const lifetime = (o: { minutes?: number; revoked?: boolean }) => ({
  expires_at: new Date(Date.now() + (o.minutes ?? 60) * 60_000).toISOString(),
  revoked_at: o.revoked ? new Date().toISOString() : null,
});
const seedTabGrant = (tabId: string, o: { minutes?: number; revoked?: boolean; tool?: string } = {}) =>
  tabGrants.push({ id: `tg${tabGrants.length + 1}`, conversation_id: C, tab_id: tabId, tool: o.tool ?? TAB_TERMINAL_GRANT, ...lifetime(o) });
const seedProjectGrant = (projectId: string, scope: 'board' | 'all', o: { minutes?: number; revoked?: boolean } = {}) =>
  projectGrants.push({ id: `pg${projectGrants.length + 1}`, conversation_id: C, project_id: projectId, scope, ...lifetime(o) });
const tab = (id: string, state: string | null, projectId = 'p1'): FakeTab => ({ id, project_id: projectId, state, state_at: null });
/** A past audit row already charged to a grant, as `executeGranted` leaves it. */
const fakeRow = (o: { grant_id: string; tool: string }): ChatAction => ({
  id: `old${actions.rows.length + 1}`, conversation_id: C, message_id: null, tool: o.tool, args: {}, class: 'write', status: 'executed',
  idempotency_key: null, machine_id: null, project_id: null, tab_id: null, grant_id: o.grant_id, error_code: null, duration_ms: null,
  decided_by: 'u1', decided_at: new Date().toISOString(), injected_at: null, created_at: new Date().toISOString(),
});
const active = (g: Grant) => !g.revoked_at && Date.parse(g.expires_at) > Date.now();

beforeEach(() => {
  run.mockClear();
  vi.mocked(readScreen).mockClear();
  vi.spyOn(chatBus, 'publish').mockImplementation(() => {});
  actions = fakeActions();
  tabGrants = [];
  projectGrants = [];
  tabs = new Map([
    ['t1', tab('t1', null)],
    ['t2', tab('t2', 'idle', 'p2')],
    ['t3', tab('t3', 'waiting_permission')],
  ]);
  tabsFind = vi.fn(async (ids: string[], o: string) => (o === 'u1' ? ids.flatMap((i) => (tabs.has(i) ? [{ ...tabs.get(i)! }] : [])) : []));
  const repos = {
    chat: { getOrCreateForUser: vi.fn(), lastTypedAt: vi.fn(async () => null) },
    chatActions: actions,
    chatGrants: { findActive: vi.fn(async (c: string, t: string, tool: string) => tabGrants.find((g) => g.conversation_id === c && g.tab_id === t && g.tool === tool && active(g))) },
    chatProjectGrants: { findActive: vi.fn(async (c: string, p: string) => projectGrants.find((g) => g.conversation_id === c && g.project_id === p && active(g))) },
    // No standing grant (TER-386): these tests are about the conversation-bound ones.
    // Every default allowance (TER-627) restricted: these tests are about the person's own grants.
    chatDefaultRestrictions: { listForUser: vi.fn(async () => new Set(DEFAULT_ALLOW_KINDS)) },
    chatStandingGrants: { findActive: vi.fn(async () => undefined) },
    projects: { findByIdsForOwner: vi.fn(async (ids: string[], o: string) => (o === 'u1' ? ids.filter((i) => i === 'p1' || i === 'p2').map((id) => ({ id, name: id })) : [])) },
    tasks: { findByIdsForOwner: vi.fn(async () => []) },
    tabs: { findByIdsForOwner: tabsFind },
    machines: { findByIdsForOwner: vi.fn(async () => []) },
  };
  ctx = { repos, scope: { user: { id: 'u1' }, ownerId: 'u1' } } as unknown as ControlContext;
});

describe('terminal grants in the gate', () => {
  it('a tab terminal grant runs send_key and shell send_input at once', async () => {
    seedTabGrant('t1');
    expect(await call('send_key', { tab_id: 't1', key: 'Enter' })).toEqual({ ok: true, value: { ok: 1 } });
    expect(await call('send_input', { tab_id: 't1', text: 'claude --resume' })).toEqual({ ok: true, value: { ok: 1 } });
    expect(actions.rows.map((r) => [r.status, r.grant_id])).toEqual([['executed', 'tg1'], ['executed', 'tg1']]);
    // The live check read a plain capture of the tab's last lines, once per call.
    expect(readScreen).toHaveBeenCalledWith(ctx, { tab_id: 't1', lines: 40 }, { plain: true });
    expect(readScreen).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['answering_permission', 'send_input', { tab_id: 't1', text: 'y', answering_permission: true }],
    ['! text', 'send_input', { tab_id: 't1', text: '  !rm -rf ~' }],
    ['control char', 'send_input', { tab_id: 't1', text: 'a\x15b' }],
    ['run_command', 'run_command', { tab_id: 't1', command: 'ls' }],
    ['another tab', 'send_key', { tab_id: 't2', key: 'Enter' }],
  ])('%s still asks', async (_n, tool, args) => {
    seedTabGrant('t1');
    expect(await call(tool, args)).toMatchObject({ ok: false, code: 'CONFIRMATION_PENDING' });
    expect(run).not.toHaveBeenCalled();
    expect(actions.insertApproved).not.toHaveBeenCalled();
  });

  it('a tab waiting on a permission asks', async () => {
    seedTabGrant('t3');
    expect(await call('send_key', { tab_id: 't3', key: '1' })).toMatchObject({ code: 'CONFIRMATION_PENDING' });
    expect(run).not.toHaveBeenCalled();
    expect(actions.insertApproved).not.toHaveBeenCalled();
  });

  it('a permission dialog on screen asks even when the monitor never reported (Review Focus 1)', async () => {
    seedTabGrant('t1');
    vi.mocked(readScreen).mockResolvedValueOnce({ tab_id: 't1', lines: 40, styled: false, text: `Do you want to proceed?\n ❯ 1. Yes\n${DIALOG_FOOTER}` });
    expect(await call('send_key', { tab_id: 't1', key: '1' })).toMatchObject({ code: 'CONFIRMATION_PENDING' });
    expect(run).not.toHaveBeenCalled();
    expect(actions.insertApproved).not.toHaveBeenCalled();
  });

  it('an exit-plan-mode dialog on screen asks, with no Esc footer (TER-374)', async () => {
    seedTabGrant('t1');
    vi.mocked(readScreen).mockResolvedValueOnce({ tab_id: 't1', lines: 40, styled: false, text: readFileSync(new URL('./fixtures/permission-dialogs/claude-exit-plan.txt', import.meta.url), 'utf8') });
    expect(await call('send_key', { tab_id: 't1', key: 'Enter' })).toMatchObject({ code: 'CONFIRMATION_PENDING' });
    expect(run).not.toHaveBeenCalled();
  });

  it('a failed screen capture asks', async () => {
    seedTabGrant('t1');
    vi.mocked(readScreen).mockRejectedValueOnce(new Error('offline'));
    expect(await call('send_key', { tab_id: 't1', key: 'Enter' })).toMatchObject({ code: 'CONFIRMATION_PENDING' });
    expect(run).not.toHaveBeenCalled();
  });

  it('the 121st terminal call in an hour asks', async () => {
    seedTabGrant('t1');
    for (let i = 0; i < 120; i++) actions.rows.push(fakeRow({ grant_id: 'tg1', tool: 'send_key' }));
    expect(await call('send_key', { tab_id: 't1', key: 'Enter' })).toMatchObject({ code: 'CONFIRMATION_PENDING' });
    expect(run).not.toHaveBeenCalled();
  });

  it('the 120th terminal call in an hour still runs', async () => {
    seedTabGrant('t1');
    for (let i = 0; i < 119; i++) actions.rows.push(fakeRow({ grant_id: 'tg1', tool: 'send_key' }));
    expect(await call('send_key', { tab_id: 't1', key: 'Enter' })).toMatchObject({ ok: true });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('a project "tudo" grant covers the project tabs only (Review Focus 3)', async () => {
    seedProjectGrant('p1', 'all');
    expect(await call('send_key', { tab_id: 't1', key: 'Escape' })).toMatchObject({ ok: true });
    expect(await call('send_key', { tab_id: 't2', key: 'Escape' })).toMatchObject({ code: 'CONFIRMATION_PENDING' });
    expect(await call('send_key', { tab_id: 'nope', key: 'Escape' })).toMatchObject({ code: 'CONFIRMATION_PENDING' });
    expect(run).toHaveBeenCalledTimes(1);
    expect(actions.rows.map((r) => [r.tab_id, r.status, r.grant_id])).toEqual([['t1', 'executed', 'pg1'], ['t2', 'pending', null], ['nope', 'pending', null]]);
  });

  it('a project "tudo" grant never covers a tab the owner-scoped read does not resolve', async () => {
    seedProjectGrant('p1', 'all');
    ctx = { ...ctx, scope: { user: { id: 'u2' }, ownerId: 'u2' } } as unknown as ControlContext;
    expect(await call('send_key', { tab_id: 't1', key: 'Enter' })).toMatchObject({ code: 'CONFIRMATION_PENDING' });
    expect(run).not.toHaveBeenCalled();
  });

  it('a board-scope project grant does not cover terminal calls (Review Focus 4)', async () => {
    seedProjectGrant('p1', 'board');
    expect(await call('send_key', { tab_id: 't1', key: 'Enter' })).toMatchObject({ code: 'CONFIRMATION_PENDING' });
    expect(run).not.toHaveBeenCalled();
  });

  it('board and terminal budgets of a "tudo" grant are counted apart (Review Focus 4)', async () => {
    seedProjectGrant('p1', 'all');
    for (let i = 0; i < 30; i++) actions.rows.push(fakeRow({ grant_id: 'pg1', tool: 'create_task' }));
    expect(await call('send_key', { tab_id: 't1', key: 'Enter' })).toMatchObject({ ok: true });
    expect(await call('create_task', { project_id: 'p1', title: 'x' })).toMatchObject({ code: 'CONFIRMATION_PENDING' });
  });

  it('terminal calls do not spend the board budget of a "tudo" grant', async () => {
    seedProjectGrant('p1', 'all');
    for (let i = 0; i < 120; i++) actions.rows.push(fakeRow({ grant_id: 'pg1', tool: 'send_key' }));
    expect(await call('create_task', { project_id: 'p1', title: 'x' })).toMatchObject({ ok: true });
    expect(await call('send_key', { tab_id: 't1', key: 'Enter' })).toMatchObject({ code: 'CONFIRMATION_PENDING' });
  });

  it('a spent tab grant falls back to a "tudo" grant of the tab project with budget left', async () => {
    seedTabGrant('t1');
    for (let i = 0; i < 120; i++) actions.rows.push(fakeRow({ grant_id: 'tg1', tool: 'send_input' }));
    seedProjectGrant('p1', 'all');
    expect(await call('send_key', { tab_id: 't1', key: 'Enter' })).toMatchObject({ ok: true });
    expect(actions.rows.at(-1)).toMatchObject({ status: 'executed', grant_id: 'pg1' });
  });

  it('expired and revoked grants ask; a denial in force refuses', async () => {
    seedTabGrant('t1', { minutes: -1 });
    seedTabGrant('t1', { revoked: true });
    seedProjectGrant('p1', 'all', { minutes: -1 });
    seedProjectGrant('p1', 'all', { revoked: true });
    expect(await call('send_key', { tab_id: 't1', key: 'Enter' })).toMatchObject({ ok: false, code: 'CONFIRMATION_PENDING' });
    expect(run).not.toHaveBeenCalled();
    expect(actions.insertApproved).not.toHaveBeenCalled();

    // Now an active grant, and a fresh "no" to the very same proposal: the "no" decides first.
    seedTabGrant('t1');
    const args = { tab_id: 't1', text: 'git push' };
    const key = idempotencyKeyFor(C, 'send_input', args);
    const denied = await actions.insertPending({ conversation_id: C, tool: 'send_input', args, class: 'write', idempotency_key: key });
    Object.assign(denied, { status: 'denied', decided_at: new Date().toISOString() });
    expect(await call('send_input', args)).toMatchObject({ ok: false, code: 'CONFIRMATION_DENIED' });
    expect(run).not.toHaveBeenCalled();
    expect(actions.insertApproved).not.toHaveBeenCalled();
    expect(readScreen).not.toHaveBeenCalled();
  });

  it('a pending row for the same call waits even with an active terminal grant', async () => {
    seedTabGrant('t1');
    const args = { tab_id: 't1', key: 'Enter' };
    await actions.insertPending({ conversation_id: C, tool: 'send_key', args, class: 'write', idempotency_key: idempotencyKeyFor(C, 'send_key', args) });
    expect(await call('send_key', args)).toMatchObject({ ok: false, code: 'CONFIRMATION_WAITING' });
    expect(run).not.toHaveBeenCalled();
    expect(actions.insertApproved).not.toHaveBeenCalled();
  });

  it('the narrow agent-text grant does not cover keys or a shell', async () => {
    seedTabGrant('t1', { tool: 'send_input' });
    expect(await call('send_key', { tab_id: 't1', key: 'Enter' })).toMatchObject({ code: 'CONFIRMATION_PENDING' });
    expect(await call('send_input', { tab_id: 't1', text: 'ls' })).toMatchObject({ code: 'CONFIRMATION_PENDING' });
    expect(run).not.toHaveBeenCalled();
  });

  it('a granted key on a tab that turned waiting_permission fails WAITING_PERMISSION (Review Focus 2)', async () => {
    seedTabGrant('t1');
    // The gate saw a quiet tab and a clean screen and decided to run. The dialog shows up in the gap
    // between that decision and the keystroke: the approved row is inserted, and from then on every
    // read reports the permission — whichever read comes next, it is `execute()`'s own lock that must
    // stop the key, since the gate's checks are already behind it.
    actions.insertApproved.mockImplementationOnce(async (i: InsertApprovedInput) => {
      Object.assign(tabs.get('t1')!, { state: 'waiting_permission', state_at: new Date().toISOString() });
      const r = fakeRow({ grant_id: i.grant_id, tool: i.tool });
      Object.assign(r, { id: 'granted', args: i.args, idempotency_key: i.idempotency_key ?? null, tab_id: i.tab_id ?? null, status: 'approved' });
      actions.rows.push(r);
      return r;
    });
    const res = await call('send_key', { tab_id: 't1', key: '1' });
    expect(res).toMatchObject({ ok: false, code: 'WAITING_PERMISSION' });
    expect((res as { message: string }).message).toMatch(/nunca é liberado sem o usuário/);
    expect(run).not.toHaveBeenCalled();
    expect(readScreen).toHaveBeenCalledTimes(1); // the gate's screen check passed
    expect(actions.rows[0]).toMatchObject({ status: 'failed', error_code: 'WAITING_PERMISSION', grant_id: 'tg1' });
  });

  it('a tab grant for a tab that no longer resolves records TAB_GONE', async () => {
    seedTabGrant('gone');
    expect(await call('send_key', { tab_id: 'gone', key: 'Enter' })).toMatchObject({ ok: false, code: 'TAB_GONE' });
    expect(run).not.toHaveBeenCalled();
    expect(readScreen).not.toHaveBeenCalled();
    expect(actions.rows[0]).toMatchObject({ status: 'failed', error_code: 'TAB_GONE', grant_id: 'tg1' });
  });
});

// TER-499: link_tab_task names a tab but types nothing into it. It always asks (no grant covers it), and
// an approval of it is not an answer to whatever the tab is asking: only a closed tab spends it.
describe('link_tab_task in the gate', () => {
  const args = { tab_id: 't3', task_id: 'k1' };
  /** The row as the decision route leaves it after the user clicked approve, `minutesAgo` back. */
  const approve = (minutesAgo: number) => {
    const at = new Date(Date.now() - minutesAgo * 60_000).toISOString();
    actions.rows.push({
      id: 'ap1', conversation_id: C, message_id: null, tool: 'link_tab_task', args, class: 'write', status: 'approved',
      idempotency_key: idempotencyKeyFor(C, 'link_tab_task', args), machine_id: null, project_id: null, tab_id: 't3', grant_id: null, error_code: null,
      duration_ms: null, decided_by: 'u1', decided_at: at, injected_at: null, created_at: at,
    });
  };

  it('asks even in a tab and a project the user trusted for everything', async () => {
    seedTabGrant('t3');
    seedProjectGrant('p1', 'all');
    expect(await call('link_tab_task', args)).toMatchObject({ ok: false, code: 'CONFIRMATION_PENDING' });
    expect(run).not.toHaveBeenCalled();
    expect(actions.rows[0]).toMatchObject({ tool: 'link_tab_task', class: 'write', status: 'pending', tab_id: 't3' });
  });

  it('runs once approved although the tab asked for another permission meanwhile: nothing is typed', async () => {
    approve(10);
    tabs.set('t3', { ...tabs.get('t3')!, state: 'waiting_permission', state_at: new Date().toISOString() });
    expect(await call('link_tab_task', args)).toEqual({ ok: true, value: { ok: 1 } });
    expect(run).toHaveBeenCalledTimes(1);
    expect(actions.rows[0].status).toBe('executed');
  });

  it('an approval for a tab that was closed meanwhile is spent as TAB_GONE', async () => {
    approve(1);
    tabs.delete('t3');
    expect(await call('link_tab_task', args)).toMatchObject({ ok: false, code: 'TAB_GONE' });
    expect(run).not.toHaveBeenCalled();
    expect(actions.rows[0]).toMatchObject({ status: 'failed', error_code: 'TAB_GONE' });
  });
});
