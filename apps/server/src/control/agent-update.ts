import { followAgentUpdate, type FollowDeps, type HooksRefresh } from '../agent/after-update.js';
import { versionAtLeast } from '../agent/errors.js';
import { belowMinimum, isOutdated, latestAgentRelease, MIN_SELF_UPDATE_VERSION, requestAgentUpdate, runAgentUpdate } from '../agent/latest-version.js';
import { MIN_AGENT_VERSION } from '../agent/min-version.js';
import { agents } from '../agent/registry.js';
import type { Machine } from '../db/repositories/types.js';
import { localizedOf } from '../lib/errors.js';
import { localeOf, msg, t, type Locale } from '../i18n/index.js';
import { ControlError, type ControlContext } from './context.js';

/**
 * The concierge's `update_machine_agent` (TER-1056): the machine screen's Atualizar button for one machine
 * or for all of the person's agent machines, behind the chat's confirmation card. It installs the newest
 * release the server verified (`latestAgentRelease`), waits for the agent to come back on it, refreshes
 * the monitor hooks when they changed (`followAgentUpdate`) and answers the version before and after.
 *
 * The machine this chat runs on is not updated on the spot: the restart would cut the conversation in the
 * middle of the call. It is queued instead (`requestAgentUpdate`) and the scheduler updates it once the
 * chat's answer is over and the machine is idle.
 */

export type AgentUpdateStatus =
  /** installed and the agent is back on the new version */
  | 'updated'
  /** installed, but the agent is not a service: someone restarts it on the machine */
  | 'restart_needed'
  /** installed and restarting, but not back on the new version within the wait */
  | 'not_back'
  /** queued: it runs once the machine is idle (the machine of this chat, see above) */
  | 'scheduled'
  /** already on the newest verified release */
  | 'current'
  | 'offline'
  /** too old to update itself: someone runs npm i -g on the machine */
  | 'too_old'
  | 'failed';

export interface MachineAgentUpdate {
  machine_id: string;
  name: string;
  status: AgentUpdateStatus;
  /** the agent's version before the call (the last one seen when offline) */
  before: string | null;
  /** its version after the call: the same as before when nothing was installed */
  after: string | null;
  below_min_version: boolean;
  hooks?: HooksRefresh;
  /** the machine still dials with the legacy token: offer a new pairing (Parear de novo, on the machine's Agente tab) */
  repair_suggested?: boolean;
  message?: string;
}

const CONFIRM_REQUIRED = () =>
  new ControlError('CONFIRMATION_REQUIRED', msg('Atualizar o agente reinicia o agente na máquina e precisa da confirmação da pessoa no chat. Nada foi alterado: proponha a chamada de novo.'));

/** The machine this chat's conversation runs on: its pinned host, or, unpinned, the person's only agent machine online. */
async function chatHost(ctx: ControlContext, machines: Machine[]): Promise<string | null> {
  const conversationId = ctx.token?.chat_conversation_id;
  if (!conversationId) return null;
  const conversation = await ctx.repos.chat.findByIdForUser(conversationId, ctx.scope.user.id);
  if (!conversation) return null;
  if (conversation.machine_id) return conversation.machine_id;
  const online = machines.filter((m) => m.type === 'agent' && agents.isOnline(m.id));
  return online.length === 1 ? online[0].id : null;
}

async function updateOne(ctx: ControlContext, machine: Machine, host: string | null, locale: Locale, deps: FollowDeps): Promise<MachineAgentUpdate> {
  const info = agents.info(machine.id);
  const before = info?.agent_version ?? machine.agent_version;
  const base = { machine_id: machine.id, name: machine.name, before, after: before, below_min_version: belowMinimum(before) };
  if (!info) return { ...base, status: 'offline', message: t(locale, 'Agente desconectado: ele atualiza quando voltar, se estiver abaixo da versão mínima ou com a atualização automática ligada.') };
  const release = latestAgentRelease();
  if (!release) throw new ControlError('AGENT_LATEST_UNKNOWN', msg('Versão mais nova do agente ainda desconhecida (npm)'));
  if (!isOutdated(info.agent_version, release.version)) return { ...base, status: 'current' };
  if (!versionAtLeast(info.agent_version, MIN_SELF_UPDATE_VERSION)) {
    return { ...base, status: 'too_old', message: t(locale, 'Este agente é antigo demais para se atualizar sozinho; rode na máquina: npm i -g @termhub/agent@latest') };
  }
  if (machine.id === host) {
    requestAgentUpdate(machine.id);
    return { ...base, status: 'scheduled', message: t(locale, 'Este chat roda nesta máquina: a atualização fica para quando a resposta terminar e a máquina estiver ociosa (alguns minutos).') };
  }
  try {
    const r = await runAgentUpdate(machine.id, release, ctx.log ?? console);
    if (!r.restarting) {
      return { ...base, status: 'restart_needed', after: r.installed_version, message: t(locale, 'Instalado; reinicie o agente na máquina (termhub-agent run ou o serviço).') };
    }
  } catch (err) {
    return { ...base, status: 'failed', message: err instanceof Error ? t(locale, localizedOf(err)) : String(err) };
  }
  const after = await followAgentUpdate(ctx.repos, machine, release.version, ctx.log ?? console, deps);
  return {
    ...base,
    status: after.back ? 'updated' : 'not_back',
    after: after.agent_version,
    below_min_version: belowMinimum(after.agent_version ?? before),
    hooks: after.hooks,
    repair_suggested: after.repair_suggested,
  };
}

export async function updateMachineAgent(
  ctx: ControlContext,
  input: { machine_id?: string; all?: boolean },
  deps: FollowDeps = {},
): Promise<{ latest_agent_version: string | null; min_agent_version: string; machines: MachineAgentUpdate[] }> {
  if (!!input.machine_id === (input.all === true)) {
    throw new ControlError('BAD_REQUEST', msg('Passe machine_id ou all: true (um dos dois).'));
  }
  const targets = input.machine_id ? [await ctx.scoped.machine(input.machine_id)] : (await ctx.repos.machines.list(ctx.scope.ownerId)).filter((m) => m.type === 'agent');
  if (input.machine_id && targets[0].type !== 'agent') throw new ControlError('BAD_REQUEST', msg('Só máquinas com agente são atualizadas por aqui'));
  // The gate asks before this runs on the concierge's token; never without the person's card.
  if (ctx.token?.gated && !ctx.approval) throw CONFIRM_REQUIRED();
  const host = await chatHost(ctx, input.machine_id ? await ctx.repos.machines.list(ctx.scope.ownerId) : targets);
  const machines = await Promise.all(targets.map((m) => updateOne(ctx, m, host, localeOf(ctx.scope.user.locale), deps)));
  return { latest_agent_version: latestAgentRelease()?.version ?? null, min_agent_version: MIN_AGENT_VERSION, machines };
}
