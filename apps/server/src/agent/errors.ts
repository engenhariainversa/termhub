import { CAPABILITY_FILE_READ, CAPABILITY_SIM, CAPABILITY_TRANSCRIPT, type RpcMethod, type RpcParams, type RpcResult } from '@termhub/agent-protocol';
import type { Machine } from '../db/repositories/types.js';
import { HttpError } from '../lib/errors.js';
import { msg } from '../i18n/index.js';
import { AgentClosedError, AgentRpcError, AgentTimeoutError } from './connection.js';
import { AgentOfflineError, agents } from './registry.js';

/**
 * Single place that turns an agent connection/RPC failure into the HTTP shape the routes
 * already use. Anything that isn't one of the known agent error classes is rethrown as-is.
 */
export function toHttpError(err: unknown): HttpError {
  if (err instanceof AgentOfflineError || err instanceof AgentClosedError) {
    return new HttpError(503, 'Agente desconectado', 'AGENT_OFFLINE');
  }
  if (err instanceof AgentTimeoutError) {
    return new HttpError(504, 'A máquina não respondeu', 'AGENT_TIMEOUT');
  }
  if (err instanceof AgentRpcError) {
    switch (err.rpcError.code) {
      case 'eperm':
        return new HttpError(403, 'Sem acesso à pasta na máquina (Acesso Total ao Disco?)', 'MACHINE_EPERM');
      case 'notfound':
        return new HttpError(404, 'Não encontrado na máquina', 'MACHINE_NOT_FOUND');
      case 'no_tmux':
        return new HttpError(502, 'tmux não encontrado na máquina', 'NO_TMUX');
      case 'invalid':
        return new HttpError(400, 'Parâmetros inválidos para a máquina', 'MACHINE_INVALID');
      case 'failed':
        // The operation ran on the machine and reported why it failed (a message meant for the user).
        return new HttpError(502, err.rpcError.message, 'MACHINE_FAILED');
      default:
        return new HttpError(502, 'Falha na máquina', 'MACHINE_FAILED');
    }
  }
  throw err;
}

/** `a >= b` for dotted numeric versions ("0.1.4"); a missing component counts as 0. */
export function versionAtLeast(a: string, b: string): boolean {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

/**
 * Refuses, with a message that says what to do, when the connected agent predates an RPC —
 * an older agent drops a method it does not know, which would otherwise surface as a timeout.
 * An offline agent passes through: the RPC itself answers 503.
 */
export function requireAgentVersion(machine: Machine, min: string): void {
  const info = agents.info(machine.id);
  if (info && !versionAtLeast(info.agent_version, min)) {
    throw new HttpError(409, msg('Atualize o agente desta máquina (npm i -g @termhub/agent, versão {{version}} ou mais nova)', { version: min }), 'AGENT_OUTDATED');
  }
}

/** First agent release that advertises `sim` (simulator rpcs + tcp channels). */
export const SIM_MIN_AGENT_VERSION = '0.5.0';

/**
 * The iOS simulator on an agent machine needs the agent online and claiming `sim`. Non-agent machines
 * (ssh/local) pass through: their checks live in the ssh code path. An offline agent is 503 like every
 * other agent call; a connected non-Mac is 400 NOT_MAC; a connected Mac without the capability is
 * told, in one sentence, to update.
 */
export function requireSimCapable(machine: Machine): void {
  if (machine.type !== 'agent') return;
  if (!agents.isOnline(machine.id)) throw new HttpError(503, 'Agente desconectado', 'AGENT_OFFLINE');
  // Updating the agent can never give a Linux/Windows machine a simulator: say what is wrong instead.
  if ((agents.info(machine.id)?.os ?? machine.os) !== 'macos') throw new HttpError(400, 'Esta máquina não é um Mac com Xcode', 'NOT_MAC');
  const capabilities = agents.capabilities(machine.id) ?? [];
  if (!capabilities.includes(CAPABILITY_SIM)) {
    throw new HttpError(409, msg('Atualize o agente desta máquina (npm i -g @termhub/agent, versão {{version}} ou mais nova) para usar o simulador', { version: SIM_MIN_AGENT_VERSION }), 'AGENT_OUTDATED');
  }
}

/** First agent release that advertises `transcript` (`transcript.read` and the `BTab` key). */
export const TRANSCRIPT_MIN_AGENT_VERSION = '0.15.0';

/**
 * Reading a tab's transcript, or pressing Shift+Tab (`BTab`), needs an agent machine whose connected
 * agent claims `transcript` (spec 2026-10-01 tab chat D7): an older agent drops the RPC, which would
 * read as a timeout, and its schema refuses the key.
 */
export function requireTranscriptCapable(machine: Machine): void {
  if (machine.type !== 'agent') throw new HttpError(400, 'Esta máquina não usa o agente do termhub', 'UNSUPPORTED_MACHINE');
  if (!agents.isOnline(machine.id)) throw new HttpError(503, 'Agente desconectado', 'AGENT_OFFLINE');
  if (!(agents.capabilities(machine.id) ?? []).includes(CAPABILITY_TRANSCRIPT)) {
    throw new HttpError(
      409,
      msg('Atualize o agente desta máquina (npm i -g @termhub/agent, versão {{version}} ou mais nova) para abrir a sessão como chat', { version: TRANSCRIPT_MIN_AGENT_VERSION }),
      'AGENT_OUTDATED',
    );
  }
}

/** First agent release that advertises `file_read` (`file.read`, spec 2026-10-04 file preview). */
export const FILE_READ_MIN_AGENT_VERSION = '0.16.0';
export const FILE_READ_OUTDATED_MESSAGE = msg('Atualize o agente desta máquina (npm i -g @termhub/agent, versão {{version}} ou mais nova) para ver arquivos', { version: FILE_READ_MIN_AGENT_VERSION });

/** Previewing a file needs an agent machine whose connected agent claims `file_read`: an older agent
 *  drops the RPC, which would read as a timeout. */
export function requireFileReadCapable(machine: Machine): void {
  if (machine.type !== 'agent') throw new HttpError(400, 'Esta máquina não usa o agente do termhub', 'UNSUPPORTED_MACHINE');
  if (!agents.isOnline(machine.id)) throw new HttpError(503, 'Agente desconectado', 'AGENT_OFFLINE');
  if (!(agents.capabilities(machine.id) ?? []).includes(CAPABILITY_FILE_READ)) throw new HttpError(409, FILE_READ_OUTDATED_MESSAGE, 'AGENT_OUTDATED');
}

/** Calls a named RPC on the machine's agent connection, converting connection/protocol errors via toHttpError. */
export async function agentRpc<M extends RpcMethod>(machine: Machine, method: M, params: RpcParams<M>): Promise<RpcResult<M>> {
  try {
    // A moving agent (a deploy) gets a few seconds to attach; an offline result falls through to
    // `agents.rpc`, which throws AgentOfflineError -> toHttpError -> 503, same as today.
    await agents.awaitAgent(machine);
    return await agents.rpc(machine.id, method, params);
  } catch (err) {
    throw toHttpError(err);
  }
}
