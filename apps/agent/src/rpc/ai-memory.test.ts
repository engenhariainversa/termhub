import { buildAiMemoryStatusScript, shellQuote } from '@termhub/machine-ops';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sh } = vi.hoisted(() => ({ sh: vi.fn() }));
vi.mock('../exec.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../exec.js')>();
  return { ...actual, sh };
});

import { status } from './ai-memory.js';

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
