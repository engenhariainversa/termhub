import { z } from 'zod';

/**
 * The machine's network as its agent sees it (TER-1080): what `net.info` answers and what the server keeps
 * as the last known value, so a machine that went to sleep can still be woken by another one (Wake-on-LAN).
 */

/** A MAC address, lower case, colon separated. */
export const MAC_RE = /^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/;
export const macAddress = z.string().regex(MAC_RE);

const IPV4_RE = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
export const ipv4Address = z.string().regex(IPV4_RE);

/** The most interfaces and addresses one `net.info` answers: a Docker host has dozens of veths, already left out. */
export const NET_INFO_MAX_INTERFACES = 16;
export const NET_INFO_MAX_ADDRESSES = 8;

export const netInterfaceKind = z.enum(['ethernet', 'wifi', 'other']);
export type NetInterfaceKind = z.infer<typeof netInterfaceKind>;

export const netAddress = z.object({
  family: z.enum(['ipv4', 'ipv6']),
  address: z.string().max(64),
  /** `address/prefix`, e.g. `192.168.1.20/24`; null when the OS did not say. */
  cidr: z.string().max(80).nullable(),
});
export type NetAddress = z.infer<typeof netAddress>;

export const netInterface = z.object({
  name: z.string().max(64),
  mac: macAddress.nullable(),
  /** null: the agent could not tell (an OS it does not know how to ask). */
  kind: netInterfaceKind.nullable(),
  addresses: z.array(netAddress).max(NET_INFO_MAX_ADDRESSES),
});
export type NetInterface = z.infer<typeof netInterface>;

export const machineNetwork = z.object({
  /** The OS hostname, which often differs from the machine's name in termhub. */
  hostname: z.string().max(255),
  /** The interface of the default route (the one the machine goes out through), null when unknown. */
  default_interface: z.string().max(64).nullable(),
  gateway: z.string().max(64).nullable(),
  interfaces: z.array(netInterface).max(NET_INFO_MAX_INTERFACES),
});
export type MachineNetwork = z.infer<typeof machineNetwork>;

/** The UDP ports a Wake-on-LAN magic packet goes to: 9 (discard) is the usual one, 7 (echo) the fallback. */
export const WOL_PORTS = [9, 7] as const;
/** The limited broadcast: every host of the link the packet leaves through. */
export const LIMITED_BROADCAST = '255.255.255.255';

/** `a.b.c.d` as an unsigned 32-bit number, or null when it is not an IPv4 address. */
export function ipv4ToInt(address: string): number | null {
  if (!IPV4_RE.test(address)) return null;
  return address.split('.').reduce((n, part) => ((n << 8) | Number(part)) >>> 0, 0);
}

function intToIpv4(n: number): string {
  return [24, 16, 8, 0].map((shift) => (n >>> shift) & 255).join('.');
}

/** `192.168.1.20/24` → its address and prefix length, or null when it is not an IPv4 CIDR. */
export function parseIpv4Cidr(cidr: string): { address: number; prefix: number } | null {
  const [addr, len, ...rest] = cidr.split('/');
  if (rest.length || len === undefined || !/^\d{1,2}$/.test(len)) return null;
  const address = ipv4ToInt(addr);
  const prefix = Number(len);
  if (address === null || prefix > 32) return null;
  return { address, prefix };
}

const maskOf = (prefix: number): number => (prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0);

/**
 * The directed broadcast of an IPv4 CIDR (`192.168.1.20/24` → `192.168.1.255`), or null for anything a
 * broadcast makes no sense on: not IPv4, a /31 or /32 point-to-point link.
 */
export function ipv4Broadcast(cidr: string): string | null {
  const c = parseIpv4Cidr(cidr);
  if (!c || c.prefix > 30) return null;
  return intToIpv4((c.address | ~maskOf(c.prefix)) >>> 0);
}

/** Whether `address` (IPv4) lies inside the network of `cidr`. */
export function ipv4InCidr(address: string, cidr: string): boolean {
  const c = parseIpv4Cidr(cidr);
  const a = ipv4ToInt(address);
  if (!c || a === null) return false;
  const mask = maskOf(c.prefix);
  return ((a & mask) >>> 0) === ((c.address & mask) >>> 0);
}
