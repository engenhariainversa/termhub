import type { RpcParams, RpcResult } from '@termhub/agent-protocol';
import { buildAiMemoryPagesScript, buildAiMemoryRulesScript, buildAiMemoryStatusScript, parseAiMemoryStatus, shellQuote } from '@termhub/machine-ops';
import { RpcFailure, sh } from '../exec.js';

/** Under the RPC's own 20 s: `ai-memory status` may take a moment to answer. */
const PAGES_TIMEOUT_MS = 15_000;

/** The protocol schema already refused any URL off loopback/private networks; the parsed tags are all that leave. */
export async function status(params: RpcParams<'aimemory.status'>): Promise<RpcResult<'aimemory.status'>> {
  const r = await sh(buildAiMemoryStatusScript(shellQuote(params.url)), { timeoutMs: 14_000 });
  if (r.timedOut) throw new RpcFailure('timeout', 'aimemory.status timed out');
  if (r.code !== 0) throw new RpcFailure('internal', `aimemory.status exited with code ${r.code}`);
  return parseAiMemoryStatus(r.stdout);
}

/**
 * Current rules as pinned ai-memory pages (TER-1019). The script quotes every value itself, always exits
 * 0 and reports skips and per-page outcomes as tagged stdout lines, which the server reads back — so
 * stdout goes back unchanged. Only a process-level failure (timeout, a non-zero exit) is an RpcFailure.
 */
export async function rulesSync(params: RpcParams<'ai_memory.rules.sync'>): Promise<RpcResult<'ai_memory.rules.sync'>> {
  const r = await sh(buildAiMemoryRulesScript(params), { timeoutMs: 55_000 });
  if (r.timedOut) throw new RpcFailure('timeout', 'ai_memory.rules.sync timed out');
  if (r.code !== 0) throw new RpcFailure('internal', `ai_memory.rules.sync exited with code ${r.code}`);
  return { stdout: r.stdout };
}

/**
 * The deliberate ai-memory pages of a checkout (TER-1021). The script always exits 0 and reports
 * expected failures (no wiki, missing cwd, …) as `ERR:` lines that the server reads, so stdout goes
 * back unchanged; only a timeout or an unexpected exit code becomes an RpcFailure (same split as docs.ts).
 */
export async function pages(params: RpcParams<'aimemory.pages'>): Promise<RpcResult<'aimemory.pages'>> {
  const r = await sh(buildAiMemoryPagesScript(shellQuote(params.cwd)), { timeoutMs: PAGES_TIMEOUT_MS });
  if (r.timedOut) throw new RpcFailure('timeout', 'aimemory.pages timed out');
  if (r.code !== 0) throw new RpcFailure('internal', `aimemory.pages exited with code ${r.code}`);
  return { stdout: r.stdout };
}
