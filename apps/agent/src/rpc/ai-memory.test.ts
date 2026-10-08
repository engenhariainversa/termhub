import { buildAiMemoryRulesScript } from '@termhub/machine-ops';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sh } = vi.hoisted(() => ({ sh: vi.fn() }));
vi.mock('../exec.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../exec.js')>();
  return { ...actual, sh };
});

import { rulesSync } from './ai-memory.js';

const page = '_rules/termhub-usar-pnpm-abc123.md';
const params = { cwd: '/home/u/proj', server_url: 'http://127.0.0.1:49374', writes: [{ path: page, title: "It's", body: '$(x)' }], deletes: [page] };

beforeEach(() => {
  sh.mockReset();
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
