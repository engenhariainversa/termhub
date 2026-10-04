import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { TTabChatFrame } from '@termhub/mobile-api';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WebSocket, type WebSocketServer } from 'ws';
import { canAccess } from '../auth/permissions.js';
import { hashToken } from '../auth/tokens.js';
import type { Repositories } from '../db/repositories/index.js';
import type { TabChatSubscriber } from '../tab-chat/hub.js';
import { createUpgradeRouter } from '../ws/router.js';
import { JtiCache } from './dpop.js';
import { MobileSocketRegistry } from './revocation.js';
import { registerMobileTabWs } from './tab-ws.js';

vi.mock('../auth/permissions.js', async (orig) => ({ ...(await orig<typeof import('../auth/permissions.js')>()), canAccess: vi.fn(async () => true) }));

const PUBLIC_URL = 'https://termhub.dev/';
const PATH = '/ws/m/tabs/t1';
const TOKEN = 'thb_mob_' + 'A'.repeat(43);
const SID = '11111111-2222-4333-8444-555555555555';
const user = { id: 'u1', email: 'u@example.com', name: 'U' };
const athOf = (token: string) => createHash('sha256').update(token).digest('base64url');
const logged: unknown[][] = [];
const log = { child: () => log, info: (...a: unknown[]) => logged.push(a), warn: (...a: unknown[]) => logged.push(a), error: () => {}, debug: (...a: unknown[]) => logged.push(a) } as never;

const tabs = [
  { id: 't1', name: 'api', project_id: 'p1', machine_id: 'm1', kind: 'terminal', tmux_session: 'th-t1', state: 'working', state_tool: 'claude', agent_session_id: SID, agent_transcript_path: `/h/.claude/projects/-w/${SID}.jsonl` },
  { id: 't2', name: 'other', project_id: 'p2', machine_id: 'm1', kind: 'terminal', tmux_session: 'th-t2', state: null, state_tool: null, agent_session_id: null, agent_transcript_path: null },
];
const projects = [
  { id: 'p1', owner_id: 'u1' },
  { id: 'p2', owner_id: 'u2' },
];

