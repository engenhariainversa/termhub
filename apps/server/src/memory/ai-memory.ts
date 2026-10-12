import { AI_MEMORY_DEFAULT_URL } from '@termhub/agent-protocol';
import { REMOTE_PATH_PREFIX, buildAiMemoryStatusScript, parseAiMemoryStatus, type AiMemoryProbe } from '@termhub/machine-ops';
import type { Machine } from '../db/repositories/types.js';
import { agentRpc, requireAgentVersion } from '../agent/errors.js';
import { HttpError } from '../lib/errors.js';
import { runOnMachine, shellQuote } from '../terminal/machine-exec.js';

/** First agent release that answers `aimemory.status` (TER-1018). */
export const AI_MEMORY_MIN_AGENT_VERSION = '0.27.0';

export type AiMemoryState =
  | { enabled: false; url: string }
  | ({ enabled: true; url: string; checked_at: string } & AiMemoryProbe);

/** The URL the probe uses: the machine's own, or the default port of `ai-memory serve`. */
export function aiMemoryUrlOf(machine: Pick<Machine, 'ai_memory_url'>): string {
  return machine.ai_memory_url ?? AI_MEMORY_DEFAULT_URL;
}

/**
 * Asks the machine whether ai-memory is there and its server answers. Agent machines go through the
 * `aimemory.status` RPC; legacy local/ssh ones run the same script with `runOnMachine`. Either way only
 * the three parsed facts come back — never what ai-memory stores.
 */
export async function probeAiMemory(machine: Machine): Promise<AiMemoryProbe> {
  const url = aiMemoryUrlOf(machine);
  if (machine.type === 'agent') {
    requireAgentVersion(machine, AI_MEMORY_MIN_AGENT_VERSION);
    return agentRpc(machine, 'aimemory.status', { url });
  }
  const script = buildAiMemoryStatusScript(shellQuote(url));
  const r = await runOnMachine(machine, { file: '/bin/sh', args: ['-lc', script] }, `${REMOTE_PATH_PREFIX}${script}`, 15_000);
  if (r.code !== 0) throw new HttpError(502, 'A máquina não respondeu', 'MACHINE_FAILED');
  return parseAiMemoryStatus(r.stdout);
}

/** What Máquinas shows. A machine that never opted in is not contacted at all. */
export async function aiMemoryState(machine: Machine): Promise<AiMemoryState> {
  const url = aiMemoryUrlOf(machine);
  if (!machine.ai_memory_enabled) return { enabled: false, url };
  const probe = await probeAiMemory(machine);
  return { enabled: true, url, checked_at: new Date().toISOString(), ...probe };
}
