import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { MachineNetwork } from '@termhub/agent-protocol';
import type { Machine } from '../db/repositories/types.js';
import type { SavedNetwork } from '../db/repositories/machines.js';
import { AgentRegistry } from './registry.js';
import { planWake, refreshNetwork, wakeMachine, wakeRelays } from './network.js';

const net = (ifaces: { name: string; mac: string | null; kind?: 'ethernet' | 'wifi' | 'other' | null; cidr: string }[], def?: string): MachineNetwork => ({
  hostname: 'host',
  default_interface: def ?? ifaces[0]?.name ?? null,
  gateway: null,
  interfaces: ifaces.map((i) => ({ name: i.name, mac: i.mac, kind: i.kind ?? 'ethernet', addresses: [{ family: 'ipv4' as const, address: i.cidr.split('/')[0], cidr: i.cidr }] })),
});

const HULK = net([
  { name: 'en0', mac: 'aa:aa:aa:aa:aa:01', cidr: '192.168.1.20/24' },
  { name: 'en1', mac: 'aa:aa:aa:aa:aa:02', kind: 'wifi', cidr: '192.168.1.21/24' },
]);
const JARVIS = net([{ name: 'eth0', mac: 'bb:bb:bb:bb:bb:01', cidr: '192.168.1.10/24' }]);
const FAR = net([{ name: 'eth0', mac: 'cc:cc:cc:cc:cc:01', cidr: '10.0.0.5/24' }]);

function machine(id: string, over: Partial<Machine> = {}): Machine {
  return {
    id, name: id, subtitle: null, host: null, ssh_user: null, ssh_port: 22, type: 'agent', os: 'linux', capabilities: [], checked_at: null,
    agent_version: null, agent_last_seen_at: null, agent_auto_update: true, claude_auto_swap: false, ai_usage_query: true, automation_allowed: true,
    is_local: false, owner_id: 'u1', owner_name: null, created_at: '', ...over,
  };
}

function attach(registry: AgentRegistry, id: string, rpc = vi.fn(), capabilities = ['net_wake']) {
  const conn = Object.assign(new EventEmitter(), {
    hello: { type: 'hello', protocol: 1, agent_version: '0.30.0', os: 'linux', tools: [], capabilities },
    connectedAt: Date.now(),
    rpc,
    close: vi.fn(),
  });
  registry.attach(id, conn as never);
  return rpc;
}

const saved = (entries: [string, MachineNetwork][]) => new Map<string, SavedNetwork>(entries.map(([id, network]) => [id, { network, updated_at: '2026-10-14T00:00:00.000Z' }]));
const log = { info: vi.fn(), warn: vi.fn() };

describe('planWake', () => {
  it('wakes every MAC on a shared network, default interface first, through the relay\'s own broadcast', () => {
    expect(planWake(HULK, JARVIS)).toEqual({ macs: ['aa:aa:aa:aa:aa:01', 'aa:aa:aa:aa:aa:02'], broadcasts: ['192.168.1.255', '255.255.255.255'], kinds: ['ethernet', 'wifi'] });
  });

  it('puts the default route\'s interface first', () => {
    expect(planWake({ ...HULK, default_interface: 'en1' }, JARVIS)?.macs).toEqual(['aa:aa:aa:aa:aa:02', 'aa:aa:aa:aa:aa:01']);
  });

  it('is null without a shared IPv4 network or a MAC', () => {
    expect(planWake(HULK, FAR)).toBeNull();
    expect(planWake(net([{ name: 'en0', mac: null, cidr: '192.168.1.20/24' }]), JARVIS)).toBeNull();
  });
});

describe('refreshNetwork', () => {
  it('saves the agent\'s net.info', async () => {
    const registry = new AgentRegistry();
    attach(registry, 'm1', vi.fn(async () => HULK));
    const setNetwork = vi.fn(async () => {});
    expect(await refreshNetwork({ machines: { setNetwork } } as never, 'm1', log, registry)).toBe(true);
    expect(setNetwork).toHaveBeenCalledWith('m1', HULK);
  });

  it('skips an agent without net_wake and never throws', async () => {
    const registry = new AgentRegistry();
    const rpc = attach(registry, 'm1', vi.fn(), []);
    const setNetwork = vi.fn();
    expect(await refreshNetwork({ machines: { setNetwork } } as never, 'm1', log, registry)).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
    attach(registry, 'm2', vi.fn(async () => Promise.reject(new Error('boom'))));
    expect(await refreshNetwork({ machines: { setNetwork } } as never, 'm2', log, registry)).toBe(false);
    expect(setNetwork).not.toHaveBeenCalled();
  });
});

