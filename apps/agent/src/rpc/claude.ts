import type { RpcParams, RpcResult } from '@termhub/agent-protocol';
import { claudeLinkScript, parseClaudeLinkStatus } from '@termhub/machine-ops';
import { RpcFailure, sh } from '../exec.js';

/** Makes a Claude session resumable under another account of this machine (spec 2026-09-26 account swap). */
export async function linkSession(params: RpcParams<'claude.linkSession'>): Promise<RpcResult<'claude.linkSession'>> {
  let script: string;
  try {
    script = claudeLinkScript(params.transcript_path, params.session_id, params.config_dir);
  } catch (err) {
    throw new RpcFailure('invalid', err instanceof Error ? err.message : 'invalid config dir');
  }
  const r = await sh(script);
  if (r.timedOut) throw new RpcFailure('timeout', 'claude.linkSession timed out');
  const status = parseClaudeLinkStatus(r.stdout);
  if (r.code !== 0 || !status) throw new RpcFailure('internal', `claude.linkSession exited with code ${r.code}`);
  return { status };
}
