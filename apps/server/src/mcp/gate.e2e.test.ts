import Fastify from 'fastify';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AgentConnection } from '../agent/connection.js';
import { agents } from '../agent/registry.js';
import { hashApiToken } from '../auth/api-tokens.js';
import { canAccess } from '../auth/permissions.js';
import { chatBus } from '../chat/bus.js';
import { idempotencyKeyFor } from '../chat/gate.js';
import type { ChatAction, InsertApprovedInput, InsertPendingInput } from '../db/repositories/chat-actions.js';
import type { Repositories } from '../db/repositories/index.js';
import { applyErrorHandler } from '../lib/errors.js';
import { mcpRoutes } from './route.js';

vi.mock('../auth/permissions.js', async (orig) => ({ ...(await orig<typeof import('../auth/permissions.js')>()), canAccess: vi.fn(async () => true) }));

const SECRET = 'thb_pat_' + 'A'.repeat(43);
const CONVERSATION = 'c1';
/** What `insertPending` stamps a new pending row with: a value nothing else in a run can produce. */
const PENDING_CREATED_AT = '2020-05-05T05:05:05.050Z';
const machine = { id: 'm1', name: 'jarvis', type: 'agent', os: 'linux', capabilities: ['tmux'], owner_id: 'u1' };
const project = { id: 'p1', name: 'app', status: 'active', owner_id: 'u1', key: 'APP', next_task_number: 1 };
const link = { id: 'l1', project_id: 'p1', machine_id: 'm1', cwd: '/home/u/app', position: 0, created_at: '' };

/** The fake machine: one tmux session whose screen is whatever was typed into it. `agentVersion` is
 * how the "this machine cannot do it" failures are staged: an agent older than the terminal RPCs makes
 * the tool throw `AGENT_OUTDATED` before it ever reaches tmux. */
function attachFakeTmux(typed: string[], agentVersion = '0.2.0') {
  const conn = {
    machineId: machine.id,
    hello: { agent_version: agentVersion, os: 'linux', tools: ['tmux'] },
    connectedAt: Date.now(),
    close: vi.fn(),
    openPty: vi.fn(),
    on() {
      return this;
    },
    rpc: vi.fn(async (method: string, params: unknown) => {
      const p = params as { text?: string };
      if (method === 'tmux.ensure') return { created: true };
      if (method === 'tmux.sendText') {
        typed.push(p.text ?? '');
        return { sent: true };
      }
      if (method === 'tmux.sendKey') {
        typed.push(`key:${(params as { key?: string }).key ?? ''}`);
        return { sent: true };
      }
      if (method === 'tmux.capture') return { text: typed.join('\n') };
      throw new Error(`unexpected rpc ${method}`);
    }),
  } as unknown as AgentConnection;
  agents.attach(machine.id, conn);
  return conn;
}

/** The repository's real semantics in memory: the partial unique index means a second *open* row for
 * a key throws, a decided row is invisible to `findOpenByKey`, a claim only succeeds while the row is
 * still approved, and every read hands back a snapshot — never a live reference into the store. */
function fakeChatActions() {
  const rows: ChatAction[] = [];
  const isOpen = (r: ChatAction) => r.status === 'pending' || r.status === 'approved';
  const sameKey = (r: ChatAction, conversationId: string, key: string) => r.conversation_id === conversationId && r.idempotency_key === key;
  const snapshot = (r: ChatAction | undefined) => (r ? { ...r } : undefined);
  return {
    rows,
    findOpenByKey: vi.fn(async (conversationId: string, key: string) => snapshot(rows.find((r) => sameKey(r, conversationId, key) && isOpen(r)))),
    findDeniedByKey: vi.fn(async (conversationId: string, key: string) => snapshot([...rows].reverse().find((r) => sameKey(r, conversationId, key) && r.status === 'denied'))),
    claimApproved: vi.fn(async (id: string) => {
      const row = rows.find((r) => r.id === id && r.status === 'approved');
      if (!row) return false;
      row.status = 'executed'; // the claim itself, exactly as the conditional UPDATE does it
      return true;
    }),
    /** The same conditional update as the claim, landing on `expired`: only a row still approved can
     * be aged out, so a claim and an expiry of one approval can never both win. */
    expireApproved: vi.fn(async (id: string) => {
      const row = rows.find((r) => r.id === id && r.status === 'approved');
      if (!row) return false;
      row.status = 'expired';
      return true;
    }),
    /** Owner-scoped, exactly like the repository: this is how the gate asks a row which race it lost. */
    findByIdForUser: vi.fn(async (id: string, userId: string) => (userId === 'u1' ? snapshot(rows.find((r) => r.id === id)) : undefined)),
    insertPending: vi.fn(async (input: InsertPendingInput) => {
      if (rows.some((r) => sameKey(r, input.conversation_id, input.idempotency_key ?? '') && isOpen(r))) {
        throw new Error('duplicate key value violates unique constraint "chat_actions_one_open_per_key"');
      }
      const row: ChatAction = {
        id: `a${rows.length + 1}`,
        conversation_id: input.conversation_id,
        message_id: input.message_id ?? null,
        tool: input.tool,
        args: input.args,
        class: input.class,
        status: 'pending',
        idempotency_key: input.idempotency_key ?? null,
        machine_id: input.machine_id ?? null,
        project_id: input.project_id ?? null,
        tab_id: input.tab_id ?? null,
        grant_id: null,
        error_code: null,
        duration_ms: null,
        decided_by: null,
        decided_at: null,
        // Distinctive and fixed, never "now": the card's timestamp must be read off the row, and
        // publishing `new Date().toISOString()` instead would be indistinguishable from that if this
        // were the current time — the row and "now" land in the same millisecond in practically
        // every run.
        created_at: PENDING_CREATED_AT,
      };
      rows.push(row);
      return row;
    }),
    /** Same duplicate check and row shape as `insertPending`, but born `approved`, already tied to
     * the grant that answered it and to whoever granted it. */
    insertApproved: vi.fn(async (input: InsertApprovedInput) => {
      if (rows.some((r) => sameKey(r, input.conversation_id, input.idempotency_key ?? '') && isOpen(r))) {
        throw new Error('duplicate key value violates unique constraint "chat_actions_one_open_per_key"');
      }
      const row: ChatAction = {
        id: `a${rows.length + 1}`,
        conversation_id: input.conversation_id,
        message_id: input.message_id ?? null,
        tool: input.tool,
        args: input.args,
        class: input.class,
        status: 'approved',
        idempotency_key: input.idempotency_key ?? null,
        machine_id: input.machine_id ?? null,
        project_id: input.project_id ?? null,
        tab_id: input.tab_id ?? null,
        grant_id: input.grant_id,
        error_code: null,
        duration_ms: null,
        decided_by: input.decided_by,
        decided_at: new Date().toISOString(),
        created_at: PENDING_CREATED_AT,
      };
      rows.push(row);
      return row;
    }),
    markExecuted: vi.fn(async (id: string, ok: boolean, errorCode?: string | null, durationMs?: number | null) => {
      const row = rows.find((r) => r.id === id);
      if (!row) return;
      row.status = ok ? 'executed' : 'failed';
      row.error_code = errorCode ?? null;
      row.duration_ms = durationMs ?? null;
    }),
    /**
     * A row already decided on, as the chat's confirmation endpoint (or the expiry sweep) leaves it.
     * `decidedMinutesAgo` dates the decision: the gate's refusal window is measured from `decided_at`,
     * so backdating the row is how the clock is moved — no fake timers, no waiting.
     */
    seed: (status: 'approved' | 'denied' | 'expired', tool: string, args: Record<string, unknown>, decidedMinutesAgo = 0) => {
      const decidedAt = new Date(Date.now() - decidedMinutesAgo * 60 * 1000).toISOString();
      const row: ChatAction = {
        id: `a${rows.length + 1}`,
        conversation_id: CONVERSATION,
        message_id: null,
        tool,
        args,
        class: 'write',
        status,
        idempotency_key: idempotencyKeyFor(CONVERSATION, tool, args),
        machine_id: null,
        project_id: null,
        tab_id: typeof args.tab_id === 'string' ? args.tab_id : null,
        grant_id: null,
        error_code: null,
        duration_ms: null,
        decided_by: status === 'expired' ? null : 'u1',
        decided_at: status === 'expired' ? null : decidedAt,
        created_at: decidedAt,
      };
      rows.push(row);
      return row;
    },
  };
}