describe('wakeMachine', () => {
  const hulk = machine('hulk', { os: 'macos' });
  const jarvis = machine('jarvis');
  const far = machine('far');
  const foreign = machine('foreign', { owner_id: 'u2' });
  const repos = (nets: Map<string, SavedNetwork>) => ({ machines: { networks: vi.fn(async (ids: string[]) => new Map([...nets].filter(([id]) => ids.includes(id)))) } }) as never;

  it('sends net.wake through an online machine of the same network and warns about macOS', async () => {
    const registry = new AgentRegistry();
    attach(registry, 'far', vi.fn());
    const rpc = attach(registry, 'jarvis', vi.fn(async () => ({ sent: 4, broadcasts: ['192.168.1.255', '255.255.255.255'] })));
    const r = await wakeMachine(repos(saved([['hulk', HULK], ['jarvis', JARVIS], ['far', FAR]])), hulk, [hulk, far, jarvis], { log, registry });
    expect(rpc).toHaveBeenCalledWith('net.wake', { macs: ['aa:aa:aa:aa:aa:01', 'aa:aa:aa:aa:aa:02'], broadcasts: ['192.168.1.255', '255.255.255.255'] }, undefined);
    expect(r).toEqual({ machine_id: 'hulk', via: { id: 'jarvis', name: 'jarvis' }, macs: ['aa:aa:aa:aa:aa:01', 'aa:aa:aa:aa:aa:02'], broadcasts: ['192.168.1.255', '255.255.255.255'], sent: 4, warnings: ['macos'] });
  });

  it('warns when only Wi-Fi can be woken', async () => {
    const registry = new AgentRegistry();
    attach(registry, 'jarvis', vi.fn(async () => ({ sent: 2, broadcasts: ['192.168.1.255'] })));
    const wifiOnly = net([{ name: 'wlan0', mac: 'aa:aa:aa:aa:aa:09', kind: 'wifi', cidr: '192.168.1.40/24' }]);
    const r = await wakeMachine(repos(saved([['hulk', wifiOnly], ['jarvis', JARVIS]])), machine('hulk'), [machine('hulk'), jarvis], { log, registry });
    expect(r.warnings).toEqual(['wifi']);
  });

  it('answers NO_NETWORK when the machine never reported its network', async () => {
    await expect(wakeMachine(repos(saved([['jarvis', JARVIS]])), hulk, [hulk, jarvis], { log, registry: new AgentRegistry() })).rejects.toMatchObject({ statusCode: 409, code: 'NO_NETWORK' });
  });

  it('answers NO_WAKE_RELAY when no capable machine is online on the same network, never another owner\'s', async () => {
    const registry = new AgentRegistry();
    attach(registry, 'far', vi.fn());
    const foreignRpc = attach(registry, 'foreign', vi.fn());
    attach(registry, 'jarvis', vi.fn(), []);
    await expect(wakeMachine(repos(saved([['hulk', HULK], ['jarvis', JARVIS], ['far', FAR], ['foreign', JARVIS]])), hulk, [hulk, jarvis, far, foreign], { log, registry })).rejects.toMatchObject({ code: 'NO_WAKE_RELAY' });
    expect(foreignRpc).not.toHaveBeenCalled();
  });

  it('uses only the machine asked for, and 404s on one outside the list', async () => {
    const registry = new AgentRegistry();
    attach(registry, 'jarvis', vi.fn(async () => ({ sent: 2, broadcasts: [] })));
    attach(registry, 'far', vi.fn());
    const nets = saved([['hulk', HULK], ['jarvis', JARVIS], ['far', FAR]]);
    await expect(wakeMachine(repos(nets), hulk, [hulk, jarvis, far], { viaId: 'far', log, registry })).rejects.toMatchObject({ code: 'NO_WAKE_RELAY' });
    await expect(wakeMachine(repos(nets), hulk, [hulk, jarvis], { viaId: 'nope', log, registry })).rejects.toMatchObject({ statusCode: 404 });
    expect((await wakeMachine(repos(nets), hulk, [hulk, jarvis, far], { viaId: 'jarvis', log, registry })).via.id).toBe('jarvis');
  });

  it('refuses a machine without the agent', async () => {
    await expect(wakeMachine(repos(new Map()), machine('box', { type: 'ssh' }), [], { log, registry: new AgentRegistry() })).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('wakeRelays', () => {
  it('lists the owner\'s other agent machines with what each can do now', () => {
    const registry = new AgentRegistry();
    attach(registry, 'jarvis');
    const hulk = machine('hulk');
    const relays = wakeRelays(hulk, HULK, [hulk, machine('jarvis'), machine('far'), machine('foreign', { owner_id: 'u2' }), machine('old', { type: 'ssh' })], saved([['jarvis', JARVIS], ['far', FAR]]), registry);
    expect(relays).toEqual([
      { id: 'jarvis', name: 'jarvis', online: true, capable: true, same_network: true },
      { id: 'far', name: 'far', online: false, capable: false, same_network: false },
    ]);
  });
});
