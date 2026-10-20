import dgram from 'node:dgram';
import { readFile, access } from 'node:fs/promises';
import os from 'node:os';
import {
  LIMITED_BROADCAST,
  NET_INFO_MAX_ADDRESSES,
  NET_INFO_MAX_INTERFACES,
  WOL_PORTS,
  ipv4Broadcast,
  type MachineNetwork,
  type NetAddress,
  type NetInterface,
  type NetInterfaceKind,
  type RpcParams,
  type RpcResult,
} from '@termhub/agent-protocol';
import { RpcFailure, run } from '../exec.js';

/**
 * Interfaces that never carry a Wake-on-LAN packet to another machine: loopback, containers and
 * bridges (a Docker host has dozens of veths), VPN tunnels and the macOS peer-to-peer links.
 */
const SKIPPED_INTERFACE_RE = /^(?:lo\d*|veth|docker|br-|virbr|vnet|cni|flannel|cali|vxlan|tun|tap|utun|awdl|llw|gif|stf|anpi|ap\d|bridge|tailscale|zt|wg|ipsec|ppp)/;
const EMPTY_MAC = '00:00:00:00:00:00';

export interface NetInfoDeps {
  interfaces: () => NodeJS.Dict<os.NetworkInterfaceInfo[]>;
  hostname: () => string;
  platform: NodeJS.Platform;
  /** The default route's interface and gateway. */
  defaultRoute: () => Promise<{ iface: string | null; gateway: string | null }>;
  /** Wired, Wi-Fi or something else, per interface name. */
  kinds: (names: string[]) => Promise<Map<string, NetInterfaceKind>>;
}

const realDeps = (): NetInfoDeps => ({
  interfaces: () => os.networkInterfaces(),
  hostname: () => os.hostname(),
  platform: process.platform,
  defaultRoute: () => (process.platform === 'darwin' ? macDefaultRoute() : linuxDefaultRoute()),
  kinds: (names) => (process.platform === 'darwin' ? macKinds() : linuxKinds(names)),
});

/** `0101A8C0` (the little-endian hex of /proc/net/route) → `192.168.1.1`. */
export function procRouteIp(hex: string): string | null {
  if (!/^[0-9A-Fa-f]{8}$/.test(hex)) return null;
  const n = parseInt(hex, 16);
  return [0, 8, 16, 24].map((shift) => (n >>> shift) & 255).join('.');
}

/** The default route out of /proc/net/route: the row whose destination and mask are both 0, lowest metric first. */
export function parseProcNetRoute(text: string): { iface: string | null; gateway: string | null } {
  let best: { iface: string; gateway: string | null; metric: number } | null = null;
  for (const line of text.split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 8 || f[1] !== '00000000' || f[7] !== '00000000') continue;
    const metric = Number(f[6]) || 0;
    if (best && best.metric <= metric) continue;
    const gateway = procRouteIp(f[2]);
    best = { iface: f[0], gateway: gateway === '0.0.0.0' ? null : gateway, metric };
  }
  return best ? { iface: best.iface, gateway: best.gateway } : { iface: null, gateway: null };
}

async function linuxDefaultRoute(): Promise<{ iface: string | null; gateway: string | null }> {
  try {
    return parseProcNetRoute(await readFile('/proc/net/route', 'utf8'));
  } catch {
    return { iface: null, gateway: null };
  }
}

/** `route -n get default` on macOS: `gateway: 192.168.1.1` and `interface: en0` lines. */
export function parseMacRoute(text: string): { iface: string | null; gateway: string | null } {
  const field = (name: string) => text.match(new RegExp(`^\\s*${name}:\\s*(\\S+)`, 'm'))?.[1] ?? null;
  return { iface: field('interface'), gateway: field('gateway') };
}

async function macDefaultRoute(): Promise<{ iface: string | null; gateway: string | null }> {
  const r = await run('/sbin/route', ['-n', 'get', 'default'], { timeoutMs: 3000 });
  return r.code === 0 ? parseMacRoute(r.stdout) : { iface: null, gateway: null };
}

/** `networksetup -listallhardwareports`: `Hardware Port: Wi-Fi` followed by `Device: en0`. */
export function parseMacHardwarePorts(text: string): Map<string, NetInterfaceKind> {
  const kinds = new Map<string, NetInterfaceKind>();
  let port: string | null = null;
  for (const line of text.split('\n')) {
    const p = line.match(/^Hardware Port:\s*(.+)$/);
    if (p) {
      port = p[1].trim();
      continue;
    }
    const d = line.match(/^Device:\s*(\S+)/);
    if (d && port) {
      kinds.set(d[1], /wi-?fi|airport/i.test(port) ? 'wifi' : /ethernet|\bLAN\b/i.test(port) ? 'ethernet' : 'other');
      port = null;
    }
  }
  return kinds;
}

async function macKinds(): Promise<Map<string, NetInterfaceKind>> {
  const r = await run('/usr/sbin/networksetup', ['-listallhardwareports'], { timeoutMs: 4000 });
  return r.code === 0 ? parseMacHardwarePorts(r.stdout) : new Map();
}

const exists = (path: string) => access(path).then(() => true, () => false);

/** Linux sysfs: a `wireless` (or `phy80211`) entry is Wi-Fi, a `device` link a physical NIC, anything else virtual. */
async function linuxKinds(names: string[]): Promise<Map<string, NetInterfaceKind>> {
  const kinds = new Map<string, NetInterfaceKind>();
  await Promise.all(
    names.map(async (name) => {
      const base = `/sys/class/net/${name}`;
      if (!(await exists(base))) return;
      if ((await exists(`${base}/wireless`)) || (await exists(`${base}/phy80211`))) kinds.set(name, 'wifi');
      else kinds.set(name, (await exists(`${base}/device`)) ? 'ethernet' : 'other');
    }),
  );
  return kinds;
}

