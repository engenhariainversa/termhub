import { describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { deviceFromUserAgent, isPublicIp, mobileSignals, normalizeIp, originLine, sameNetwork, sameNetworkAs, timeZoneOf, webSignals } from './client-origin.js';

const req = (headers: Record<string, string>, ip = '203.0.113.7') => ({ headers, ip }) as unknown as FastifyRequest;

describe('same network (TER-1088)', () => {
  it('is the same IPv4 behind one NAT', () => {
    expect(sameNetwork('203.0.113.7', '203.0.113.7')).toBe(true);
    expect(sameNetwork('::ffff:203.0.113.7', '203.0.113.7')).toBe(true);
  });

  it('is not a different IPv4, even in the same /24', () => {
    expect(sameNetwork('203.0.113.7', '203.0.113.8')).toBe(false);
    expect(sameNetwork('203.0.113.7', '198.51.100.7')).toBe(false);
  });

  it('is the same IPv6 /64, whatever the interface id', () => {
    expect(sameNetwork('2804:14c:5b80:8a1c::1', '2804:14c:5b80:8a1c:a1b2:c3d4:e5f6:7788')).toBe(true);
    expect(sameNetwork('2804:14C:5B80:8A1C:0:0:0:1%en0', '2804:14c:5b80:8a1c::2')).toBe(true);
  });

  it('is not another IPv6 /64, nor across families', () => {
    expect(sameNetwork('2804:14c:5b80:8a1c::1', '2804:14c:5b80:8a1d::1')).toBe(false);
    expect(sameNetwork('2804:14c:5b80:8a1c::1', '203.0.113.7')).toBe(false);
  });

  it('never counts a private, loopback, CGNAT or link-local address', () => {
    expect(sameNetwork('192.168.0.10', '192.168.0.10')).toBe(false);
    expect(sameNetwork('10.0.0.2', '10.0.0.2')).toBe(false);
    expect(sameNetwork('100.64.1.2', '100.64.1.2')).toBe(false);
    expect(sameNetwork('127.0.0.1', '127.0.0.1')).toBe(false);
    expect(sameNetwork('fe80::1', 'fe80::1')).toBe(false);
    expect(sameNetwork('fd00::1', 'fd00::1')).toBe(false);
    expect(isPublicIp('172.20.0.3')).toBe(false);
    expect(isPublicIp('172.32.0.3')).toBe(true);
  });

  it('is never the same with a side unknown', () => {
    expect(sameNetwork(null, '203.0.113.7')).toBe(false);
    expect(sameNetwork('203.0.113.7', 'not-an-ip')).toBe(false);
    expect(normalizeIp('')).toBeNull();
  });

  it('names the machines on the client network, in order', () => {
    const machines = [
      { name: 'hulk', ip: '203.0.113.7' },
      { name: 'vps', ip: '198.51.100.1' },
      { name: 'capitão américa', ip: '203.0.113.7' },
      { name: 'offline', ip: null },
    ];
    expect(sameNetworkAs('203.0.113.7', machines)).toEqual(['hulk', 'capitão américa']);
    expect(sameNetworkAs('192.0.2.1', machines)).toEqual([]);
  });
});

describe('client signals', () => {
  it('reads the device from a browser User-Agent', () => {
    expect(deviceFromUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X)')).toEqual({ device: 'phone', os: 'iOS' });
    expect(deviceFromUserAgent('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)')).toEqual({ device: 'tablet', os: 'iPadOS' });
    expect(deviceFromUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile Safari/537.36')).toEqual({ device: 'phone', os: 'Android' });
    expect(deviceFromUserAgent('Mozilla/5.0 (Linux; Android 14; SM-X710) Safari/537.36')).toEqual({ device: 'tablet', os: 'Android' });
    expect(deviceFromUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toEqual({ device: 'computer', os: 'macOS' });
    expect(deviceFromUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toEqual({ device: 'computer', os: 'Windows' });
    expect(deviceFromUserAgent(undefined)).toEqual({ device: null, os: null });
  });

  it('keeps only a real IANA time zone', () => {
    expect(timeZoneOf(req({ 'x-termhub-time-zone': 'America/Sao_Paulo' }))).toBe('America/Sao_Paulo');
    expect(timeZoneOf(req({ 'x-termhub-time-zone': 'Mars/Olympus' }))).toBeNull();
    expect(timeZoneOf(req({}))).toBeNull();
  });

  it('builds the web signals from the request', () => {
    const s = webSignals(req({ 'x-termhub-client': 'web/1.4.0', 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'accept-language': 'en-US', 'x-termhub-time-zone': 'Europe/Lisbon' }));
    expect(s).toEqual({ client: 'web', app_version: '1.4.0', device: 'computer', os: 'macOS', ip: '203.0.113.7', time_zone: 'Europe/Lisbon', locale: 'en' });
    expect(webSignals(req({ 'x-termhub-client': 'web/<script>' })).app_version).toBeNull();
  });

  it('builds the app signals from X-Termhub-App and the device row', () => {
    const device = { platform: 'ios', model: 'iPhone 15 Pro', os_version: '18.1', app_version: '0.5.0' };
    expect(mobileSignals(req({ 'x-termhub-app': 'ios/0.6.0+40', 'accept-language': 'pt-BR' }), device)).toMatchObject({ client: 'ios', app_version: '0.6.0', device: 'phone', os: 'iOS 18.1', locale: 'pt-BR' });
    expect(mobileSignals(req({}), { ...device, model: 'iPad Pro 11' })).toMatchObject({ client: 'ios', app_version: '0.5.0', device: 'tablet', os: 'iPadOS 18.1' });
    expect(mobileSignals(req({ 'x-termhub-app': 'android/0.6.0+40' }), { platform: 'android', model: 'Pixel 8', os_version: '14', app_version: '0.6.0' })).toMatchObject({ client: 'android', device: 'phone', os: 'Android 14' });
  });

  it('writes the origin line without the IP', () => {
    const line = originLine({ client: 'web', app_version: null, device: null, os: null, ip: '203.0.113.7', time_zone: null, locale: 'es', same_network_as: [], at: '' });
    expect(line).toContain('web · unknown device · not on the same network as any of their machines');
    expect(line).toContain('language es');
    expect(line).not.toContain('203.0.113.7');
  });
});
