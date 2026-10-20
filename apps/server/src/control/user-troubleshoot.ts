import type { FastifyBaseLogger } from 'fastify';
import type { HookEntriesState, HooksStatus } from '@termhub/machine-ops';
import { z } from 'zod';
import { agents } from '../agent/registry.js';
import { belowMinimum, latestAgentVersion } from '../agent/latest-version.js';
import type { Repositories } from '../db/repositories/index.js';
import type { Machine } from '../db/repositories/types.js';
import type { SupportWindow } from '../db/repositories/support.js';
import { readHooksStatus } from '../monitor/install.js';
import { claudeAccountDirs } from '../monitor/machine-hooks.js';
import { msg } from '../i18n/index.js';
import { isAdmin } from '../auth/permissions.js';
import { ControlError, type ControlContext } from './context.js';

/**
 * Admin troubleshooting of one user (TER-1092): a handful of read-only views of their technical metadata,
 * for support to diagnose a report without opening the production database. Shared by the HTTP routes
 * (`routes/admin-troubleshoot.ts`) and the concierge's `admin_user_troubleshoot` MCP tool; both check that
 * the caller is an admin before reaching here.
 *
 * Every call carries a reason and is written to the security trail (`support.troubleshoot`) BEFORE any
 * data is read: if the trail cannot be written, nothing is answered. The views never carry message,
 * prompt or answer content, terminal screens, attachments, e-mail, tokens or IPs (see `SupportRepository`).
 */

export const TROUBLESHOOT_ENDPOINTS = ['search', 'requests', 'tabs', 'machines', 'errors', 'client'] as const;
export type TroubleshootEndpoint = (typeof TROUBLESHOOT_ENDPOINTS)[number];

const HOUR_MS = 3600_000;
export const TROUBLESHOOT_DEFAULT_HOURS = 12;
export const TROUBLESHOOT_MAX_DAYS = 7;
const MAX_WINDOW_MS = TROUBLESHOOT_MAX_DAYS * 24 * HOUR_MS;
export const TROUBLESHOOT_REQUESTS_MAX = 1000;
const LIST_LIMIT = 200;
const SEARCH_LIMIT = 10;
/** How long one machine's live hooks read may take before it is reported as unanswered. */
const HOOKS_TIMEOUT_MS = 8_000;

