import { describe, expect, it } from 'vitest';
import { ipv4Broadcast, ipv4InCidr, ipv4ToInt, machineNetwork, parseIpv4Cidr } from './network.js';
import { RPC } from './rpc.js';

describe('ipv4 helpers', () => {
  it('parses addresses and CIDRs', () => {
    expect(ipv4ToInt('192.168.1.1')).toBe(0xc0a80101);
    expect(ipv4ToInt('256.1.1.1')).toBeNull();
    expect(ipv4ToInt('fe80::1')).toBeNull();
    expect(parseIpv4Cidr('10.0.0.5/8')).toEqual({ address: 0x0a000005, prefix: 8 });
    expect(parseIpv4Cidr('10.0.0.5/33')).toBeNull();
    expect(parseIpv4Cidr('10.0.0.5')).toBeNull();
  });

  it('computes the directed broadcast', () => {
    expect(ipv4Broadcast('192.168.1.20/24')).toBe('192.168.1.255');
    expect(ipv4Broadcast('10.1.2.3/16')).toBe('10.1.255.255');
    expect(ipv4Broadcast('172.16.5.4/22')).toBe('172.16.7.255');
    expect(ipv4Broadcast('10.0.0.1/31')).toBeNull();
    expect(ipv4Broadcast('fd00::1/64')).toBeNull();
  });

  it('tells whether an address is in a network', () => {
    expect(ipv4InCidr('192.168.1.99', '192.168.1.20/24')).toBe(true);
    expect(ipv4InCidr('192.168.2.99', '192.168.1.20/24')).toBe(false);
    expect(ipv4InCidr('192.168.2.99', '192.168.1.20/16')).toBe(true);
    expect(ipv4InCidr('x', '192.168.1.20/24')).toBe(false);
  });
});

describe('net.* rpc', () => {
  it('net.wake takes MACs and IPv4 broadcasts only', () => {
    const p = RPC['net.wake'].params;
    expect(p.safeParse({ macs: ['aa:bb:cc:dd:ee:ff'], broadcasts: ['192.168.1.255'] }).success).toBe(true);
    expect(p.safeParse({ macs: ['AA:BB:CC:DD:EE:FF'], broadcasts: ['192.168.1.255'] }).success).toBe(false);
    expect(p.safeParse({ macs: ['aa:bb:cc:dd:ee:ff'], broadcasts: ['example.com'] }).success).toBe(false);
    expect(p.safeParse({ macs: [], broadcasts: ['192.168.1.255'] }).success).toBe(false);
    expect(p.safeParse({ macs: ['aa:bb:cc:dd:ee:ff'], broadcasts: ['192.168.1.255'], port: 22 }).success).toBe(false);
  });

  it('net.info answers a machine network', () => {
    const net = {
      hostname: 'hulk.local',
      default_interface: 'en0',
      gateway: '192.168.1.1',
      interfaces: [{ name: 'en0', mac: 'aa:bb:cc:dd:ee:ff', kind: 'ethernet', addresses: [{ family: 'ipv4', address: '192.168.1.20', cidr: '192.168.1.20/24' }] }],
    };
    expect(RPC['net.info'].result.safeParse(net).success).toBe(true);
    expect(machineNetwork.safeParse({ ...net, interfaces: [{ ...net.interfaces[0], kind: 'bluetooth' }] }).success).toBe(false);
  });
});
