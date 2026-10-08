import { buildAiMemoryRulesScript, buildAiMemoryStatusScript, shellQuote } from '@termhub/machine-ops';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sh } = vi.hoisted(() => ({ sh: vi.fn() }));
vi.mock('../exec.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../exec.js')>();
  return { ...actual, sh };
});

import { rulesSync, status } from './ai-memory.js';

const page = '_rules/termhub-usar-pnpm-abc123.md';
const params = { cwd: '/home/u/proj', server_url: 'http://127.0.0.1:49374', writes: [{ path: page, title: "It's", body: '$(x)' }], deletes: [page] };

beforeEach(() => {
  sh.mockReset();
});

describe('aimemory.status', () => {
  it('runs the script for the quoted url and returns only the parsed facts', async () => {
    sh.mockResolvedValue({ code: 0, stdout: 'BIN:yes\nVERSION:ai-memory 2.6.0\nSTATUS:ok\nSERVER:up\n', stderr: '', timedOut: false });
    await expect(status({ url: 'http://127.0.0.1:49374' })).resolves.toEqual({ installed: true, version: '2.6.0', server_up: true });
    expect(sh).toHaveBeenCalledWith(buildAiMemoryStatusScript(shellQuote('http://127.0.0.1:49374')), { timeoutMs: 14_000 });
  });

  it('reports a machine without the binary as not installed', async () => {
    sh.mockResolvedValue({ code: 0, stdout: 'BIN:no\n', stderr: '', timedOut: false });
    await expect(status({ url: 'http://127.0.0.1:49374' })).resolves.toEqual({ installed: false, version: null, server_up: false });
  });

  it('raises timeout / internal on a process-level failure', async () => {
    sh.mockResolvedValue({ code: null, stdout: '', stderr: '', timedOut: true });
    await expect(status({ url: 'http://127.0.0.1:49374' })).rejects.toMatchObject({ code: 'timeout' });
    sh.mockResolvedValue({ code: 2, stdout: '', stderr: 'x', timedOut: false });
    await expect(status({ url: 'http://127.0.0.1:49374' })).rejects.toMatchObject({ code: 'internal' });
  });
});

describe('ai_memory.rules.sync', () => {
  it('runs buildAiMemoryRulesScript(params) and passes stdout through unchanged', async () => {
    sh.mockResolvedValue({ code: 0, stdout: `ok briefing\nok write ${page}\n`, stderr: 'INFO x', timedOut: false });
    await expect(rulesSync(params)).resolves.toEqual({ stdout: `ok briefing\nok write ${page}\n` });
    expect(sh.mock.calls[0]![0]).toBe(buildAiMemoryRulesScript(params));
  });

  it('passes a skip through instead of throwing', async () => {
    sh.mockResolvedValue({ code: 0, stdout: 'skip no_marker\n', stderr: '', timedOut: false });
    await expect(rulesSync(params)).resolves.toEqual({ stdout: 'skip no_marker\n' });
  });

  it('raises internal on a process-level failure and timeout when it times out', async () => {
    sh.mockResolvedValue({ code: 2, stdout: '', stderr: 'boom', timedOut: false });
    await expect(rulesSync(params)).rejects.toMatchObject({ code: 'internal' });
    sh.mockResolvedValue({ code: null, stdout: '', stderr: '', timedOut: true });
    await expect(rulesSync(params)).rejects.toMatchObject({ code: 'timeout' });
  });
});
