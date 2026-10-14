import type os from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { RpcFailure } from '../exec.js';
import { collect, magicPacket, parseMacHardwarePorts, parseMacRoute, parseProcNetRoute, procRouteIp, sendWake, allowedBroadcasts, type NetInfoDeps } from './net-info.js';

const v4 = (address: string, cidr: string, mac = 'AA:BB:CC:DD:EE:01'): os.NetworkInterfaceInfo =>
  ({ address, netmask: '255.255.255.0', family: 'IPv4', mac, internal: false, cidr }) as os.NetworkInterfaceInfo;
const v6 = (address: string, mac = 'aa:bb:cc:dd:ee:01'): os.NetworkInterfaceInfo =>
  ({ address, netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', mac, internal: false, cidr: `${address}/64`, scopeid: 0 }) as os.NetworkInterfaceInfo;

function deps(over: Partial<NetInfoDeps> = {}): NetInfoDeps {
  return {
    interfaces: () => ({
      lo: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: true, cidr: '127.0.0.1/8' }],
      docker0: [v4('172.17.0.1', '172.17.0.1/16', '02:42:00:00:00:01')],
      veth12ab: [v6('fe80::1')],
      wlan0: [v4('192.168.1.30', '192.168.1.30/24', 'AA:BB:CC:DD:EE:02')],
      eth0: [v4('192.168.1.20', '192.168.1.20/24'), v6('fe80::abcd'), v6('2804:14c::20')],
    }),
    hostname: () => 'jarvis',
    platform: 'linux',
    defaultRoute: async () => ({ iface: 'eth0', gateway: '192.168.1.1' }),
    kinds: async () => new Map([['eth0', 'ethernet'], ['wlan0', 'wifi']]),
    ...over,
  };
}

describe('collect', () => {
  it('keeps the real interfaces, default route first, with MAC (lower case) and kind', async () => {
    expect(await collect(deps())).toEqual({
      hostname: 'jarvis',
      default_interface: 'eth0',
      gateway: '192.168.1.1',
      interfaces: [
        {
          name: 'eth0',
          mac: 'aa:bb:cc:dd:ee:01',
          kind: 'ethernet',
          addresses: [
            { family: 'ipv4', address: '192.168.1.20', cidr: '192.168.1.20/24' },
            { family: 'ipv6', address: '2804:14c::20', cidr: '2804:14c::20/64' },
          ],
        },
        { name: 'wlan0', mac: 'aa:bb:cc:dd:ee:02', kind: 'wifi', addresses: [{ family: 'ipv4', address: '192.168.1.30', cidr: '192.168.1.30/24' }] },
      ],
    });
  });

  it('still answers when the route and the kinds cannot be read', async () => {
    const net = await collect(deps({ defaultRoute: async () => Promise.reject(new Error('x')), kinds: async () => Promise.reject(new Error('y')) }));
    expect(net.default_interface).toBeNull();
    expect(net.gateway).toBeNull();
    expect(net.interfaces.map((i) => i.kind)).toEqual([null, null]);
  });
});

describe('route and port parsers', () => {
  it('reads the default route out of /proc/net/route', () => {
    const text = [
      'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT',
      'wlan0\t00000000\t0101A8C0\t0003\t0\t0\t600\t00000000\t0\t0\t0',
      'eth0\t00000000\t0101A8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0',
      'eth0\t0001A8C0\t00000000\t0001\t0\t0\t100\t00FFFFFF\t0\t0\t0',
    ].join('\n');
    expect(parseProcNetRoute(text)).toEqual({ iface: 'eth0', gateway: '192.168.1.1' });
    expect(parseProcNetRoute('Iface\tDestination\n')).toEqual({ iface: null, gateway: null });
    expect(procRouteIp('0101A8C0')).toBe('192.168.1.1');
  });

  it('reads macOS route and hardware ports', () => {
    expect(parseMacRoute('   route to: default\ndestination: default\n    gateway: 192.168.0.1\n  interface: en0\n')).toEqual({ iface: 'en0', gateway: '192.168.0.1' });
    const ports = parseMacHardwarePorts(
      'Hardware Port: Ethernet\nDevice: en0\nEthernet Address: aa:bb\n\nHardware Port: Wi-Fi\nDevice: en1\n\nHardware Port: Thunderbolt Bridge\nDevice: bridge0\n',
    );
    expect([...ports]).toEqual([['en0', 'ethernet'], ['en1', 'wifi'], ['bridge0', 'other']]);
  });
});

describe('wake', () => {
  it('builds the magic packet', () => {
    const p = magicPacket('aa:bb:cc:dd:ee:ff');
    expect(p.length).toBe(102);
    expect(p.subarray(0, 6).toString('hex')).toBe('ffffffffffff');
    expect(p.subarray(96).toString('hex')).toBe('aabbccddeeff');
  });

  it('allows only the limited broadcast and the broadcasts of its own networks', () => {
    expect([...allowedBroadcasts({ eth0: [v4('192.168.1.20', '192.168.1.20/24')], lo: [{ ...v4('127.0.0.1', '127.0.0.1/8'), internal: true }] })]).toEqual(['255.255.255.255', '192.168.1.255']);
  });

  it('sends each MAC to each allowed broadcast on ports 9 and 7, dropping the others', async () => {
    const send = vi.fn(async () => {});
    const r = await sendWake({ macs: ['aa:bb:cc:dd:ee:ff'], broadcasts: ['192.168.1.255', '10.0.0.255'] }, { allowed: () => new Set(['192.168.1.255', '255.255.255.255']), send });
    expect(r).toEqual({ sent: 2, broadcasts: ['192.168.1.255'] });
    expect(send.mock.calls.map((c) => [c[1], c[2]])).toEqual([['192.168.1.255', 9], ['192.168.1.255', 7]]);
  });

  it('refuses when no broadcast belongs to this machine', async () => {
    await expect(sendWake({ macs: ['aa:bb:cc:dd:ee:ff'], broadcasts: ['10.0.0.255'] }, { allowed: () => new Set(['255.255.255.255']), send: async () => {} })).rejects.toBeInstanceOf(RpcFailure);
  });

  it('fails when nothing could be sent', async () => {
    await expect(
      sendWake({ macs: ['aa:bb:cc:dd:ee:ff'], broadcasts: ['255.255.255.255'] }, { allowed: () => new Set(['255.255.255.255']), send: async () => Promise.reject(new Error('EHOSTUNREACH')) }),
    ).rejects.toMatchObject({ code: 'failed' });
  });
});
