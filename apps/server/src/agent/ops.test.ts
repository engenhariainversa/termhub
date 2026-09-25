import { execFile, spawn } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ execFile: vi.fn(), spawn: vi.fn() }));

import { claudeAdapter } from '../ai/claude.js';
import { CredentialError, readCredential } from '../ai/credentials.js';
import type { Machine } from '../db/repositories/types.js';
import { HttpError } from '../lib/errors.js';
import { collectHardware } from '../system/hardware.js';
import { killTmuxSession, listTmuxSessions, runOnMachine } from '../terminal/machine-exec.js';
import { browseMachine, ensureDirectory, makeDirectory } from '../terminal/machine-fs.js';
import { saveFileOnMachine } from '../terminal/paste-file.js';
import type { AgentConnection } from './connection.js';
import { AgentClosedError, AgentRpcError, AgentTimeoutError } from './connection.js';
import { toHttpError } from './errors.js';
import { agents, AgentOfflineError } from './registry.js';
import { captureScreen, captureStyledScreen } from './screen.js';

function agentMachine(id = 'm1'): Machine {
  return {
    id,
    name: 'agent-1',
    host: null,
    ssh_user: null,
    ssh_port: 22,
    type: 'agent',
    os: 'linux',
    capabilities: ['tmux'],
    checked_at: null,
    agent_version: '0.1.0',
    agent_last_seen_at: null,
    agent_auto_update: false,
    is_local: false,
    owner_id: null,
    owner_name: null,
    created_at: '',
  };
}

/** Attaches a fake AgentConnection to the registry whose rpc() is driven by `rpcImpl`. */
function attachFakeConn(machineId: string, rpcImpl: (method: string, params: unknown) => unknown) {
  const listeners: Record<string, ((...a: unknown[]) => void)[]> = {};
  const conn = {
    machineId,
    hello: { agent_version: '0.1.0', os: 'linux', tools: ['tmux'] },
    connectedAt: Date.now(),
    close: vi.fn(),
    rpc: vi.fn(async (method: string, params: unknown) => rpcImpl(method, params)),
    openPty: vi.fn(),
    on(ev: string, l: (...a: unknown[]) => void) {
      (listeners[ev] ??= []).push(l);
      return this;
    },
  } as unknown as AgentConnection;
  agents.attach(machineId, conn);
  return conn;
}

