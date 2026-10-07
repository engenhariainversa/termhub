import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { TTabChatFrame } from '@termhub/mobile-api';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WebSocket, type WebSocketServer } from 'ws';
import type { Repositories } from '../db/repositories/index.js';
import type { UpgradeHandler } from '../ws/router.js';
import type { TabChatSubscriber } from './hub.js';
import { registerTabChatWs } from './ws.js';

const SID = '11111111-2222-4333-8444-555555555555';
const user = { id: 'u1', email: 'u@example.com', name: 'U' };
const scope = { user, viewAs: { kind: 'self' }, ownerId: 'u1', createAs: 'u1' };
const logged: unknown[][] = [];
const log = { child: () => log, info: (...a: unknown[]) => logged.push(a), warn: (...a: unknown[]) => logged.push(a), error: () => {}, debug: () => {} } as never;

const tabs = [
  { id: 't1', name: 'api', project_id: 'p1', machine_id: 'm1', kind: 'terminal', tmux_session: 'th-t1', state: 'working', state_tool: 'claude', agent_session_id: SID, agent_transcript_path: `/h/.claude/projects/-w/${SID}.jsonl` },
  { id: 't2', name: 'other', project_id: 'p2', machine_id: 'm1', kind: 'terminal', tmux_session: 'th-t2', state: null, state_tool: null, agent_session_id: null, agent_transcript_path: null },
  { id: 't3', name: 'sim', project_id: 'p1', machine_id: 'm1', kind: 'simulator', tmux_session: null, state: null, state_tool: null, agent_session_id: null, agent_transcript_path: null },
];
const projects = [
  { id: 'p1', owner_id: 'u1' },
  { id: 'p2', owner_id: 'u2' },
];

let server: Server;
let wss: WebSocketServer;
let port: number;
let hub: { subscribe: ReturnType<typeof vi.fn>; subs: TabChatSubscriber[]; release: ReturnType<typeof vi.fn> };
const agent = { online: true, caps: ['transcript'] as string[] | null };
const clients: WebSocket[] = [];

beforeEach(async () => {
  logged.length = 0;
  const repos = {
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
  // The cookie router's own checks (origin, user, terminals:read) have their tests; here it only routes.
  let handler: { pattern: RegExp; fn: UpgradeHandler } | null = null;
  wss = registerTabChatWs({ add: (pattern, fn) => (handler = { pattern, fn }) }, { repos, hub: hub as never, log, agent: { isOnline: () => agent.online, capabilities: () => agent.caps } });
  server = createServer();
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const m = handler && url.pathname.match(handler.pattern);
    if (!handler || !m) return socket.destroy();
    void handler.fn({ req, socket, head, url, params: m.slice(1), user: user as never, scope: scope as never, canWrite: true });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.terminate();
  wss.close();
  await new Promise<void>((r) => server.close(() => r()));
  agent.online = true;
  agent.caps = ['transcript'];
});

function connect(path: string): { ws: WebSocket; frames: TTabChatFrame[]; opened: Promise<void>; failed: Promise<number> } {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  clients.push(ws);
  const frames: TTabChatFrame[] = [];
  ws.on('message', (d) => frames.push(JSON.parse(String(d))));
  const opened = new Promise<void>((r) => ws.once('open', () => r()));
  const failed = new Promise<number>((r) => ws.once('unexpected-response', (_req, res) => r(res.statusCode ?? 0)));
  ws.on('error', () => {});
  return { ws, frames, opened, failed };
}

const until = async (cond: () => boolean) => {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
};

it("says hello with the tab's availability, then subscribes from the given cursor", async () => {
  const { frames, opened } = connect(`/ws/tabs/t1/chat?after=${SID}.120`);
  await opened;
  await until(() => frames.length > 0 && hub.subscribe.mock.calls.length > 0);
  expect(frames[0]).toMatchObject({ type: 'hello', availability: 'ready' });
  expect(hub.subscribe).toHaveBeenCalledWith('t1', `${SID}.120`, expect.anything());
  hub.subs[0]!.send({ type: 'items', items: [{ kind: 'assistant', id: 'a', at: 'x', text: 'oi' }], live: `${SID}.200`, mode: null });
  await until(() => frames.length > 1);
  expect(frames[1]).toMatchObject({ type: 'items', live: `${SID}.200` });
});

it('an old agent is told in the hello', async () => {
  agent.caps = [];
  const { frames, opened } = connect('/ws/tabs/t1/chat');
  await opened;
  await until(() => frames.length > 0);
  expect(frames[0]).toMatchObject({ type: 'hello', availability: 'agent_outdated' });
  expect(hub.subscribe).toHaveBeenCalledWith('t1', null, expect.anything());
});

it('closing the socket releases the follower', async () => {
  const { ws, opened } = connect('/ws/tabs/t1/chat');
  await opened;
  await until(() => hub.subscribe.mock.calls.length > 0);
  ws.close();
  await until(() => hub.release.mock.calls.length > 0);
  expect(hub.release).toHaveBeenCalledTimes(1);
});

it("a tab outside the caller's scope, a missing one or a simulator is a 404 before the upgrade", async () => {
  for (const path of ['/ws/tabs/t2/chat', '/ws/tabs/nope/chat', '/ws/tabs/t3/chat']) {
    const { failed } = connect(path);
    expect(await failed).toBe(404);
  }
  expect(hub.subscribe).not.toHaveBeenCalled();
});

it('logs ids, never a frame', async () => {
  const { frames, opened } = connect('/ws/tabs/t1/chat');
  await opened;
  await until(() => hub.subs.length > 0);
  hub.subs[0]!.send({ type: 'items', items: [{ kind: 'user', id: 'u', at: 'x', text: 'segredo', images: 0 }], live: `${SID}.1`, mode: null });
  await until(() => frames.length > 1);
  expect(JSON.stringify(logged)).not.toContain('segredo');
});
