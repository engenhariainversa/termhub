import type { RpcParams } from '@termhub/agent-protocol';
import { AgentClosedError, AgentRpcError, AgentTimeoutError } from '../agent/connection.js';
import { requireAgentVersion } from '../agent/errors.js';
import { AgentOfflineError, agents } from '../agent/registry.js';
import type { Machine } from '../db/repositories/types.js';
import { HttpError } from '../lib/errors.js';
import { msg } from '../i18n/index.js';

export type SecretSource = RpcParams<'secret.read'>['source'];

/** First agent release that answers `secret.read` (spec 2026-09-28 MCP integrations D8). */
export const SECRET_MIN_AGENT_VERSION = '0.9.0';

/** A token as a provider takes it: one word, bounded like the integration route's `secret`. */
const SECRET_SHAPE = /^\S{1,4096}$/;

/**
 * Reads a secret the machine already holds (today only its `gh auth token`) through the agent, for
 * the caller to store encrypted. The value never reaches a log or an error: every failure answers a
 * fixed pt-BR message that names the machine, never the agent's own text (like the AI usage query, ai/index.ts).
 * Agent machines only: an ssh/local machine would need a shell script, and D2 keeps this to the one
 * reviewed RPC. An agent older than 0.9.0 drops the unknown method (a full timeout), so the version
 * is checked first.
 */
export async function readMachineSecret(machine: Machine, source: SecretSource): Promise<string> {
  if (machine.type !== 'agent') {
    throw new HttpError(
      400,
      msg('A máquina {{machine}} não está conectada pelo agente do termhub; só dá para ler o login do gh de uma máquina com o agente', { machine: machine.name }),
      'UNSUPPORTED_MACHINE',
    );
  }
  const offline = () => new HttpError(503, msg('A máquina {{machine}} está desconectada', { machine: machine.name }), 'MACHINE_OFFLINE');
  // an agent moving between instances (a deploy) gets a few seconds to attach before it is called offline
  if (!(await agents.awaitAgent(machine))) throw offline();
  requireAgentVersion(machine, SECRET_MIN_AGENT_VERSION);
  const unavailable = () => new HttpError(502, msg('`gh auth token` falhou na máquina {{machine}}: rode `gh auth login` nela', { machine: machine.name }), 'SECRET_UNAVAILABLE');
  let value: string;
  try {
    ({ value } = await agents.rpc(machine.id, 'secret.read', { source }));
  } catch (err) {
    if (err instanceof AgentOfflineError || err instanceof AgentClosedError) throw offline();
    if (err instanceof AgentTimeoutError) throw new HttpError(504, msg('A máquina {{machine}} não respondeu a tempo', { machine: machine.name }), 'AGENT_TIMEOUT');
    if (err instanceof AgentRpcError) {
      if (err.rpcError.code === 'failed') throw unavailable();
      throw new HttpError(502, msg('Falha ao ler o login do gh na máquina {{machine}}', { machine: machine.name }), 'MACHINE_FAILED');
    }
    throw err;
  }
  if (!SECRET_SHAPE.test(value)) throw unavailable();
  return value;
}