/** The reason an admin gives for a query ("TER-1091", "relato do Humberto"): short text, kept on the trail. */
export const troubleshootReason = z.string().trim().min(3).max(200);
/** A route prefix to filter requests by (`/api/tabs`); a pattern, never a query string. */
export const troubleshootRoutePrefix = z.string().trim().min(1).max(200).regex(/^\/[^?#\s]*$/);

export interface TroubleshootActor {
  id: string;
  email: string;
  ip: string | null;
  /** where the query came from: the HTTP API (the admin's own session) or the MCP tool */
  via: 'api' | 'mcp';
}

export interface TroubleshootInput {
  endpoint: TroubleshootEndpoint;
  reason: string;
  /** the user under diagnosis (every endpoint but `search`) */
  user_id?: string;
  /** a name or e-mail to look for (`search` only) */
  query?: string;
  from?: Date;
  to?: Date;
  route_prefix?: string;
  limit?: number;
}

export interface TroubleshootDeps {
  repos: Repositories;
  log?: Pick<FastifyBaseLogger, 'warn'>;
  /** the live hooks read of one machine; defaults to the agent's `hooks.status` (tests replace it) */
  readHooks?: (machine: Machine) => Promise<HooksStatus>;
  now?: () => Date;
}

/** The window: up to `to` (default now), from `from` (default 12 h before `to`), at most 7 days long. */
export function troubleshootWindow(input: { from?: Date; to?: Date }, now = new Date()): SupportWindow {
  const to = input.to ?? now;
  const from = input.from ?? new Date(to.getTime() - TROUBLESHOOT_DEFAULT_HOURS * HOUR_MS);
  if (!(from.getTime() < to.getTime())) throw new ControlError('INVALID_WINDOW', 'Janela inválida: o início precisa vir antes do fim');
  if (to.getTime() - from.getTime() > MAX_WINDOW_MS) throw new ControlError('WINDOW_TOO_LONG', msg('Janela longa demais: no máximo {{days}} dias', { days: TROUBLESHOOT_MAX_DAYS }));
  return { from, to };
}

interface HooksView {
  installed_at: string | null;
  /** live: read from the agent now; offline/not_agent: not read; unanswered: the read failed or timed out */
  read: 'live' | 'offline' | 'not_agent' | 'unanswered';
  error_code?: string;
  script?: { installed: boolean; outdated: boolean };
  claude?: { present: boolean; state: HookEntriesState };
  codex?: { present: boolean; state: HookEntriesState; notify: boolean; trusted: HooksStatus['codex']['trusted'] };
  cursor?: { present: boolean; state: HookEntriesState };
}

/** The states per CLI, as `get_machine_hooks` answers them, minus the config dirs (paths name the person's home). */
function hooksView(s: HooksStatus): Pick<HooksView, 'script' | 'claude' | 'codex' | 'cursor'> {
  return {
    script: { installed: s.script.installed, outdated: s.script.outdated },
    claude: { present: s.claude.present, state: s.claude.state },
    codex: { present: s.codex.present, state: s.codex.state, notify: s.codex.notify, trusted: s.codex.trusted },
    cursor: { present: s.cursor.present, state: s.cursor.state },
  };
}

const errorCodeOf = (err: unknown): string => {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code ? code : 'ERROR';
};

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })), ms);
    p.then(
      (v) => (clearTimeout(timer), resolve(v)),
      (e) => (clearTimeout(timer), reject(e)),
    );
  });
}

async function machinesOf(deps: TroubleshootDeps, userId: string) {
  const { repos } = deps;
  const machines = await repos.machines.list(userId);
  const installed = await repos.machineHooks.installedAtByMachine(machines.map((m) => m.id));
  const readHooks = deps.readHooks ?? (async (m: Machine) => readHooksStatus(m, await claudeAccountDirs(repos, m.id)));
  return Promise.all(
    machines.map(async (m) => {
      const online = m.type === 'agent' ? agents.isOnline(m.id) : null;
      const agent_version = m.type === 'agent' ? (agents.info(m.id)?.agent_version ?? m.agent_version) : null;
      let hooks: HooksView = { installed_at: installed[m.id] ?? null, read: m.type !== 'agent' ? 'not_agent' : online ? 'live' : 'offline' };
      // Only an online agent is asked: an ssh or local machine would mean running commands on it.
      if (hooks.read === 'live') {
        try {
          hooks = { ...hooks, ...hooksView(await withTimeout(readHooks(m), HOOKS_TIMEOUT_MS)) };
        } catch (err) {
          hooks = { ...hooks, read: 'unanswered', error_code: errorCodeOf(err) };
        }
      }
      return {
        machine_id: m.id,
        name: m.name,
        type: m.type,
        os: m.os,
        online,
        agent_version,
        below_min_version: m.type === 'agent' ? belowMinimum(agent_version) : undefined,
        agent_last_seen_at: m.agent_last_seen_at,
        agent_auto_update: m.agent_auto_update,
        hooks,
      };
    }),
  );
}

/** Writes the query to the trail; throws (and nothing is read) when it cannot be written. */
async function auditQuery(deps: TroubleshootDeps, actor: TroubleshootActor, input: TroubleshootInput, target: { id: string; name: string } | null, extra: Record<string, unknown>): Promise<void> {
  await deps.repos.securityEvents.record({
    actor_id: actor.id,
    actor_email: actor.email,
    action: 'support.troubleshoot',
    target_type: target ? 'user' : null,
    target_id: target?.id ?? null,
    target_label: target?.name ?? null,
    ip: actor.ip,
    meta: { endpoint: input.endpoint, reason: input.reason, via: actor.via, ...extra },
  });
}