function fakeChatGrants() {
  const grants: { id: string; conversation_id: string; tab_id: string; tool: string; expires_at: string; revoked_at: string | null }[] = [];
  return {
    grants,
    /** A grant as the decision route leaves it; `expiresInMinutes` < 0 stages an expired one. */
    seed: (tabId: string, opts: { conversationId?: string; expiresInMinutes?: number; revoked?: boolean } = {}) => {
      const g = { id: `g${grants.length + 1}`, conversation_id: opts.conversationId ?? CONVERSATION, tab_id: tabId, tool: 'send_input', expires_at: new Date(Date.now() + (opts.expiresInMinutes ?? 60) * 60_000).toISOString(), revoked_at: opts.revoked ? new Date().toISOString() : null };
      grants.push(g);
      return g;
    },
    findActive: vi.fn(async (conversationId: string, tabId: string, tool: string) =>
      grants.find((g) => g.conversation_id === conversationId && g.tab_id === tabId && g.tool === tool && g.revoked_at === null && Date.parse(g.expires_at) > Date.now()),
    ),
  };
}

function build(opts: { gated: boolean; conversationId?: string }) {
  const tab = (id: string, name: string) => ({ id, project_id: 'p1', machine_id: 'm1', name, kind: 'terminal', tmux_session: `termhub-p1-${id}`, simulator_udid: null, position: 0, state: null, state_text: null, state_tool: null, state_at: null, state_seen_at: null, created_at: '', created_by_token_id: null });
  const tabs = new Map<string, Record<string, unknown>>([
    ['t1', tab('t1', 'Terminal 1')],
    // Somebody else's tab: it exists, so an unscoped `findById` resolves it, and the owner-scoped read
    // below does not — the difference the gate's re-validation must be built on.
    ['t9', tab('t9', 'Terminal do vizinho')],
  ]);
  const foreignTabIds = new Set(['t9']);
  const apiTokens = {
    findActiveByHash: vi.fn(async (h: string) =>
      h === hashApiToken(SECRET)
        ? { id: 'tok1', user_id: 'u1', name: 'concierge', scopes: ['read', 'terminals'], expires_at: null, revoked_at: null, last_used_at: null, created_at: '', gated: opts.gated, chat_conversation_id: opts.conversationId ?? null }
        : undefined,
    ),
    touchLastUsed: vi.fn(async () => {}),
    recordEvent: vi.fn(async () => {}),
  };
  const actions = fakeChatActions();
  const grants = fakeChatGrants();
  const chat = { getOrCreateForUser: vi.fn(async (userId: string) => ({ id: CONVERSATION, user_id: userId, cli_session_id: null, created_at: '' })) };
  const projectsRepo = {
    findById: vi.fn(async () => project),
    findByIdsForOwner: vi.fn(async (ids: string[], ownerId: string) => (ownerId === machine.owner_id && ids.includes(project.id) ? [project] : [])),
  };
  const repos = {
    apiTokens,
    chat,
    chatActions: actions,
    chatGrants: grants,
    users: { findById: vi.fn(async () => ({ id: 'u1', role_id: 'r' })) },
    machines: {
      findById: vi.fn(async () => machine),
      list: vi.fn(async () => [machine]),
      findByIdsForOwner: vi.fn(async (ids: string[], ownerId: string) => (ownerId === machine.owner_id && ids.includes(machine.id) ? [machine] : [])),
    },
    projects: projectsRepo,
    projectMachines: {
      find: vi.fn(async () => link),
      listByProject: vi.fn(async () => [link]),
    },
    tasks: { listByProject: vi.fn(async () => []), findByIdsForOwner: vi.fn(async () => []) },
    tabs: {
      listByProject: vi.fn(async () => [...tabs.values()]),
      countOpenByToken: vi.fn(async () => 0),
      findById: vi.fn(async (id: string) => tabs.get(id)),
      findByIdsForOwner: vi.fn(async (ids: string[], ownerId: string) =>
        ownerId === machine.owner_id ? [...tabs.values()].filter((t) => ids.includes(t.id as string) && !foreignTabIds.has(t.id as string)) : [],
      ),
      delete: vi.fn(async (id: string) => tabs.delete(id)),
    },
  } as unknown as Repositories;

  const app = Fastify();
  applyErrorHandler(app);
  app.register((a) => mcpRoutes(a, { repos, version: '0.0.0-test' }));
  return { app, apiTokens, actions, tabs, grants, projects: projectsRepo };
}

