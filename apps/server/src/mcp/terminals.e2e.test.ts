import Fastify from 'fastify';
import { beforeEach, expect, it, vi } from 'vitest';
import type { AgentConnection } from '../agent/connection.js';
import { agents } from '../agent/registry.js';
import { hashApiToken } from '../auth/api-tokens.js';
import { canAccess } from '../auth/permissions.js';
import type { Repositories } from '../db/repositories/index.js';
import { applyErrorHandler } from '../lib/errors.js';
import { mcpRoutes } from './route.js';

vi.mock('../auth/permissions.js', async (orig) => ({ ...(await orig<typeof import('../auth/permissions.js')>()), canAccess: vi.fn(async () => true) }));

const SECRET = 'thb_pat_' + 'A'.repeat(43);
const machine = { id: 'm1', name: 'jarvis', type: 'agent', os: 'linux', capabilities: ['tmux'], owner_id: 'u1' };
const project = { id: 'p1', name: 'app', status: 'active', owner_id: 'u1', key: 'APP', next_task_number: 1 };
const link = { id: 'l1', project_id: 'p1', machine_id: 'm1', cwd: '/home/u/app', position: 0, created_at: '' };

/** The fake machine: one tmux session whose screen is whatever was typed into it. */
function attachFakeTmux(typed: string[]) {
  const conn = {
    machineId: machine.id,
    hello: { agent_version: '0.2.0', os: 'linux', tools: ['tmux'] },
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
      if (method === 'tmux.capture') return { text: typed.join('\n') };
      throw new Error(`unexpected rpc ${method}`);
    }),
  } as unknown as AgentConnection;
  agents.attach(machine.id, conn);
  return conn;
}

function build() {
  const tabs = new Map<string, Record<string, unknown>>();
  const apiTokens = {
    findActiveByHash: vi.fn(async (h: string) => (h === hashApiToken(SECRET) ? { id: 'tok1', user_id: 'u1', name: 'jarvis', scopes: ['read', 'terminals'], expires_at: null, revoked_at: null, last_used_at: null, created_at: '' } : undefined)),
    touchLastUsed: vi.fn(async () => {}),
    recordEvent: vi.fn(async () => {}),
  };
  const repos = {
    apiTokens,
    users: { findById: vi.fn(async () => ({ id: 'u1', role_id: 'r' })) },
    machines: { findById: vi.fn(async () => machine), list: vi.fn(async () => [machine]) },
    projects: { findById: vi.fn(async () => project) },
    projectMachines: {
      find: vi.fn(async () => link),
      listByProject: vi.fn(async () => [link]),
    },
    tasks: { listByProject: vi.fn(async () => []) },
    tabs: {
      listByProject: vi.fn(async () => [...tabs.values()]),
      countOpenByToken: vi.fn(async () => 0),
      findById: vi.fn(async (id: string) => tabs.get(id)),
      delete: vi.fn(async (id: string) => tabs.delete(id)),
      create: vi.fn(async (projectId: string, machineId: string, name: string, opts: { created_by_token_id?: string | null } = {}) => {
        const id = `t${tabs.size + 1}`;
        const tab = { id, project_id: projectId, machine_id: machineId, name, kind: 'terminal', tmux_session: `termhub-${projectId}-${id}`, simulator_udid: null, position: 0, state: null, state_text: null, state_tool: null, state_at: null, state_seen_at: null, created_at: '', created_by_token_id: opts.created_by_token_id ?? null };
        tabs.set(id, tab);
        return tab;
      }),
    },
    legal: { statusFor: vi.fn(async () => ({ pending: [], upcoming: [] })) },
  } as unknown as Repositories;

  const app = Fastify();
  applyErrorHandler(app);
  app.register((a) => mcpRoutes(a, { repos, version: '0.0.0-test' }));
  return { app, apiTokens };
}

const callTool = (app: ReturnType<typeof Fastify>, name: string, args: object) =>
  app.inject({
    method: 'POST',
    url: '/mcp',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${SECRET}` },
    payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
  });

const payloadOf = (res: { json(): { result: { content: { text: string }[]; isError?: boolean } } }) => JSON.parse(res.json().result.content[0].text);

beforeEach(() => {
  agents.reset();
  vi.mocked(canAccess).mockResolvedValue(true);
});

it('opens a tab, types into it and reads the text back', async () => {
  const typed: string[] = [];
  const conn = attachFakeTmux(typed);
  const { app, apiTokens } = build();

  const opened = await callTool(app, 'open_tab', { project_id: 'p1' });
  const { tab_id } = payloadOf(opened);
  expect(conn.rpc).toHaveBeenCalledWith('tmux.ensure', { session: `termhub-p1-${tab_id}`, cwd: '/home/u/app' }, undefined);

  await callTool(app, 'send_input', { tab_id, text: 'echo termhub', enter: true });
  const screen = await callTool(app, 'read_screen', { tab_id, lines: 10 });
  expect(payloadOf(screen).text).toContain('echo termhub');

  await new Promise((r) => setTimeout(r, 0));
  const rows = apiTokens.recordEvent.mock.calls.map((c) => c[0]);
  expect(rows.map((r) => r.tool)).toEqual(['open_tab', 'send_input', 'read_screen']);
  expect(rows.every((r) => r.ok)).toBe(true);
  // metadata only: nothing typed and nothing on the screen is ever stored
  expect(JSON.stringify(rows)).not.toContain('echo termhub');
});

it('tells the caller to update an agent that does not know the new RPCs', async () => {
  const conn = attachFakeTmux([]);
  (conn as unknown as { hello: { agent_version: string } }).hello.agent_version = '0.1.6';
  const { app, apiTokens } = build();

  const r = await callTool(app, 'open_tab', { project_id: 'p1' });
  expect(r.json().result.isError).toBe(true);
  expect(r.json().result.content[0].text).toContain('Atualize o agente');
  await new Promise((r) => setTimeout(r, 0));
  expect(apiTokens.recordEvent.mock.calls[0][0]).toMatchObject({ tool: 'open_tab', ok: false, error_code: 'AGENT_OUTDATED' });
});
