import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { findFreePort } from './tunnel-types.js';
import { probeLocalPorts } from './port-probe.js';

const servers: { close(): void }[] = [];
const sockets: net.Socket[] = [];
afterEach(() => {
  for (const s of sockets.splice(0)) s.destroy();
  for (const s of servers.splice(0)) s.close();
});

async function listen(server: net.Server): Promise<number> {
  servers.push(server);
  server.on('connection', (sock) => sockets.push(sock));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return (server.address() as AddressInfo).port;
}
const httpServer = (handler: http.RequestListener) => listen(http.createServer(handler));

describe('probeLocalPorts', () => {
  it('refused ports are free', async () => {
    expect(await probeLocalPorts(await findFreePort(), await findFreePort())).toEqual({ wda: 'free', mjpeg: 'free' });
  });

  it('a socket closed without a response is free (what ssh and agent tunnels do on ECONNREFUSED)', async () => {
    const port = await listen(net.createServer((sock) => sock.destroy()));
    expect(await probeLocalPorts(port, port)).toEqual({ wda: 'free', mjpeg: 'free' });
  });

  it('recognizes WDA /status and the WDA MJPEG stream', async () => {
    const wda = await httpServer((req, res) => {
      expect(req.url).toBe('/status');
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ value: { ready: true }, sessionId: 'x' }));
    });
    const mjpeg = await httpServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=--BoundaryString' });
      res.write('--BoundaryString\r\n'); // and never ends, like WDA
    });
    expect(await probeLocalPorts(wda, mjpeg)).toEqual({ wda: 'wda', mjpeg: 'mjpeg' });
  });

  it('any other HTTP answer means the port is taken (the hulk case: a foreign 404 on 9180)', async () => {
    const foreign = await httpServer((_req, res) => {
      res.statusCode = 404;
      res.end('<html><head><title>Not Found</title></head><body><h1>404 Not Found</h1></body></html>');
    });
    expect(await probeLocalPorts(foreign, foreign)).toEqual({ wda: 'taken', mjpeg: 'taken' });
  });

  it('200 JSON without value.ready is not WDA', async () => {
    const other = await httpServer((_req, res) => res.end(JSON.stringify({ ok: true })));
    expect((await probeLocalPorts(other, await findFreePort())).wda).toBe('taken');
  });

  it('a listener that accepts and stays silent is taken', async () => {
    const silent = await listen(net.createServer(() => {}));
    expect(await probeLocalPorts(silent, silent, 200)).toEqual({ wda: 'taken', mjpeg: 'taken' });
  });
});
