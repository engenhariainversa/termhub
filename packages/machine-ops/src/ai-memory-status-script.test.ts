/** Runs the real script with `/bin/sh` and a fake `ai-memory` on PATH, the way the agent does. */
import { execFile } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildAiMemoryStatusScript, parseAiMemoryStatus } from './ai-memory-script.js';
import { shellQuote } from './shell.js';

const run = promisify(execFile);
let dir: string;
let server: Server | null = null;

function fakeBinary(body: string): void {
  const path = join(dir, 'ai-memory');
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

async function probe(url: string, path = `${dir}:/usr/bin:/bin`): Promise<string> {
  return (await run('/bin/sh', ['-c', buildAiMemoryStatusScript(shellQuote(url))], { encoding: 'utf8', timeout: 20_000, env: { PATH: path } })).stdout;
}

async function listen(): Promise<string> {
  server = createServer((_req, res) => res.writeHead(404).end());
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A port nothing listens on: bind one, then close it. */
async function closedUrl(): Promise<string> {
  const url = await listen();
  await new Promise((resolve) => server!.close(resolve));
  server = null;
  return url;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ai-memory-script-'));
});
afterEach(async () => {
  if (server) await new Promise((resolve) => server!.close(resolve));
  server = null;
  rmSync(dir, { recursive: true, force: true });
});

describe('ai-memory status script', () => {
  it('reports only BIN:no when the binary is missing', async () => {
    const out = await probe('http://127.0.0.1:49374');
    expect(out.trim()).toBe('BIN:no');
    expect(parseAiMemoryStatus(out)).toEqual({ installed: false, version: null, server_up: false });
  });

  it('finds the binary, its version and a server that answers (any HTTP status)', async () => {
    fakeBinary('[ "$1" = "--version" ] && echo "ai-memory 2.6.0"; [ "$1" = status ] && echo "secret project names"; exit 0');
    const out = await probe(await listen());
    expect(out).not.toContain('secret');
    expect(parseAiMemoryStatus(out)).toEqual({ installed: true, version: '2.6.0', server_up: true });
  });

  it('says the server is down when nothing listens at the url', async () => {
    fakeBinary('[ "$1" = "--version" ] && echo "ai-memory 2.6.0"; exit 0');
    expect(parseAiMemoryStatus(await probe(await closedUrl()))).toEqual({ installed: true, version: '2.6.0', server_up: false });
  });

  it('cuts a hanging `ai-memory status` instead of waiting for it', async () => {
    fakeBinary('[ "$1" = status ] && sleep 30; exit 0');
    const started = Date.now();
    const out = await probe(await closedUrl());
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(out).toContain('STATUS:fail');
  });
});

describe('parseAiMemoryStatus', () => {
  it('falls back on `ai-memory status` when the machine has no curl', () => {
    expect(parseAiMemoryStatus('BIN:yes\nVERSION:2.6.0\nSTATUS:ok\nSERVER:unknown\n').server_up).toBe(true);
    expect(parseAiMemoryStatus('BIN:yes\nVERSION:\nSTATUS:fail\nSERVER:unknown\n')).toEqual({ installed: true, version: null, server_up: false });
  });

  it('trusts curl over the status exit code when both are there', () => {
    expect(parseAiMemoryStatus('BIN:yes\nSTATUS:ok\nSERVER:down\n').server_up).toBe(false);
    expect(parseAiMemoryStatus('BIN:yes\r\nSTATUS:fail\r\nSERVER:up\r\n').server_up).toBe(true);
  });

  it('keeps only a version number out of the version line', () => {
    expect(parseAiMemoryStatus('BIN:yes\nVERSION:ai-memory v2.7.0-rc.1 (abc)\n').version).toBe('2.7.0-rc.1');
    expect(parseAiMemoryStatus('BIN:yes\nVERSION:whatever\n').version).toBeNull();
  });
});
