import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import type { AuthContext } from '../auth/index.js';
import { createLifecycle } from './drain.js';
import { createUpgradeRouter } from './router.js';

const { resolveUserMock, canAccessMock } = vi.hoisted(() => ({ resolveUserMock: vi.fn(), canAccessMock: vi.fn() }));

// `resolveUser` de fato bate no banco/serviço de sessão — para o roteador só interessa o
// resultado (User | null), então mockamos o módulo inteiro e controlamos o retorno por teste.
// `parseCookies` fica com uma implementação real mínima (não é usada pelas rotas deste teste,
// mas o roteador chama incondicionalmente antes de resolveUser).
// The permission check hits the roles repository; the router only cares that it is consulted.
vi.mock('../auth/permissions.js', () => ({ canAccess: (...args: unknown[]) => canAccessMock(...args) }));

vi.mock('../auth/index.js', () => ({
  parseCookies: (header?: string) => {
    const out: Record<string, string> = {};
    if (!header) return out;
    for (const part of header.split(';')) {
      const idx = part.indexOf('=');
      if (idx === -1) continue;
      const k = part.slice(0, idx).trim();
      const v = part.slice(idx + 1).trim();
      if (k) out[k] = decodeURIComponent(v);
    }
    return out;
  },
  resolveUser: (...args: unknown[]) => resolveUserMock(...args),
}));

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

