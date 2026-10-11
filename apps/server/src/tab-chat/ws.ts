import type { FastifyBaseLogger } from 'fastify';
import { WebSocketServer, WebSocket } from 'ws';
import { MOBILE_API_VERSION, type TTabChatFrame } from '@termhub/mobile-api';
import { Scoped } from '../auth/scope.js';
import type { Repositories } from '../db/repositories/index.js';
import { rejectUpgrade, type createUpgradeRouter } from '../ws/router.js';
import type { TabChatHub } from './hub.js';
import { availabilityOf, type AgentView } from './reader.js';

export interface TabChatWsDeps {
  repos: Repositories;
  hub: Pick<TabChatHub, 'subscribe'>;
  log: FastifyBaseLogger;
  /** Injected by tests; the agent registry otherwise. */
  agent?: AgentView;
}

/** A tab id, as `newId` makes them; `/ws/tabs/:id` (the terminal) never matches this path. */
export const TAB_CHAT_WS_PATH = /^\/ws\/tabs\/([a-z0-9]{1,64})\/chat\/?$/;
/** The `after` cursor is `<session uuid>.<offset>`; anything longer is not one. */
const AFTER_MAX = 128;

/**
 * `/ws/tabs/:id/chat?after=<cursor>`: a Claude Code tab read as a conversation in the web (TER-1003),
 * the browser's twin of the phone's `/ws/m/tabs/:id` (spec 2026-10-01 tab chat §5.5). The upgrade
 * router authenticates the cookie and checks `terminals:read`; the tab must be in the caller's scope
 * (404 before the upgrade otherwise). Server to browser only, the same frames as the phone: `hello`,
 * then what the hub sends. The open socket is the subscription. Logs ids only, never a frame.
 */
export function registerTabChatWs(router: Pick<ReturnType<typeof createUpgradeRouter>, 'add'>, deps: TabChatWsDeps): WebSocketServer {
  // The browser sends nothing on this socket.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  const log = deps.log.child({ mod: 'tab-chat-ws' });

  router.add(TAB_CHAT_WS_PATH, async ({ req, socket, head, url, params, user, scope }) => {
    const tabId = params[0]!;
    // ownership: a tab outside the caller's scope is a 404, like a missing one
    const found = await new Scoped(deps.repos, scope).tab(tabId).catch(() => null);
    if (!found || found.tab.kind !== 'terminal') return rejectUpgrade(socket, 404, 'Not Found');
    const rawAfter = url.searchParams.get('after');
    const after = rawAfter && rawAfter.length <= AFTER_MAX ? rawAfter : null;

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
      const w = ws as WebSocket & { isAlive?: boolean };
      w.isAlive = true;
      ws.on('pong', () => (w.isAlive = true));

      const send = (frame: TTabChatFrame) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
      };
      send({ type: 'hello', protocol: MOBILE_API_VERSION, server_time: new Date().toISOString(), availability: availabilityOf(found.tab, found.machine, deps.agent) });
      // Subscribed even when the tab is not readable yet: the hub says when it becomes so.
      const unsubscribe = deps.hub.subscribe(found.tab.id, after, { send });
      let closed = false;
      const done = () => {
        if (closed) return;
        closed = true;
        unsubscribe();
      };
      ws.on('close', (code: number) => {
        done();
        log.info({ userId: user.id, tabId, code }, 'tab chat disconnected');
      });
      ws.on('error', done);
      log.info({ userId: user.id, tabId }, 'tab chat connected');
    });
  });

  const interval = setInterval(() => {
    for (const ws of wss.clients) {
      const w = ws as WebSocket & { isAlive?: boolean };
      if (w.isAlive === false) {
        w.terminate();
        continue;
      }
      w.isAlive = false;
      w.ping();
    }
  }, 30_000);
  interval.unref();
  wss.on('close', () => clearInterval(interval));
  return wss;
}