function addressOf(a: os.NetworkInterfaceInfo): NetAddress | null {
  const family = a.family === 'IPv4' || (a.family as unknown) === 4 ? 'ipv4' : 'ipv6';
  // An IPv6 link-local address (fe80::) is on every interface and reaches nothing past the link.
  if (family === 'ipv6' && /^fe80:/i.test(a.address)) return null;
  return { family, address: a.address, cidr: a.cidr ?? null };
}

/** The machine's interfaces and default route, for `net.info`. Never throws: what cannot be read is null. */
export async function collect(deps: NetInfoDeps = realDeps()): Promise<MachineNetwork> {
  const raw = deps.interfaces();
  const interfaces: Omit<NetInterface, 'kind'>[] = [];
  for (const [name, list] of Object.entries(raw)) {
    if (!list || SKIPPED_INTERFACE_RE.test(name)) continue;
    const external = list.filter((a) => !a.internal);
    const addresses = external.map(addressOf).filter((a): a is NetAddress => a !== null).slice(0, NET_INFO_MAX_ADDRESSES);
    if (!addresses.length) continue;
    const mac = external.map((a) => a.mac?.toLowerCase()).find((m) => m && m !== EMPTY_MAC) ?? null;
    interfaces.push({ name, mac, addresses });
  }
  const [route, kinds] = await Promise.all([
    deps.defaultRoute().catch(() => ({ iface: null, gateway: null })),
    deps.kinds(interfaces.map((i) => i.name)).catch(() => new Map<string, NetInterfaceKind>()),
  ]);
  // The default route's interface first: it is the one a sleeping machine is most likely woken on.
  interfaces.sort((a, b) => Number(b.name === route.iface) - Number(a.name === route.iface));
  return {
    hostname: deps.hostname().slice(0, 255),
    default_interface: route.iface,
    gateway: route.gateway,
    interfaces: interfaces.slice(0, NET_INFO_MAX_INTERFACES).map((i) => ({ ...i, kind: kinds.get(i.name) ?? null })),
  };
}

export async function info(_params: RpcParams<'net.info'>): Promise<RpcResult<'net.info'>> {
  return collect();
}

/** The Wake-on-LAN magic packet: 6 bytes of 0xFF, then the MAC 16 times. */
export function magicPacket(mac: string): Buffer {
  const bytes = Buffer.from(mac.replace(/:/g, ''), 'hex');
  if (bytes.length !== 6) throw new RpcFailure('invalid', 'invalid MAC address');
  return Buffer.concat([Buffer.alloc(6, 0xff), ...Array.from({ length: 16 }, () => bytes)]);
}

/** The addresses this machine may broadcast to: the limited broadcast and the directed broadcast of each of its IPv4 networks. */
export function allowedBroadcasts(raw: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): Set<string> {
  const allowed = new Set<string>([LIMITED_BROADCAST]);
  for (const list of Object.values(raw)) {
    for (const a of list ?? []) {
      if (a.internal || !a.cidr) continue;
      const b = ipv4Broadcast(a.cidr);
      if (b) allowed.add(b);
    }
  }
  return allowed;
}

export interface WakeDeps {
  allowed: () => Set<string>;
  send: (packet: Buffer, address: string, port: number) => Promise<void>;
}

/** Sends over one UDP socket, broadcast enabled; resolves once every datagram is handed to the OS. */
async function udpSender(): Promise<{ send: WakeDeps['send']; close: () => void }> {
  const socket = dgram.createSocket('udp4');
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(0, () => {
      socket.off('error', reject);
      socket.setBroadcast(true);
      resolve();
    });
  });
  return {
    send: (packet, address, port) => new Promise((resolve, reject) => socket.send(packet, port, address, (err) => (err ? reject(err) : resolve()))),
    close: () => socket.close(),
  };
}

/**
 * `net.wake`: a magic packet for each MAC to each allowed broadcast, ports 9 and 7. No `wakeonlan`
 * binary needed. Only broadcasts of this machine's own networks: the server cannot aim it at a host.
 */
export async function sendWake(params: RpcParams<'net.wake'>, deps?: WakeDeps): Promise<RpcResult<'net.wake'>> {
  const allowed = (deps?.allowed ?? (() => allowedBroadcasts()))();
  const broadcasts = [...new Set(params.broadcasts)].filter((b) => allowed.has(b));
  if (!broadcasts.length) throw new RpcFailure('invalid', 'none of the broadcast addresses belongs to a network of this machine');
  const own = deps ? null : await udpSender();
  const send = deps?.send ?? own!.send;
  let sent = 0;
  try {
    for (const mac of params.macs) {
      const packet = magicPacket(mac);
      for (const address of broadcasts) {
        for (const port of WOL_PORTS) {
          try {
            await send(packet, address, port);
            sent++;
          } catch {
            // One address unreachable (no route on this host) must not stop the others.
          }
        }
      }
    }
  } finally {
    own?.close();
  }
  if (!sent) throw new RpcFailure('failed', 'nenhum pacote Wake-on-LAN pôde sair desta máquina (sem rota para a rede local?)');
  return { sent, broadcasts };
}

export const wake = (params: RpcParams<'net.wake'>) => sendWake(params);