function shutdown(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

interface Outcome {
  statusCode?: number;
  opened?: boolean;
  firstMessage?: string;
}

/** Tenta o handshake e resolve com o status HTTP (upgrade rejeitado) ou com a 1ª mensagem (aberto). */
function attempt(url: string, options?: WebSocket.ClientOptions): Promise<Outcome> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, options);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('timeout esperando resposta do upgrade'));
    }, 2000);
    ws.on('unexpected-response', (_req, res) => {
      clearTimeout(timer);
      res.resume();
      ws.terminate();
      resolve({ statusCode: res.statusCode });
    });
    ws.on('message', (data) => {
      clearTimeout(timer);
      resolve({ opened: true, firstMessage: data.toString() });
      ws.close();
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

describe('createUpgradeRouter', () => {
  let server: http.Server;
  let wss: WebSocketServer;
  let port: number;

  beforeEach(async () => {
    resolveUserMock.mockReset();
    canAccessMock.mockReset();
    canAccessMock.mockResolvedValue(true);
    server = http.createServer();
    const router = createUpgradeRouter(server, { auth: {} as AuthContext });
    wss = new WebSocketServer({ noServer: true });
    router.add(/^\/ws\/ok\/([a-z0-9]+)$/, ({ req, socket, head, params }) => {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
        ws.send(params[0]);
      });
    });
    port = await listen(server);
  });

  afterEach(async () => {
    wss.close();
    await shutdown(server);
  });

  it('path desconhecido → 404 (mesmo com origem e auth válidas)', async () => {
    resolveUserMock.mockResolvedValue({ id: 'u1' });
    const outcome = await attempt(`ws://127.0.0.1:${port}/ws/nope`, { headers: { Origin: `http://127.0.0.1:${port}` } });
    expect(outcome.statusCode).toBe(404);
    expect(resolveUserMock).not.toHaveBeenCalled();
  });

  it('origem de outro host → 403', async () => {
    const outcome = await attempt(`ws://127.0.0.1:${port}/ws/ok/abc123`, { headers: { Origin: 'https://evil.example' } });
    expect(outcome.statusCode).toBe(403);
    expect(resolveUserMock).not.toHaveBeenCalled();
  });

  it('origem malformada → 403', async () => {
    const outcome = await attempt(`ws://127.0.0.1:${port}/ws/ok/abc123`, { headers: { Origin: 'not a url' } });
    expect(outcome.statusCode).toBe(403);
  });

  it('usuário sem terminals:read → 403', async () => {
    resolveUserMock.mockResolvedValue({ id: 'u1' });
    canAccessMock.mockResolvedValue(false);
    const outcome = await attempt(`ws://127.0.0.1:${port}/ws/ok/abc123`, { headers: { Origin: `http://127.0.0.1:${port}` } });
    expect(outcome.statusCode).toBe(403);
    expect(canAccessMock).toHaveBeenCalledWith(undefined, { id: 'u1' }, 'terminals', 'read');
  });

  it('origem válida, resolveUser sem usuário → 401', async () => {
    resolveUserMock.mockResolvedValue(null);
    const outcome = await attempt(`ws://127.0.0.1:${port}/ws/ok/abc123`, { headers: { Origin: `http://127.0.0.1:${port}` } });
    expect(outcome.statusCode).toBe(401);
  });

  it('origem válida, resolveUser com usuário → abre e entrega o handler com o param casado', async () => {
    resolveUserMock.mockResolvedValue({ id: 'u1' });
    const outcome = await attempt(`ws://127.0.0.1:${port}/ws/ok/abc123`, { headers: { Origin: `http://127.0.0.1:${port}` } });
    expect(outcome.opened).toBe(true);
    expect(outcome.firstMessage).toBe('abc123');
  });

  it('sem header Origin (cliente não-navegador), sem usuário → 401', async () => {
    resolveUserMock.mockResolvedValue(null);
    const outcome = await attempt(`ws://127.0.0.1:${port}/ws/ok/abc123`);
    expect(outcome.statusCode).toBe(401);
  });

  it('sem header Origin (cliente não-navegador), com usuário → abre', async () => {
    resolveUserMock.mockResolvedValue({ id: 'u1' });
    const outcome = await attempt(`ws://127.0.0.1:${port}/ws/ok/abc123`);
    expect(outcome.opened).toBe(true);
    expect(outcome.firstMessage).toBe('abc123');
  });

  describe('canWrite', () => {
    let cwServer: http.Server;
    let cwWss: WebSocketServer;
    let cwPort: number;

    beforeEach(async () => {
      cwServer = http.createServer();
      const router = createUpgradeRouter(cwServer, { auth: {} as AuthContext });
      cwWss = new WebSocketServer({ noServer: true });
      router.add(/^\/ws\/cw$/, ({ req, socket, head, canWrite }) => {
        cwWss.handleUpgrade(req, socket, head, (ws) => {
          cwWss.emit('connection', ws, req);
          ws.send(String(canWrite));
        });
      });
      cwPort = await listen(cwServer);
    });

    afterEach(async () => {
      cwWss.close();
      await shutdown(cwServer);
    });

    it('hands the handler canWrite: true for a user with terminals:write', async () => {
      resolveUserMock.mockResolvedValue({ id: 'u1' });
      const outcome = await attempt(`ws://127.0.0.1:${cwPort}/ws/cw`);
      expect(outcome.firstMessage).toBe('true');
      expect(canAccessMock).toHaveBeenCalledWith(undefined, { id: 'u1' }, 'terminals', 'write');
    });

    it('still opens for a user with terminals:read only, with canWrite: false', async () => {
      resolveUserMock.mockResolvedValue({ id: 'u1' });
      canAccessMock.mockImplementation(async (_r: unknown, _u: unknown, _res: string, action: string) => action === 'read');
      const outcome = await attempt(`ws://127.0.0.1:${cwPort}/ws/cw`);
      expect(outcome.opened).toBe(true);
      expect(outcome.firstMessage).toBe('false');
    });
  });

  describe('addPublic', () => {
    let pubServer: http.Server;
    let pubWss: WebSocketServer;
    let pubPort: number;

    beforeEach(async () => {
      pubServer = http.createServer();
      const router = createUpgradeRouter(pubServer, { auth: {} as AuthContext });
      pubWss = new WebSocketServer({ noServer: true });
      router.addPublic(/^\/agent\/ok\/?$/, ({ req, socket, head }) => {
        pubWss.handleUpgrade(req, socket, head, (ws) => {
          pubWss.emit('connection', ws, req);
          ws.send('public-ok');
        });
      });
      router.add(/^\/ws\/ok\/([a-z0-9]+)$/, ({ req, socket, head, params }) => {
        pubWss.handleUpgrade(req, socket, head, (ws) => {
          pubWss.emit('connection', ws, req);
          ws.send(params[0]);
        });
      });
      pubPort = await listen(pubServer);
    });

    afterEach(async () => {
      pubWss.close();
      await shutdown(pubServer);
    });

    it('rota pública: alcançável sem cookie/usuário, sem checar origem nem terminals:read', async () => {
      resolveUserMock.mockResolvedValue(null);
      const outcome = await attempt(`ws://127.0.0.1:${pubPort}/agent/ok`, { headers: { Origin: 'https://evil.example' } });
      expect(outcome.opened).toBe(true);
      expect(outcome.firstMessage).toBe('public-ok');
      expect(resolveUserMock).not.toHaveBeenCalled();
      expect(canAccessMock).not.toHaveBeenCalled();
    });

    it('rota autenticada continua exigindo cookie mesmo com uma rota pública registrada', async () => {
      resolveUserMock.mockResolvedValue(null);
      const outcome = await attempt(`ws://127.0.0.1:${pubPort}/ws/ok/abc123`, { headers: { Origin: `http://127.0.0.1:${pubPort}` } });
      expect(outcome.statusCode).toBe(401);
    });
  });

  // Node's http server drops its own socket `error` handler once it hands a socket to `upgrade`, and
  // `ws` only adds one inside handleUpgrade: a client resetting the connection while a route still
  // awaits a lookup would raise an unhandled ECONNRESET and take the whole process down.
  describe('a client that resets mid-admission', () => {
    let rstServer: http.Server;
    let rstWss: WebSocketServer;
    let rstPort: number;
    let seenErrorListeners: number[];
    interface Gate {
      entered: Promise<void>;
      proceed: () => void;
      finished: Promise<void>;
      wait: (socket: Duplex) => Promise<void>;
    }
    let gates: { pub: Gate; auth: Gate };

    /** Stands in for a slow DB lookup: tells the test the handler is waiting, and waits for its go. */
    function gate(): Gate {
      let entered!: () => void;
      let done!: () => void;
      let proceed!: () => void;
      const go = new Promise<void>((r) => (proceed = r));
      const g: Gate = {
        entered: new Promise((r) => (entered = r)),
        proceed: () => proceed(),
        finished: new Promise((r) => (done = r)),
        wait: async (socket) => {
          seenErrorListeners.push(socket.listenerCount('error'));
          entered();
          await go;
          await new Promise((r) => setTimeout(r, 20));
          done();
        },
      };
      return g;
    }

    beforeEach(async () => {
      seenErrorListeners = [];
      rstServer = http.createServer();
      const router = createUpgradeRouter(rstServer, { auth: {} as AuthContext });
      rstWss = new WebSocketServer({ noServer: true });
      gates = { pub: gate(), auth: gate() };
      const upgrade = (req: http.IncomingMessage, socket: Duplex, head: Buffer) =>
        rstWss.handleUpgrade(req, socket, head, (ws) => rstWss.emit('connection', ws, req));
      router.addPublic(/^\/pub\/slow$/, async ({ req, socket, head }) => {
        await gates.pub.wait(socket);
        upgrade(req, socket, head);
      });
      router.add(/^\/ws\/slow$/, async ({ req, socket, head }) => {
        await gates.auth.wait(socket);
        upgrade(req, socket, head);
      });
      rstPort = await listen(rstServer);
    });

    afterEach(async () => {
      rstWss.close();
      await shutdown(rstServer);
    });

    function resetDuringAdmission(path: string, g: Gate): Promise<void> {
      return new Promise((resolve, reject) => {
        const client = net.connect(rstPort, '127.0.0.1', () => {
          client.write(
            `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${rstPort}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
              'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
          );
        });
        client.on('error', () => {});
        g.entered.then(() => {
          client.resetAndDestroy();
          client.on('close', () => resolve());
        }, reject);
      });
    }

    for (const [label, path, key] of [
      ['public route', '/pub/slow', 'pub'],
      ['authenticated route', '/ws/slow', 'auth'],
    ] as const) {
      it(`${label}: the socket already has an error listener while the handler awaits, and the process survives a reset`, async () => {
        resolveUserMock.mockResolvedValue({ id: 'u1' });
        const onUncaught = vi.fn();
        process.on('uncaughtException', onUncaught);
        try {
          const g = gates[key];
          await resetDuringAdmission(path, g);
          // Give the server time to see the RST before the handler goes on to write to the socket.
          await new Promise((r) => setTimeout(r, 50));
          g.proceed();
          await g.finished;
          await new Promise((r) => setTimeout(r, 50));
          expect(seenErrorListeners).toHaveLength(1);
          expect(seenErrorListeners[0]).toBeGreaterThan(0);
          expect(onUncaught).not.toHaveBeenCalled();
        } finally {
          process.off('uncaughtException', onUncaught);
        }
        // and the server still answers
        resolveUserMock.mockResolvedValue(null);
        const outcome = await attempt(`ws://127.0.0.1:${rstPort}/ws/nope`);
        expect(outcome.statusCode).toBe(404);
      });
    }
  });
  describe('while draining', () => {
    let drainServer: http.Server;
    let drainWss: WebSocketServer;
    let drainPort: number;
    const handler = vi.fn();
    const publicHandler = vi.fn();

    beforeEach(async () => {
      handler.mockReset();
      publicHandler.mockReset();
      resolveUserMock.mockResolvedValue({ id: 'u1' });
      drainServer = http.createServer();
      const lifecycle = createLifecycle();
      const router = createUpgradeRouter(drainServer, { auth: {} as AuthContext, lifecycle });
      drainWss = new WebSocketServer({ noServer: true });
      const open = ({ req, socket, head }: { req: http.IncomingMessage; socket: Duplex; head: Buffer }) =>
        drainWss.handleUpgrade(req, socket, head, (ws) => {
          drainWss.emit('connection', ws, req);
          ws.send('opened');
        });
      router.add(/^\/ws\/ok$/, (ctx) => {
        handler();
        open(ctx);
      });
      router.addPublic(/^\/agent\/ok$/, (ctx) => {
        publicHandler();
        open(ctx);
      });
      drainPort = await listen(drainServer);
      // Open before draining starts, so the routes are known to work.
      await expect(attempt(`ws://127.0.0.1:${drainPort}/ws/ok`)).resolves.toMatchObject({ opened: true });
      handler.mockReset();
      lifecycle.startDraining();
    });

    afterEach(async () => {
      drainWss.close();
      await shutdown(drainServer);
    });

    it('a cookie route answers 503 and its handler is not called', async () => {
      const outcome = await attempt(`ws://127.0.0.1:${drainPort}/ws/ok`);
      expect(outcome.statusCode).toBe(503);
      expect(handler).not.toHaveBeenCalled();
    });

    it('a public route answers 503 and its handler is not called', async () => {
      const outcome = await attempt(`ws://127.0.0.1:${drainPort}/agent/ok`);
      expect(outcome.statusCode).toBe(503);
      expect(publicHandler).not.toHaveBeenCalled();
    });
  });

  describe('when draining starts while the upgrade is being admitted', () => {
    let server: http.Server;
    let wss: WebSocketServer;
    let port: number;
    const handler = vi.fn();
    const lifecycle = createLifecycle();

    beforeEach(async () => {
      handler.mockReset();
      server = http.createServer();
      const router = createUpgradeRouter(server, { auth: {} as AuthContext, lifecycle });
      wss = new WebSocketServer({ noServer: true });
      router.add(/^\/ws\/ok$/, ({ req, socket, head }) => {
        handler();
        wss.handleUpgrade(req, socket, head, (ws) => ws.send('opened'));
      });
      port = await listen(server);
    });

    afterEach(async () => {
      resolveUserMock.mockReset();
      wss.close();
      await shutdown(server);
    });

    it('a cookie route answers 503 when draining flips during auth, and its handler is not called', async () => {
      resolveUserMock.mockImplementation(async () => {
        lifecycle.startDraining();
        return { id: 'u1' };
      });
      const outcome = await attempt(`ws://127.0.0.1:${port}/ws/ok`);
      expect(outcome.statusCode).toBe(503);
      expect(handler).not.toHaveBeenCalled();
    });
  });
});
