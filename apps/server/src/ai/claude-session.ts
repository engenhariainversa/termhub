import { claudeLinkScript, parseClaudeLinkStatus, type ClaudeLinkStatus } from '@termhub/machine-ops';
import { agentRpc, requireAgentVersion } from '../agent/errors.js';
import { ControlError } from '../control/context.js';
import type { Machine } from '../db/repositories/types.js';
import { runOnMachine } from '../terminal/machine-exec.js';

/** The agent release that answers claude.linkSession. */
export const CLAUDE_LINK_MIN_AGENT_VERSION = '0.6.0';

/**
 * Makes a Claude session resumable under another account of the machine (see machine-ops
 * claude-session.ts): the agent does it through its RPC, a local/ssh machine runs the same script.
 */
export async function linkClaudeSession(machine: Machine, input: { transcriptPath: string; sessionId: string; configDir: string | null }): Promise<ClaudeLinkStatus> {
  if (machine.type === 'agent') {
    requireAgentVersion(machine, CLAUDE_LINK_MIN_AGENT_VERSION);
    const { status } = await agentRpc(machine, 'claude.linkSession', { transcript_path: input.transcriptPath, session_id: input.sessionId, config_dir: input.configDir });
    return status;
  }
  const script = claudeLinkScript(input.transcriptPath, input.sessionId, input.configDir);
  const r = await runOnMachine(machine, { file: '/bin/sh', args: ['-c', script] }, script, 10_000);
  const status = r.timedOut ? null : parseClaudeLinkStatus(r.stdout);
  if (!status) throw new ControlError('LINK_FAILED', 'Não foi possível preparar a sessão na outra conta desta máquina');
  return status;
}
