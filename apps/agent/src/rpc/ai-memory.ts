import type { RpcParams, RpcResult } from '@termhub/agent-protocol';
import { buildAiMemoryPagesScript, shellQuote } from '@termhub/machine-ops';
import { RpcFailure, sh } from '../exec.js';

/** Under the RPC's own 20 s: `ai-memory status` may take a moment to answer. */
const SCRIPT_TIMEOUT_MS = 15_000;

/**
 * The script always exits 0 and reports expected failures (no wiki, missing cwd, …) as `ERR:` lines
 * that the server reads, so stdout goes back unchanged; only a timeout or an unexpected exit code
 * becomes an RpcFailure (same split as docs.ts).
 */
export async function pages(params: RpcParams<'aimemory.pages'>): Promise<RpcResult<'aimemory.pages'>> {
  const r = await sh(buildAiMemoryPagesScript(shellQuote(params.cwd)), { timeoutMs: SCRIPT_TIMEOUT_MS });
  if (r.timedOut) throw new RpcFailure('timeout', 'aimemory.pages timed out');
  if (r.code !== 0) throw new RpcFailure('internal', `aimemory.pages exited with code ${r.code}`);
  return { stdout: r.stdout };
}
