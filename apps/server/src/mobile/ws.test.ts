import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WebSocket, type WebSocketServer } from 'ws';
import { canAccess } from '../auth/permissions.js';
import { hashToken } from '../auth/tokens.js';
import { chatBus } from '../chat/bus.js';
import type { Repositories } from '../db/repositories/index.js';
import { createUpgradeRouter } from '../ws/router.js';
import { JtiCache } from './dpop.js';
import { MobileSocketRegistry } from './revocation.js';
import { registerMobileChatWs } from './ws.js';

vi.mock('../auth/permissions.js', async (orig) => ({ ...(await orig<typeof import('../auth/permissions.js')>()), canAccess: vi.fn(async () => true) }));

const PUBLIC_URL = 'https://termhub.dev/';
const HTU = 'https://termhub.dev/ws/m/chat';
const TOKEN = 'thb_mob_' + 'A'.repeat(43);
const user = { id: 'u1', email: 'u@example.com', name: 'U' };
const athOf = (token: string) => createHash('sha256').update(token).digest('base64url');
const log = { child: () => log, info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never;

let server: Server;
let wss: WebSocketServer;
let sockets: MobileSocketRegistry;
let jtis: JtiCache;
let port: number;
let sign: (claims: Record<string, unknown>) => Promise<string>;
let device: { id: string; user_id: string; public_key: string; status: string };
let findActiveById: ReturnType<typeof vi.fn>;
const clients: WebSocket[] = [];

async function start() {
  const { privateKey, publicKey } = await generateKeyPair('ES256');
  const jwk = await exportJWK(publicKey);
  sign = (claims) => new SignJWT({ iat: Math.floor(Date.now() / 1000), jti: randomUUID(), ...claims }).setProtectedHeader({ alg: 'ES256', typ: 'dpop+jwt', jwk }).sign(privateKey);
  device = { id: 'd1', user_id: user.id, public_key: JSON.stringify(jwk), status: 'active' };
  findActiveById = vi.fn(async (id: string) => (id === device.id ? device : undefined));
  const repos = {
    users: { findById: vi.fn(async (id: string) => (id === user.id ? user : undefined)) },
    devices: { findActiveById: (id: string) => findActiveById(id) },
    deviceSessions: { findValidToken: vi.fn(async (hash: string) => (hash === hashToken(TOKEN) ? { device } : undefined)) },
  } as unknown as Repositories;
  server = createServer();
  const upgrades = createUpgradeRouter(server, { auth: {} as never });
  sockets = new MobileSocketRegistry();
  jtis = new JtiCache();
  wss = registerMobileChatWs(upgrades, { repos, jtis, publicUrl: PUBLIC_URL, sockets, log });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
}

const proof = () => sign({ htm: 'GET', htu: HTU, ath: athOf(TOKEN) });
const headers = async (extra: Record<string, string> = {}) => ({ authorization: `Bearer ${TOKEN}`, dpop: await proof(), ...extra });

/** Opens a client and resolves with its frames, its close and the HTTP status of a refused upgrade. */
function open(h: Record<string, string>, query = '?v=1', opts: { autoPong?: boolean } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/m/chat${query}`, { headers: h, ...opts });
  clients.push(ws);
  const frames: Record<string, unknown>[] = [];
  ws.on('message', (data) => frames.push(JSON.parse(String(data))));
  const opened = new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  opened.catch(() => {}); // a refused upgrade rejects it; tests that expect a refusal read `status`
  const status = new Promise<number>((resolve) => ws.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0)));
  ws.on('error', () => {});
  const closed = new Promise<{ code: number; reason: string }>((resolve) => ws.once('close', (code, reason) => resolve({ code, reason: String(reason) })));
  return { ws, frames, opened, status, closed };
}

const waitFor = async (cond: () => boolean) => {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(cond()).toBe(true);
};

beforeEach(start);
afterEach(async () => {
  for (const c of clients) c.terminate();
  clients.length = 0;
  wss.close();
  await new Promise<void>((r) => server.close(() => r()));
  vi.mocked(canAccess).mockClear();
  vi.useRealTimers();
});

it('sends hello first, then only this user chat events', async () => {
  const c = open(await headers());
  await c.opened;
  await waitFor(() => c.frames.length === 1);
  expect(c.frames[0]).toEqual({ type: 'hello', protocol: 1, server_time: expect.any(String) });
  expect(sockets.hasLive('d1')).toBe(true);
  chatBus.publish({ type: 'delta', user_id: 'u2', conversation_id: 'c1', message_id: 'm0', delta: 'nao' });
  chatBus.publish({ type: 'delta', user_id: 'u1', conversation_id: 'c1', message_id: 'm1', delta: 'oi' });
  await waitFor(() => c.frames.length === 2);
  expect(c.frames[1]).toMatchObject({ type: 'delta', user_id: 'u1', delta: 'oi' });
  c.ws.close();
  await c.closed;
  await waitFor(() => !sockets.hasLive('d1'));
});

it('refuses a missing token, a bad proof, a replayed jti (401) and a user without chat:read (403)', async () => {
  expect(await open({ dpop: await proof() }).status).toBe(401);
  expect(await open({ authorization: `Bearer ${TOKEN}`, dpop: 'garbage' }).status).toBe(401);
  const wrongUrl = await sign({ htm: 'GET', htu: 'https://termhub.dev/ws/chat', ath: athOf(TOKEN) });
  expect(await open({ authorization: `Bearer ${TOKEN}`, dpop: wrongUrl }).status).toBe(401);
  const once = await proof();
  const first = open({ authorization: `Bearer ${TOKEN}`, dpop: once });
  await first.opened;
  expect(await open({ authorization: `Bearer ${TOKEN}`, dpop: once }).status).toBe(401);
  vi.mocked(canAccess).mockResolvedValueOnce(false);
  expect(await open(await headers()).status).toBe(403);
  expect(vi.mocked(canAccess)).toHaveBeenLastCalledWith(expect.anything(), user, 'chat', 'read');
});

it("accepts the Origin React Native sends on its own: the public URL's", async () => {
  // SocketRocket (iOS) and OkHttp (Android) set `Origin` to the socket URL's own origin; the app cannot drop it.
  const c = open(await headers({ origin: 'https://termhub.dev' }));
  await c.opened;
  await waitFor(() => c.frames.length === 1);
  expect(c.frames[0]).toMatchObject({ type: 'hello' });
});

it('refuses any other Origin header with 403, even with valid credentials', async () => {
  expect(await open(await headers({ origin: 'https://evil.example' })).status).toBe(403);
  expect(await open(await headers({ origin: 'http://termhub.dev' })).status).toBe(403);
});

it('closes a wrong or missing protocol version with 4400 after the upgrade', async () => {
  const v2 = open(await headers(), '?v=2');
  await v2.opened;
  expect(await v2.closed).toEqual({ code: 4400, reason: 'protocol' });
  const none = open(await headers(), '');
  await none.opened;
  expect(await none.closed).toEqual({ code: 4400, reason: 'protocol' });
  expect(v2.frames).toEqual([]);
  expect(sockets.hasLive('d1')).toBe(false);
});

it('closes the client with 4401 when the device is revoked', async () => {
  const c = open(await headers());
  await c.opened;
  expect(sockets.closeDevice('d1', 4401, 'device revoked')).toBe(1);
  expect(await c.closed).toEqual({ code: 4401, reason: 'device revoked' });
});

it('terminates a client that stops answering pings', async () => {
  // The heartbeat interval is created at registration: rebuild the server under fake intervals.
  wss.close();
  await new Promise<void>((r) => server.close(() => r()));
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  await start();
  const c = open(await headers(), '?v=1', { autoPong: false });
  await c.opened;
  vi.advanceTimersByTime(30_000);
  vi.advanceTimersByTime(30_000);
  expect((await c.closed).code).toBe(1006);
  await waitFor(() => !sockets.hasLive('d1'));
});

it('closes with 4401 a device revoked between the token check and the registration', async () => {
  findActiveById.mockResolvedValueOnce(undefined);
  const c = open(await headers());
  await c.opened;
  expect(await c.closed).toEqual({ code: 4401, reason: 'device revoked' });
  expect(c.frames).toEqual([]);
  expect(findActiveById).toHaveBeenCalledWith('d1');
  await waitFor(() => !sockets.hasLive('d1'));
});

it('refuses a device whose stored key is not JSON with 401', async () => {
  device.public_key = 'not json';
  expect(await open(await headers()).status).toBe(401);
});
