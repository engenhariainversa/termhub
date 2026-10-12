import type { RpcParams, RpcResult } from '@termhub/agent-protocol';
import { AI_LOGIN_HINTS, type AiUsageResult, DEFAULT_CONFIG_DIRS, configDirPrefix, credentialScript, usageFromCredentialOutput } from '@termhub/machine-ops';
import { RpcFailure, sh } from '../exec.js';

/** The credential read itself (disk or macOS keychain); the provider calls have their own 12 s timeouts. */
const READ_TIMEOUT_MS = 10_000;

const cut = (s: string | null, max: number): string | null => (s === null ? null : s.slice(0, max));

/** Clamps a usage result into the `ai.usage` result schema, so an odd provider answer never fails validation. */
export function boundUsageResult(r: AiUsageResult): RpcResult<'ai.usage'> {
  const retry = r.retry_after_ms;
  return {
    ok: r.ok,
    plan: cut(r.plan, 100),
    windows: r.windows.slice(0, 50).map((w) => ({
      key: w.key.slice(0, 200),
      label: w.label.slice(0, 200),
      utilization: Number.isFinite(w.utilization) ? Math.max(0, Math.min(100, w.utilization)) : 0,
      resets_at: cut(w.resets_at, 64),
      ...(w.model !== undefined ? { model: w.model.slice(0, 64) } : {}),
    })),
    error: cut(r.error, 500),
    hint: cut(r.hint, 500),
    ...(r.rate_limited !== undefined ? { rate_limited: r.rate_limited } : {}),
    ...(retry !== undefined ? { retry_after_ms: retry === null || !Number.isFinite(retry) ? null : Math.max(0, retry) } : {}),
  };
}

/**
 * Usage of the AI account whose CLI login lives in `config_dir` (since agent 0.20.0). The credential
 * is read off disk (or the macOS keychain) and used right here to ask the provider: only the numbers
 * go back to the server. Never logs stdout.
 */
export async function usage(params: RpcParams<'ai.usage'>): Promise<RpcResult<'ai.usage'>> {
  let prefix: string;
  try {
    prefix = configDirPrefix(params.config_dir, DEFAULT_CONFIG_DIRS[params.provider]);
  } catch (err) {
    throw new RpcFailure('invalid', err instanceof Error ? err.message : 'invalid config dir');
  }
  const fail = (error: string, hint: string | null = null): RpcResult<'ai.usage'> => ({ ok: false, plan: null, windows: [], error, hint });
  const r = await sh(`${prefix}; ${credentialScript(params.provider)}`, { timeoutMs: READ_TIMEOUT_MS });
  if (r.timedOut) return fail('Machine did not answer in time');
  if (r.code !== 0) return fail('Could not read the credential on the machine', AI_LOGIN_HINTS[params.provider]);
  return boundUsageResult(await usageFromCredentialOutput(params.provider, r.stdout));
}
