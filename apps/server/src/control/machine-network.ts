import type { MachineNetwork } from '@termhub/agent-protocol';
import { agents } from '../agent/registry.js';
import { wakeMachine, wakeRelays, type WakeRelay, type WakeResult } from '../agent/network.js';
import { localeOf, t } from '../i18n/index.js';
import type { ControlContext } from './context.js';

/**
 * The machine screen's network card, for the concierge (TER-1080): `get_machine_network` reads what the
 * agent last reported (IPs, MACs, default interface), `wake_machine` sends the Wake-on-LAN packet through
 * another machine of the same network, as the "Acordar" button does.
 */

export interface MachineNetworkView {
  machine_id: string;
  name: string;
  online: boolean;
  /** null: no agent 0.30.0+ reported it yet */
  network: MachineNetwork | null;
  updated_at: string | null;
  relays: WakeRelay[];
}

export async function getMachineNetwork(ctx: ControlContext, input: { machine_id: string }): Promise<MachineNetworkView> {
  const machine = await ctx.scoped.machine(input.machine_id);
  const machines = await ctx.repos.machines.list(ctx.scope.ownerId);
  const nets = await ctx.repos.machines.networks(machines.filter((m) => m.type === 'agent').map((m) => m.id));
  const saved = nets.get(machine.id) ?? null;
  return {
    machine_id: machine.id,
    name: machine.name,
    online: agents.isOnline(machine.id),
    network: saved?.network ?? null,
    updated_at: saved?.updated_at ?? null,
    relays: wakeRelays(machine, saved?.network ?? null, machines, nets),
  };
}

export async function wakeMachineTool(ctx: ControlContext, input: { machine_id: string; via_machine_id?: string }): Promise<WakeResult & { notes: string[] }> {
  const machine = await ctx.scoped.machine(input.machine_id);
  const machines = await ctx.repos.machines.list(ctx.scope.ownerId);
  const result = await wakeMachine(ctx.repos, machine, machines, { viaId: input.via_machine_id, log: ctx.log ?? console });
  const locale = localeOf(ctx.scope.user.locale);
  const notes = result.warnings.map((w) =>
    w === 'wifi'
      ? t(locale, 'A interface salva é Wi-Fi: o Wake-on-LAN raramente funciona por Wi-Fi. Se a máquina não acordar, ligue-a no cabo.')
      : t(locale, 'No macOS, o Wake-on-LAN só funciona com "Despertar para acesso à rede" (Wake for network access) ligado em Ajustes do Sistema > Bateria/Energia.'),
  );
  return { ...result, notes };
}
