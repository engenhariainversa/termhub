import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { config } from '../config.js';
import { parseCookies, resolveUser, type AuthContext } from '../auth/index.js';
import { canAccess } from '../auth/permissions.js';
import { resolveScope, type Scope } from '../auth/scope.js';
import type { User } from '../db/repositories/types.js';
import type { Lifecycle } from './drain.js';
import { isPendingDeletion } from '../account/deletion.js';

export interface UpgradeContext {
  req: IncomingMessage;
  socket: Duplex;
  head: Buffer;
  url: URL;
  params: string[];
  user: User;
  scope: Scope;
}
export type UpgradeHandler = (ctx: UpgradeContext) => void | Promise<void>;

/** Public upgrade routes authenticate themselves (e.g. bearer token): no cookie user/scope. */
export interface PublicUpgradeContext {
  req: IncomingMessage;
  socket: Duplex;
  head: Buffer;
  url: URL;
  params: string[];
}
export type PublicUpgradeHandler = (ctx: PublicUpgradeContext) => void | Promise<void>;

export function rejectUpgrade(socket: Duplex, status: number, text: string) {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

/** Anti CSWSH: a origem do navegador precisa bater com o host servido ou o PUBLIC_URL. */
function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // clientes não-navegador (curl, wscat) — já protegidos pela auth
  let o: URL;
  try {
    o = new URL(origin);
  } catch {
    return false;
  }
  const host = req.headers.host;
  if (host && o.host === host) return true;
  try {
    if (o.host === new URL(config.publicUrl).host) return true;
  } catch {
    /* ignore */
  }
  if (!config.isProd && (o.hostname === 'localhost' || o.hostname === '127.0.0.1')) return true;
  return false;
}

/** Um único listener de `upgrade`: casa o path, checa origem e auth, e delega ao handler. */
export function createUpgradeRouter(server: HttpServer, deps: { auth: AuthContext; lifecycle?: Lifecycle }) {
  const routes: { pattern: RegExp; handler: UpgradeHandler }[] = [];
  const publicRoutes: { pattern: RegExp; handler: PublicUpgradeHandler }[] = [];
  server.on('upgrade', async (req, socket, head) => {
    // Node's http server removes its own socket `error` handler once it emits `upgrade`, and `ws`
    // only adds one inside handleUpgrade. Every route below awaits (auth, DB lookups) before that,
    // so a client resetting the connection in the meantime would raise an unhandled ECONNRESET and
    // take the whole process down. The error itself needs no handling here: the socket is destroyed
    // and emits `close`, which is what routes release their resources on.
    socket.on('error', () => {});
    // Draining for a shutdown (spec 2026-09-27 §5.2): the client retries and lands on the other colour.
    if (deps.lifecycle?.draining) return rejectUpgrade(socket, 503, 'Service Unavailable');
    const url = new URL(req.url ?? '/', 'http://localhost');

    // Public routes match first and authenticate themselves (bearer token, not cookie):
    // they skip originAllowed() too — agents send no Origin, and a browser can't set
    // Authorization on a WebSocket, so cross-site WebSocket hijacking doesn't apply here.
    const pub = publicRoutes.map((r) => ({ r, m: url.pathname.match(r.pattern) })).find((x) => x.m);
    if (pub?.m) {
      try {
        await pub.r.handler({ req, socket, head, url, params: pub.m.slice(1) });
      } catch {
        rejectUpgrade(socket, 500, 'Internal Server Error');
      }
      return;
    }

    const route = routes.map((r) => ({ r, m: url.pathname.match(r.pattern) })).find((x) => x.m);
    if (!route?.m) return rejectUpgrade(socket, 404, 'Not Found');
    if (!originAllowed(req)) return rejectUpgrade(socket, 403, 'Forbidden');
    const cookies = parseCookies(req.headers.cookie);
    let user: User | null = null;
    try {
      user = await resolveUser(deps.auth, { headers: req.headers, cookies });
    } catch {
      user = null;
    }
    if (!user) return rejectUpgrade(socket, 401, 'Unauthorized');
    // A deactivated account (deletion pending, TER-720) opens no socket: only the cancel path is left.
    if (isPendingDeletion(user)) return rejectUpgrade(socket, 403, 'Forbidden');
    const scope = await resolveScope(deps.auth.repos, user, cookies);
    // One gate for every WebSocket here: terminals:read. It fits the terminal and simulator streams
    // it was written for, and /ws/chat rides on it too — the chat is the global terminal as a
    // conversation, so nobody who cannot read a terminal has any business on it either.
    // (The chat's own per-user filter lives in chat/ws.ts; this only decides who may connect.)
    if (!(await canAccess(deps.auth.repos, user, 'terminals', 'read'))) return rejectUpgrade(socket, 403, 'Forbidden');
    // The awaits above give a drain time to start: a socket admitted now would miss its handover.
    if (deps.lifecycle?.draining) return rejectUpgrade(socket, 503, 'Service Unavailable');
    try {
      await route.r.handler({ req, socket, head, url, params: route.m.slice(1), user, scope });
    } catch {
      rejectUpgrade(socket, 500, 'Internal Server Error');
    }
  });
  return {
    add(pattern: RegExp, handler: UpgradeHandler) {
      routes.push({ pattern, handler });
    },
    addPublic(pattern: RegExp, handler: PublicUpgradeHandler) {
      publicRoutes.push({ pattern, handler });
    },
  };
}
