import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../auth/permissions.js', async (orig) => ({ ...(await orig<typeof import('../auth/permissions.js')>()), canAccess: vi.fn() }));
vi.mock('../control/inventory.js', async (orig) => ({ ...(await orig<typeof import('../control/inventory.js')>()), listMachines: vi.fn() }));
vi.mock('../control/screen.js', async (orig) => ({ ...(await orig<typeof import('../control/screen.js')>()), readScreen: vi.fn() }));
vi.mock('../control/terminals.js', async (orig) => ({ ...(await orig<typeof import('../control/terminals.js')>()), sendInput: vi.fn() }));
vi.mock('../control/tasks.js', async (orig) => ({ ...(await orig<typeof import('../control/tasks.js')>()), createTask: vi.fn(), deleteTask: vi.fn() }));
vi.mock('../control/agents.js', async (orig) => ({ ...(await orig<typeof import('../control/agents.js')>()), startAgent: vi.fn() }));
vi.mock('../control/integrations.js', async (orig) => ({ ...(await orig<typeof import('../control/integrations.js')>()), createIntegration: vi.fn() }));
vi.mock('../control/memory.js', async (orig) => ({ ...(await orig<typeof import('../control/memory.js')>()), searchMemory: vi.fn() }));
vi.mock('../chat/attachments/read-tool.js', async (orig) => ({ ...(await orig<typeof import('../chat/attachments/read-tool.js')>()), readAttachment: vi.fn() }));

import { canAccess } from '../auth/permissions.js';
import { listMachines } from '../control/inventory.js';
import { readScreen } from '../control/screen.js';
import { sendInput } from '../control/terminals.js';
import { createTask, deleteTask } from '../control/tasks.js';
import { startAgent } from '../control/agents.js';
import { readAttachment } from '../chat/attachments/read-tool.js';
import { searchMemory } from '../control/memory.js';
import { createIntegration } from '../control/integrations.js';
import type { AttachmentStore } from '../chat/attachments/store.js';
import { ControlError } from '../control/context.js';
import type { Repositories } from '../db/repositories/index.js';
import type { ApiToken } from '../db/repositories/api-tokens.js';
import { applyErrorHandler } from '../lib/errors.js';
import { hashApiToken } from '../auth/api-tokens.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { mcpRoutes } from './route.js';
import { TokenRateLimiter } from './rate-limit.js';
import { TOOLS, type ToolDef } from './tools.js';
import { z } from 'zod';

const SECRET = 'thb_pat_' + 'A'.repeat(43);
const token = (over: Partial<ApiToken> = {}): ApiToken => ({ id: 'tok1', user_id: 'u1', name: 'jarvis', scopes: ['read'], expires_at: null, last_used_at: null, revoked_at: null, created_at: '', ...over });

function build(opts: { token?: ApiToken | undefined; grants?: string[]; limiter?: TokenRateLimiter; attachments?: AttachmentStore; tabs?: { id: string; project_id: string }[] } = {}) {
  const app = Fastify();
  applyErrorHandler(app);
  const active = 'token' in opts ? opts.token : token();
  const apiTokens = {
    findActiveByHash: vi.fn(async (hash: string) => (hash === hashApiToken(SECRET) ? active : undefined)),
    touchLastUsed: vi.fn(async () => {}),
    recordEvent: vi.fn(async () => {}),
  };
  const tabs = { findById: vi.fn(async (id: string) => opts.tabs?.find((t) => t.id === id)) };
  const repos = { apiTokens, tabs, users: { findById: vi.fn(async (id: string) => (id === 'u1' ? { id: 'u1', role_id: 'r' } : undefined)) } } as unknown as Repositories;
  const grants = opts.grants ?? ['machines:read', 'projects:read', 'terminals:read'];
  vi.mocked(canAccess).mockImplementation(async (_r, _u, resource, action) => grants.includes(`${resource}:${action}`));
  app.register((a) => mcpRoutes(a, { repos, version: '0.0.0-test', limiter: opts.limiter, attachments: opts.attachments }));
  return { app, apiTokens };
}

const rpc = (app: ReturnType<typeof Fastify>, body: unknown, auth: string | null = `Bearer ${SECRET}`) =>
  app.inject({
    method: 'POST',
    url: '/mcp',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(auth ? { authorization: auth } : {}) },
    payload: body as object,
  });
const call = (name: string, args: object = {}) => ({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } });
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.mocked(listMachines).mockResolvedValue({ machines: [{ id: 'm1', name: 'MacBook Pro M4', type: 'agent', os: 'macos', online: true, capabilities: [] }] });
  vi.mocked(readScreen).mockReset();
  vi.mocked(listMachines).mockClear();
});

