import {
  AI_LOGIN_HINTS,
  DEFAULT_CONFIG_DIRS,
  configDirPrefix,
  credentialScript,
  parseUsageScriptOutput,
  queryUsage,
  usageFromCredentialOutput,
  usageRequestScript,
  type AiUsageResult,
  type UsageContext,
  type UsageHttp,
  type UsageReply,
} from '@termhub/machine-ops';
import { AgentClosedError, AgentRpcError, AgentTimeoutError } from '../agent/connection.js';
import { AI_USAGE_MIN_AGENT_VERSION, toHttpError, versionAtLeast } from '../agent/errors.js';
import { AgentOfflineError, agents } from '../agent/registry.js';
import type { AiAccount, AiProvider, Machine } from '../db/repositories/types.js';
import { runOnMachine } from '../terminal/machine-exec.js';

export type { AiUsageResult, AiUsageWindow } from '@termhub/machine-ops';

export interface AiAccountUsage extends AiUsageResult {
  account_id: string;
  fetched_at: string;
  /** the last successful reading, kept because the provider is currently rate-limiting us */
  stale?: boolean;
  /**
   * Why there is no reading, when it is not an error to fix on the provider side (the web shows a
   * neutral note): the query is turned off on the machine, or its agent predates `ai.usage`.
   */
  reason?: 'disabled' | 'agent_outdated';
}

/** Providers rate-limit their usage endpoints; one query per account every few minutes is plenty for 5 h / 7 d windows. */
const CACHE_TTL_MS = 5 * 60_000;
/** A manual refresh (↻) still cannot hit the provider more often than this. */
const MIN_REFRESH_MS = 30_000;
/** After a 429 without Retry-After, wait this long before asking again. */
const RATE_LIMIT_BACKOFF_MS = 10 * 60_000;
/** One SSH exec per provider request: connect + credential + curl (-m 12). */
const SSH_REQUEST_TIMEOUT_MS = 20_000;
/** Reading the credential on the server's own host. */
const LOCAL_TIMEOUT_MS = 10_000;

interface Entry {
  result: AiAccountUsage;
  /** last time the provider was actually asked */
  asked_at: number;
  /** do not ask the provider again before this time (rate-limit back-off) */
  blocked_until: number;
  /** last ok result, reused while rate-limited */
  last_ok: AiAccountUsage | null;
}
const cache = new Map<string, Entry>();

/** A failure found before (or instead of) the provider's answer; becomes `{ ok: false, error, hint }`. */
class UsageError extends Error {
  constructor(
    message: string,
    public hint: string | null = null,
  ) {
    super(message);
  }
}

/**
 * Usage for one account. The CLI credential is read and used on the machine that holds it (spec
 * 2026-10-07 ai-usage-on-machine): the agent answers `ai.usage`, an SSH machine runs curl itself and
 * sends back only the provider's response, and the server's own host is queried in-process.
 * Cached per account; `refresh` shortens the cache to MIN_REFRESH_MS but never bypasses a
 * rate-limit back-off. While rate-limited, the last successful reading is returned as stale.
 * A machine with `ai_usage_query` off is never contacted; that answer is not cached, so turning the
 * switch back on takes effect on the next reading.
 */
export async function getAccountUsage(account: AiAccount, machine: Machine | undefined, refresh = false): Promise<AiAccountUsage> {
  const now = Date.now();
  const fetched_at = new Date(now).toISOString();
  const fail = (error: string, hint: string | null = null): AiAccountUsage => ({ account_id: account.id, fetched_at, ok: false, plan: null, windows: [], error, hint });

  if (machine?.ai_usage_query === false) return { ...fail('Usage query turned off on this machine'), reason: 'disabled' };

  const entry = cache.get(account.id);
  if (entry) {
    const age = now - entry.asked_at;
    if (now < entry.blocked_until || age < (refresh ? MIN_REFRESH_MS : CACHE_TTL_MS)) return entry.result;
  }

  let result: AiAccountUsage;
  if (!machine) result = fail('Machine no longer exists');
  else {
    try {
      const usage = await queryOnMachine(machine, account.provider, account.config_dir);
      result = { account_id: account.id, fetched_at, ...usage };
    } catch (err) {
      if (err instanceof UsageError) result = fail(err.message, err.hint);
      else if (err instanceof Error && err.name === 'TimeoutError') result = fail('Provider did not answer in time');
      else result = fail(err instanceof Error ? err.message : 'Unknown error');
    }
  }

  let blocked_until = 0;
  const last_ok = result.ok ? result : (entry?.last_ok ?? null);
  if (result.rate_limited) {
    blocked_until = now + (result.retry_after_ms ?? RATE_LIMIT_BACKOFF_MS);
    // keep the bars on screen: the old numbers beat an error box
    if (last_ok) result = { ...last_ok, stale: true, hint: result.hint };
  }
  cache.set(account.id, { result, asked_at: now, blocked_until, last_ok });
  return result;
}

export function forgetAccountUsage(accountId: string): void {
  cache.delete(accountId);
}