/** One troubleshooting query: audited first, then answered. */
export async function troubleshoot(deps: TroubleshootDeps, actor: TroubleshootActor, input: TroubleshootInput) {
  const { repos } = deps;
  const now = deps.now?.() ?? new Date();

  if (input.endpoint === 'search') {
    const query = input.query?.trim();
    if (!query) throw new ControlError('QUERY_REQUIRED', 'Informe o nome ou e-mail a procurar');
    const users = await repos.support.searchUsers(query, SEARCH_LIMIT);
    // The trail keeps who was found, by id; the text searched (often an e-mail) is not kept.
    await auditQuery(deps, actor, input, null, { found: users.map((u) => u.user_id) });
    return { endpoint: input.endpoint, users };
  }

  if (!input.user_id) throw new ControlError('USER_REQUIRED', 'Informe o usuário (user_id); procure-o com search');
  const user = await repos.support.findUser(input.user_id);
  if (!user) throw new ControlError('USER_NOT_FOUND', 'Usuário não encontrado');
  const window = input.endpoint === 'machines' ? null : troubleshootWindow(input, now);
  const span = window ? { from: window.from.toISOString(), to: window.to.toISOString() } : {};
  await auditQuery(deps, actor, input, user, { ...span, ...(input.route_prefix ? { route_prefix: input.route_prefix } : {}) });

  const base = { endpoint: input.endpoint, user: { user_id: user.id, name: user.name }, ...span };
  switch (input.endpoint) {
    case 'requests': {
      const limit = Math.min(input.limit ?? LIST_LIMIT, TROUBLESHOOT_REQUESTS_MAX);
      const rows = await repos.support.requests(user.id, window!, input.route_prefix, limit + 1);
      return { ...base, requests: rows.slice(0, limit), truncated: rows.length > limit };
    }
    case 'tabs': {
      const rows = await repos.support.tabs(user.id, window!, LIST_LIMIT + 1);
      return { ...base, tabs: rows.slice(0, LIST_LIMIT), truncated: rows.length > LIST_LIMIT };
    }
    case 'errors': {
      const rows = await repos.support.errors(user.id, window!, LIST_LIMIT + 1);
      return { ...base, errors: rows.slice(0, LIST_LIMIT), truncated: rows.length > LIST_LIMIT };
    }
    case 'client': {
      const [clients, devices] = await Promise.all([repos.support.clients(user.id, window!), repos.support.devices(user.id)]);
      return { ...base, clients, devices };
    }
    case 'machines':
      return { ...base, latest_agent_version: latestAgentVersion(), machines: await machinesOf(deps, user.id) };
  }
}

/**
 * `admin_user_troubleshoot` (TER-1092): the same views for the concierge. The tool is listed only to an
 * admin (`allowedIf`), and checked again here; on the chat's token the gate asks the person on the first
 * query about each user in a conversation (chat/gate-runtime.ts).
 */
export async function troubleshootTool(ctx: ControlContext, args: Record<string, unknown>) {
  if (!(await isAdmin(ctx.repos, ctx.scope.user))) throw new ControlError('FORBIDDEN', 'Só administradores podem consultar dados de suporte');
  const date = (v: unknown) => (typeof v === 'string' ? new Date(v) : undefined);
  const user = ctx.scope.user;
  return troubleshoot({ repos: ctx.repos, log: ctx.log }, { id: user.id, email: user.email, ip: null, via: 'mcp' }, {
    endpoint: args.endpoint as TroubleshootEndpoint,
    reason: args.reason as string,
    user_id: args.user_id as string | undefined,
    query: args.query as string | undefined,
    from: date(args.from),
    to: date(args.to),
    route_prefix: args.route_prefix as string | undefined,
    limit: args.limit as number | undefined,
  });
}