let server: Server;
let wss: WebSocketServer;
let sockets: MobileSocketRegistry;
let port: number;
let sign: (claims: Record<string, unknown>) => Promise<string>;
let device: { id: string; user_id: string; public_key: string; status: string };
let findActiveById: ReturnType<typeof vi.fn>;
let hub: { subscribe: ReturnType<typeof vi.fn>; subs: TabChatSubscriber[]; release: ReturnType<typeof vi.fn> };
const agent = { online: true, caps: ['transcript'] as string[] | null };
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
    tabs: { findById: vi.fn(async (id: string) => tabs.find((t) => t.id === id)) },
    projects: { findById: vi.fn(async (id: string) => projects.find((p) => p.id === id)) },
    machines: { findById: vi.fn(async (id: string) => (id === 'm1' ? { id: 'm1', type: 'agent', owner_id: 'u1' } : undefined)) },
    projectMachines: { find: vi.fn(async (p: string, m: string) => ({ project_id: p, machine_id: m, cwd: '/w' })) },
  } as unknown as Repositories;
  const release = vi.fn();
  hub = {
    subs: [],
    release,
    subscribe: vi.fn((_tabId: string, _after: string | null, sub: TabChatSubscriber) => {
      hub.subs.push(sub);
      return release;
    }),
  };
  server = createServer();
  const upgrades = createUpgradeRouter(server, { auth: {} as never });
  sockets = new MobileSocketRegistry();
  wss = registerMobileTabWs(upgrades, {
    repos,
    jtis: new JtiCache(),
    publicUrl: PUBLIC_URL,
    sockets,
    hub: hub as never,
    log,
    agent: { isOnline: () => agent.online, capabilities: () => agent.caps },
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
}

const proof = (path = PATH) => sign({ htm: 'GET', htu: `https://termhub.dev${path}`, ath: athOf(TOKEN) });
const headers = async (extra: Record<string, string> = {}, path = PATH) => ({ authorization: `Bearer ${TOKEN}`, dpop: await proof(path), ...extra });

function open(h: Record<string, string>, path = PATH, query = '?v=1') {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}${query}`, { headers: h });
  clients.push(ws);
  const frames: Record<string, unknown>[] = [];
  ws.on('message', (data) => frames.push(JSON.parse(String(data))));
  const opened = new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  opened.catch(() => {});
  const status = new Promise<number>((resolve) => ws.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0)));
  ws.on('error', () => {});
  const closed = new Promise<{ code: number; reason: string }>((resolve) => ws.once('close', (code, reason) => resolve({ code, reason: String(reason) })));
  return { ws, frames, opened, status, closed };
}

const waitFor = async (cond: () => boolean) => {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(cond()).toBe(true);
};

beforeEach(async () => {
  agent.online = true;
  agent.caps = ['transcript'];
  logged.length = 0;
  await start();
});
afterEach(async () => {
  for (const c of clients) c.terminate();
  clients.length = 0;
  wss.close();
  await new Promise<void>((r) => server.close(() => r()));
  vi.mocked(canAccess).mockClear();
});

it('sends hello with the availability, then follows the tab from the `after` cursor', async () => {
  const c = open(await headers(), PATH, `?v=1&after=${SID}.120`);
  await c.opened;
  await waitFor(() => c.frames.length === 1);
  expect(c.frames[0]).toEqual({ type: 'hello', protocol: 1, server_time: expect.any(String), availability: 'ready' });
  expect(hub.subscribe).toHaveBeenCalledWith('t1', `${SID}.120`, expect.anything());
  expect(sockets.hasLive('d1')).toBe(true);
  const frame: TTabChatFrame = { type: 'items', items: [{ kind: 'assistant', id: 'u1:0', at: '', text: 'segredo' }], live: `${SID}.130`, mode: null };
  hub.subs[0]!.send(frame);
  await waitFor(() => c.frames.length === 2);
  expect(c.frames[1]).toEqual(frame);
  c.ws.close();
  await c.closed;
  await waitFor(() => hub.release.mock.calls.length === 1);
  await waitFor(() => !sockets.hasLive('d1'));
  // ids only: never a frame
  expect(JSON.stringify(logged)).not.toContain('segredo');
  expect(logged.some((l) => JSON.stringify(l).includes('"tabId":"t1"') && JSON.stringify(l).includes('"deviceId":"d1"'))).toBe(true);
});

it('subscribes without a cursor when there is none', async () => {
  const c = open(await headers());
  await c.opened;
  await waitFor(() => hub.subscribe.mock.calls.length === 1);
  expect(hub.subscribe).toHaveBeenCalledWith('t1', null, expect.anything());
});

it('a tab that is not ready says why in hello and still subscribes, to come alive when it is', async () => {
  agent.online = false;
  const c = open(await headers());
  await c.opened;
  await waitFor(() => c.frames.length === 1);
  expect(c.frames[0]).toMatchObject({ type: 'hello', availability: 'offline' });
  expect(hub.subscribe).toHaveBeenCalledTimes(1);
});

it('refuses a missing token, a bad proof, a proof over another path (401) and a foreign Origin (403)', async () => {
  expect(await open({ dpop: await proof() }).status).toBe(401);
  expect(await open({ authorization: `Bearer ${TOKEN}`, dpop: 'garbage' }).status).toBe(401);
  // a proof made for another tab's socket does not open this one
  expect(await open({ authorization: `Bearer ${TOKEN}`, dpop: await proof('/ws/m/tabs/t9') }).status).toBe(401);
  expect(await open(await headers({ origin: 'https://evil.example' })).status).toBe(403);
});

it('refuses a user without terminals:read with 403', async () => {
  vi.mocked(canAccess).mockResolvedValueOnce(false);
  expect(await open(await headers()).status).toBe(403);
  expect(vi.mocked(canAccess)).toHaveBeenLastCalledWith(expect.anything(), user, 'terminals', 'read');
});

it('closes a wrong protocol version with 4400', async () => {
  const c = open(await headers(), PATH, '?v=2');
  await c.opened;
  expect(await c.closed).toEqual({ code: 4400, reason: 'protocol' });
  expect(hub.subscribe).not.toHaveBeenCalled();
});

it("closes with 4404 a tab outside the caller's scope, or one that does not exist", async () => {
  const foreign = open(await headers({}, '/ws/m/tabs/t2'), '/ws/m/tabs/t2');
  await foreign.opened;
  expect(await foreign.closed).toEqual({ code: 4404, reason: 'not found' });
  const none = open(await headers({}, '/ws/m/tabs/nope'), '/ws/m/tabs/nope');
  await none.opened;
  expect(await none.closed).toEqual({ code: 4404, reason: 'not found' });
  expect(hub.subscribe).not.toHaveBeenCalled();
  await waitFor(() => !sockets.hasLive('d1'));
});

it('closes with 4401 when the device is revoked, and releases the subscription once', async () => {
  const c = open(await headers());
  await c.opened;
  await waitFor(() => hub.subscribe.mock.calls.length === 1);
  expect(sockets.closeDevice('d1', 4401, 'device revoked')).toBe(1);
  expect(await c.closed).toEqual({ code: 4401, reason: 'device revoked' });
  await waitFor(() => hub.release.mock.calls.length === 1);
  await new Promise((r) => setTimeout(r, 30));
  expect(hub.release).toHaveBeenCalledTimes(1);
});

it('closes with 4401 a device revoked before the registration', async () => {
  findActiveById.mockResolvedValueOnce(undefined);
  const c = open(await headers());
  await c.opened;
  expect(await c.closed).toEqual({ code: 4401, reason: 'device revoked' });
  expect(hub.subscribe).not.toHaveBeenCalled();
});

it('does not take a path that is not a tab id', async () => {
  expect(await open(await headers({}, '/ws/m/tabs/A_B'), '/ws/m/tabs/A_B').status).toBe(404);
});
