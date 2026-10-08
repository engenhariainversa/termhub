import { buildAiMemoryPagesScript, shellQuote } from '@termhub/machine-ops';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sh } = vi.hoisted(() => ({ sh: vi.fn() }));
vi.mock('../exec.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../exec.js')>();
  return { ...actual, sh };
});

import { pages } from './ai-memory.js';

beforeEach(() => {
  sh.mockReset();
});

describe('aimemory.pages', () => {
  it('runs buildAiMemoryPagesScript(shellQuote(cwd)) and passes stdout through unchanged', async () => {
    sh.mockResolvedValue({ code: 0, stdout: 'ERR:nowiki\n', stderr: '', timedOut: false });
    await expect(pages({ cwd: "/home/u/it's" })).resolves.toEqual({ stdout: 'ERR:nowiki\n' });
    expect(sh).toHaveBeenCalledWith(buildAiMemoryPagesScript(shellQuote("/home/u/it's")), { timeoutMs: 15_000 });
  });

  it('raises timeout and internal on process-level failures', async () => {
    sh.mockResolvedValue({ code: null, stdout: '', stderr: '', timedOut: true });
    await expect(pages({ cwd: '/p' })).rejects.toMatchObject({ code: 'timeout' });
    sh.mockResolvedValue({ code: 2, stdout: '', stderr: 'x', timedOut: false });
    await expect(pages({ cwd: '/p' })).rejects.toMatchObject({ code: 'internal' });
  });
});
