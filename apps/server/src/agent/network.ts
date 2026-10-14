import type { FastifyBaseLogger } from 'fastify';
import {
  CAPABILITY_NET_WAKE,
  LIMITED_BROADCAST,
  NET_WAKE_MIN_AGENT_VERSION,
  ipv4Broadcast,
  ipv4InCidr,
  type MachineNetwork,
  type NetInterfaceKind,
} from '@termhub/agent-protocol';
import type { Repositories } from '../db/repositories/index.js';
import type { SavedNetwork } from '../db/repositories/machines.js';
import type { Machine } from '../db/repositories/types.js';
import { HttpError } from '../lib/errors.js';
import { msg } from '../i18n/index.js';
import { agents, type AgentRegistry } from './registry.js';
import { toHttpError } from './errors.js';

/**
 * TER-1080: the machine's network, kept for when it sleeps, and Wake-on-LAN through another machine of
 * the same network. The agent reports `net.info` on connect and every `NETWORK_REFRESH_MS`; the server
 * keeps the last answer (`machines.network`). Waking sends `net.wake` to an online machine of the same
 * owner that shares an IPv4 network with the sleeping one.
 */

/** How often a connected agent is asked again: a DHCP lease or a change of Wi-Fi moves the address. */
export const NETWORK_REFRESH_MS = 10 * 60_000;

const MAX_WAKE_MACS = 4;

/** Asks a connected agent for its network and saves it. Best effort: an agent without `net_wake` is skipped. */
export async function refreshNetwork(
  repos: Pick<Repositories, 'machines'>,
  machineId: string,
  log: Pick<FastifyBaseLogger, 'warn'>,
  registry: AgentRegistry = agents,
): Promise<boolean> {
  if (!(registry.capabilities(machineId) ?? []).includes(CAPABILITY_NET_WAKE)) return false;
  try {
    const network = await registry.rpc(machineId, 'net.info', {});
    await repos.machines.setNetwork(machineId, network);
    return true;
  } catch (err) {
    log.warn({ err: (err as { code?: string })?.code ?? (err as Error)?.name, machineId }, 'machine network refresh failed');
    return false;
  }
}

/** What `net.wake` is sent with, from one relay machine. */
export interface WakePlan {
  macs: string[];
  broadcasts: string[];
  /** the kinds of the interfaces whose MAC is woken */
  kinds: (NetInterfaceKind | null)[];
}

/**
 * Which of the target's MACs a relay can reach, and where to broadcast: each target interface with a MAC
 * and an IPv4 network the relay also has an address in. The broadcast is the relay's own directed broadcast
 * of that network (the only kind its agent accepts) plus the limited broadcast. Null: no shared network.
 */
export function planWake(target: MachineNetwork, relay: MachineNetwork): WakePlan | null {
  const relayV4 = relay.interfaces.flatMap((i) => i.addresses.filter((a) => a.family === 'ipv4' && a.cidr));
  const macs: string[] = [];
  const kinds: (NetInterfaceKind | null)[] = [];
  const broadcasts = new Set<string>();
  // the default route's interface first: that is where the machine was reachable
  const ordered = [...target.interfaces].sort((a, b) => Number(b.name === target.default_interface) - Number(a.name === target.default_interface));
  for (const iface of ordered) {
    if (!iface.mac || macs.includes(iface.mac)) continue;
    const shared = iface.addresses.flatMap((a) => (a.family === 'ipv4' && a.cidr ? relayV4.filter((r) => ipv4InCidr(r.address, a.cidr!)) : []));
    if (!shared.length) continue;
    macs.push(iface.mac);
    kinds.push(iface.kind);
    for (const r of shared) {
      const b = ipv4Broadcast(r.cidr!);
      if (b) broadcasts.add(b);
    }
    if (macs.length === MAX_WAKE_MACS) break;
  }
  if (!macs.length) return null;
  return { macs, broadcasts: [...broadcasts].slice(0, 3).concat(LIMITED_BROADCAST), kinds };
}

export type WakeWarning = 'wifi' | 'macos';

export interface WakeResult {
  machine_id: string;
  via: { id: string; name: string };
  macs: string[];
  broadcasts: string[];
  sent: number;
  /** `wifi`: every MAC woken is a Wi-Fi interface (Wake-on-LAN rarely works there); `macos`: remind "Wake for network access". */
  warnings: WakeWarning[];
}

