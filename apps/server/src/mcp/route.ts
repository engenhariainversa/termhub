import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Repositories } from '../db/repositories/index.js';
import type { ApiToken } from '../db/repositories/api-tokens.js';
import { controlContextFor, ControlError, type ControlContext } from '../control/context.js';
import { HttpError } from '../lib/errors.js';
import { authenticateToken } from './auth.js';
import { TokenRateLimiter } from './rate-limit.js';
import { allowedTools, refusalMessage } from './tools.js';

export const MCP_BODY_LIMIT = 256 * 1024;

declare module 'fastify' {
  interface FastifyRequest {
    /** set by the /mcp token check */
    mcp?: { token: ApiToken; ctx: ControlContext };
  }
}

const UNAUTHORIZED = { error: 'Não autenticado', code: 'UNAUTHORIZED' } as const;

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };
const text = (t: string, isError = false): ToolResult => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });
/** An id worth auditing: refused calls carry raw, unvalidated arguments, so anything else is dropped. */
const auditId = (v: unknown) => (typeof v === 'string' && v.length >= 1 && v.length <= 64 ? v : null);
const idsOf = (args: unknown) => {
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
  return { machine_id: auditId(a.machine_id), project_id: auditId(a.project_id), tab_id: auditId(a.tab_id) };
};

/** Same headers the app's global onSend hook sets — a hijacked reply bypasses that hook. */
const SECURITY_HEADERS = { 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'same-origin' } as const;
const BATCH_REJECTED = { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Batch requests are not supported' } } as const;

/** `arguments` is optional in tools/call, but the SDK validates `undefined` against the tool's object schema. */
function withDefaultArguments(body: unknown): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const msg = body as { method?: unknown; params?: { arguments?: unknown } };
  if (msg.method !== 'tools/call' || !msg.params || typeof msg.params !== 'object' || msg.params.arguments !== undefined) return body;
  return { ...msg, params: { ...msg.params, arguments: {} } };
}

/**
 * The global terminal's MCP endpoint (spec §3.3). Public route outside /api: no session, no CSRF —
 * a personal API token authenticates each request, and the token's user is the data scope. Stateless:
 * a fresh McpServer per request, so a revoked token stops working on the next call.
 */
