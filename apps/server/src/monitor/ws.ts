import { WebSocketServer, WebSocket } from 'ws';
import type { FastifyBaseLogger } from 'fastify';
import type { createUpgradeRouter } from '../ws/router.js';
import { monitorBus, type TabLifecycle, type TabStateChange } from './bus.js';
import { automationBus, type PublishedAutomationEvent } from '../automation/events.js';

/** Whether a change on a machine of `ownerId` belongs to the scope (null = an admin viewing "all"). */
const inScope = (scopeOwner: string | null, ownerId: string | null) => scopeOwner === null || ownerId === scopeOwner;

/** A tab's monitor state changed (`type: 'tab'`); null when outside the scope. */
export function stateFrame(scopeOwner: string | null, change: TabStateChange) {
  if (!inScope(scopeOwner, change.owner_id)) return null;
  return { type: 'tab' as const, tab: change.tab, project_id: change.project_id, machine_id: change.machine_id };
}

/** A tab opened or renamed (`tab_upsert`, the whole row) or closed (`tab_removed`); null when outside the scope. */
export function lifecycleFrame(scopeOwner: string | null, event: TabLifecycle) {
  if (!inScope(scopeOwner, event.owner_id)) return null;
  if (event.kind === 'upsert') return { type: 'tab_upsert' as const, tab: event.tab, project_id: event.project_id, machine_id: event.machine_id };
  return { type: 'tab_removed' as const, tab_id: event.tab_id, project_id: event.project_id, machine_id: event.machine_id };
}

/** Something the automatic work did (`type: 'automation'`, agentic board); null when outside the scope. */
export function automationFrame(scopeOwner: string | null, e: PublishedAutomationEvent) {
  if (!inScope(scopeOwner, e.owner_id)) return null;
  const { owner_id: _owner, ...event } = e;
  return { type: 'automation' as const, event };
}

/**
 * `/ws/monitor`: pushes tab state changes (home list, tab bar dots) and tabs opened, renamed and
 * closed (the sidebar's open tabs), and automation events (pauses, runs, PRs), to the browser. One message per change, filtered by the
 * caller's scope; the client fetches the snapshots over REST.
 * Only metadata and the tool's own message travel here — never terminal content.
 */
export function registerMonitorWs(router: ReturnType<typeof createUpgradeRouter>, deps: { log: FastifyBaseLogger }): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  const log = deps.log.child({ mod: 'monitor-ws' });

  router.add(/^\/ws\/monitor\/?$/, async ({ req, socket, head, scope }) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
      const w = ws as WebSocket & { isAlive?: boolean };
      w.isAlive = true;
      ws.on('pong', () => (w.isAlive = true));

      const send = (frame: object | null) => {
        if (frame && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
      };
      const offState = monitorBus.subscribe((change) => send(stateFrame(scope.ownerId, change)));
      const offLifecycle = monitorBus.subscribeLifecycle((event) => send(lifecycleFrame(scope.ownerId, event)));
      const offAutomation = automationBus.subscribe((e) => send(automationFrame(scope.ownerId, e)));
      const unsubscribe = () => {
        offState();
        offLifecycle();
        offAutomation();
      };
      log.info({ userId: scope.user.id }, 'monitor conectado');
      ws.on('close', () => {
        unsubscribe();
        log.info({ userId: scope.user.id }, 'monitor desconectado');
      });
      ws.on('error', () => unsubscribe());
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
  wss.on('close', () => clearInterval(interval));
  return wss;
}
