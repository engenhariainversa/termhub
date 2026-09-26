import type { FastifyBaseLogger } from 'fastify';
import { WebSocketServer, WebSocket } from 'ws';
import { MOBILE_API_VERSION, canonicalHtu } from '@termhub/mobile-api';
import { canAccess } from '../auth/permissions.js';
import { hashToken } from '../auth/tokens.js';
import { chatBus } from '../chat/bus.js';
import type { Repositories } from '../db/repositories/index.js';
import { rejectUpgrade, type createUpgradeRouter } from '../ws/router.js';
import { MOBILE_TOKEN_RE } from './codes.js';
import { verifyProof, type JtiCache } from './dpop.js';
import type { MobileSocketRegistry } from './revocation.js';

export interface MobileChatWsDeps {
  repos: Repositories;
  jtis: JtiCache;
  /** The mobile API's public base URL: proofs are bound to `<publicUrl>/ws/m/chat`. */
  publicUrl: string;
  sockets: MobileSocketRegistry;
  log: FastifyBaseLogger;
}

/**
 * `/ws/m/chat`: the phone's server → client chat stream. A public upgrade route that authenticates
 * itself like the REST prefix does — `Authorization: Bearer thb_mob_…` plus a DPoP proof over
 * `GET <publicUrl>/ws/m/chat` bound to that token — then pushes `hello` and the user's own chat
 * events. Registered in the device's socket registry so a revoke closes it with 4401.
 * Never log a token or a proof.
 */
export function registerMobileChatWs(router: ReturnType<typeof createUpgradeRouter>, deps: MobileChatWsDeps): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const log = deps.log.child({ mod: 'mobile-chat-ws' });
  const ownOrigin = new URL(deps.publicUrl).origin;

  router.addPublic(/^\/ws\/m\/chat\/?$/, async ({ req, socket, head, url }) => {
    // React Native's WebSocket (SocketRocket on iOS, OkHttp on Android) always sends the socket
    // URL's own origin, and the app cannot drop it. Any other Origin is a page elsewhere trying
    // its luck; it could not send the bearer token and proof anyway, so refuse it outright.
    const origin = req.headers.origin;
    if (origin && origin !== ownOrigin) return rejectUpgrade(socket, 403, 'Forbidden');
    const raw = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
    if (!MOBILE_TOKEN_RE.test(raw)) return rejectUpgrade(socket, 401, 'Unauthorized');
    const found = await deps.repos.deviceSessions.findValidToken(hashToken(raw), new Date());
    if (!found) return rejectUpgrade(socket, 401, 'Unauthorized');
    let publicKeyJwk: JsonWebKey;
    try {
      publicKeyJwk = JSON.parse(found.device.public_key) as JsonWebKey;
    } catch {
      return rejectUpgrade(socket, 401, 'Unauthorized');
    }
    const proof = await verifyProof({
      proof: String(req.headers.dpop ?? ''),
      htm: 'GET',
      htu: canonicalHtu(deps.publicUrl, url.pathname),
      publicKeyJwk,
      accessToken: raw,
    });
    // The jti is claimed only once the signature has verified, so garbage cannot fill the cache.
    if (!proof.ok || !deps.jtis.claim(found.device.id, proof.jti)) return rejectUpgrade(socket, 401, 'Unauthorized');
    const user = await deps.repos.users.findById(found.device.user_id);
    if (!user || !(await canAccess(deps.repos, user, 'chat', 'read'))) return rejectUpgrade(socket, 403, 'Forbidden');

    const deviceId = found.device.id;
    wss.handleUpgrade(req, socket, head, async (ws) => {
      // Closed after the upgrade so the app reads a close code, not an opaque HTTP failure.
      if (url.searchParams.get('v') !== String(MOBILE_API_VERSION)) return ws.close(4400, 'protocol');
      wss.emit('connection', ws, req);
      const w = ws as WebSocket & { isAlive?: boolean };
      w.isAlive = true;
      ws.on('pong', () => (w.isAlive = true));

      // Register first, then re-check the device: a revoke that lands after `add` is closed by
      // `closeDevice`, one that landed during the awaits above is caught by the re-check below.
      const release = deps.sockets.add(deviceId, ws, user.id);
      let closed = false;
      let unsubscribe = () => {};
      const done = () => {
        closed = true;
        unsubscribe();
        release();
      };
      ws.on('close', (code: number) => {
        done();
        log.info({ userId: user.id, deviceId, code }, 'mobile chat disconnected');
      });
      ws.on('error', done);

      let active: unknown;
      try {
        active = await deps.repos.devices.findActiveById(deviceId);
      } catch (err) {
        log.warn({ err: err instanceof Error ? err.name : typeof err, deviceId }, 'mobile chat device re-check failed');
        return ws.close(1011, 'server error');
      }
      if (closed) return;
      if (!active) return ws.close(4401, 'device revoked');

      ws.send(JSON.stringify({ type: 'hello', protocol: MOBILE_API_VERSION, server_time: new Date().toISOString() }));
      unsubscribe = chatBus.subscribe((event) => {
        if (event.user_id !== user.id) return;
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event));
      });
      log.info({ userId: user.id, deviceId }, 'mobile chat connected');
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