describe('POST /mcp auth', () => {
  it.each([
    ['no header', null],
    ['not bearer', `Basic ${SECRET}`],
    ['malformed token', 'Bearer thb_pat_short'],
    ['unknown token', `Bearer thb_pat_${'B'.repeat(43)}`],
  ])('answers the same 401 for %s', async (_n, auth) => {
    const { app } = build();
    const r = await rpc(app, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, auth);
    expect(r.statusCode).toBe(401);
    expect(r.json()).toEqual({ error: 'Não autenticado', code: 'UNAUTHORIZED' });
  });

  it('401s a token that the repository no longer returns (revoked/expired)', async () => {
    const { app } = build({ token: undefined });
    expect((await rpc(app, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).statusCode).toBe(401);
  });

  it('refuses GET and DELETE with 405', async () => {
    const { app } = build();
    for (const method of ['GET', 'DELETE'] as const) {
      const r = await app.inject({ method, url: '/mcp', headers: { authorization: `Bearer ${SECRET}` } });
      expect(r.statusCode).toBe(405);
      expect(r.headers.allow).toBe('POST');
    }
  });
});

describe('POST /mcp tools', () => {
  it('initializes and lists only the tools the token scopes and user grants allow', async () => {
    const { app, apiTokens } = build();
    const init = await rpc(app, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    expect(init.statusCode).toBe(200);
    expect(init.json().result.serverInfo.name).toBe('termhub');

    const list = await rpc(app, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const names = list.json().result.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual(['find', 'get_project_setup', 'list_machines', 'list_project_groups', 'list_projects', 'list_tab_questions', 'list_tabs', 'read_last_answer', 'read_screen', 'recap_pending_cards', 'wait_for_state']);
    await flush();
    expect(apiTokens.touchLastUsed).toHaveBeenCalledWith('tok1');
  });

  it('shows nothing to a token without the read scope', async () => {
    const { app } = build({ token: token({ scopes: ['tasks'] }) });
    const list = await rpc(app, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(list.json().result.tools).toEqual([]);
  });

  it('calls a tool, returns JSON text, and records one metadata-only audit row', async () => {
    const { app, apiTokens } = build();
    const r = await rpc(app, call('list_machines'));
    const res = r.json().result;
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(res.content[0].text).machines[0].name).toBe('MacBook Pro M4');
    await flush();
    expect(apiTokens.recordEvent).toHaveBeenCalledTimes(1);
    expect(apiTokens.recordEvent.mock.calls[0][0]).toMatchObject({ token_id: 'tok1', tool: 'list_machines', ok: true, error_code: null });
  });

  it('returns expected failures as tool errors with the pt-BR message, and audits the code without content', async () => {
    const { app, apiTokens } = build();
    vi.mocked(readScreen).mockRejectedValue(new ControlError('MACHINE_OFFLINE', 'A máquina está offline'));
    const r = await rpc(app, call('read_screen', { tab_id: 't1' }));
    const res = r.json().result;
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe('A máquina está offline');
    await flush();
    expect(apiTokens.recordEvent.mock.calls[0][0]).toMatchObject({ tool: 'read_screen', tab_id: 't1', ok: false, error_code: 'MACHINE_OFFLINE' });
  });

  it('never leaks unexpected errors or screen text into the audit', async () => {
    const { app, apiTokens } = build();
    vi.mocked(readScreen).mockResolvedValue({ tab_id: 't1', lines: 200, text: 'SECRET-SCREEN' });
    await rpc(app, call('read_screen', { tab_id: 't1' }));
    vi.mocked(readScreen).mockRejectedValue(new Error('pg: connection refused at 10.0.0.1'));
    const r = await rpc(app, call('read_screen', { tab_id: 't1' }));
    expect(r.json().result.content[0].text).toBe('Erro interno ao executar a ferramenta');
    await flush();
    expect(JSON.stringify(apiTokens.recordEvent.mock.calls)).not.toMatch(/SECRET-SCREEN|10\.0\.0\.1/);
  });

  it('refuses a tool outside the token\'s allowed set as a pt-BR tool error', async () => {
    const { app } = build({ grants: ['machines:read'] });
    const r = await rpc(app, call('read_screen', { tab_id: 't1' }));
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({
      jsonrpc: '2.0',
      id: 2,
      result: { content: [{ type: 'text', text: 'Este token não pode usar a ferramenta read_screen: ela precisa do escopo `read` e da permissão terminals:read na sua role' }], isError: true },
    });
    expect(readScreen).not.toHaveBeenCalled();
  });

  it('refuses a tool the token scope does not cover the same way', async () => {
    const { app } = build({ token: token({ scopes: ['tasks'] }) });
    const r = await rpc(app, call('list_machines'));
    expect(r.json().result).toEqual({ content: [{ type: 'text', text: 'Este token não pode usar a ferramenta list_machines: ela precisa do escopo `read` e da permissão machines:read na sua role' }], isError: true });
    expect(listMachines).not.toHaveBeenCalled();
  });

  it('refuses an unknown tool name as a pt-BR tool error, truncating the name', async () => {
    const { app } = build();
    const r = await rpc(app, { jsonrpc: '2.0', id: 'abc', method: 'tools/call', params: { name: 'y'.repeat(200), arguments: {} } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ jsonrpc: '2.0', id: 'abc', result: { content: [{ type: 'text', text: `Ferramenta desconhecida: ${'y'.repeat(64)}` }], isError: true } });
  });

  it('offers find to a user who can read only projects', async () => {
    const { app } = build({ grants: ['projects:read'] });
    const list = await rpc(app, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const names = list.json().result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain('find');
    expect(names).not.toContain('list_machines');
  });

  it('names what find needs when the user can read none of its kinds', async () => {
    const { app } = build({ grants: ['terminals:read'] });
    const r = await rpc(app, call('find', { query: 'mac' }));
    expect(r.json().result).toEqual({
      content: [{ type: 'text', text: 'Este token não pode usar a ferramenta find: ela precisa do escopo `read` e da permissão de leitura de máquinas, projetos, tarefas, tickets ou contas de IA na sua role' }],
      isError: true,
    });
  });

  it('treats an omitted arguments object as empty', async () => {
    const { app } = build();
    const r = await rpc(app, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_machines' } });
    expect(r.json().result.isError).toBeFalsy();
    expect(JSON.parse(r.json().result.content[0].text).machines[0].id).toBe('m1');
  });

  it('refuses arguments: null for an all-optional tool as INVALID_ARGS instead of silently passing it through', async () => {
    const { app, apiTokens } = build();
    const r = await rpc(app, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'list_machines', arguments: null } });
    expect(r.json().error ?? r.json().result?.isError).toBeTruthy();
    await flush();
    expect(apiTokens.recordEvent.mock.calls[0][0]).toMatchObject({ tool: 'list_machines', ok: false, error_code: 'INVALID_ARGS' });
    expect(listMachines).not.toHaveBeenCalled();
  });

  it('applies the per-token rate limit', async () => {
    const { app } = build({ limiter: new TokenRateLimiter(1, 60_000) });
    await rpc(app, call('list_machines'));
    const r = await rpc(app, call('list_machines'));
    expect(r.json().result.isError).toBe(true);
    expect(r.json().result.content[0].text).toMatch(/Limite de 1 chamadas por minuto/);
  });
});

describe('POST /mcp hardening', () => {
  it('rejects JSON-RPC batches with 400 and runs nothing', async () => {
    const { app, apiTokens } = build();
    const r = await rpc(app, [call('list_machines'), call('list_machines')]);
    expect(r.statusCode).toBe(400);
    expect(r.json()).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Batch requests are not supported' } });
    await flush();
    expect(listMachines).not.toHaveBeenCalled();
    expect(apiTokens.recordEvent).not.toHaveBeenCalled();
  });

  it('audits and counts a call to a tool outside the allowed set', async () => {
    const { app, apiTokens } = build({ grants: ['machines:read'], limiter: new TokenRateLimiter(1, 60_000) });
    await rpc(app, call('read_screen', { tab_id: 't1' }));
    await flush();
    expect(apiTokens.recordEvent).toHaveBeenCalledTimes(1);
    expect(apiTokens.recordEvent.mock.calls[0][0]).toMatchObject({ token_id: 'tok1', tool: 'read_screen', tab_id: 't1', ok: false, error_code: 'TOOL_NOT_ALLOWED', duration_ms: 0 });
    const next = await rpc(app, call('list_machines'));
    expect(next.json().result.content[0].text).toMatch(/Limite de 1 chamadas por minuto/);
  });

  it('truncates an unknown tool name to 64 chars in the audit', async () => {
    const { app, apiTokens } = build();
    await rpc(app, call('x'.repeat(200)));
    await flush();
    expect(apiTokens.recordEvent.mock.calls[0][0].tool).toBe('x'.repeat(64));
  });

  it('audits and counts a call with invalid arguments without running the tool', async () => {
    const { app, apiTokens } = build({ limiter: new TokenRateLimiter(2, 60_000) });
    for (const args of [{ tab_id: 't1', lines: 'x' }, {}]) {
      const r = await rpc(app, call('read_screen', args));
      expect(r.json().result.isError).toBe(true);
    }
    await flush();
    expect(readScreen).not.toHaveBeenCalled();
    expect(apiTokens.recordEvent.mock.calls.map((c) => c[0])).toMatchObject([
      { tool: 'read_screen', tab_id: 't1', ok: false, error_code: 'INVALID_ARGS' },
      { tool: 'read_screen', ok: false, error_code: 'INVALID_ARGS' },
    ]);
    const next = await rpc(app, call('list_machines'));
    expect(next.json().result.content[0].text).toMatch(/Limite de 2 chamadas por minuto/);
  });

  it('audits only bounded ids from a refused call', async () => {
    const { app, apiTokens } = build({ grants: ['machines:read'] });
    await rpc(app, call('read_screen', { tab_id: 't'.repeat(1000) }));
    await rpc(app, call('read_screen', { tab_id: 't'.repeat(64), machine_id: '' }));
    await flush();
    const rows = apiTokens.recordEvent.mock.calls.map((c) => c[0]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ error_code: 'TOOL_NOT_ALLOWED', tab_id: null });
    expect(rows[1]).toMatchObject({ error_code: 'TOOL_NOT_ALLOWED', tab_id: 't'.repeat(64), machine_id: null });
  });

  it('leaves a tools/call with a non-string name to the SDK and audits nothing', async () => {
    const { app, apiTokens } = build();
    for (const name of [{ toString: 1 }, undefined, 42]) {
      const r = await rpc(app, { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: {} } });
      expect(r.statusCode).not.toBe(500);
      expect(r.json().error ?? r.json().result?.isError).toBeTruthy();
    }
    await flush();
    expect(apiTokens.recordEvent).not.toHaveBeenCalled();
  });

  it('audits a refused call over the rate limit as RATE_LIMITED', async () => {
    const { app, apiTokens } = build({ grants: ['machines:read'], limiter: new TokenRateLimiter(1, 60_000) });
    await rpc(app, call('read_screen', { tab_id: 't1' }));
    await rpc(app, call('read_screen', { tab_id: 't1' }));
    const limited = await rpc(app, call('read_screen', { tab_id: 't1' }));
    expect(limited.json().result.isError).toBe(true);
    expect(limited.json().result.content[0].text).toMatch(/^Limite de 1 chamadas por minuto deste token; tente de novo em \d+ s$/);
    await flush();
    expect(apiTokens.recordEvent.mock.calls.map((c) => c[0].error_code)).toEqual(['TOOL_NOT_ALLOWED', 'RATE_LIMITED', 'RATE_LIMITED']);
  });

  it('sets the security headers on a hijacked 200 response', async () => {
    const { app } = build();
    const r = await rpc(app, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['referrer-policy']).toBe('same-origin');
  });

  it('closes the MCP server when the client disconnects before the tools are resolved', async () => {
    const closeSpy = vi.spyOn(McpServer.prototype, 'close');
    const { app, apiTokens } = build();
    let reached!: () => void;
    const inGrantCheck = new Promise<void>((r) => (reached = r));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    vi.mocked(canAccess).mockImplementation(async () => {
      reached();
      await gate;
      return true;
    });
    const base = await app.listen({ port: 0, host: '127.0.0.1' });
    try {
      const ac = new AbortController();
      const req = fetch(`${base}/mcp`, {
        method: 'POST',
        signal: ac.signal,
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${SECRET}` },
        body: JSON.stringify(call('list_machines')),
      }).catch(() => undefined);
      await inGrantCheck;
      ac.abort();
      await req;
      await vi.waitFor(() => expect(closeSpy).toHaveBeenCalled());
      release();
      await new Promise((r) => setTimeout(r, 20));
      expect(listMachines).not.toHaveBeenCalled();
      expect(apiTokens.recordEvent).not.toHaveBeenCalled();
    } finally {
      release();
      closeSpy.mockRestore();
      app.server.closeAllConnections(); // the aborted client's socket would otherwise hold close() for seconds
      await app.close();
    }
  });
});

describe('POST /mcp over a real socket', () => {
  it('serves initialize and tools/list through the SDK transport on a listening server', async () => {
    const { app } = build();
    const base = await app.listen({ port: 0, host: '127.0.0.1' });
    try {
      const post = (body: object) =>
        fetch(`${base}/mcp`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${SECRET}` },
          body: JSON.stringify(body),
        });
      const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
      expect(init.status).toBe(200);
      expect(init.headers.get('content-type')).toMatch(/application\/json/);
      expect(((await init.json()) as { result: { serverInfo: { name: string } } }).result.serverInfo.name).toBe('termhub');
      const list = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
      expect(list.status).toBe(200);
      const names = ((await list.json()) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
      expect(names).toContain('list_machines');
      const unauth = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      expect(unauth.status).toBe(401);
    } finally {
      await app.close();
    }
  });
});

describe('terminals scope', () => {
  const terminalsToken = token({ scopes: ['read', 'terminals'] });
  const writeGrants = ['machines:read', 'projects:read', 'terminals:read', 'terminals:write'];

  it('hides the write tools from a read-only token and names the scope when one is called', async () => {
    const { app, apiTokens } = build({ grants: writeGrants });
    const list = await rpc(app, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(list.json().result.tools.map((t: { name: string }) => t.name)).not.toContain('send_input');

    const refused = await rpc(app, call('send_input', { tab_id: 't1', text: 'oi' }));
    expect(refused.json().result.isError).toBe(true);
    expect(refused.json().result.content[0].text).toContain('escopo `terminals`');
    await flush();
    expect(apiTokens.recordEvent.mock.calls[0][0]).toMatchObject({ tool: 'send_input', ok: false, error_code: 'TOOL_NOT_ALLOWED', tab_id: 't1' });
  });

  it('offers the write tools to a terminals token whose user has the grant', async () => {
    const { app } = build({ token: terminalsToken, grants: writeGrants });
    const list = await rpc(app, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(list.json().result.tools.map((t: { name: string }) => t.name)).toEqual(expect.arrayContaining(['open_tab', 'send_input', 'send_key', 'run_command', 'close_tab']));
  });

  it('keeps the write tools from a token whose user lost the terminals:write grant', async () => {
    const { app } = build({ token: terminalsToken, grants: ['terminals:read'] });
    const list = await rpc(app, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(list.json().result.tools.map((t: { name: string }) => t.name)).not.toContain('send_input');
  });

  it('refuses a key outside the closed list before the machine is touched', async () => {
    const { app, apiTokens } = build({ token: terminalsToken, grants: writeGrants });
    const r = await rpc(app, call('send_key', { tab_id: 't1', key: 'C-d' }));
    expect(r.json().error ?? r.json().result.isError).toBeTruthy();
    await flush();
    expect(apiTokens.recordEvent.mock.calls[0][0]).toMatchObject({ tool: 'send_key', ok: false, error_code: 'INVALID_ARGS' });
  });

  it('never records what was typed', async () => {
    vi.mocked(sendInput).mockResolvedValue({ tab_id: 't1', sent: true });
    const { app, apiTokens } = build({ token: terminalsToken, grants: writeGrants });
    await rpc(app, call('send_input', { tab_id: 't1', text: 'SENHA-SECRETA' }));
    await flush();
    expect(JSON.stringify(apiTokens.recordEvent.mock.calls)).not.toMatch(/SENHA-SECRETA/);
    expect(apiTokens.recordEvent.mock.calls[0][0]).toMatchObject({ tool: 'send_input', tab_id: 't1', ok: true });
  });

  it('answers a notification with 202 and no body', async () => {
    const { app } = build();
    const res = await rpc(app, { jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(res.statusCode).toBe(202);
    expect(res.body).toBe('');
  });
});

describe('tasks scope', () => {
  const TASK_TOOLS = ['list_tasks', 'create_task', 'add_subtasks', 'update_task', 'move_task', 'delete_task', 'link_tab_task'];
  const tasksToken = token({ scopes: ['read', 'tasks'] });
  const taskGrants = ['projects:read', 'tasks:read', 'tasks:create', 'tasks:update', 'tasks:delete'];

  it('hides the task tools from a read-only token and names the scope when one is called', async () => {
    const { app, apiTokens } = build({ grants: taskGrants });
    const list = await rpc(app, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const names = list.json().result.tools.map((t: { name: string }) => t.name);
    for (const n of TASK_TOOLS) expect(names).not.toContain(n);

    const refused = await rpc(app, call('create_task', { project_id: 'p1', title: 'x' }));
    expect(refused.json().result.isError).toBe(true);
    expect(refused.json().result.content[0].text).toContain('escopo `tasks`');
    await flush();
    expect(apiTokens.recordEvent.mock.calls[0][0]).toMatchObject({ tool: 'create_task', ok: false, error_code: 'TOOL_NOT_ALLOWED', project_id: 'p1' });
  });

  it('offers each task tool only with its own grant', async () => {
    const { app } = build({ token: tasksToken, grants: ['tasks:read', 'tasks:update'] });
    const list = await rpc(app, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const names = list.json().result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(expect.arrayContaining(['list_tasks', 'update_task', 'move_task', 'link_tab_task']));
    expect(names).not.toContain('create_task');
    expect(names).not.toContain('add_subtasks');
    expect(names).not.toContain('delete_task');
  });

  it('offers all of them to a tasks token whose user has every tasks grant', async () => {
    const { app } = build({ token: tasksToken, grants: taskGrants });
    const list = await rpc(app, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(list.json().result.tools.map((t: { name: string }) => t.name)).toEqual(expect.arrayContaining(TASK_TOOLS));
  });

  it('rejects an invalid status before the control layer runs', async () => {
    const { app, apiTokens } = build({ token: tasksToken, grants: taskGrants });
    const r = await rpc(app, call('create_task', { project_id: 'p1', title: 'x', status: 'blocked' }));
    expect(r.json().error ?? r.json().result.isError).toBeTruthy();
    await flush();
    expect(apiTokens.recordEvent.mock.calls[0][0]).toMatchObject({ tool: 'create_task', ok: false, error_code: 'INVALID_ARGS' });
    expect(createTask).not.toHaveBeenCalled();
  });

  it('never records titles or descriptions, only the project id', async () => {
    vi.mocked(createTask).mockResolvedValue({ task: { id: 'k9' } as never, board_url: 'https://app.test/projects/p1/tasks' });
    const { app, apiTokens } = build({ token: tasksToken, grants: taskGrants });
    const r = await rpc(app, call('create_task', { project_id: 'p1', title: 'TITULO-SECRETO', description: 'DESC-SECRETA', subtasks: [{ title: 'SUB-SECRETA' }] }));
    expect(r.json().result.isError).toBeUndefined();
    await flush();
    expect(JSON.stringify(apiTokens.recordEvent.mock.calls)).not.toMatch(/SECRET/);
    expect(apiTokens.recordEvent.mock.calls[0][0]).toMatchObject({ tool: 'create_task', ok: true, project_id: 'p1' });
  });

  it('surfaces the confirm refusal of delete_task as a tool error with its code', async () => {
    vi.mocked(deleteTask).mockRejectedValue(new ControlError('CONFIRM_REQUIRED', 'Isso exclui a tarefa "x"; repita com confirm: true para confirmar'));
    const { app, apiTokens } = build({ token: tasksToken, grants: taskGrants });
    const r = await rpc(app, call('delete_task', { task_id: 'k1' }));
    expect(r.json().result.isError).toBe(true);
    expect(r.json().result.content[0].text).toContain('confirm: true');
    await flush();
    expect(apiTokens.recordEvent.mock.calls[0][0]).toMatchObject({ tool: 'delete_task', ok: false, error_code: 'CONFIRM_REQUIRED' });
  });
});

describe('start_agent', () => {
  const terminalsToken = token({ scopes: ['read', 'terminals'] });
  const writeGrants = ['machines:read', 'projects:read', 'terminals:read', 'terminals:write'];

  it('is a terminals-scope tool, hidden from a read-only token', async () => {
    const { app } = build({ grants: writeGrants });
    const list = await rpc(app, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(list.json().result.tools.map((t: { name: string }) => t.name)).not.toContain('start_agent');
    const offered = await rpc(build({ token: terminalsToken, grants: writeGrants }).app, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(offered.json().result.tools.map((t: { name: string }) => t.name)).toContain('start_agent');
  });

  it('never records the prompt, only the project id', async () => {
    vi.mocked(startAgent).mockResolvedValue({ tab_id: 't9', project_id: 'p1' } as never);
    const { app, apiTokens } = build({ token: terminalsToken, grants: writeGrants });
    const r = await rpc(app, call('start_agent', { project_id: 'p1', account_id: 'a1', prompt: 'PROMPT-SECRETO', tab_name: 'NOME-SECRETO' }));
    expect(r.json().result.isError).toBeUndefined();
    await flush();
    expect(JSON.stringify(apiTokens.recordEvent.mock.calls)).not.toMatch(/SECRETO/);
    expect(apiTokens.recordEvent.mock.calls[0][0]).toMatchObject({ tool: 'start_agent', ok: true, project_id: 'p1' });
  });

  it('rejects an empty or oversized prompt before the control layer runs', async () => {
    vi.mocked(startAgent).mockClear();
    const { app, apiTokens } = build({ token: terminalsToken, grants: writeGrants });
    for (const prompt of ['', 'x'.repeat(4001)]) {
      const r = await rpc(app, call('start_agent', { project_id: 'p1', account_id: 'a1', prompt }));
      expect(r.json().error ?? r.json().result.isError).toBeTruthy();
    }
    await flush();
    expect(apiTokens.recordEvent.mock.calls.map((c) => c[0])).toEqual([expect.objectContaining({ tool: 'start_agent', ok: false, error_code: 'INVALID_ARGS' }), expect.objectContaining({ tool: 'start_agent', ok: false, error_code: 'INVALID_ARGS' })]);
    expect(startAgent).not.toHaveBeenCalled();
  });

  it('surfaces control refusals as pt-BR tool errors with their code', async () => {
    vi.mocked(startAgent).mockRejectedValue(new ControlError('PROVIDER_UNSUPPORTED', 'Iniciar um agente gemini ainda não é suportado; por enquanto só claude e chatgpt (Codex)'));
    const { app, apiTokens } = build({ token: terminalsToken, grants: writeGrants });
    const r = await rpc(app, call('start_agent', { project_id: 'p1', account_id: 'a5', prompt: 'x' }));
    expect(r.json().result.isError).toBe(true);
    expect(r.json().result.content[0].text).toContain('ainda não é suportado');
    await flush();
    expect(apiTokens.recordEvent.mock.calls[0][0]).toMatchObject({ tool: 'start_agent', ok: false, error_code: 'PROVIDER_UNSUPPORTED' });
  });
});

describe('read_attachment', () => {
  const chatGrants = ['chat:read'];
  const store = { read: vi.fn(), write: vi.fn(), remove: vi.fn(), listAll: async function* () {} } as unknown as AttachmentStore;

  it('is offered to a read token whose user can read the chat, and hidden otherwise', async () => {
    const offered = await rpc(build({ grants: chatGrants }).app, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    // search_memory shares the same chat:read grant as read_attachment.
    expect(offered.json().result.tools.map((t: { name: string }) => t.name)).toEqual(['read_attachment', 'search_memory']);
    const hidden = await rpc(build({ grants: ['machines:read'] }).app, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(hidden.json().result.tools.map((t: { name: string }) => t.name)).not.toContain('read_attachment');
    expect(hidden.json().result.tools.map((t: { name: string }) => t.name)).not.toContain('search_memory');
  });

  it('passes an MCP content result through untouched — an image block stays an image block — and audits without the content', async () => {
    vi.mocked(readAttachment).mockResolvedValue({ content: [{ type: 'image', data: 'QUJD', mimeType: 'image/png' }, { type: 'text', text: '«foto.png» imagem 2×2' }] });
    const { app, apiTokens } = build({ grants: chatGrants, attachments: store });
    const r = await rpc(app, call('read_attachment', { id: 'abc123' }));
    expect(r.json().result).toEqual({ content: [{ type: 'image', data: 'QUJD', mimeType: 'image/png' }, { type: 'text', text: '«foto.png» imagem 2×2' }] });
    // The store reached the tool through the context, so the tool can read the file.
    expect(vi.mocked(readAttachment).mock.calls[0][0].attachments).toBe(store);
    await flush();
    expect(apiTokens.recordEvent.mock.calls[0][0]).toMatchObject({ tool: 'read_attachment', ok: true, error_code: null });
    expect(JSON.stringify(apiTokens.recordEvent.mock.calls)).not.toMatch(/QUJD|foto\.png/);
  });

  it('a not-found is a pt-BR tool error with its code; an invalid offset never reaches the tool', async () => {
    vi.mocked(readAttachment).mockRejectedValue(new ControlError('NOT_FOUND', 'Anexo não encontrado'));
    const { app, apiTokens } = build({ grants: chatGrants, attachments: store });
    const r = await rpc(app, call('read_attachment', { id: 'abc123' }));
    expect(r.json().result).toEqual({ content: [{ type: 'text', text: 'Anexo não encontrado' }], isError: true });
    vi.mocked(readAttachment).mockClear();
    const bad = await rpc(app, call('read_attachment', { id: 'abc123', offset: -1 }));
    expect(bad.json().error ?? bad.json().result?.isError).toBeTruthy();
    expect(readAttachment).not.toHaveBeenCalled();
    await flush();
    expect(apiTokens.recordEvent.mock.calls.map((c) => c[0].error_code)).toEqual(['NOT_FOUND', 'INVALID_ARGS']);
  });

  it('a gated (concierge) token reads attachments without a confirmation card', async () => {
    vi.mocked(readAttachment).mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
    const { app } = build({ token: token({ gated: true, chat_conversation_id: 'c1' } as Partial<ApiToken>), grants: chatGrants, attachments: store });
    const r = await rpc(app, call('read_attachment', { id: 'abc123' }));
    expect(r.json().result).toEqual({ content: [{ type: 'text', text: 'ok' }] });
  });

  it('audits the attachment id, and never the image, the name or the text', async () => {
    vi.mocked(readAttachment).mockResolvedValue({ content: [{ type: 'image', data: 'QUJD', mimeType: 'image/png' }, { type: 'text', text: '«foto.png» imagem 2×2' }] });
    const { app, apiTokens } = build({ grants: chatGrants, attachments: store });
    await rpc(app, call('read_attachment', { id: 'abc123' }));
    await flush();
    expect(apiTokens.recordEvent.mock.calls[0][0]).toMatchObject({ tool: 'read_attachment', attachment_id: 'abc123', ok: true });
    expect(JSON.stringify(apiTokens.recordEvent.mock.calls)).not.toMatch(/QUJD|foto\.png|imagem/);
  });

  it('a refused call keeps a name passed as id out of the audit', async () => {
    const { app, apiTokens } = build({ grants: chatGrants, attachments: store });
    await rpc(app, call('read_attachment', { id: 'Relatório Final.pdf' }));
    await flush();
    expect(apiTokens.recordEvent.mock.calls[0][0]).toMatchObject({ tool: 'read_attachment', attachment_id: null, ok: false, error_code: 'INVALID_ARGS' });
    expect(JSON.stringify(apiTokens.recordEvent.mock.calls)).not.toMatch(/Relat/);
  });

  it('only read_attachment fills attachment_id', async () => {
    const { app, apiTokens } = build({ grants: chatGrants, attachments: store });
    await rpc(app, call('list_machines', { id: 'abc123' }));
    await flush();
    expect(apiTokens.recordEvent.mock.calls[0][0].attachment_id).toBeNull();
  });
});

describe('integration tools', () => {
  const full = token({ scopes: ['read', 'terminals'] });
  const grants = ['integrations:read', 'integrations:create', 'projects:read', 'projects:update'];
  const args = { provider: 'github', name: 'GitHub pessoal', secret_from: { machine_id: 'm1', source: 'gh_auth_token' } };
  const PASTED = 'gho_PastedTokenValue999';

  it('offers the reads to a read token and the writes only to a terminals token', async () => {
    const read = build({ grants });
    const readNames = (await rpc(read.app, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).json().result.tools.map((t: { name: string }) => t.name);
    expect(readNames).toEqual(expect.arrayContaining(['list_integrations', 'get_project_setup']));
    expect(readNames).not.toContain('create_integration');
    expect(readNames).not.toContain('set_project_repo');
    const write = build({ token: full, grants });
    const writeNames = (await rpc(write.app, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).json().result.tools.map((t: { name: string }) => t.name);
    expect(writeNames).toEqual(expect.arrayContaining(['create_integration', 'set_project_repo']));
  });

  it('advertises create_integration with no room for extra arguments', async () => {
    const { app } = build({ token: full, grants });
    const tools = (await rpc(app, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).json().result.tools as { name: string; inputSchema: { additionalProperties?: unknown; properties: Record<string, unknown> } }[];
    const t = tools.find((x) => x.name === 'create_integration')!;
    expect(t.inputSchema.additionalProperties).toBe(false);
    expect(Object.keys(t.inputSchema.properties).sort()).toEqual(['name', 'provider', 'secret_from']);
  });

  it('refuses a pasted token argument: the tool never runs and the value is neither echoed nor audited', async () => {
    const { app, apiTokens } = build({ token: full, grants });
    for (const extra of [{ secret: PASTED }, { token: PASTED }, { secret_from: { ...args.secret_from, value: PASTED } }]) {
      const r = await rpc(app, call('create_integration', { ...args, ...extra }));
      expect(r.json().error ?? r.json().result.isError).toBeTruthy();
      expect(r.body).not.toContain(PASTED);
    }
    await flush();
    expect(createIntegration).not.toHaveBeenCalled();
    expect(apiTokens.recordEvent.mock.calls.map((c) => (c as unknown[])[0])).toEqual(Array(3).fill(expect.objectContaining({ tool: 'create_integration', ok: false, error_code: 'INVALID_ARGS' })));
    expect(JSON.stringify(apiTokens.recordEvent.mock.calls)).not.toContain(PASTED);
  });

  it('runs create_integration with valid arguments', async () => {
    vi.mocked(createIntegration).mockResolvedValue({ id: 'g1', provider: 'github', name: 'GitHub pessoal', config: { login: 'ana' }, created_at: '', account: 'ana' });
    const { app } = build({ token: full, grants });
    const r = await rpc(app, call('create_integration', args));
    expect(r.json().result.isError).toBeFalsy();
    expect(vi.mocked(createIntegration).mock.calls[0][1]).toEqual(args);
  });
});

describe('tab token (TER-212)', () => {
  const tabToken = () => token({ id: 'tokTab', scopes: ['read', 'memory'], tab_id: 'tab1', gated: false });
  const tabs = [{ id: 'tab1', project_id: 'p1' }];
  const grants = ['machines:read', 'projects:read', 'terminals:read', 'terminals:write', 'chat:read', 'chat:create', 'tasks:read'];
  beforeEach(() => vi.mocked(searchMemory).mockReset());

  it('401s once the tab row is gone', async () => {
    const { app } = build({ token: tabToken(), grants, tabs: [] });
    const r = await rpc(app, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(r.statusCode).toBe(401);
    expect(r.json()).toEqual({ error: 'Não autenticado', code: 'UNAUTHORIZED' });
  });

  it('401s a tab token that claims to be gated, even with its tab alive', async () => {
    const { app } = build({ token: { ...tabToken(), gated: true }, grants, tabs });
    expect((await rpc(app, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).statusCode).toBe(401);
  });

  it('lists only the allowlisted memory tools', async () => {
    const { app } = build({ token: tabToken(), grants, tabs });
    const names: string[] = (await rpc(app, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).json().result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain('search_memory');
    expect(names.every((n) => ['search_memory', 'record_lesson', 'get_automation_policy'].includes(n))).toBe(true);
  });

  it('also lists the real record_lesson once the owner has notes:update (TER-205)', async () => {
    const { app } = build({ token: tabToken(), grants: [...grants, 'notes:update'], tabs });
    const names: string[] = (await rpc(app, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).json().result.tools.map((t: { name: string }) => t.name);
    expect(names.sort()).toEqual(['get_automation_policy', 'record_lesson', 'search_memory']);
  });

  it('refuses list_tabs as a pt-BR tool error, audited as TOOL_NOT_ALLOWED', async () => {
    const { app, apiTokens } = build({ token: tabToken(), grants, tabs });
    const res = (await rpc(app, call('list_tabs', { project_id: 'p1' }))).json().result;
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('list_tabs');
    expect(res.content[0].text).toContain('aba');
    await flush();
    expect(apiTokens.recordEvent).toHaveBeenCalledWith(expect.objectContaining({ tool: 'list_tabs', ok: false, error_code: 'TOOL_NOT_ALLOWED' }));
  });

  it('refuses search_memory on another project without running it, audited as TAB_SCOPE', async () => {
    const { app, apiTokens } = build({ token: tabToken(), grants, tabs });
    const res = (await rpc(app, call('search_memory', { query: 'x', project_id: 'p2' }))).json().result;
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('projeto da aba');
    expect(searchMemory).not.toHaveBeenCalled();
    await flush();
    expect(apiTokens.recordEvent).toHaveBeenCalledWith(expect.objectContaining({ tool: 'search_memory', ok: false, error_code: 'TAB_SCOPE' }));
  });

  it('fills a missing project_id with the tab\'s project and hands the tab to the control layer', async () => {
    vi.mocked(searchMemory).mockResolvedValue({ note: 'n', results: [] });
    const { app, apiTokens } = build({ token: tabToken(), grants, tabs });
    const res = (await rpc(app, call('search_memory', { query: 'x' }))).json().result;
    expect(res.isError).toBeFalsy();
    const [ctx, args] = vi.mocked(searchMemory).mock.calls[0]!;
    expect(args).toEqual({ query: 'x', project_id: 'p1' });
    expect(ctx.token?.tab).toEqual({ id: 'tab1', project_id: 'p1' });
    await flush();
    expect(apiTokens.recordEvent).toHaveBeenCalledWith(expect.objectContaining({ tool: 'search_memory', ok: true, project_id: 'p1' }));
  });

  describe('a tool whose project_id and tab_id are required', () => {
    // Stands in for record_lesson (TER-205): allowlisted by name, with ids a tab does not know.
    const run = vi.fn(async (_ctx: unknown, a: Record<string, unknown>) => ({ saved: a }));
    const fake: ToolDef = {
      name: 'record_lesson', description: 'test', scope: 'memory', resource: 'chat', action: 'read',
      input: { project_id: z.string().min(1).max(64), tab_id: z.string().min(1).max(64), text: z.string().min(1) },
      run: (ctx, a) => run(ctx, a),
    };
    beforeEach(() => {
      run.mockClear();
      TOOLS.push(fake);
    });
    afterEach(() => {
      TOOLS.splice(TOOLS.indexOf(fake), 1);
    });

    it('runs for a tab token without them, filled with the tab\'s values', async () => {
      const { app, apiTokens } = build({ token: tabToken(), grants, tabs });
      const res = (await rpc(app, call('record_lesson', { text: 'l' }))).json().result;
      expect(res.isError).toBeFalsy();
      expect(run).toHaveBeenCalledTimes(1);
      expect(run.mock.calls[0]![1]).toEqual({ text: 'l', project_id: 'p1', tab_id: 'tab1' });
      await flush();
      expect(apiTokens.recordEvent).toHaveBeenCalledWith(expect.objectContaining({ tool: 'record_lesson', ok: true, project_id: 'p1', tab_id: 'tab1' }));
    });

    it('still refuses a foreign project as TAB_SCOPE', async () => {
      const { app, apiTokens } = build({ token: tabToken(), grants, tabs });
      const res = (await rpc(app, call('record_lesson', { text: 'l', project_id: 'p2' }))).json().result;
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain('projeto da aba');
      expect(run).not.toHaveBeenCalled();
      await flush();
      expect(apiTokens.recordEvent).toHaveBeenCalledWith(expect.objectContaining({ tool: 'record_lesson', ok: false, error_code: 'TAB_SCOPE' }));
    });

    it('keeps the required-field error for an ordinary token', async () => {
      const { app, apiTokens } = build({ token: token({ scopes: ['read', 'memory'] }), grants });
      const r = (await rpc(app, call('record_lesson', { text: 'l' }))).json();
      expect(r.error ?? r.result?.isError).toBeTruthy();
      expect(run).not.toHaveBeenCalled();
      await flush();
      expect(apiTokens.recordEvent).toHaveBeenCalledWith(expect.objectContaining({ tool: 'record_lesson', ok: false, error_code: 'INVALID_ARGS' }));
    });
  });

  it('leaves an ordinary token\'s search_memory call as it came', async () => {
    vi.mocked(searchMemory).mockResolvedValue({ note: 'n', results: [] });
    const { app } = build({ grants });
    await rpc(app, call('search_memory', { query: 'x' }));
    const [ctx, args] = vi.mocked(searchMemory).mock.calls[0]!;
    expect(args).toEqual({ query: 'x' });
    expect(ctx.token?.tab).toBeUndefined();
  });
});
