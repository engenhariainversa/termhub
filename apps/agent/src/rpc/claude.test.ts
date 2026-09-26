import { beforeEach, describe, expect, it, vi } from 'vitest';

const sh = vi.fn();
vi.mock('../exec.js', async (orig) => ({ ...(await orig<typeof import('../exec.js')>()), sh: (s: string) => sh(s) }));

const { linkSession } = await import('./claude.js');

const params = {
  transcript_path: '/h/.claude_a/projects/-p/6d127d73-4bd0-42d6-b4a6-d96899507e62.jsonl',
  session_id: '6d127d73-4bd0-42d6-b4a6-d96899507e62',
  config_dir: '~/.claude_b',
};

describe('claude.linkSession', () => {
  beforeEach(() => sh.mockReset());

  it('runs the link script and answers its status', async () => {
    sh.mockResolvedValue({ code: 0, stdout: 'linked\n', stderr: '', timedOut: false });
    await expect(linkSession(params)).resolves.toEqual({ status: 'linked' });
    expect(sh.mock.calls[0][0]).toContain("SRC='/h/.claude_a/projects/-p/6d127d73-4bd0-42d6-b4a6-d96899507e62.jsonl'");
  });

  it('fails on a timeout or an unreadable answer', async () => {
    sh.mockResolvedValue({ code: 0, stdout: '', stderr: '', timedOut: true });
    await expect(linkSession(params)).rejects.toMatchObject({ code: 'timeout' });
    sh.mockResolvedValue({ code: 0, stdout: '???', stderr: '', timedOut: false });
    await expect(linkSession(params)).rejects.toMatchObject({ code: 'internal' });
  });
});