describe('agent machine operations use named RPCs', () => {
  beforeEach(() => {
    agents.reset();
    vi.clearAllMocks();
  });

  it('listTmuxSessions calls tmux.list and never shells out', async () => {
    const machine = agentMachine();
    const conn = attachFakeConn(machine.id, () => ({ sessions: ['a', 'b'] }));
    const result = await listTmuxSessions(machine);
    expect(result).toEqual(new Set(['a', 'b']));
    expect(conn.rpc).toHaveBeenCalledWith('tmux.list', {}, undefined);
    expect(execFile).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('listTmuxSessions returns an empty set when the agent is offline', async () => {
    const machine = agentMachine('offline-tmux');
    const result = await listTmuxSessions(machine);
    expect(result).toEqual(new Set());
    expect(execFile).not.toHaveBeenCalled();
  });

  it('killTmuxSession calls tmux.kill', async () => {
    const machine = agentMachine();
    const conn = attachFakeConn(machine.id, () => ({ killed: true }));
    const result = await killTmuxSession(machine, 'sess1');
    expect(result).toBe(true);
    expect(conn.rpc).toHaveBeenCalledWith('tmux.kill', { session: 'sess1' }, undefined);
    expect(execFile).not.toHaveBeenCalled();
  });

  it('collectHardware calls hw.probe and parses stdout', async () => {
    const machine = agentMachine();
    const conn = attachFakeConn(machine.id, () => ({ stdout: 'OS:linux\nHOST:box\nNCPU:4\n' }));
    const snap = await collectHardware(machine);
    expect(snap.os).toBe('linux');
    expect(snap.hostname).toBe('box');
    expect(conn.rpc).toHaveBeenCalledWith('hw.probe', {}, undefined);
    expect(execFile).not.toHaveBeenCalled();
  });

  it('browseMachine calls fs.list and parses stdout', async () => {
    const machine = agentMachine();
    const conn = attachFakeConn(machine.id, () => ({ stdout: 'HOME:/home/u\nPWD:/home/u\nDIR:proj\n' }));
    const listing = await browseMachine(machine, undefined);
    expect(listing.path).toBe('/home/u');
    expect(listing.entries).toEqual([{ name: 'proj', path: '/home/u/proj' }]);
    expect(conn.rpc).toHaveBeenCalledWith('fs.list', { path: '~' }, undefined);
    expect(execFile).not.toHaveBeenCalled();
  });

  it('browseMachine on an offline agent throws HttpError 503', async () => {
    const machine = agentMachine('offline-fs');
    await expect(browseMachine(machine, undefined)).rejects.toBeInstanceOf(HttpError);
    await expect(browseMachine(machine, undefined)).rejects.toMatchObject({ statusCode: 503 });
    expect(execFile).not.toHaveBeenCalled();
  });

  it('makeDirectory calls fs.mkdir and parses stdout', async () => {
    const machine = agentMachine();
    const conn = attachFakeConn(machine.id, () => ({ stdout: 'PWD:/home/u/new\n' }));
    const path = await makeDirectory(machine, '~', 'new');
    expect(path).toBe('/home/u/new');
    expect(conn.rpc).toHaveBeenCalledWith('fs.mkdir', { parent: '~', name: 'new' }, undefined);
    expect(execFile).not.toHaveBeenCalled();
  });

  it('ensureDirectory(create: true) on an existing directory succeeds without calling fs.mkdir', async () => {
    const machine = agentMachine();
    const conn = attachFakeConn(machine.id, (method) => {
      if (method === 'fs.list') return { stdout: 'HOME:/home/u\nPWD:/home/u/proj\n' };
      throw new Error(`unexpected rpc: ${method}`);
    });
    const result = await ensureDirectory(machine, '~/proj', true);
    expect(result).toEqual({ path: '/home/u/proj', created: false });
    expect(conn.rpc).toHaveBeenCalledWith('fs.list', { path: '~/proj' }, undefined);
    expect(conn.rpc).toHaveBeenCalledTimes(1);
    expect(execFile).not.toHaveBeenCalled();
  });

  it('ensureDirectory(create: true) on a missing directory calls fs.mkdir and reports created:true', async () => {
    const machine = agentMachine();
    const conn = attachFakeConn(machine.id, (method) => {
      if (method === 'fs.list') return { stdout: 'ERR:notfound\n' };
      if (method === 'fs.mkdir') return { stdout: 'PWD:/home/u/proj\n' };
      throw new Error(`unexpected rpc: ${method}`);
    });
    const result = await ensureDirectory(machine, '~/proj', true);
    expect(result).toEqual({ path: '/home/u/proj', created: true });
    expect(conn.rpc).toHaveBeenNthCalledWith(1, 'fs.list', { path: '~/proj' }, undefined);
    // recursive: the ssh/local branch does `mkdir -p`, so a nested new path must work here too.
    expect(conn.rpc).toHaveBeenNthCalledWith(2, 'fs.mkdir', { parent: '~', name: 'proj', recursive: true }, undefined);
    expect(execFile).not.toHaveBeenCalled();
  });

  it('ensureDirectory(create: false) on a missing directory answers 400 DIR_NOT_FOUND like the ssh branch', async () => {
    const machine = agentMachine();
    attachFakeConn(machine.id, () => ({ stdout: 'ERR:notfound\n' }));
    await expect(ensureDirectory(machine, '~/nope', false)).rejects.toMatchObject({
      statusCode: 400,
      code: 'DIR_NOT_FOUND',
      message: 'A pasta não existe na máquina. Marque "criar a pasta" ou escolha outra.',
    });
  });

  it('ensureDirectory(create: true) maps a failed mkdir to the ssh branch message', async () => {
    const machine = agentMachine();
    attachFakeConn(machine.id, (method) => (method === 'fs.list' ? { stdout: 'ERR:notfound\n' } : { stdout: 'ERR:denied\n' }));
    await expect(ensureDirectory(machine, '/srv/x', true)).rejects.toMatchObject({ statusCode: 403, message: 'Não foi possível criar a pasta (permissão?)' });
  });

  it('ensureDirectory uses the ssh branch wording for notdir and denied', async () => {
    const machine = agentMachine();
    attachFakeConn(machine.id, () => ({ stdout: 'ERR:notdir\n' }));
    await expect(ensureDirectory(machine, '~/file.txt', false)).rejects.toMatchObject({ statusCode: 400, message: 'O caminho existe, mas não é uma pasta' });
    agents.reset();
    attachFakeConn(machine.id, () => ({ stdout: 'ERR:denied\n' }));
    await expect(ensureDirectory(machine, '~/locked', true)).rejects.toMatchObject({ statusCode: 403, message: 'Sem permissão para acessar a pasta' });
  });

  it('ensureDirectory(create: false) rejects a path that exists but is not a directory', async () => {
    const machine = agentMachine();
    attachFakeConn(machine.id, () => ({ stdout: 'ERR:notdir\n' }));
    await expect(ensureDirectory(machine, '~/file.txt', false)).rejects.toMatchObject({ statusCode: 400 });
    expect(execFile).not.toHaveBeenCalled();
  });

  it('ensureDirectory(create: true) rejects a path that exists but is not a directory', async () => {
    const machine = agentMachine();
    const conn = attachFakeConn(machine.id, () => ({ stdout: 'ERR:notdir\n' }));
    await expect(ensureDirectory(machine, '~/file.txt', true)).rejects.toMatchObject({ statusCode: 400 });
    // must not attempt fs.mkdir on a path that's a regular file
    expect(conn.rpc).toHaveBeenCalledTimes(1);
    expect(execFile).not.toHaveBeenCalled();
  });

  it('readCredential calls ai.credential and parses the result via the adapter', async () => {
    const machine = agentMachine();
    const credJson = JSON.stringify({ claudeAiOauth: { accessToken: 'tok123', expiresAt: 999, subscriptionType: 'max' } });
    const conn = attachFakeConn(machine.id, () => ({ stdout: credJson }));
    const cred = await readCredential(machine, claudeAdapter, null, '.claude');
    expect(cred.token).toBe('tok123');
    expect(conn.rpc).toHaveBeenCalledWith('ai.credential', { provider: 'claude', config_dir: null }, undefined);
    expect(execFile).not.toHaveBeenCalled();
  });

  it('readCredential maps an offline agent to a CredentialError with the offline message', async () => {
    const machine = agentMachine('offline-cred');
    await expect(readCredential(machine, claudeAdapter, null, '.claude')).rejects.toBeInstanceOf(CredentialError);
    await expect(readCredential(machine, claudeAdapter, null, '.claude')).rejects.toMatchObject({ message: 'Agente desconectado' });
    expect(execFile).not.toHaveBeenCalled();
  });

  it('readCredential maps an agent RPC timeout to a CredentialError with the timeout message', async () => {
    const machine = agentMachine();
    attachFakeConn(machine.id, () => {
      throw new AgentTimeoutError('agent rpc timeout: ai.credential');
    });
    await expect(readCredential(machine, claudeAdapter, null, '.claude')).rejects.toBeInstanceOf(CredentialError);
    await expect(readCredential(machine, claudeAdapter, null, '.claude')).rejects.toMatchObject({ message: 'Machine did not answer in time' });
  });

  it('readCredential never forwards the raw AgentRpcError message, only the fixed per-code mapping', async () => {
    const machine = agentMachine();
    const leaky = 'no access to /Users/someone/.claude/.credentials.json';
    attachFakeConn(machine.id, () => {
      throw new AgentRpcError({ code: 'eperm', message: leaky });
    });
    let caught: unknown;
    try {
      await readCredential(machine, claudeAdapter, null, '.claude');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CredentialError);
    expect((caught as CredentialError).message).not.toBe(leaky);
    expect((caught as CredentialError).message).toBe('Sem acesso à pasta na máquina (Acesso Total ao Disco?)');
  });

  it('saveFileOnMachine calls file.paste with base64 data', async () => {
    const machine = agentMachine();
    const conn = attachFakeConn(machine.id, () => ({ path: '/home/u/.cache/termhub/paste/paste-x-report.txt' }));
    const data = Buffer.from('hello world');
    const result = await saveFileOnMachine(machine, data, 'report.txt');
    expect(result.path).toBe('/home/u/.cache/termhub/paste/paste-x-report.txt');
    expect(result.bytes).toBe(data.length);
    expect(conn.rpc).toHaveBeenCalled();
    const call = (conn.rpc as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe('file.paste');
    expect((call[1] as { data_b64: string }).data_b64).toBe(data.toString('base64'));
    expect(execFile).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('captureScreen calls tmux.capture with clamped lines', async () => {
    const machine = agentMachine();
    const conn = attachFakeConn(machine.id, () => ({ text: 'hello screen' }));
    const text = await captureScreen(machine, 'sess1', 100);
    expect(text).toBe('hello screen');
    expect(conn.rpc).toHaveBeenCalledWith('tmux.capture', { session: 'sess1', lines: 100 }, undefined);
    expect(execFile).not.toHaveBeenCalled();
  });

  it('captureStyledScreen asks the agent for escapes and trusts its answer', async () => {
    const machine = agentMachine();
    const conn = attachFakeConn(machine.id, () => ({ text: '❯ \x1b[2mcommit it\x1b[0m', escapes: true }));
    await expect(captureStyledScreen(machine, 'sess1', 15)).resolves.toEqual({ text: '❯ \x1b[2mcommit it\x1b[0m', styled: true });
    expect(conn.rpc).toHaveBeenCalledWith('tmux.capture', { session: 'sess1', lines: 15, escapes: true }, undefined);
    expect(execFile).not.toHaveBeenCalled();
  });

  it('captureStyledScreen: an agent older than 0.5.2 answers plain text, and says nothing about escapes', async () => {
    const machine = agentMachine();
    attachFakeConn(machine.id, () => ({ text: '❯ commit it' }));
    await expect(captureStyledScreen(machine, 'sess1', 15)).resolves.toEqual({ text: '❯ commit it', styled: false });
  });

  it('runOnMachine throws for an agent machine', () => {
    const machine = agentMachine();
    expect(() => runOnMachine(machine, { file: '/bin/sh', args: [] }, 'echo hi')).toThrow();
    expect(execFile).not.toHaveBeenCalled();
  });
});

describe('toHttpError', () => {
  it('maps AgentOfflineError to 503', () => {
    expect(toHttpError(new AgentOfflineError('offline'))).toMatchObject({ statusCode: 503, message: 'Agente desconectado' });
  });

  it('maps AgentClosedError to 503', () => {
    expect(toHttpError(new AgentClosedError('closed'))).toMatchObject({ statusCode: 503, message: 'Agente desconectado' });
  });

  it('maps AgentTimeoutError to 504', () => {
    expect(toHttpError(new AgentTimeoutError('timeout'))).toMatchObject({ statusCode: 504, message: 'A máquina não respondeu' });
  });

  it('maps AgentRpcError eperm to 403', () => {
    expect(toHttpError(new AgentRpcError({ code: 'eperm', message: 'x' }))).toMatchObject({ statusCode: 403 });
  });

  it('maps AgentRpcError notfound to 404', () => {
    expect(toHttpError(new AgentRpcError({ code: 'notfound', message: 'x' }))).toMatchObject({ statusCode: 404 });
  });

  it('maps AgentRpcError no_tmux to 502', () => {
    expect(toHttpError(new AgentRpcError({ code: 'no_tmux', message: 'x' }))).toMatchObject({ statusCode: 502 });
  });

  it('maps AgentRpcError invalid to 400', () => {
    expect(toHttpError(new AgentRpcError({ code: 'invalid', message: 'x' }))).toMatchObject({ statusCode: 400, message: 'Parâmetros inválidos para a máquina' });
  });

  it('maps other AgentRpcError codes to 502', () => {
    expect(toHttpError(new AgentRpcError({ code: 'internal', message: 'x' }))).toMatchObject({ statusCode: 502 });
  });

  it('rethrows anything else as-is', () => {
    const err = new Error('boom');
    expect(() => toHttpError(err)).toThrow(err);
  });
});
