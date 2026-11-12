import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ControlContext } from '../control/context.js';
import { readScreen } from '../control/screen.js';
import type { ChatAction, InsertApprovedInput, InsertPendingInput } from '../db/repositories/chat-actions.js';
import type { ChatBlock } from '../db/repositories/chat-blocks.js';
import { chatBus } from './bus.js';
import { applyGate } from './gate-runtime.js';
import type { DefaultAllowKind } from './gate.js';
import { openGrantId, quotedAnswerGrantId, type BlockKind } from './open-permissions.js';
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
    findDeniedByKey: vi.fn(async () => undefined),
    findByIdForUser: vi.fn(async (id: string) => rows.find((r) => r.id === id)),
    insertPending: vi.fn(async (i: InsertPendingInput) => { const r = make(i, 'pending'); rows.push(r); return r; }),
    insertApproved: vi.fn(async (i: InsertApprovedInput) => { const r = make(i, 'approved', { grant_id: i.grant_id, decided_by: i.decided_by, decided_at: new Date().toISOString() }); rows.push(r); return r; }),
    claimApproved: vi.fn(async (id: string) => { const r = rows.find((x) => x.id === id && x.status === 'approved'); if (!r) return false; r.status = 'executed'; return true; }),
    expireApproved: vi.fn(async () => false),
    markExecuted: vi.fn(async (id: string, ok: boolean, code?: string | null) => { const r = rows.find((x) => x.id === id)!; r.status = ok ? 'executed' : 'failed'; r.error_code = code ?? null; }),
    countForGrantSince: vi.fn(async () => 0),
    countByGrantSince: vi.fn(async (g: string, since: Date) => rows.filter((r) => r.grant_id === g && Date.parse(r.created_at) > since.getTime()).length),
  };
}

type FakeTab = { id: string; project_id: string; machine_id: string; kind: string; state: string | null; state_at: string | null; state_tool?: string | null };

let actions: ReturnType<typeof fakeActions>;
let flagOn: boolean;
let blocks: ChatBlock[];
let restricted: Set<DefaultAllowKind>;
let standing: { kind: string; project_id: string }[];
let tabs: Map<string, FakeTab>;
let messages: { id: string; created_at: string }[];
let ctx: ControlContext;
const run = vi.fn(async () => ({ ok: 1 }));
const call = (tool: string, args: Record<string, unknown>) => applyGate(ctx, { token: { gated: true, chat_conversation_id: C }, tool, args, run });
const tab = (id: string, state: string | null, projectId = 'p1'): FakeTab => ({ id, project_id: projectId, machine_id: 'm1', kind: 'terminal', state, state_at: new Date(Date.now() - 60_000).toISOString(), state_tool: 'claude' });
const block = (kind: BlockKind, o: Partial<ChatBlock> = {}): ChatBlock => ({ id: `b${blocks.length + 1}`, user_id: 'u1', project_id: null, kind, words: [], effect: 'ask', conversation_id: null, created_at: new Date().toISOString(), revoked_at: null, ...o });

async function expectAsks(tool: string, args: Record<string, unknown>) {
  expect(await call(tool, args)).toMatchObject({ ok: false, code: 'CONFIRMATION_PENDING' });
  expect(actions.rows.at(-1)).toMatchObject({ tool, status: 'pending', grant_id: null });
  expect(run).not.toHaveBeenCalled();
}
async function expectRuns(tool: string, args: Record<string, unknown>, grantId: string) {
  expect(await call(tool, args)).toEqual({ ok: true, value: { ok: 1 } });
  expect(actions.rows.at(-1)).toMatchObject({ tool, status: 'executed', grant_id: grantId });
}
const O = (kind: BlockKind) => openGrantId('u1', kind);