const callTool = (app: ReturnType<typeof Fastify>, name: string, args: object) =>
  app.inject({
    method: 'POST',
    url: '/mcp',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${SECRET}` },
    payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
  });

type Injected = Awaited<ReturnType<typeof callTool>>;
const resultOf = (res: Injected) => (res.json() as { result: { content: { text: string }[]; isError?: boolean } }).result;
const textOf = (res: Injected) => resultOf(res).content[0].text;
const payloadOf = (res: Injected) => JSON.parse(textOf(res));
/** `recordEvent` is fired and forgotten by the route; a macrotask turn is enough for it to land. */
const settle = () => new Promise((r) => setTimeout(r, 0));

const collected: Record<string, unknown>[] = [];
let unsubscribe: (() => void) | undefined;

beforeEach(() => {
  agents.reset();
  vi.mocked(canAccess).mockResolvedValue(true);
  collected.length = 0;
  unsubscribe = chatBus.subscribe((event) => collected.push(event as unknown as Record<string, unknown>));
});

afterEach(() => unsubscribe?.());

it('asks instead of acting, and says so in a way the model can act on', async () => {
  const typed: string[] = [];
  attachFakeTmux(typed);
  const { app, actions, apiTokens } = build({ gated: true });

  const res = await callTool(app, 'send_input', { tab_id: 't1', text: 'npm test' });
  expect(resultOf(res).isError).toBe(true);
  expect(textOf(res)).toMatch(/pendente de confirmação/i);
  expect(actions.insertPending).toHaveBeenCalledTimes(1);
  expect(typed).toEqual([]); // nothing was typed
  expect(actions.rows[0]).toMatchObject({ status: 'pending', tool: 'send_input', class: 'write', tab_id: 't1', args: { tab_id: 't1', text: 'npm test' } });

  // the per-call audit row is still written exactly once, with the existing shape
  await settle();
  expect(apiTokens.recordEvent).toHaveBeenCalledTimes(1);
  expect(apiTokens.recordEvent.mock.calls[0][0]).toMatchObject({ token_id: 'tok1', tool: 'send_input', tab_id: 't1', ok: false, error_code: 'CONFIRMATION_PENDING' });
  expect(JSON.stringify(apiTokens.recordEvent.mock.calls[0][0])).not.toContain('npm test');
});

it('asks in the conversation named by the token, not the account-wide one', async () => {
  const typed: string[] = [];
  attachFakeTmux(typed);
  const { app, actions } = build({ gated: true, conversationId: 'c_project' });

  const res = await callTool(app, 'send_input', { tab_id: 't1', text: 'npm test' });
  expect(resultOf(res).isError).toBe(true);
  expect(textOf(res)).toMatch(/pendente de confirmação/i);
  expect(actions.insertPending).toHaveBeenCalledWith(expect.objectContaining({ conversation_id: 'c_project' }));
});

it('does not ask twice for the same proposal', async () => {
  attachFakeTmux([]);
  const { app, actions } = build({ gated: true });

  await callTool(app, 'send_input', { tab_id: 't1', text: 'npm test' });
  const again = await callTool(app, 'send_input', { tab_id: 't1', text: 'npm test' });

  expect(resultOf(again).isError).toBe(true);
  expect(textOf(again)).toMatch(/ainda está aguardando a confirmação/i);
  expect(actions.insertPending).toHaveBeenCalledTimes(1);
  expect(actions.rows).toHaveLength(1);
});

it('asks only once when a concurrent duplicate insert loses the unique index', async () => {
  attachFakeTmux([]);
  const { app, actions } = build({ gated: true });
  await callTool(app, 'send_input', { tab_id: 't1', text: 'npm test' });
  // The racing request read the table before the first insert committed, so it still tries to
  // insert: the partial unique index rejects it, and it must answer "waiting" instead of failing.
  actions.findOpenByKey.mockResolvedValueOnce(undefined);

  const res = await callTool(app, 'send_input', { tab_id: 't1', text: 'npm test' });

  expect(resultOf(res).isError).toBe(true);
  expect(textOf(res)).toMatch(/ainda está aguardando a confirmação/i);
  expect(actions.insertPending).toHaveBeenCalledTimes(2);
  expect(actions.rows).toHaveLength(1);
});

it('executes once the row is approved, and marks it executed', async () => {
  const typed: string[] = [];
  attachFakeTmux(typed);
  const { app, actions } = build({ gated: true });
  const row = actions.seed('approved', 'send_input', { tab_id: 't1', text: 'npm test' });

  const res = await callTool(app, 'send_input', { tab_id: 't1', text: 'npm test' });

  expect(resultOf(res).isError).toBeUndefined();
  expect(payloadOf(res)).toMatchObject({ tab_id: 't1', sent: true });
  expect(typed).toEqual(['npm test']);
  expect(actions.markExecuted).toHaveBeenCalledWith(row.id, true, null, expect.any(Number));
  expect(actions.rows[0].status).toBe('executed');
  expect(actions.insertPending).not.toHaveBeenCalled();
});

it('keeps refusing right after a denial, without asking again', async () => {
  const typed: string[] = [];
  attachFakeTmux(typed);
  const { app, actions } = build({ gated: true });
  actions.seed('denied', 'send_input', { tab_id: 't1', text: 'npm test' });

  const res = await callTool(app, 'send_input', { tab_id: 't1', text: 'npm test' });

  expect(resultOf(res).isError).toBe(true);
  expect(textOf(res)).toMatch(/recusou/i);
  expect(typed).toEqual([]);
  expect(actions.insertPending).not.toHaveBeenCalled();
  expect(actions.rows).toHaveLength(1);
});

it('still refuses the identical proposal a minute after the denial', async () => {
  const typed: string[] = [];
  attachFakeTmux(typed);
  const { app, actions } = build({ gated: true });
  actions.seed('denied', 'send_input', { tab_id: 't1', text: 'npm test' }, 1);

  const res = await callTool(app, 'send_input', { tab_id: 't1', text: 'npm test' });

  expect(resultOf(res).isError).toBe(true);
  expect(textOf(res)).toMatch(/recusou/i);
  expect(typed).toEqual([]);
  expect(actions.insertPending).not.toHaveBeenCalled();
});

it('asks again once the denial is older than the window: the user may have changed their mind', async () => {
  const typed: string[] = [];
  attachFakeTmux(typed);
  const { app, actions } = build({ gated: true });
  actions.seed('denied', 'send_input', { tab_id: 't1', text: 'npm test' }, 16);

  const res = await callTool(app, 'send_input', { tab_id: 't1', text: 'npm test' });

  expect(resultOf(res).isError).toBe(true);
  expect(textOf(res)).toMatch(/pendente de confirmação/i);
  expect(typed).toEqual([]); // still nothing typed: it is a question, not an action
  expect(actions.insertPending).toHaveBeenCalledTimes(1);
  expect(actions.rows.map((r) => r.status)).toEqual(['denied', 'pending']);
  expect(collected.map((e) => e.type)).toEqual(['confirmation']);
});

it('asks a question left to expire again, because nobody ever answered it', async () => {
  const typed: string[] = [];
  attachFakeTmux(typed);
  const { app, actions } = build({ gated: true });
  actions.seed('expired', 'send_input', { tab_id: 't1', text: 'npm test' }, 60 * 25);

  const res = await callTool(app, 'send_input', { tab_id: 't1', text: 'npm test' });

  expect(resultOf(res).isError).toBe(true);
  expect(textOf(res)).toMatch(/pendente de confirmação/i);
  expect(typed).toEqual([]);
  expect(actions.insertPending).toHaveBeenCalledTimes(1);
  expect(actions.rows.map((r) => r.status)).toEqual(['expired', 'pending']);
  expect(collected.map((e) => e.type)).toEqual(['confirmation']);
});

it('re-validates the tab before executing an approved action', async () => {
  const typed: string[] = [];
  attachFakeTmux(typed);
  const { app, actions, tabs } = build({ gated: true });
  const row = actions.seed('approved', 'send_input', { tab_id: 't1', text: 'npm test' });
  tabs.delete('t1'); // the tab was killed while the question waited

  const res = await callTool(app, 'send_input', { tab_id: 't1', text: 'npm test' });

  expect(resultOf(res).isError).toBe(true);
  expect(textOf(res)).toContain('t1');
  expect(typed).toEqual([]);
  expect(actions.markExecuted).toHaveBeenCalledWith(row.id, false, 'TAB_GONE', expect.any(Number));
  expect(actions.rows[0].status).toBe('failed');
});

it('refuses an approved keystroke into a tab that is now waiting for a permission', async () => {
  const typed: string[] = [];
  attachFakeTmux(typed);
  const { app, actions, tabs } = build({ gated: true });
  const row = actions.seed('approved', 'send_input', { tab_id: 't1', text: 'npm test' });
  tabs.set('t1', { ...tabs.get('t1')!, state: 'waiting_permission', state_text: 'Allow edit?' });

  const res = await callTool(app, 'send_input', { tab_id: 't1', text: 'npm test' });

  expect(resultOf(res).isError).toBe(true);
  expect(typed).toEqual([]);
  expect(actions.markExecuted).toHaveBeenCalledWith(row.id, false, 'WAITING_PERMISSION', expect.any(Number));
  expect(actions.rows[0].status).toBe('failed');
});

it('types once when two identical calls both read the same approved row', async () => {
  const typed: string[] = [];
  attachFakeTmux(typed);
  const { app, actions } = build({ gated: true });
  const row = actions.seed('approved', 'send_input', { tab_id: 't1', text: 'npm test' });
  // Both arrivals read the row while it was still approved — a client that issues the call twice in
  // parallel, or a re-injection delivered twice. Only the claim can keep the second one from typing.
  actions.findOpenByKey.mockResolvedValue({ ...row });

  const first = await callTool(app, 'send_input', { tab_id: 't1', text: 'npm test' });
  const second = await callTool(app, 'send_input', { tab_id: 't1', text: 'npm test' });

  expect(resultOf(first).isError).toBeUndefined();
  expect(typed).toEqual(['npm test']); // one approval, one command
  expect(resultOf(second).isError).toBe(true);
  expect(textOf(second)).toMatch(/já está executando esta ação/i);
  // The loser asked the row which race it lost: it is `executed`, so "wait for the first call" is the
  // truth. It must not read as an expiry — there is a result coming.
  expect(textOf(second)).not.toMatch(/expirou/i);
  expect(actions.claimApproved).toHaveBeenCalledTimes(2);
  expect(actions.markExecuted).toHaveBeenCalledTimes(1);
});

it('says the approval expired, not that another call is running, when the sweep took the row', async () => {
  const typed: string[] = [];
  attachFakeTmux(typed);
  const { app, actions } = build({ gated: true });
  const row = actions.seed('approved', 'send_input', { tab_id: 't1', text: 'npm test' });
  // The gate read the row while it was still approved, and the hourly sweep retired it before the claim
  // landed. The claim loses either way — but here nobody is executing anything, so telling the model to
  // wait for another call's result would leave it waiting for a result that never comes: the user would
  // see nothing happen and never be asked again.
  actions.claimApproved.mockImplementationOnce(async () => {
    row.status = 'expired';
    return false;
  });

  const res = await callTool(app, 'send_input', { tab_id: 't1', text: 'npm test' });

  expect(resultOf(res).isError).toBe(true);
  expect(textOf(res)).toMatch(/expirou/i);
  expect(textOf(res)).not.toMatch(/já está executando/i);
  expect(typed).toEqual([]);
  expect(actions.markExecuted).not.toHaveBeenCalled(); // the row is the sweep's now, not this call's
  expect(actions.rows[0].status).toBe('expired');
});

it('answers the permission the user saw, and refuses one asked after it', async () => {
  const typed: string[] = [];
  attachFakeTmux(typed);
  const { app, actions, tabs } = build({ gated: true });
  const args = { tab_id: 't1', key: 'Enter' };
  const stale = actions.seed('approved', 'send_key', args, 40);
  // The prompt the user confirmed was answered, and another one appeared while the approval waited:
  // `state_at` is newer than the question, so pressing Enter now would accept something unseen.
  tabs.set('t1', { ...tabs.get('t1')!, state: 'waiting_permission', state_text: 'Allow rm -rf?', state_at: new Date().toISOString() });

  const res = await callTool(app, 'send_key', args);

  expect(resultOf(res).isError).toBe(true);
  expect(textOf(res)).toMatch(/outra permissão/i);
  expect(typed).toEqual([]);
  expect(actions.markExecuted).toHaveBeenCalledWith(stale.id, false, 'PROMPT_CHANGED', expect.any(Number));
  expect(actions.rows[0].status).toBe('failed');
});

it('still answers a permission that was already on screen when the user confirmed', async () => {
  const typed: string[] = [];
  attachFakeTmux(typed);
  const { app, actions, tabs } = build({ gated: true });
  const args = { tab_id: 't1', key: 'Enter' };
  const row = actions.seed('approved', 'send_key', args);
  tabs.set('t1', { ...tabs.get('t1')!, state: 'waiting_permission', state_text: 'Allow edit?', state_at: new Date(Date.now() - 10 * 60 * 1000).toISOString() });

  const res = await callTool(app, 'send_key', args);

  expect(resultOf(res).isError).toBeUndefined();
  expect(typed).toEqual(['key:Enter']); // the exemption itself still stands
  expect(actions.markExecuted).toHaveBeenCalledWith(row.id, true, null, expect.any(Number));
});

it('asks before an irreversible action too, and kills nothing meanwhile', async () => {
  const typed: string[] = [];
  const conn = attachFakeTmux(typed);
  const { app, actions } = build({ gated: true });

  const res = await callTool(app, 'close_tab', { tab_id: 't1' });

  expect(resultOf(res).isError).toBe(true);
  expect(textOf(res)).toMatch(/pendente de confirmação/i);
  expect(actions.rows[0]).toMatchObject({ tool: 'close_tab', class: 'irreversible', status: 'pending', tab_id: 't1' });
  expect(conn.rpc).not.toHaveBeenCalled();
  expect(collected.map((e) => e.class)).toEqual(['irreversible']);
});

it('refuses a tool it does not know before the gate is ever reached', async () => {
  attachFakeTmux([]);
  const { app, actions, apiTokens } = build({ gated: true });

  // The route's allowlist answers an unknown name itself, so `actionClass`'s irreversible default for
  // one is a second line of defence, never the first: no proposal is recorded and nothing is asked.
  const res = await callTool(app, 'drop_everything', { tab_id: 't1' });

  expect(resultOf(res).isError).toBe(true);
  expect(textOf(res)).toMatch(/desconhecida/i);
  expect(actions.insertPending).not.toHaveBeenCalled();
  expect(collected).toEqual([]);
  await settle();
  expect(apiTokens.recordEvent.mock.calls[0][0]).toMatchObject({ tool: 'drop_everything', ok: false, error_code: 'TOOL_NOT_ALLOWED' });
});

it('fails closed when the actions table cannot be read', async () => {
  const typed: string[] = [];
  attachFakeTmux(typed);
  const { app, actions } = build({ gated: true });
  actions.findOpenByKey.mockRejectedValueOnce(new Error('connection terminated'));

  const res = await callTool(app, 'send_input', { tab_id: 't1', text: 'npm test' });

  // A gate that cannot read its own table must not let the write through.
  expect(resultOf(res).isError).toBe(true);
  expect(typed).toEqual([]);
  expect(actions.insertPending).not.toHaveBeenCalled();
});

it('does not carry the proposal in the error when the proposal cannot be recorded', async () => {
  const typed: string[] = [];
  attachFakeTmux(typed);
  const { app, actions } = build({ gated: true });
  // A rejected write carries the rejected data; whatever comes out of the gate must not.
  actions.insertPending.mockRejectedValueOnce(new Error('null value in column "args" violates ... { text: "npm test" }'));

  const res = await callTool(app, 'send_input', { tab_id: 't1', text: 'npm test' });

  expect(resultOf(res).isError).toBe(true);
  expect(textOf(res)).not.toContain('npm test');
  expect(textOf(res)).toMatch(/registrar esta ação/i);
  expect(typed).toEqual([]);
});

it("lets a person's own token through untouched", async () => {
  const typed: string[] = [];
  attachFakeTmux(typed);
  const { app, actions } = build({ gated: false });

  const res = await callTool(app, 'send_input', { tab_id: 't1', text: 'npm test' });

  expect(resultOf(res).isError).toBeUndefined();
  expect(typed).toEqual(['npm test']);
  expect(actions.insertPending).not.toHaveBeenCalled();
  expect(actions.findOpenByKey).not.toHaveBeenCalled();
  expect(collected).toEqual([]);
});

it('never gates a read', async () => {
  attachFakeTmux(['npm test']);
  const { app, actions } = build({ gated: true });

  const res = await callTool(app, 'read_screen', { tab_id: 't1', lines: 10 });

  expect(resultOf(res).isError).toBeUndefined();
  expect(payloadOf(res).text).toContain('npm test');
  expect(actions.insertPending).not.toHaveBeenCalled();
  expect(actions.findOpenByKey).not.toHaveBeenCalled();
});

it('publishes the question to the chat, with the arguments and no terminal content', async () => {
  attachFakeTmux(['segredo na tela']);
  const { app, actions } = build({ gated: true });

  await callTool(app, 'send_input', { tab_id: 't1', text: 'npm test' });

  expect(collected).toHaveLength(1);
  expect(Object.keys(collected[0]).sort()).toEqual(['action_id', 'args', 'class', 'conversation_id', 'created_at', 'machine_id', 'project_id', 'summary', 'tab_id', 'tool', 'type', 'user_id']);
  expect(collected[0]).toEqual({
    type: 'confirmation',
    user_id: 'u1',
    conversation_id: actions.rows[0].conversation_id,
    action_id: actions.rows[0].id,
    tool: 'send_input',
    args: { tab_id: 't1', text: 'npm test' },
    class: 'write',
    machine_id: null,
    project_id: null,
    tab_id: 't1',
    // Enriched through the tab: t1 belongs to project "app" on machine "jarvis" (this test's fixtures).
    summary: 'digitar `npm test` na aba Terminal 1 do projeto app, no jarvis',
    created_at: actions.rows[0].created_at,
  });
  expect(JSON.stringify(collected[0])).not.toContain('segredo na tela');
});

it('stops honouring an approval nobody consumed for a day, and asks again instead of executing', async () => {
  const typed: string[] = [];
  attachFakeTmux(typed);
  const { app, actions } = build({ gated: true });
  // The "yes" is a day old: no call ever came back to use it (the run died, the session was dropped,
  // the model moved on). Without the clock, this byte-identical proposal would claim it and type.
  actions.seed('approved', 'send_input', { tab_id: 't1', text: 'npm test' }, 60 * 25);

  const res = await callTool(app, 'send_input', { tab_id: 't1', text: 'npm test' });

  expect(resultOf(res).isError).toBe(true);
  expect(typed).toEqual([]); // nothing ran on the machine
  expect(textOf(res)).toMatch(/expirou/i);
  expect(textOf(res)).not.toMatch(/recusou/i); // an approval that lapsed is not a "no"
  expect(actions.claimApproved).not.toHaveBeenCalled();
  expect(actions.rows[0].status).toBe('expired');
  expect(collected).toEqual([]); // no question either: this call only retired the dead approval

  // And "propose it again" is now something the model can actually do: the retired row no longer
  // occupies the key, so the identical call asks the user instead of finding the same dead approval.
  const again = await callTool(app, 'send_input', { tab_id: 't1', text: 'npm test' });
  expect(textOf(again)).toMatch(/pendente de confirmação/i);
  expect(actions.rows.map((r) => r.status)).toEqual(['expired', 'pending']);
  expect(typed).toEqual([]);
  expect(collected.map((e) => e.type)).toEqual(['confirmation']);
});

it('still executes an approval given hours ago, inside the window', async () => {
  const typed: string[] = [];
  attachFakeTmux(typed);
  const { app, actions } = build({ gated: true });
  const row = actions.seed('approved', 'send_input', { tab_id: 't1', text: 'npm test' }, 60 * 23);

  const res = await callTool(app, 'send_input', { tab_id: 't1', text: 'npm test' });

  expect(resultOf(res).isError).toBeUndefined();
  expect(typed).toEqual(['npm test']);
  expect(actions.markExecuted).toHaveBeenCalledWith(row.id, true, null, expect.any(Number));
  expect(actions.expireApproved).not.toHaveBeenCalled();
});

it('fails an approved action the machine cannot do, and never puts the row back to pending', async () => {
  // Ruling R2: an offline machine, an agent too old, any failure at all ends as a `failed` row
  // carrying the real error code, and the error reaches the model. Never back to `pending`, and never
  // a new question — asking again for what the machine cannot do is a loop with no exit.
  const { app, actions, apiTokens } = build({ gated: true }); // no agent attached: the machine is offline
  const row = actions.seed('approved', 'send_input', { tab_id: 't1', text: 'npm test' });

  const res = await callTool(app, 'send_input', { tab_id: 't1', text: 'npm test' });

  expect(resultOf(res).isError).toBe(true);
  expect(textOf(res)).toMatch(/offline/i); // the machine's own failure, as any ungated call would get it
  expect(actions.markExecuted).toHaveBeenCalledWith(row.id, false, 'MACHINE_OFFLINE', expect.any(Number));
  expect(actions.rows[0]).toMatchObject({ status: 'failed', error_code: 'MACHINE_OFFLINE' });
  expect(actions.insertPending).not.toHaveBeenCalled();
  expect(collected).toEqual([]);
  // The error reached the caller, which is what the per-call audit row records.
  await settle();
  expect(apiTokens.recordEvent.mock.calls[0][0]).toMatchObject({ tool: 'send_input', ok: false, error_code: 'MACHINE_OFFLINE' });
});

it('fails an approved action an outdated agent cannot run, with that error code', async () => {
  const typed: string[] = [];
  attachFakeTmux(typed, '0.0.1'); // older than the terminal RPCs
  const { app, actions } = build({ gated: true });
  const row = actions.seed('approved', 'send_input', { tab_id: 't1', text: 'npm test' });

  const res = await callTool(app, 'send_input', { tab_id: 't1', text: 'npm test' });

  expect(resultOf(res).isError).toBe(true);
  expect(typed).toEqual([]);
  expect(actions.markExecuted).toHaveBeenCalledWith(row.id, false, 'AGENT_OUTDATED', expect.any(Number));
  expect(actions.rows[0]).toMatchObject({ status: 'failed', error_code: 'AGENT_OUTDATED' });
  expect(actions.insertPending).not.toHaveBeenCalled();
});

it("never resolves another user's tab when re-validating an approval", async () => {
  const typed: string[] = [];
  attachFakeTmux(typed);
  const { app, actions } = build({ gated: true });
  // `t9` exists, and belongs to somebody else. The re-validation must read it through the
  // owner-scoped batch, so it is simply absent — the model learns `TAB_GONE`, not that the tab exists
  // (which the tool's own "not found" further down would have told it).
  const row = actions.seed('approved', 'send_input', { tab_id: 't9', text: 'npm test' });

  const res = await callTool(app, 'send_input', { tab_id: 't9', text: 'npm test' });

  expect(resultOf(res).isError).toBe(true);
  expect(textOf(res)).toContain('t9');
  expect(typed).toEqual([]);
  expect(actions.markExecuted).toHaveBeenCalledWith(row.id, false, 'TAB_GONE', expect.any(Number));
  expect(actions.rows[0].status).toBe('failed');
});

it('types at once into a trusted tab, and leaves an executed audit row tied to the grant', async () => {
  const typed: string[] = [];
  attachFakeTmux(typed);
  const { app, actions, grants } = build({ gated: true });
  const g = grants.seed('t1');

  const res = await callTool(app, 'send_input', { tab_id: 't1', text: 'sim, pode seguir' });
  expect(resultOf(res).isError).toBeFalsy();
  expect(typed).toContain('sim, pode seguir');
  expect(actions.insertPending).not.toHaveBeenCalled();
  expect(actions.rows).toHaveLength(1);
  expect(actions.rows[0]).toMatchObject({ status: 'executed', grant_id: g.id, decided_by: 'u1', tab_id: 't1' });
  const live = collected.find((e) => e.type === 'granted_action') as { action: { status: string; grant_id: string; summary: string } } | undefined;
  expect(live?.action).toMatchObject({ status: 'executed', grant_id: g.id });
  expect(collected.some((e) => e.type === 'confirmation')).toBe(false);
});

it.each([
  ['answering a permission', 'send_input', { tab_id: 't1', text: '1', answering_permission: true }],
  ['run_command', 'run_command', { tab_id: 't1', command: 'ls' }],
  ['send_key', 'send_key', { tab_id: 't1', key: 'Enter' }],
])('still asks for %s on a trusted tab', async (_label, tool, args) => {
  const typed: string[] = [];
  attachFakeTmux(typed);
  const { app, actions, grants } = build({ gated: true });
  grants.seed('t1');
  const res = await callTool(app, tool, args);
  expect(textOf(res)).toMatch(/pendente de confirmação/i);
  expect(actions.insertPending).toHaveBeenCalledTimes(1);
  expect(typed).toEqual([]);
});

it.each([
  ['another tab', () => ({ tabId: 't2' })],
  ['another conversation', () => ({ tabId: 't1', conversationId: 'c_other' })],
  ['an expired grant', () => ({ tabId: 't1', expiresInMinutes: -1 })],
  ['a revoked grant', () => ({ tabId: 't1', revoked: true })],
])('asks when the only grant is for %s', async (_label, grantOf) => {
  const typed: string[] = [];
  attachFakeTmux(typed);
  const { app, actions, grants } = build({ gated: true });
  const { tabId, ...opts } = grantOf();
  grants.seed(tabId, opts);
  const res = await callTool(app, 'send_input', { tab_id: 't1', text: 'oi' });
  expect(textOf(res)).toMatch(/pendente de confirmação/i);
  expect(actions.insertPending).toHaveBeenCalledTimes(1);
  expect(typed).toEqual([]);
});

it('a recent "no" to the same text beats the grant', async () => {
  const typed: string[] = [];
  attachFakeTmux(typed);
  const { app, actions, apiTokens, grants } = build({ gated: true });
  grants.seed('t1');
  actions.seed('denied', 'send_input', { tab_id: 't1', text: 'rm -rf' }, 1);
  const res = await callTool(app, 'send_input', { tab_id: 't1', text: 'rm -rf' });
  expect(resultOf(res).isError).toBe(true);
  expect(textOf(res)).toMatch(/recusou/i);
  expect(typed).toEqual([]);
  expect(actions.insertApproved).not.toHaveBeenCalled();
  // The denial itself decided this, without ever consulting the grant: `applyGate` only looks at
  // `chatGrants` from the branch that would otherwise ask, which a denial in force never reaches.
  expect(grants.findActive).not.toHaveBeenCalled();
  await settle();
  expect(apiTokens.recordEvent.mock.calls[0][0]).toMatchObject({ tool: 'send_input', tab_id: 't1', ok: false, error_code: 'CONFIRMATION_DENIED' });
});

it('a trusted tab that is waiting on a permission types nothing and records WAITING_PERMISSION', async () => {
  const typed: string[] = [];
  attachFakeTmux(typed);
  const { app, actions, grants, tabs } = build({ gated: true });
  const g = grants.seed('t1');
  Object.assign(tabs.get('t1')!, { state: 'waiting_permission', state_at: new Date().toISOString() });
  const res = await callTool(app, 'send_input', { tab_id: 't1', text: 'oi' });
  expect(resultOf(res).isError).toBe(true);
  expect(typed).toEqual([]);
  expect(actions.rows[0]).toMatchObject({ status: 'failed', error_code: 'WAITING_PERMISSION' });
  expect(collected.some((e) => e.type === 'confirmation')).toBe(false);
  // A failed grant run still tells the trail live — the card just reads as failed, not as pending.
  const live = collected.find((e) => e.type === 'granted_action') as { action: { status: string; grant_id: string } } | undefined;
  expect(live?.action).toMatchObject({ status: 'failed', grant_id: g.id });
});

it('a trusted tab that no longer exists records TAB_GONE', async () => {
  const typed: string[] = [];
  attachFakeTmux(typed);
  const { app, actions, grants, tabs } = build({ gated: true });
  const g = grants.seed('t1');
  tabs.delete('t1');
  const res = await callTool(app, 'send_input', { tab_id: 't1', text: 'oi' });
  expect(resultOf(res).isError).toBe(true);
  expect(typed).toEqual([]);
  expect(actions.rows[0]).toMatchObject({ status: 'failed', error_code: 'TAB_GONE' });
  const live = collected.find((e) => e.type === 'granted_action') as { action: { status: string; grant_id: string } } | undefined;
  expect(live?.action).toMatchObject({ status: 'failed', grant_id: g.id });
});

it('a grant on a foreign tab is TAB_GONE, never the foreign tab\'s own name', async () => {
  // The tab exists (t9, "Terminal do vizinho"), but belongs to someone else. The re-validation the
  // grant path shares with an approved row must read it through the owner-scoped batch, exactly as
  // "never resolves another user's tab when re-validating an approval" proves for that other path.
  const typed: string[] = [];
  attachFakeTmux(typed);
  const { app, actions, grants } = build({ gated: true });
  const g = grants.seed('t9');

  const res = await callTool(app, 'send_input', { tab_id: 't9', text: 'oi' });

  expect(resultOf(res).isError).toBe(true);
  expect(typed).toEqual([]);
  expect(actions.rows[0]).toMatchObject({ status: 'failed', error_code: 'TAB_GONE', grant_id: g.id });
  expect(textOf(res)).not.toContain('Terminal do vizinho');
  const live = collected.find((e) => e.type === 'granted_action') as { action: { status: string; summary: string } } | undefined;
  expect(live?.action.status).toBe('failed');
  expect(live?.action.summary).not.toContain('Terminal do vizinho');
});

it('an open confirmation for the same call wins over an active grant', async () => {
  // The gate decides from the open row before it ever looks at a grant (`applyGate` only consults
  // `chatGrants` in the branch reached when there is no row at all): a question already on screen for
  // this exact proposal must keep being "wait", not suddenly execute because a grant showed up between
  // the ask and the reply.
  const typed: string[] = [];
  attachFakeTmux(typed);
  const { app, actions, grants } = build({ gated: true });
  await callTool(app, 'send_input', { tab_id: 't1', text: 'oi' }); // opens a pending row, no grant yet
  expect(actions.rows).toHaveLength(1);
  grants.seed('t1');
  grants.findActive.mockClear(); // only this call's own use of the grant matters from here on

  const res = await callTool(app, 'send_input', { tab_id: 't1', text: 'oi' });

  expect(resultOf(res).isError).toBe(true);
  expect(textOf(res)).toMatch(/ainda está aguardando a confirmação/i);
  expect(actions.insertApproved).not.toHaveBeenCalled();
  expect(grants.findActive).not.toHaveBeenCalled();
  expect(typed).toEqual([]);
  expect(actions.rows).toHaveLength(1); // still just the one pending row
});

it('grant → direct send → revoke → asks again', async () => {
  const typed: string[] = [];
  attachFakeTmux(typed);
  const { app, actions, grants } = build({ gated: true });
  const g = grants.seed('t1');
  await callTool(app, 'send_input', { tab_id: 't1', text: 'primeira' });
  expect(typed).toContain('primeira');
  g.revoked_at = new Date().toISOString();
  const res = await callTool(app, 'send_input', { tab_id: 't1', text: 'segunda' });
  expect(textOf(res)).toMatch(/pendente de confirmação/i);
  expect(typed).not.toContain('segunda');
  expect(actions.rows.map((r) => r.status)).toEqual(['executed', 'pending']);
});

it("a person's own token never looks at grants", async () => {
  const typed: string[] = [];
  attachFakeTmux(typed);
  const { app, grants } = build({ gated: false });
  await callTool(app, 'send_input', { tab_id: 't1', text: 'oi' });
  expect(grants.findActive).not.toHaveBeenCalled();
});

// Fix round 1 (TER-4): `executeGranted`'s own insert can fail two different ways, and its live-trail
// publish must never turn an already-executed keystroke into a different outcome.

it('answers ACTION_NOT_RECORDED and types nothing when the grant insert fails outright', async () => {
  const typed: string[] = [];
  attachFakeTmux(typed);
  const { app, actions, grants } = build({ gated: true });
  grants.seed('t1');
  // A rejected write carries the rejected data; whatever comes out of the gate must not.
  actions.insertApproved.mockRejectedValueOnce(new Error('null value in column "args" violates ... { text: "comando secreto" }'));

  const res = await callTool(app, 'send_input', { tab_id: 't1', text: 'comando secreto' });

  expect(resultOf(res).isError).toBe(true);
  expect(textOf(res)).toMatch(/registrar esta ação/i);
  expect(textOf(res)).not.toContain('comando secreto');
  expect(typed).toEqual([]);
  expect(actions.rows).toHaveLength(0);
});

it('answers that a concurrent call already owns it when the grant insert loses the unique index', async () => {
  const typed: string[] = [];
  attachFakeTmux(typed);
  const { app, actions, grants } = build({ gated: true });
  grants.seed('t1');
  actions.insertApproved.mockRejectedValueOnce(new Error('duplicate key value violates unique constraint "chat_actions_one_open_per_key"'));
  // The gate's own first check (before it ever tries to insert) sees nothing yet; by the time
  // `executeGranted` re-checks after the failed insert, the winning call's row already occupies the key.
  actions.findOpenByKey.mockImplementationOnce(async () => undefined);
  actions.findOpenByKey.mockImplementationOnce(async () => ({ id: 'a-winner' }) as never);

  const res = await callTool(app, 'send_input', { tab_id: 't1', text: 'oi' });

  expect(resultOf(res).isError).toBe(true);
  expect(textOf(res)).toMatch(/já está executando esta ação/i);
  expect(typed).toEqual([]);
  expect(actions.rows).toHaveLength(0); // nothing of this call's own was ever recorded
});

it('still succeeds, typing exactly once, when telling the trail live fails after a granted run', async () => {
  const typed: string[] = [];
  attachFakeTmux(typed);
  const { app, actions, grants, projects } = build({ gated: true });
  grants.seed('t1');
  // Forces the enrichment inside the post-execution publish step to throw — after `execute()`'s own
  // `staleApproval` read (which only touches `tabs`) already succeeded and the keystroke already ran.
  projects.findByIdsForOwner.mockRejectedValueOnce(new Error('connection terminated'));

  const res = await callTool(app, 'send_input', { tab_id: 't1', text: 'oi' });

  expect(resultOf(res).isError).toBeFalsy();
  expect(typed).toEqual(['oi']); // exactly once: a retry must not be provoked by the publish failure
  expect(actions.rows).toHaveLength(1);
  expect(actions.rows[0].status).toBe('executed');
  expect(collected.some((e) => e.type === 'granted_action')).toBe(false); // best-effort: swallowed
});
