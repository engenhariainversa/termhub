import type { RpcParams, RpcResult } from '@termhub/agent-protocol';
import { buildAiMemoryRulesScript, buildAiMemoryStatusScript, parseAiMemoryStatus, shellQuote } from '@termhub/machine-ops';
import { RpcFailure, sh } from '../exec.js';

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