/** Usage (or a failure) from the machine that holds the credential; throws UsageError for known failures. */
async function queryOnMachine(machine: Machine, provider: AiProvider, configDir: string | null): Promise<AiUsageResult & { reason?: 'agent_outdated' }> {
  if (machine.type === 'agent') return queryOverAgent(machine, provider, configDir);
  if (machine.type === 'ssh') return queryOverSsh(machine, provider, configDir);
  return queryLocally(machine, provider, configDir);
}

async function queryOverAgent(machine: Machine, provider: AiProvider, configDir: string | null): Promise<AiUsageResult & { reason?: 'agent_outdated' }> {
  const info = agents.isOnline(machine.id) ? agents.info(machine.id) : null;
  if (!info) throw new UsageError('Agente desconectado');
  if (!versionAtLeast(info.agent_version, AI_USAGE_MIN_AGENT_VERSION)) {
    // No fallback: older agents could only hand the credential itself over, which the server no longer asks for.
    return {
      ok: false,
      plan: null,
      windows: [],
      error: 'Update the agent on this machine to see usage',
      hint: `npm i -g @termhub/agent (${AI_USAGE_MIN_AGENT_VERSION} or newer)`,
      reason: 'agent_outdated',
    };
  }
  try {
    return await agents.rpc(machine.id, 'ai.usage', { provider, config_dir: configDir });
  } catch (err) {
    if (err instanceof AgentOfflineError || err instanceof AgentClosedError) throw new UsageError('Agente desconectado');
    if (err instanceof AgentTimeoutError) throw new UsageError('Machine did not answer in time');
    // Never forward the agent-supplied rpcError.message (up to 2000 chars, may echo a path):
    // route it through the same fixed per-code mapping every other RPC caller uses.
    if (err instanceof AgentRpcError) throw new UsageError(toHttpError(err).message);
    throw err;
  }
}

/**
 * Over SSH the server cannot run code on the machine: each provider request is one exec of
 * usageRequestScript, which reads the credential and calls curl there. Only the meta block (expiry,
 * plan) and the provider's response come back, never the token.
 */
async function queryOverSsh(machine: Machine, provider: AiProvider, configDir: string | null): Promise<AiUsageResult> {
  const replies: UsageReply[] = [];
  const seen: { meta: UsageContext | null } = { meta: null };
  const live: UsageHttp = async (req) => {
    let script: string;
    try {
      script = usageRequestScript(provider, configDir, req);
    } catch (err) {
      throw new UsageError(err instanceof Error ? err.message : 'Invalid config dir');
    }
    const r = await runOnMachine(machine, { file: '/bin/sh', args: ['-c', script] }, script, SSH_REQUEST_TIMEOUT_MS);
    if (r.timedOut) throw new UsageError('Machine did not answer in time');
    if (r.code !== 0) throw new UsageError('Machine unreachable over SSH');
    const out = parseUsageScriptOutput(r.stdout);
    if (out.kind === 'no_credential') throw new UsageError('No credential found on the machine', AI_LOGIN_HINTS[provider]);
    if (out.kind === 'no_curl') throw new UsageError('curl is not installed on the machine', 'Install curl to see usage on SSH machines');
    if (out.kind === 'invalid') throw new UsageError('Unexpected answer from the machine');
    // curl prints 000 when it got no HTTP answer at all (timeout, DNS, TLS)
    if (out.reply.status === 0) throw new UsageError('Provider did not answer in time');
    seen.meta ??= out.meta;
    replies.push(out.reply);
    return out.reply;
  };

  // The adapters need the credential's expiry and plan before their first request, but over SSH those
  // only arrive with the first reply. So: ask once without them, then, when the machine reported any,
  // run the adapter again with the real context, replaying the replies already received (the adapters
  // are deterministic given the same replies), so an expired token or the plan read as on the machine.
  const first = await queryUsage(provider, { plan: null, expires_at: null }, live);
  const ctx = seen.meta;
  if (!ctx || (ctx.plan === null && ctx.expires_at === null)) return first;
  let i = 0;
  const replay: UsageHttp = (req) => (i < replies.length ? Promise.resolve(replies[i++]) : live(req));
  return queryUsage(provider, ctx, replay);
}

/** The server's own host: the credential never leaves it, so it is read and used in-process, like the agent does. */
async function queryLocally(machine: Machine, provider: AiProvider, configDir: string | null): Promise<AiUsageResult> {
  let setD: string;
  try {
    setD = configDirPrefix(configDir, DEFAULT_CONFIG_DIRS[provider]);
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : 'Invalid config dir');
  }
  const script = `${setD}; ${credentialScript(provider)}`;
  const r = await runOnMachine(machine, { file: '/bin/sh', args: ['-c', script] }, script, LOCAL_TIMEOUT_MS);
  if (r.timedOut) throw new UsageError('Machine did not answer in time');
  if (r.code !== 0) throw new UsageError('Could not read the credential on the machine');
  return usageFromCredentialOutput(provider, r.stdout);
}