beforeEach(() => {
  run.mockClear();
  vi.mocked(readScreen).mockReset();
  vi.mocked(readScreen).mockImplementation(async () => ({ text: '$ ', lines: 40, tab_id: 't1', styled: false }));
  vi.spyOn(chatBus, 'publish').mockImplementation(() => {});
  actions = fakeActions();
  flagOn = true;
  blocks = [];
  restricted = new Set();
  standing = [];
  messages = [];
  tabs = new Map([
    ['agent', tab('agent', 'waiting_input')],
    ['shell', tab('shell', null)],
    ['perm', tab('perm', 'waiting_permission')],
    ['busy', tab('busy', 'working')],
    ['other', tab('other', 'waiting_input', 'p2')],
  ]);
  const repos = {
    featureFlags: { overrideFor: vi.fn(async () => (flagOn ? true : null)), instanceValue: vi.fn(async () => null) },
    chat: {
      getOrCreateForUser: vi.fn(),
      lastTypedAt: vi.fn(async () => null),
      findUserMessagesForUser: vi.fn(async (ids: string[]) => messages.filter((m) => ids.includes(m.id)).map((m) => ({ ...m, role: 'user' }))),
    },
    memoryItems: {
      findManyForOwner: vi.fn(async () => []),
      findMessagesBySource: vi.fn(async (ids: string[]) => messages.filter((m) => ids.includes(m.id)).map((m) => ({ id: `mi-${m.id}`, kind: 'message', trust: 'person', source_id: m.id }))),
    },
    chatActions: actions,
    chatBlocks: { listActive: vi.fn(async () => blocks.filter((b) => !b.revoked_at)) },
    chatGrants: { findActive: vi.fn(async () => undefined) },
    chatProjectGrants: { findActive: vi.fn(async () => undefined) },
    chatDefaultRestrictions: { listForUser: vi.fn(async () => new Set(restricted)) },
    chatStandingGrants: { findActive: vi.fn(async (_u: string, p: string, k: string) => standing.find((g) => g.project_id === p && g.kind === k)) },
    chatCommandRules: { listActiveFor: vi.fn(async () => []) },
    chatFileGrants: { listActiveForMachine: vi.fn(async () => []) },
    projects: { findByIdsForOwner: vi.fn(async (ids: string[], o: string) => (o === 'u1' ? ids.filter((i) => i === 'p1' || i === 'p2').map((id) => ({ id, name: id })) : [])) },
    tasks: { findByIdsForOwner: vi.fn(async (ids: string[], o: string) => (o === 'u1' ? ids.filter((i) => i === 'k1').map((id) => ({ id, project_id: 'p1', ref: 'APP-1', title: 't' })) : [])) },
    taskColumns: { findByIdsForOwner: vi.fn(async () => []) },
    tabs: { findByIdsForOwner: vi.fn(async (ids: string[], o: string) => (o === 'u1' ? ids.flatMap((i) => (tabs.has(i) ? [{ ...tabs.get(i)! }] : [])) : [])) },
    machines: { findByIdsForOwner: vi.fn(async () => []) },
    integrations: { list: vi.fn(async () => []) },
  };
  ctx = { repos, scope: { user: { id: 'u1' }, ownerId: 'u1' }, token: { gated: true, id: 'tok', chat_conversation_id: C } } as unknown as ControlContext;
});

