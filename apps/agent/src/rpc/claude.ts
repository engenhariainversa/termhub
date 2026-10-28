import os from 'node:os';
import type { RpcParams, RpcResult } from '@termhub/agent-protocol';
import { claudeLinkScript, parseClaudeLinkStatus } from '@termhub/machine-ops';
import { trustFolder as markTrusted } from '../claude-trust.js';
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

/** Marks a folder trusted in every Claude account of this machine before Claude Code opens it (TER-1148). */
export async function trustFolder(params: RpcParams<'claude.trustFolder'>, home = os.homedir()): Promise<RpcResult<'claude.trustFolder'>> {
  const changed = await markTrusted(params.dir, home, params.config_dirs ?? []);
  if (changed === null) throw new RpcFailure('notfound', 'not a folder on this machine');
  return { changed };
}
