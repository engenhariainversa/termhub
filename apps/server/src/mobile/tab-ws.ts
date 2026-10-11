import type { FastifyBaseLogger } from 'fastify';
import { WebSocketServer, WebSocket } from 'ws';
import { MOBILE_API_VERSION, type TTabChatFrame } from '@termhub/mobile-api';
import { canAccess } from '../auth/permissions.js';
import { controlContextFor } from '../control/context.js';
import { HttpError } from '../lib/errors.js';
import type { TabChatHub } from '../tab-chat/hub.js';
import { availabilityOf, type AgentView } from '../tab-chat/reader.js';
import { rejectUpgrade, type createUpgradeRouter } from '../ws/router.js';
import type { MobileSocketRegistry } from './revocation.js';
import { authenticateMobileUpgrade, type MobileUpgradeDeps } from './ws-auth.js';

export interface MobileTabWsDeps extends MobileUpgradeDeps {
  sockets: MobileSocketRegistry;
  hub: Pick<TabChatHub, 'subscribe'>;
  log: FastifyBaseLogger;
  /** Injected by tests; the agent registry otherwise. */
  agent?: AgentView;
}

/** A tab id, as `newId` makes them (the protocol's TAB_ID_RE). */
const TAB_PATH = /^\/ws\/m\/tabs\/([a-z0-9]{1,64})\/?$/;
/** The `after` cursor is `<session uuid>.<offset>`; anything longer is not one. */
const AFTER_MAX = 128;

/**
 * `/ws/m/tabs/:id?v=1&after=<cursor>`: one open session screen on the phone (spec 2026-10-01 tab chat
 * §5.5). Authenticated like `/ws/m/chat` (bearer token, DPoP proof over this tab's own path, device
 * re-check, registered so a revoke closes it with 4401), then `terminals:read` and the tab in the
 * caller's scope (4404 otherwise). Server to phone only: `hello` with the tab's availability, then
 * what the hub sends — `items`, `state`, `reset`, `unavailable`. The open socket is the subscription:
 * closing it releases the hub's follower. Logs ids only, never a frame.
 */
export function registerMobileTabWs(router: ReturnType<typeof createUpgradeRouter>, deps: MobileTabWsDeps): WebSocketServer {
  // The phone sends nothing on this socket.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  const log = deps.log.child({ mod: 'mobile-tab-ws' });

  router.addPublic(TAB_PATH, async ({ req, socket, head, url, params }) => {
    const tabId = params[0]!;
    const who = await authenticateMobileUpgrade(deps, { req, socket, url });
    if (!who) return;
    const { user, deviceId } = who;
    if (!(await canAccess(deps.repos, user, 'terminals', 'read'))) return rejectUpgrade(socket, 403, 'Forbidden');
    const rawAfter = url.searchParams.get('after');
    const after = rawAfter && rawAfter.length <= AFTER_MAX ? rawAfter : null;

    wss.handleUpgrade(req, socket, head, async (ws) => {
      // Closed after the upgrade so the app reads a close code, not an opaque HTTP failure.
      if (url.searchParams.get('v') !== String(MOBILE_API_VERSION)) return ws.close(4400, 'protocol');
      wss.emit('connection', ws, req);
      const w = ws as WebSocket & { isAlive?: boolean };
      w.isAlive = true;
      ws.on('pong', () => (w.isAlive = true));

      // Register first, then re-check the device (as /ws/m/chat): a revoke after `add` is closed by
      // `closeDevice`, one during the awaits above is caught by the re-check.
      const release = deps.sockets.add(deviceId, ws, user.id);
      let closed = false;
      let unsubscribe = () => {};
      const done = () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        release();
      };
      ws.on('close', (code: number) => {
        done();
        log.info({ userId: user.id, deviceId, tabId, code }, 'mobile tab chat disconnected');
      });
      ws.on('error', done);

      let found: Awaited<ReturnType<ReturnType<typeof controlContextFor>['scoped']['tab']>>;
      try {
        const active = await deps.repos.devices.findActiveById(deviceId);
        if (closed) return;
        if (!active) return ws.close(4401, 'device revoked');
        found = await controlContextFor(deps.repos, user).scoped.tab(tabId);
      } catch (err) {
        if (closed) return;
        if (err instanceof HttpError && err.statusCode === 404) return ws.close(4404, 'not found');
        log.warn({ err: err instanceof Error ? err.name : typeof err, deviceId, tabId }, 'mobile tab chat setup failed');
        return ws.close(1011, 'server error');
      }
      if (closed) return;

      const send = (frame: TTabChatFrame) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
      };
      send({ type: 'hello', protocol: MOBILE_API_VERSION, server_time: new Date().toISOString(), availability: availabilityOf(found.tab, found.machine, deps.agent) });
      // Subscribed even when the tab is not readable yet: the hub tells the phone when it becomes so.
      unsubscribe = deps.hub.subscribe(found.tab.id, after, { send });
      log.info({ userId: user.id, deviceId, tabId }, 'mobile tab chat connected');
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