export interface WakeRelay {
  id: string;
  name: string;
  online: boolean;
  /** the agent answers `net.wake` */
  capable: boolean;
  /** shares an IPv4 network with the target (null: no saved network) */
  same_network: boolean;
}

const isAgent = (m: Machine) => m.type === 'agent';

/** The other agent machines of the target's owner among `machines`, and whether each could send the packet now. */
export function wakeRelays(target: Machine, targetNet: MachineNetwork | null, machines: Machine[], nets: Map<string, SavedNetwork>, registry: AgentRegistry = agents): WakeRelay[] {
  return machines
    .filter((m) => m.id !== target.id && isAgent(m) && m.owner_id === target.owner_id)
    .map((m) => {
      const net = nets.get(m.id)?.network ?? null;
      return {
        id: m.id,
        name: m.name,
        online: registry.isOnline(m.id),
        capable: (registry.capabilities(m.id) ?? []).includes(CAPABILITY_NET_WAKE),
        same_network: !!(targetNet && net && planWake(targetNet, net)),
      };
    });
}

/**
 * Wakes `target` through `viaId` or, without it, the first online, capable machine of its owner that shares
 * a network with it. `machines` is the caller's scope (the route's or the control context's).
 */
export async function wakeMachine(
  repos: Pick<Repositories, 'machines'>,
  target: Machine,
  machines: Machine[],
  opts: { viaId?: string; log: Pick<FastifyBaseLogger, 'info'>; registry?: AgentRegistry },
): Promise<WakeResult> {
  const registry = opts.registry ?? agents;
  if (!isAgent(target)) throw new HttpError(400, 'Esta máquina não usa o agente do termhub', 'UNSUPPORTED_MACHINE');
  const others = machines.filter((m) => m.id !== target.id && isAgent(m) && m.owner_id === target.owner_id);
  const nets = await repos.machines.networks([target.id, ...others.map((m) => m.id)]);
  const targetNet = nets.get(target.id)?.network;
  if (!targetNet || !targetNet.interfaces.some((i) => i.mac)) {
    throw new HttpError(
      409,
      msg('Ainda não sabemos o IP e o MAC desta máquina: atualize o agente dela para a versão {{version}} ou mais nova e deixe-a online uma vez', { version: NET_WAKE_MIN_AGENT_VERSION }),
      'NO_NETWORK',
    );
  }
  let pool = others;
  if (opts.viaId) {
    pool = others.filter((m) => m.id === opts.viaId);
    if (!pool.length) throw new HttpError(404, 'Máquina não encontrada', 'NOT_FOUND');
  }
  const ready = pool
    .filter((m) => registry.isOnline(m.id) && (registry.capabilities(m.id) ?? []).includes(CAPABILITY_NET_WAKE))
    .map((m) => ({ machine: m, plan: nets.get(m.id) ? planWake(targetNet, nets.get(m.id)!.network) : null }))
    .filter((r): r is { machine: Machine; plan: WakePlan } => r.plan !== null);
  const relay = ready[0];
  if (!relay) {
    throw new HttpError(
      409,
      opts.viaId
        ? msg('Essa máquina não pode acordar a outra: ela precisa estar online, com o agente {{version}} ou mais novo, e na mesma rede local', { version: NET_WAKE_MIN_AGENT_VERSION })
        : msg('Nenhuma máquina online na mesma rede local pode acordar esta (é preciso o agente {{version}} ou mais novo)', { version: NET_WAKE_MIN_AGENT_VERSION }),
      'NO_WAKE_RELAY',
    );
  }
  let sent: number;
  let broadcasts: string[];
  try {
    ({ sent, broadcasts } = await registry.rpc(relay.machine.id, 'net.wake', { macs: relay.plan.macs, broadcasts: relay.plan.broadcasts }));
  } catch (err) {
    throw toHttpError(err);
  }
  const warnings: WakeWarning[] = [];
  if (relay.plan.kinds.every((k) => k === 'wifi')) warnings.push('wifi');
  if (target.os === 'macos') warnings.push('macos');
  opts.log.info({ machineId: target.id, via: relay.machine.id, macs: relay.plan.macs.length, sent }, 'wake-on-lan sent');
  return { machine_id: target.id, via: { id: relay.machine.id, name: relay.machine.name }, macs: relay.plan.macs, broadcasts, sent, warnings };
}