export async function mcpRoutes(app: FastifyInstance, deps: { repos: Repositories; version: string; limiter?: TokenRateLimiter }) {
  const { repos } = deps;
  const limiter = deps.limiter ?? new TokenRateLimiter();

  const authenticate = async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = await authenticateToken(repos, request.headers.authorization);
    if (!auth) return reply.code(401).send(UNAUTHORIZED);
    request.mcp = { token: auth.token, ctx: controlContextFor(repos, auth.user) };
    void repos.apiTokens.touchLastUsed(auth.token.id).catch((err) => request.log.warn({ err }, 'mcp: touchLastUsed failed'));
  };

  const notAllowed = async (_request: FastifyRequest, reply: FastifyReply) => reply.code(405).header('allow', 'POST').send({ error: 'Use POST', code: 'METHOD_NOT_ALLOWED' });
  app.get('/mcp', notAllowed);
  app.delete('/mcp', notAllowed);

  app.post('/mcp', { bodyLimit: MCP_BODY_LIMIT, onRequest: authenticate }, async (request, reply) => {
    // Closing the transport + server aborts in-flight handlers (e.g. wait_for_state) when the client goes away.
    let server: McpServer | undefined;
    let transport: StreamableHTTPServerTransport | undefined;
    let closed = false;
    const close = () => {
      closed = true;
      void transport?.close();
      void server?.close();
    };
    reply.raw.on('close', close);
    const gone = () => {
      reply.hijack(); // the client is gone: nothing to send, and Fastify must not try
      reply.raw.destroy();
    };
    if (request.raw.destroyed || reply.raw.destroyed) {
      close();
      return gone();
    }

    // MCP 2025-06-18 removed JSON-RPC batching; refusing it keeps one message = one audited call.
    if (Array.isArray(request.body)) return reply.code(400).send(BATCH_REJECTED);

    const { token, ctx } = request.mcp!;
    const audit = (tool: string, args: unknown, errorCode: string | null, durationMs: number) =>
      void repos.apiTokens
        .recordEvent({ token_id: token.id, tool: tool.slice(0, 64), ...idsOf(args), ok: errorCode === null, error_code: errorCode, duration_ms: durationMs })
        .catch((err) => request.log.warn({ err }, 'mcp: recordEvent failed'));

    server = new McpServer({ name: 'termhub', version: deps.version }, { capabilities: { tools: {} } });
    const rateLimited = (retryInSeconds: number) => text(`Limite de ${limiter.limit} chamadas por minuto deste token; tente de novo em ${retryInSeconds} s`, true);
    const tools = await allowedTools(ctx, token.scopes);
    // McpServer installs its tools/* handlers on the first registerTool; with nothing allowed, answer an
    // empty catalog instead of "Method not found" (tools/call then stays a JSON-RPC "Method not found").
    if (tools.length === 0) server.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [] }));
    for (const tool of tools) {
      server.registerTool(tool.name, { description: tool.description, inputSchema: tool.input }, async (args: Record<string, unknown>, extra: { signal: AbortSignal }) => {
        const started = Date.now();
        let errorCode: string | null = null;
        let out: ToolResult;
        const rate = limiter.take(token.id);
        if (!rate.ok) {
          errorCode = 'RATE_LIMITED';
          out = rateLimited(rate.retryInSeconds);
        } else {
          try {
            out = text(JSON.stringify(await tool.run(ctx, args, extra.signal), null, 2));
          } catch (e) {
            if (e instanceof ControlError || e instanceof HttpError) {
              errorCode = e.code ?? 'ERROR';
              out = text(e.message, true);
            } else {
              errorCode = 'INTERNAL';
              request.log.error({ err: e, tool: tool.name, token_id: token.id }, 'mcp: tool failed');
              out = text('Erro interno ao executar a ferramenta', true);
            }
          }
        }
        audit(tool.name, args, errorCode, Date.now() - started);
        return out;
      });
    }

    // Calls refused before reaching a handler (tool not allowed, arguments invalid) are counted and audited
    // here. A tool outside the allowed set, or any refused call over the rate limit, is answered here as a
    // pt-BR tool error (spec §6) — the SDK would say "Tool X not found" as a JSON-RPC error. Invalid
    // arguments are left to the SDK's validation error. Valid allowed calls are audited by the handler.
    const body = withDefaultArguments(request.body);
    const msg = body as { id?: unknown; method?: unknown; params?: { name?: unknown; arguments?: unknown } } | null;
    // A non-string name is left to the SDK, which rejects the request itself (nothing to audit it as).
    if (msg && typeof msg === 'object' && msg.method === 'tools/call' && msg.params && typeof msg.params === 'object' && typeof msg.params.name === 'string') {
      const name = msg.params.name;
      const tool = tools.find((t) => t.name === name);
      const refusal = !tool ? 'TOOL_NOT_ALLOWED' : !z.object(tool.input).safeParse(msg.params.arguments).success ? 'INVALID_ARGS' : null;
      if (refusal) {
        const rate = limiter.take(token.id);
        audit(name, msg.params.arguments, rate.ok ? refusal : 'RATE_LIMITED', 0);
        const answer = !rate.ok ? rateLimited(rate.retryInSeconds) : refusal === 'TOOL_NOT_ALLOWED' ? text(refusalMessage(name), true) : null;
        if (answer) {
          if (closed) return gone();
          return reply.code(200).send({ jsonrpc: '2.0', id: msg.id ?? null, result: answer });
        }
      }
    }

    if (closed) return gone();
    transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) reply.raw.setHeader(k, v);
    reply.hijack();
    await transport.handleRequest(request.raw, reply.raw, body);
  });
}
