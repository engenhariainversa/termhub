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
import Ajv2020 from 'ajv/dist/2020.js';
import { API_TOKEN_SCOPES } from '../auth/api-tokens.js';
import { ACTIONS, RESOURCE_KEYS } from '../auth/permissions.js';

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
  // every listed tab has an active automatic run: the run-only tab tools (report_card, get_card) are listed
  const automationRuns = { activeByTab: vi.fn(async (id: string) => { const t = opts.tabs?.find((x) => x.id === id); return t ? { id: 'run1', project_id: t.project_id } : null; }) };
  const repos = { apiTokens, tabs, automationRuns, users: { findById: vi.fn(async (id: string) => (id === 'u1' ? { id: 'u1', role_id: 'r' } : undefined)) } } as unknown as Repositories;
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


/** Every `pattern` keyword of a JSON schema, wherever it sits. */
function patternsOf(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) node.forEach((n) => patternsOf(n, out));
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === 'pattern' && typeof v === 'string') out.push(v);
      else patternsOf(v, out);
    }
  }
  return out;
}

/**
 * TER-626: the Claude API refuses a whole session when one tool's input_schema is not a valid JSON Schema
 * draft 2020-12 document ("tools.N.custom.input_schema: JSON schema is invalid"), and every session that
 * loads this MCP (the concierge, its subagents, every tab) dies with it. So every tool the server can list
 * — the termhub MCP's and the tabs' termhub_tab ones are all in TOOLS — is checked as the API sees it.
 */
describe('tools/list input schemas (TER-626)', () => {
  it('lists every tool with an input schema that is valid draft 2020-12, and patterns any regex engine reads', async () => {
    const grants = RESOURCE_KEYS.flatMap((r) => ACTIONS.map((a) => `${r}:${a}`));
    const { app } = build({ token: token({ scopes: [...API_TOKEN_SCOPES] }), grants });
    const r = await rpc(app, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const text = r.body.includes('data:') ? r.body.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5)).join('') : r.body;
    const listed = JSON.parse(text).result.tools as { name: string; inputSchema: Record<string, unknown> }[];
    // the run-only tab tools are listed to a tab token whose tab has an active run, never to this one
    const runOnly = ['report_card', 'get_card'];
    expect(listed.map((t) => t.name).sort()).toEqual(TOOLS.map((t) => t.name).filter((n) => !runOnly.includes(n)).sort());
    const tabApp = build({ token: token({ scopes: ['read', 'memory'], tab_id: 'tab1', gated: false }), grants, tabs: [{ id: 'tab1', project_id: 'p1' }] }).app;
    const tabRes = await rpc(tabApp, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const tabText = tabRes.body.includes('data:') ? tabRes.body.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5)).join('') : tabRes.body;
    const tabTools = (JSON.parse(tabText).result.tools as typeof listed).filter((t) => runOnly.includes(t.name));
    expect(tabTools.map((t) => t.name).sort()).toEqual([...runOnly].sort());
    const tools = [...listed, ...tabTools];

    // Formats (`uri`…) are valid 2020-12 keywords; checking values against them is not what is at stake here.
    const ajv = new Ajv2020({ strict: true, strictRequired: false, allowUnionTypes: true, validateFormats: false });
    for (const tool of tools) {
      // The SDK stamps draft-07's `$schema`; the document itself must still be valid under 2020-12.
      const { $schema: _draft, ...schema } = tool.inputSchema;
      expect(() => ajv.compile(schema), tool.name).not.toThrow();
      // The strictest ECMAScript mode (`v`, unicode sets) reads an unescaped `[` or `-` inside a class the
      // way nested-class engines (Rust's regex) do: a pattern valid there is valid for any validator.
      for (const pattern of patternsOf(schema)) expect(() => new RegExp(pattern, 'v'), `${tool.name}: ${pattern}`).not.toThrow();
    }
  });
});
