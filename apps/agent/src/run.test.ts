import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type RawData } from 'ws';
import { CLOSE, CONTROL_CHANNEL, decodeFrame, encodeFrame, helloMessage } from '@termhub/agent-protocol';

const { runForeverMock, stopRestartLoopMock, healMock } = vi.hoisted(() => ({ runForeverMock: vi.fn(), stopRestartLoopMock: vi.fn(async () => {}), healMock: vi.fn(async () => [] as string[]) }));
vi.mock('./client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./client.js')>();
  return { ...actual, runForever: (...args: unknown[]) => runForeverMock(...args) };
});
vi.mock('./rpc/hooks.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./rpc/hooks.js')>();
  return { ...actual, heal: (...args: unknown[]) => healMock(...(args as [])) };
});
vi.mock('./service/launchd.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./service/launchd.js')>();
  return { ...actual, stopRestartLoop: (...args: unknown[]) => stopRestartLoopMock(...args) };
});

import { ProtocolMismatchError, RevokedError } from './client.js';
import { capabilitiesFor, checkServerConnection, runAgent } from './run.js';

const TOKEN = 'thb_ag_' + 'a'.repeat(43);

function asBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data as ArrayBuffer);
}

interface TestServer {
  port: number;
  hellos: unknown[];
  stop(): Promise<void>;
}

type Reply = { close: { code: number; reason: string }; before?: object } | { rejectStatus: number } | { silent: true };

