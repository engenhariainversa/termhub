import { describe, expect, it, vi } from 'vitest';
import { GithubCiError } from './github-ci.js';
import { createGithubWriteClient } from './github-write.js';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const call = (f: ReturnType<typeof vi.fn>, i = 0) => {
  const [url, init] = f.mock.calls[i] as unknown as [string, RequestInit];
  return { url, method: init.method, body: init.body ? JSON.parse(init.body as string) : undefined, headers: new Headers(init.headers) };
};
const kindOf = async (p: Promise<unknown>) => ((await p.catch((e: unknown) => e)) as GithubCiError).kind;

describe('github write client', () => {
  it('reads a branch sha and null when missing', async () => {
    const f = vi.fn(async () => json(200, { object: { sha: 'abc' } }));
    expect(await createGithubWriteClient(f).branchSha('tok', 'a/b', 'feat/x')).toBe('abc');
    expect(call(f).url).toBe('https://api.github.com/repos/a/b/git/ref/heads/feat/x');
    expect(call(f).headers.get('authorization')).toBe('Bearer tok');
    expect(await createGithubWriteClient(async () => json(404, {})).branchSha('t', 'a/b', 'x')).toBeNull();
  });

  it('creates a branch, and reports an existing one', async () => {
    const f = vi.fn(async () => json(201, {}));
    expect(await createGithubWriteClient(f).createBranch('t', 'a/b', 'TER-1', 'sha1')).toBe('created');
    expect(call(f)).toMatchObject({ url: 'https://api.github.com/repos/a/b/git/refs', method: 'POST', body: { ref: 'refs/heads/TER-1', sha: 'sha1' } });
    const dup = async () => json(422, { message: 'Reference already exists' });
    expect(await createGithubWriteClient(dup).createBranch('t', 'a/b', 'TER-1', 's')).toBe('exists');
    expect(await kindOf(createGithubWriteClient(async () => json(422, { message: 'Invalid' })).createBranch('t', 'a/b', 'x', 's'))).toBe('http');
  });

  it('opens and finds pulls', async () => {
    const f = vi.fn(async () => json(201, { number: 5, html_url: 'u5' }));
    const i = { head: 'TER-1', base: 'main', title: 't', body: 'b', draft: true };
    expect(await createGithubWriteClient(f).openPull('t', 'a/b', i)).toEqual({ number: 5, url: 'u5' });
    expect(call(f)).toMatchObject({ url: 'https://api.github.com/repos/a/b/pulls', method: 'POST', body: i });
    const g = vi.fn(async () => json(200, [{ number: 6, html_url: 'u6' }]));
    expect(await createGithubWriteClient(g).findOpenPull('t', 'a/b', 'TER-1', 'main')).toEqual({ number: 6, url: 'u6' });
    expect(call(g).url).toBe('https://api.github.com/repos/a/b/pulls?state=open&head=a%3ATER-1&base=main&per_page=1');
    expect(await createGithubWriteClient(async () => json(200, [])).findOpenPull('t', 'a/b', 'x', 'main')).toBeNull();
  });

  it('reads mergeability', async () => {
    const f = vi.fn(async () => json(200, { mergeable: null, mergeable_state: 'unknown', head: { sha: 'h', ref: 'TER-1-x', repo: { full_name: 'fork/b' } }, base: { ref: 'main' } }));
    expect(await createGithubWriteClient(f).pull('t', 'a/b', 9)).toEqual({ mergeable: null, mergeable_state: 'unknown', head_sha: 'h', head_ref: 'TER-1-x', head_repo: 'fork/b', base_ref: 'main' });
    const gone = async () => json(200, { mergeable: true, mergeable_state: 'clean', head: { sha: 'h', ref: 'x', repo: null }, base: { ref: 'main' } });
    expect((await createGithubWriteClient(gone).pull('t', 'a/b', 9)).head_repo).toBeNull();
    expect(call(f).url).toBe('https://api.github.com/repos/a/b/pulls/9');
  });

  it('follows Link rel=next for files and is complete', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(json(200, [{ filename: 'a.ts' }], { link: '<https://api.github.com/repos/a/b/pulls/9/files?per_page=100&page=2>; rel="next", <x>; rel="last"' }))
      .mockResolvedValueOnce(json(200, [{ filename: 'b.ts' }]));
    expect(await createGithubWriteClient(f).files('t', 'a/b', 9)).toEqual({ paths: ['a.ts', 'b.ts'], complete: true });
    expect(call(f, 0).url).toBe('https://api.github.com/repos/a/b/pulls/9/files?per_page=100');
    expect(call(f, 1).url).toBe('https://api.github.com/repos/a/b/pulls/9/files?per_page=100&page=2');
  });

  it('does not follow a Link next to another origin', async () => {
    const f = vi.fn(async () => json(200, [{ filename: 'a.ts' }], { link: '<https://evil.example/files?page=2>; rel="next"' }));
    expect(await createGithubWriteClient(f).files('t', 'a/b', 9)).toEqual({ paths: ['a.ts'], complete: false });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('reads a 200 merge response with merged false', async () => {
    const f = async () => json(200, { merged: false, message: 'nope' });
    expect(await createGithubWriteClient(f).merge('t', 'a/b', 9, { sha: 'h', title: 'T', method: 'merge' })).toEqual({ merged: false, sha: null });
  });

  it('flags the file list incomplete at the 3000 cap', async () => {
    let page = 0;
    const f = vi.fn(async () => json(200, Array.from({ length: 100 }, (_, i) => ({ filename: `f${page}-${i}` })), { link: `<https://api.github.com/x?page=${++page + 1}>; rel="next"` }));
    const r = await createGithubWriteClient(f).files('t', 'a/b', 9);
    expect(r.paths.length).toBe(3000);
    expect(r.complete).toBe(false);
  });

  it('merges with the sha guard; 409 is not merged; 405 is not_mergeable', async () => {
    const f = vi.fn(async () => json(200, { merged: true, sha: 'm1' }));
    const i = { sha: 'h', title: 'T', method: 'squash' as const };
    expect(await createGithubWriteClient(f).merge('t', 'a/b', 9, i)).toEqual({ merged: true, sha: 'm1' });
    expect(call(f)).toMatchObject({ url: 'https://api.github.com/repos/a/b/pulls/9/merge', method: 'PUT', body: { sha: 'h', commit_title: 'T', merge_method: 'squash' } });
    expect(await createGithubWriteClient(async () => json(409, {})).merge('t', 'a/b', 9, i)).toEqual({ merged: false, sha: null });
    expect(await kindOf(createGithubWriteClient(async () => json(405, {})).merge('t', 'a/b', 9, i))).toBe('not_mergeable');
  });

  it('compares the head with the base branch', async () => {
    const f = vi.fn(async () => json(200, { ahead_by: 2, behind_by: 3, files: [] }));
    expect(await createGithubWriteClient(f).compare('t', 'a/b', 'main', 'h1')).toEqual({ ahead_by: 2, behind_by: 3 });
    expect(call(f).url).toBe('https://api.github.com/repos/a/b/compare/main...h1?per_page=1');
  });

  it('updates a branch behind its base with the head guard; 422 is not updated', async () => {
    const f = vi.fn(async () => json(202, { message: 'Updating pull request branch.' }));
    expect(await createGithubWriteClient(f).updateBranch('t', 'a/b', 9, 'h')).toBe(true);
    expect(call(f)).toMatchObject({ url: 'https://api.github.com/repos/a/b/pulls/9/update-branch', method: 'PUT', body: { expected_head_sha: 'h' } });
    expect(await createGithubWriteClient(async () => json(422, {})).updateBranch('t', 'a/b', 9, 'h')).toBe(false);
    expect(await kindOf(createGithubWriteClient(async () => json(403, {})).updateBranch('t', 'a/b', 9, 'h'))).toBe('forbidden');
  });

  it('types write failures', async () => {
    const reset = String(Math.floor(Date.now() / 1000) + 60);
    const merge = (res: Response) => kindOf(createGithubWriteClient(async () => res).openPull('t', 'a/b', { head: 'h', base: 'b', title: 't', body: '', draft: false }));
    expect(await merge(json(403, {}, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset }))).toBe('rate_limited');
    expect(await merge(json(403, { message: 'Resource not accessible' }))).toBe('forbidden');
    expect(await merge(json(401, {}))).toBe('auth');
    expect(await merge(json(404, {}))).toBe('not_found');
  });
});
