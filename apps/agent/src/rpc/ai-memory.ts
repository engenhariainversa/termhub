import type { RpcParams, RpcResult } from '@termhub/agent-protocol';
import { buildAiMemoryStatusScript, parseAiMemoryStatus, shellQuote } from '@termhub/machine-ops';
import { RpcFailure, sh } from '../exec.js';

/** The protocol schema already refused any URL off loopback/private networks; the parsed tags are all that leave. */
export async function status(params: RpcParams<'aimemory.status'>): Promise<RpcResult<'aimemory.status'>> {
  const r = await sh(buildAiMemoryStatusScript(shellQuote(params.url)), { timeoutMs: 14_000 });
  if (r.timedOut) throw new RpcFailure('timeout', 'aimemory.status timed out');
  if (r.code !== 0) throw new RpcFailure('internal', `aimemory.status exited with code ${r.code}`);
  return parseAiMemoryStatus(r.stdout);
}