/** A fake termhub server: records every hello it gets and answers it as `reply` says. */
function startServer(reply: Reply): Promise<TestServer> {
  return new Promise((resolve) => {
    const server = http.createServer();
    const hellos: unknown[] = [];
    const wss = new WebSocketServer({
      server,
      verifyClient: (_info, done) => {
        if ('rejectStatus' in reply) done(false, reply.rejectStatus, http.STATUS_CODES[reply.rejectStatus] ?? 'Rejected');
        else done(true);
      },
    });
    wss.on('connection', (ws) => {
      ws.once('message', (data) => {
        const { ch, payload } = decodeFrame(asBuffer(data));
        if (ch === CONTROL_CHANNEL) hellos.push(JSON.parse(payload.toString('utf8')));
        if ('close' in reply) {
          if (reply.before) ws.send(encodeFrame(CONTROL_CHANNEL, JSON.stringify(reply.before)));
          ws.close(reply.close.code, reply.close.reason);
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        hellos,
        stop: () =>
          new Promise((res) => {
            for (const client of wss.clients) client.terminate();
            wss.close();
            server.closeAllConnections?.();
            server.close(() => res());
          }),
      });
    });
  });
}

describe('capabilitiesFor', () => {
  it('claims sim on macOS only', () => {
    expect(capabilitiesFor('macos')).toEqual(expect.arrayContaining(['claude', 'claude.system_prompt', 'sim']));
    expect(capabilitiesFor('linux')).not.toContain('sim');
    expect(capabilitiesFor('linux')).toEqual(expect.arrayContaining(['claude', 'claude.system_prompt', 'transcript', 'file_read', 'file_list', 'worktree', 'net_check']));
  });
});

describe('checkServerConnection', () => {
  let srv: TestServer | undefined;

  afterEach(async () => {
    await srv?.stop();
    srv = undefined;
  });

  it('sends a probe hello and reports ok when the server answers 1000 "probe-ok"', async () => {
    srv = await startServer({ close: { code: 1000, reason: 'probe-ok' } });
    const result = await checkServerConnection({ url: `http://127.0.0.1:${srv.port}`, token: TOKEN });
    expect(result).toEqual({ ok: true });
    expect(srv.hellos).toHaveLength(1);
    expect(helloMessage.parse(srv.hellos[0]).probe).toBe(true);
  });

  it('returns the hooks and MCP addresses the server sends with probe_info before probe-ok', async () => {
    const before = { type: 'probe_info', hooks_url: 'https://termhub.dev/api/hooks/events', mcp_url: 'https://termhub.dev/mcp' };
    srv = await startServer({ close: { code: 1000, reason: 'probe-ok' }, before });
    const result = await checkServerConnection({ url: `http://127.0.0.1:${srv.port}`, token: TOKEN });
    expect(result).toEqual({ ok: true, endpoints: { hooks_url: before.hooks_url, mcp_url: before.mcp_url } });
  });

  it('reports the revoked-token message on an HTTP 401 upgrade rejection', async () => {
    srv = await startServer({ rejectStatus: 401 });
    const result = await checkServerConnection({ url: `http://127.0.0.1:${srv.port}`, token: TOKEN });
    expect(result).toEqual({ ok: false, error: 'Token inválido ou revogado' });
  });

  it('reports the revoked-token message on a 4401 close after the hello', async () => {
    srv = await startServer({ close: { code: CLOSE.UNAUTHORIZED, reason: 'revoked' } });
    const result = await checkServerConnection({ url: `http://127.0.0.1:${srv.port}`, token: TOKEN });
    expect(result).toEqual({ ok: false, error: 'Token inválido ou revogado' });
  });

  it('reports the upgrade message on a 4409 "protocol" close', async () => {
    srv = await startServer({ close: { code: CLOSE.CONFLICT, reason: 'protocol' } });
    const result = await checkServerConnection({ url: `http://127.0.0.1:${srv.port}`, token: TOKEN });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Atualize o agente');
  });

  it('reports not ok when the server closes with anything else', async () => {
    srv = await startServer({ close: { code: 1011, reason: 'boom' } });
    const result = await checkServerConnection({ url: `http://127.0.0.1:${srv.port}`, token: TOKEN });
    expect(result.ok).toBe(false);
  });

  it('gives up (not ok) after the timeout when the server never answers the probe', async () => {
    srv = await startServer({ silent: true });
    const result = await checkServerConnection({ url: `http://127.0.0.1:${srv.port}`, token: TOKEN }, 200);
    expect(result.ok).toBe(false);
    expect(srv.hellos).toHaveLength(1);
  });
});

describe('runAgent — terminal errors (exit 78)', () => {
  const config = { url: 'http://127.0.0.1:1', token: TOKEN, machine_id: '', machine_name: '', created_at: '' };
  let errors: string[];
  let exitCodes: (number | undefined)[];

  beforeEach(() => {
    errors = [];
    exitCodes = [];
    runForeverMock.mockReset();
    stopRestartLoopMock.mockClear();
    vi.spyOn(console, 'error').mockImplementation((msg?: unknown) => {
      errors.push(String(msg));
    });
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exitCodes.push(code);
      throw new Error(`__process_exit_${code}__`);
    }) as never);
  });

  afterEach(() => {
    healMock.mockReset();
    healMock.mockImplementation(async () => [] as string[]);
    vi.restoreAllMocks();
  });

  it('on RevokedError prints the pt-BR message, stops the launchd restart loop, then exits 78', async () => {
    runForeverMock.mockRejectedValue(new RevokedError('revoked'));
    await expect(runAgent(config, { log: () => {} })).rejects.toThrow('__process_exit_78__');
    expect(errors.join('\n')).toContain('Token revogado');
    expect(stopRestartLoopMock).toHaveBeenCalledTimes(1);
    expect(exitCodes).toEqual([78]);
    // Order matters: the message must be on stderr before the job is booted out (bootout may
    // SIGTERM us) and the bootout must have completed before exit.
    expect(stopRestartLoopMock.mock.invocationCallOrder[0]).toBeLessThan((process.exit as unknown as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!);
  });

  it('on ProtocolMismatchError prints the upgrade hint, stops the restart loop, then exits 78', async () => {
    runForeverMock.mockRejectedValue(new ProtocolMismatchError('protocol'));
    await expect(runAgent(config, { log: () => {} })).rejects.toThrow('__process_exit_78__');
    expect(errors.join('\n')).toContain('Atualize o agente');
    expect(stopRestartLoopMock).toHaveBeenCalledTimes(1);
    expect(exitCodes).toEqual([78]);
  });

  it('heals the monitor hooks on startup and on every session that comes up', async () => {
    healMock.mockClear();
    runForeverMock.mockImplementation(async (opts: { onConnect?: () => void }) => {
      opts.onConnect?.();
    });
    await runAgent(config, { log: () => {} });
    expect(healMock.mock.calls.length).toBe(2);
  });

  it('logs a heal that keeps failing once, not on every reconnect', async () => {
    healMock.mockReset();
    healMock.mockRejectedValue(new Error('EACCES: permission denied'));
    const logs: string[] = [];
    runForeverMock.mockImplementation(async (opts: { onConnect?: () => void }) => {
      for (let i = 0; i < 3; i += 1) {
        opts.onConnect?.();
        await new Promise((r) => setImmediate(r));
      }
    });

    await runAgent(config, { log: (msg: string) => logs.push(msg) });
    await new Promise((r) => setImmediate(r));

    expect(healMock.mock.calls.length).toBe(4);
    expect(logs.filter((m) => m === 'monitor hooks could not be repaired')).toHaveLength(1);
  });

  it('logs a heal failure again once a heal has worked in between', async () => {
    healMock.mockReset();
    healMock
      .mockRejectedValueOnce(new Error('EACCES: permission denied'))
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('EACCES: permission denied'));
    const logs: string[] = [];
    runForeverMock.mockImplementation(async (opts: { onConnect?: () => void }) => {
      for (let i = 0; i < 2; i += 1) {
        await new Promise((r) => setImmediate(r));
        opts.onConnect?.();
      }
      await new Promise((r) => setImmediate(r));
    });

    await runAgent(config, { log: (msg: string) => logs.push(msg) });
    await new Promise((r) => setImmediate(r));

    expect(logs.filter((m) => m === 'monitor hooks could not be repaired')).toHaveLength(2);
  });

  it('rethrows any other error without touching the service or exiting', async () => {
    runForeverMock.mockRejectedValue(new Error('boom'));
    await expect(runAgent(config, { log: () => {} })).rejects.toThrow('boom');
    expect(stopRestartLoopMock).not.toHaveBeenCalled();
    expect(exitCodes).toEqual([]);
  });
});