describe('open permissions (TER-1164): the chat acts without a card unless the core or a block says so', () => {
  it.each([
    ['open_tab', { project_id: 'p1', machine_id: 'm1' }, 'open_tab'],
    ['start_agent', { project_id: 'p1', prompt: 'x' }, 'start_agent'],
    ['create_task', { project_id: 'p1', title: 't' }, 'board'],
    ['update_task', { task_id: 'k1', title: 't' }, 'board'],
    ['link_tab_task', { tab_id: 'agent', task_id: 'k1' }, 'link_tab_task'],
    ['send_input', { tab_id: 'agent', text: 'segue com o plano' }, 'terminal'],
    ['send_key', { tab_id: 'agent', key: 'Enter' }, 'terminal'],
    ['close_tab', { tab_id: 'agent' }, 'close_tab'],
    ['run_command', { tab_id: 'shell', command: 'git push origin main' }, 'run_command'],
    ['send_input', { tab_id: 'shell', text: 'npm test' }, 'terminal'],
    ['share_file', { machine_id: 'm1', path: '/tmp/x.png' }, 'share_file'],
    ['wake_machine', { machine_id: 'm1' }, 'machines'],
    ['sync_tickets', { project_id: 'p1' }, 'tickets'],
    ['resume_automation', { project_id: 'p1' }, 'automation'],
  ] as const)('%s runs, audited as liberado por padrão', async (tool, args, kind) => {
    await expectRuns(tool, { ...args }, O(kind));
  });

  it('runs in a new project with no grant of any kind', async () => {
    await expectRuns('send_input', { tab_id: 'other', text: 'ok' }, O('terminal'));
  });

  it.each([
    ['delete_task', { task_id: 'k1' }],
    ['push_ticket_status', { task_id: 'k1' }],
    ['create_integration', { name: 'x' }],
    ['set_project_repo', { project_id: 'p1', repo: 'a/b' }],
    ['start_ai_login', { machine_id: 'm1' }],
    ['unblock_action', { block_id: 'b1' }],
    ['send_key', { tab_id: 'agent', key: 'C-c' }],
    ['send_key', { tab_id: 'agent', key: 'Escape' }],
    ['close_tab', { tab_id: 'busy' }],
    ['unlink_project_machine', { project_id: 'p1', machine_id: 'm1', confirm: true }],
    ['some_new_tool', {}],
  ])('core: %s still asks', async (tool, args) => {
    await expectAsks(tool, args);
  });

  it.each([
    ['rm -rf build'],
    ['git push --force origin main'],
    ['git reset --hard'],
    ['ls | wc -l'],
    ['sudo apt update'],
    ['ssh host uptime'],
    ['bash -c "echo hi"'],
    ['cat .env'],
  ])('core: run_command %s asks', async (command) => {
    await expectAsks('run_command', { tab_id: 'shell', command });
  });

  it('core: text typed into a shell is a command, held to the same list', async () => {
    await expectAsks('send_input', { tab_id: 'shell', text: 'rm -rf /tmp/x' });
  });

  it('core: `!` in an agent tab runs bash, held to the same list', async () => {
    await expectAsks('send_input', { tab_id: 'agent', text: '!git reset --hard' });
    run.mockClear();
    await expectRuns('send_input', { tab_id: 'agent', text: '!git status' }, O('terminal'));
  });

  it('core: control characters ask', async () => {
    await expectAsks('send_input', { tab_id: 'agent', text: 'x\x15!rm -rf ~' });
  });

  it('core: a key into a shell asks (it could replay a command)', async () => {
    await expectAsks('send_key', { tab_id: 'shell', key: 'Up' });
  });

  it('core: a permission dialog on screen asks, even with the tab reporting an agent', async () => {
    vi.mocked(readScreen).mockImplementation(async () => ({ text: `Do you want to proceed?\n❯ 1. Yes\n  2. No\n${DIALOG_FOOTER}`, lines: 40, tab_id: 'agent', styled: false }));
    await expectAsks('send_input', { tab_id: 'agent', text: 'ok' });
  });

  describe('a permission answered with the person\'s own words', () => {
    const now = () => new Date().toISOString();

    it('runs when the quoted message came after the tab started asking', async () => {
      messages.push({ id: 'msg1', created_at: now() });
      await expectRuns('send_input', { tab_id: 'perm', text: '1', answering_permission: true, on_behalf_of: ['message:msg1'] }, quotedAnswerGrantId('u1'));
    });

    it('asks without on_behalf_of', async () => {
      await expectAsks('send_input', { tab_id: 'perm', text: '1', answering_permission: true });
    });

    it('asks when the message is older than the dialog', async () => {
      messages.push({ id: 'msg1', created_at: new Date(Date.now() - 5 * 60_000).toISOString() });
      await expectAsks('send_input', { tab_id: 'perm', text: '1', answering_permission: true, on_behalf_of: ['message:msg1'] });
    });

    it('asks when the message is more than 30 minutes old', async () => {
      tabs.set('perm', { ...tab('perm', 'waiting_permission'), state_at: new Date(Date.now() - 2 * 60 * 60_000).toISOString() });
      messages.push({ id: 'msg1', created_at: new Date(Date.now() - 45 * 60_000).toISOString() });
      await expectAsks('send_input', { tab_id: 'perm', text: '1', answering_permission: true, on_behalf_of: ['message:msg1'] });
    });

    it('asks for free text into a tab asking a permission', async () => {
      messages.push({ id: 'msg1', created_at: now() });
      await expectAsks('send_input', { tab_id: 'perm', text: 'ok', on_behalf_of: ['message:msg1'] });
    });
  });

  describe('blocks', () => {
    it('a block for every project asks', async () => {
      blocks.push(block('terminal'));
      await expectAsks('send_input', { tab_id: 'agent', text: 'ok' });
    });

    it('a project block asks there and nowhere else', async () => {
      blocks.push(block('terminal', { project_id: 'p2' }));
      await expectAsks('send_input', { tab_id: 'other', text: 'ok' });
      await expectRuns('send_input', { tab_id: 'agent', text: 'ok' }, O('terminal'));
    });

    it('"nunca" refuses with no card', async () => {
      blocks.push(block('board', { effect: 'never' }));
      expect(await call('create_task', { project_id: 'p1', title: 't' })).toMatchObject({ ok: false, code: 'BLOCKED_BY_PERSON' });
      expect(actions.rows).toHaveLength(0);
      expect(run).not.toHaveBeenCalled();
    });

    it('a command block asks for the commands it names, also typed into a shell or after `!`', async () => {
      blocks.push(block('run_command', { words: ['git', 'push'] }));
      await expectAsks('run_command', { tab_id: 'shell', command: 'git push origin main' });
      await expectAsks('send_input', { tab_id: 'shell', text: 'git push' });
      await expectAsks('send_input', { tab_id: 'agent', text: '!git push' });
      await expectRuns('run_command', { tab_id: 'shell', command: 'git status' }, O('run_command'));
    });

    it('a default the person restricted before reads as a block for every project', async () => {
      restricted.add('start_agent');
      await expectAsks('start_agent', { project_id: 'p1', prompt: 'x' });
    });

    it('a block wins over a grant given before it', async () => {
      standing.push({ kind: 'terminal', project_id: 'p1' });
      blocks.push(block('terminal', { project_id: 'p1' }));
      await expectAsks('send_input', { tab_id: 'agent', text: 'ok' });
    });
  });

  it('past the hourly budget, asks', async () => {
    for (let i = 0; i < 10; i++) await call('start_agent', { project_id: 'p1', prompt: `x${i}` });
    run.mockClear();
    await expectAsks('start_agent', { project_id: 'p1', prompt: 'one more' });
  });

  it('a tab that is not the person\'s asks (the tool then 404s)', async () => {
    await expectAsks('send_input', { tab_id: 'stranger', text: 'ok' });
  });

  it('with the flag off, the grants model decides: a new project asks for a shell text', async () => {
    flagOn = false;
    restricted.add('terminal');
    await expectAsks('send_input', { tab_id: 'agent', text: 'ok' });
  });
});
