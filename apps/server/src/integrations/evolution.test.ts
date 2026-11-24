import { describe, expect, it, vi } from 'vitest';
import { connectionState, EvolutionError, fetchGroups, sendText } from './evolution.js';

const dns = vi.hoisted(() => ({
  lookup: vi.fn(async (host: string) => {
    const table: Record<string, string> = { 'wpp.example.com': '104.21.1.1', 'evil.example.com': '172.18.0.3' };
    if (!table[host]) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
    return [{ address: table[host], family: 4 }];
  }),
}));
vi.mock('node:dns/promises', () => ({ lookup: dns.lookup, default: { lookup: dns.lookup } }));

const target = { server_url: 'https://wpp.example.com/', instance: 'my inst', api_key: 'k-123' };
const answer = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('evolution client', () => {
  it('reads the connection state with the apikey header, never following redirects', async () => {
    const fetchImpl = vi.fn(async () => answer(200, { instance: { instanceName: 'my inst', state: 'open' } }));
    await expect(connectionState(target, fetchImpl as unknown as typeof fetch)).resolves.toBe('open');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://wpp.example.com/instance/connectionState/my%20inst');
    expect(init.redirect).toBe('manual');
    expect((init.headers as Record<string, string>).apikey).toBe('k-123');
  });

  it('sends a text to the number', async () => {
    const fetchImpl = vi.fn(async () => answer(201, { key: { id: 'x' } }));
    await sendText(target, '5562999998888', 'oi', fetchImpl as unknown as typeof fetch);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://wpp.example.com/message/sendText/my%20inst');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ number: '5562999998888', text: 'oi' });
  });

  it('lists the groups (id, name, size), skipping anything that is not a group JID', async () => {
    const fetchImpl = vi.fn(async () =>
      answer(200, [
        { id: '120363028290126547@g.us', subject: 'CustomEasy Gestão', size: 5, desc: 'x' },
        { id: '5562999998888@s.whatsapp.net', subject: 'not a group' },
        { subject: 'no id' },
      ]),
    );
    await expect(fetchGroups(target, fetchImpl as unknown as typeof fetch)).resolves.toEqual([{ id: '120363028290126547@g.us', name: 'CustomEasy Gestão', size: 5 }]);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://wpp.example.com/group/fetchAllGroups/my%20inst?getParticipants=false');
    expect(init.method).toBe('GET');
  });

  it.each([
    [401, 'AUTH'],
    [403, 'AUTH'],
    [404, 'INSTANCE_NOT_FOUND'],
    [302, 'REDIRECT'],
    [400, 'BAD_NUMBER'],
    [500, 'HTTP_500'],
  ])('maps HTTP %i to %s, without the answer body', async (status, code) => {
    const fetchImpl = vi.fn(async () => answer(status, { secret: 'echoed key k-123' }));
    const err = await sendText(target, '5562999998888', 'oi', fetchImpl as unknown as typeof fetch).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EvolutionError);
    expect((err as EvolutionError).code).toBe(code);
    expect((err as Error).message).not.toContain('k-123');
  });

  it('refuses a server on the internal network before any request', async () => {
    const fetchImpl = vi.fn();
    for (const server_url of ['https://evil.example.com', 'http://wpp.example.com', 'https://127.0.0.1:8080', 'https://evolution-api']) {
      const err = await connectionState({ ...target, server_url }, fetchImpl as unknown as typeof fetch).catch((e: unknown) => e);
      expect((err as EvolutionError).code).toBe('URL_REFUSED');
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports a network failure as UNREACHABLE and a timeout as TIMEOUT', async () => {
    const down = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(connectionState(target, down as unknown as typeof fetch)).rejects.toMatchObject({ code: 'UNREACHABLE' });
    const slow = vi.fn(async () => {
      throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    });
    await expect(connectionState(target, slow as unknown as typeof fetch)).rejects.toMatchObject({ code: 'TIMEOUT' });
  });
});
