import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type RawData } from 'ws';
import { CONTROL_CHANNEL, decodeFrame, encodeFrame } from '@termhub/agent-protocol';
import { readConfig } from '../config.js';
import { deviceKeyPath, readDeviceKey } from '../device-key.js';
import { connectCommand } from './connect.js';

const TOKEN = `thb_ag_${'a'.repeat(43)}`;
const asBuffer = (d: RawData) => (Buffer.isBuffer(d) ? d : Array.isArray(d) ? Buffer.concat(d) : Buffer.from(d));
const log = () => {};

/**
 * A server that answers a probe hello with 1000 probe-ok (`true`, an older server that takes the token as
 * a bearer), rejects the upgrade with 401 (`false`), pairs (`'pair'`: `paired`, then 1000 paired) or finds
 * the pairing token spent (`'spent'`: 4401 pairing).
 */
function startServer(accept: boolean | 'pair' | 'spent'): Promise<{ port: number; hellos: Record<string, unknown>[]; connections: () => number; stop: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer();
    const hellos: Record<string, unknown>[] = [];
    let connections = 0;
    const wss = new WebSocketServer({
      server,
      verifyClient: (_info, done) => (accept ? done(true) : done(false, 401, 'Unauthorized')),
    });
    wss.on('connection', (ws) => {
      connections++;
      ws.once('message', (data) => {
        const { ch, payload } = decodeFrame(asBuffer(data));
        if (ch === CONTROL_CHANNEL) hellos.push(JSON.parse(payload.toString('utf8')) as Record<string, unknown>);
        if (accept === 'pair') {
          ws.send(encodeFrame(CONTROL_CHANNEL, JSON.stringify({ type: 'paired', machine_id: 'm-42', machine_name: 'mini' })));
          ws.close(1000, 'paired');
        } else if (accept === 'spent') ws.close(4401, 'pairing');
        else ws.close(1000, 'probe-ok');
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        hellos,
        connections: () => connections,
        stop: () =>
          new Promise((res) => {
            for (const c of wss.clients) c.terminate();
            wss.close();
            server.closeAllConnections?.();
            server.close(() => res());
          }),
      });
    });
  });
}

describe('connectCommand', () => {
  let home: string;
  let stop: (() => Promise<void>) | undefined;
  let logs: string[];

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'termhub-agent-connect-'));
    process.env.TERMHUB_AGENT_HOME = home;
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void logs.push(a.join(' ')));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    process.exitCode = undefined;
  });
  afterEach(async () => {
    await stop?.();
    stop = undefined;
    vi.restoreAllMocks();
    delete process.env.TERMHUB_AGENT_HOME;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('pairs with a probe hello, saves the config and returns instead of staying connected', async () => {
    const srv = await startServer(true);
    stop = srv.stop;
    // if connect kept running the agent in the foreground this would never resolve
    await expect(connectCommand({ url: `http://127.0.0.1:${srv.port}`, token: TOKEN }, log)).resolves.toBeUndefined();
    expect(process.exitCode).toBeUndefined();
    // the server processes the hello/close frames after the client's promise settles
    await vi.waitFor(() => expect(srv.hellos[0]).toMatchObject({ type: 'hello', probe: true }));
    // no second (long-lived) connection was opened
    await new Promise((r) => setTimeout(r, 150));
    expect(srv.connections()).toBe(1);
    expect(readConfig()).toMatchObject({ url: `http://127.0.0.1:${srv.port}`, credential: 'bearer', token: TOKEN });
    expect(readDeviceKey()).toBeNull();
    expect(logs.join('\n')).toContain('Conectado. Configuração salva.');
    expect(logs.join('\n')).toContain('termhub-agent service install');
  });

  it('rejects a revoked token without saving a config', async () => {
    const srv = await startServer(false);
    stop = srv.stop;
    await connectCommand({ url: `http://127.0.0.1:${srv.port}`, token: TOKEN }, log);
    expect(process.exitCode).toBe(1);
    expect(readConfig()).toBeNull();
  });

  it('rejects a malformed token before touching the network', async () => {
    await connectCommand({ url: 'http://127.0.0.1:1', token: 'nope' }, log);
    expect(process.exitCode).toBe(2);
    expect(readConfig()).toBeNull();
  });

  it('trades the pairing token for a device key: saves the key 0600 and a key config without the token (TER-1017)', async () => {
    const srv = await startServer('pair');
    stop = srv.stop;
    await connectCommand({ url: `http://127.0.0.1:${srv.port}`, token: TOKEN }, log);
    expect(process.exitCode).toBeUndefined();
    const hello = srv.hellos[0] as { probe?: boolean; pair?: { public_key: string } };
    expect(hello.probe).toBe(true);
    const key = readDeviceKey();
    expect(key?.publicKey).toBe(hello.pair?.public_key);
    expect(fs.statSync(deviceKeyPath()).mode & 0o777).toBe(0o600);
    const config = readConfig();
    expect(config).toMatchObject({ credential: 'key', machine_id: 'm-42', machine_name: 'mini' });
    expect(config?.token).toBeUndefined();
    expect(fs.readFileSync(path.join(home, 'config.json'), 'utf8')).not.toContain(TOKEN);
    expect(logs.join('\n')).toContain('Pareado com a máquina mini');
  });

  it('a spent or expired pairing token saves nothing', async () => {
    const srv = await startServer('spent');
    stop = srv.stop;
    await connectCommand({ url: `http://127.0.0.1:${srv.port}`, token: TOKEN }, log);
    expect(process.exitCode).toBe(1);
    expect(readConfig()).toBeNull();
    expect(readDeviceKey()).toBeNull();
  });
});
