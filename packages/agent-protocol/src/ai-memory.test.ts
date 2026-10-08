import { describe, expect, it } from 'vitest';
import { AI_MEMORY_DEFAULT_URL, aiMemoryUrl, isPrivateHost, normalizeAiMemoryUrl } from './ai-memory.js';
import { RPC } from './rpc.js';

describe('ai-memory url', () => {
  it('accepts loopback and private networks, normalized to the origin', () => {
    expect(normalizeAiMemoryUrl(AI_MEMORY_DEFAULT_URL)).toBe('http://127.0.0.1:49374');
    expect(normalizeAiMemoryUrl(' http://localhost:49374/ ')).toBe('http://localhost:49374');
    expect(normalizeAiMemoryUrl('http://127.1:49374')).toBe('http://127.0.0.1:49374');
    expect(normalizeAiMemoryUrl('https://10.0.0.5:8443')).toBe('https://10.0.0.5:8443');
    expect(normalizeAiMemoryUrl('http://172.16.1.1')).toBe('http://172.16.1.1');
    expect(normalizeAiMemoryUrl('http://172.31.255.1')).toBe('http://172.31.255.1');
    expect(normalizeAiMemoryUrl('http://192.168.0.10:49374')).toBe('http://192.168.0.10:49374');
    expect(normalizeAiMemoryUrl('http://[::1]:49374')).toBe('http://[::1]:49374');
    expect(normalizeAiMemoryUrl('http://[fd12:3456::1]:49374')).toBe('http://[fd12:3456::1]:49374');
  });

  it('refuses public addresses, names, other schemes and anything beyond the origin', () => {
    for (const bad of [
      'http://8.8.8.8:49374',
      'http://172.32.0.1',
      'http://172.15.0.1',
      'http://169.254.169.254',
      'http://example.com',
      'http://termhub.dev',
      'http://127.0.0.1.nip.io',
      'http://[2001:db8::1]',
      'http://[::ffff:127.0.0.1]',
      'ftp://127.0.0.1',
      'file:///etc/passwd',
      'http://user:pw@127.0.0.1:49374',
      'http://127.0.0.1:49374/api',
      'http://127.0.0.1:49374?x=1',
      'http://127.0.0.1:49374#x',
      'not a url',
      '',
    ]) {
      expect(normalizeAiMemoryUrl(bad), bad).toBeNull();
    }
  });

  it('isPrivateHost ignores case and rejects malformed quads', () => {
    expect(isPrivateHost('LOCALHOST')).toBe(true);
    expect(isPrivateHost('127.0.0.256')).toBe(false);
  });

  it('the zod schema and the rpc params apply the same rule', () => {
    expect(aiMemoryUrl.parse('http://localhost:49374/')).toBe('http://localhost:49374');
    expect(aiMemoryUrl.safeParse('http://1.1.1.1').success).toBe(false);
    expect(RPC['aimemory.status'].params.safeParse({ url: 'http://127.0.0.1:49374' }).success).toBe(true);
    expect(RPC['aimemory.status'].params.safeParse({ url: 'http://1.1.1.1' }).success).toBe(false);
    expect(RPC['aimemory.status'].result.safeParse({ installed: true, version: '2.6.0', server_up: false }).success).toBe(true);
  });
});
