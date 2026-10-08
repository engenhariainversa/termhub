import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunResult } from '../exec.js';
import { RpcFailure } from '../exec.js';
import { sha512Integrity, type UpdateDeps, updateAgent } from './update.js';

const ok: RunResult = { code: 0, stdout: '', stderr: '', timedOut: false, error: undefined };
const EXEC_PATH = '/opt/node/bin/node';
const NPM_CLI = '/opt/node/lib/node_modules/npm/bin/npm-cli.js';

function deps(overrides: Partial<UpdateDeps> = {}): UpdateDeps & { run: ReturnType<typeof vi.fn>; exit: ReturnType<typeof vi.fn>; log: ReturnType<typeof vi.fn> } {
  return {
    run: vi.fn(async () => ok),
    execPath: EXEC_PATH,
    npmCli: () => NPM_CLI,
    installedVersion: async () => '0.2.2',
    serviceInstalled: async () => true,
    makeTempDir: async () => '/tmp/never-used',
    removeDir: async () => {},
    listDir: async () => [],
    fileIntegrity: async () => 'sha512-never',
    exit: vi.fn(),
    log: vi.fn(),
    ...overrides,
  } as never;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('agent.update', () => {
  it('installs the requested version by running npm-cli.js with the running node (argv, no shell) and schedules an exit(1) when a service runs it', async () => {
    const d = deps();
    const r = await updateAgent({ version: '0.2.2' }, d);
    expect(d.run).toHaveBeenCalledWith(EXEC_PATH, [NPM_CLI, 'install', '-g', '--no-fund', '--no-audit', '@termhub/agent@0.2.2'], { timeoutMs: 150_000 });
    expect(r).toEqual({ installed_version: '0.2.2', restart: 'service' });
    expect(d.exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(750);
    expect(d.exit).toHaveBeenCalledWith(1);
  });

  it('does not exit when no service is installed (manual restart)', async () => {
    const d = deps({ serviceInstalled: async () => false });
    const r = await updateAgent({ version: '0.2.2' }, d);
    expect(r.restart).toBe('manual');
    vi.advanceTimersByTime(2000);
    expect(d.exit).not.toHaveBeenCalled();
  });

  it('reports notfound when npm-cli.js cannot be found beside node, without running anything', async () => {
    const d = deps({ npmCli: () => null });
    await expect(updateAgent({ version: '0.2.2' }, d)).rejects.toMatchObject({ code: 'notfound', message: 'npm not found beside node' });
    expect(d.run).not.toHaveBeenCalled();
  });

  it('reports notfound when npm itself is missing (ENOENT running node)', async () => {
    const d = deps({ run: vi.fn(async () => ({ ...ok, code: null, error: 'enoent' })) });
    await expect(updateAgent({ version: '0.2.2' }, d)).rejects.toMatchObject({ code: 'notfound' });
  });

  it('reports failed with the exit code when npm fails, without logging npm output', async () => {
    const d = deps({ run: vi.fn(async () => ({ ...ok, code: 243, stderr: 'EACCES secret-path' })) });
    await expect(updateAgent({ version: '0.2.2' }, d)).rejects.toMatchObject({ code: 'failed', message: 'npm exited with code 243' });
    expect(JSON.stringify(d.log.mock.calls)).not.toContain('secret-path');
    expect(d.exit).not.toHaveBeenCalled();
  });

  it('reports failed when the installed version does not match', async () => {
    const d = deps({ installedVersion: async () => '0.2.0' });
    await expect(updateAgent({ version: '0.2.2' }, d)).rejects.toBeInstanceOf(RpcFailure);
    expect(d.exit).not.toHaveBeenCalled();
  });

  it('refuses a second update while one is running', async () => {
    let release!: () => void;
    const d = deps({ run: vi.fn(() => new Promise<RunResult>((res) => (release = () => res(ok)))) });
    const first = updateAgent({ version: '0.2.2' }, d);
    await expect(updateAgent({ version: '0.2.2' }, d)).rejects.toMatchObject({ code: 'failed', message: 'update already running' });
    release();
    await first;
  });
});

describe('agent.update with a verified integrity', () => {
  const TARBALL = Buffer.from('fake tarball bytes');
  const INTEGRITY = `sha512-${createHash('sha512').update(TARBALL).digest('base64')}`;
  let root: string;
  let made: string[];

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'termhub-agent-update-test-'));
    made = [];
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  /** Real temp dirs and hashing; `npm pack` is faked by writing `bytes` into --pack-destination. */
  function verified(bytes: Buffer, overrides: Partial<UpdateDeps> = {}) {
    const run = vi.fn(async (_file: string, args: string[]) => {
      if (args[1] === 'pack') fs.writeFileSync(path.join(args[args.indexOf('--pack-destination') + 1], 'termhub-agent-0.2.2.tgz'), bytes);
      return ok;
    });
    return deps({
      run,
      makeTempDir: async () => {
        const dir = fs.mkdtempSync(path.join(root, 'dl-'));
        made.push(dir);
        return dir;
      },
      removeDir: async (dir) => fs.rmSync(dir, { recursive: true, force: true }),
      listDir: async (dir) => fs.readdirSync(dir),
      fileIntegrity: sha512Integrity,
      ...overrides,
    });
  }

  it('packs the version into a private temp dir, checks its SHA-512 and installs that file, then removes the dir', async () => {
    const d = verified(TARBALL);
    const r = await updateAgent({ version: '0.2.2', integrity: INTEGRITY }, d);
    expect(r).toEqual({ installed_version: '0.2.2', restart: 'service' });
    const [dir] = made;
    expect(d.run).toHaveBeenNthCalledWith(1, EXEC_PATH, [NPM_CLI, 'pack', '@termhub/agent@0.2.2', '--pack-destination', dir, '--json'], { timeoutMs: 25_000 });
    expect(d.run).toHaveBeenNthCalledWith(2, EXEC_PATH, [NPM_CLI, 'install', '-g', '--no-fund', '--no-audit', path.join(dir, 'termhub-agent-0.2.2.tgz')], { timeoutMs: 150_000 });
    expect(d.run).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(dir)).toBe(false);
    vi.advanceTimersByTime(750);
    expect(d.exit).toHaveBeenCalledWith(1);
  });

  it('fails with "integrity mismatch" and installs nothing when the tarball differs', async () => {
    const d = verified(Buffer.from('tampered'));
    await expect(updateAgent({ version: '0.2.2', integrity: INTEGRITY }, d)).rejects.toMatchObject({ code: 'failed', message: 'integrity mismatch' });
    expect(d.run).toHaveBeenCalledTimes(1);
    expect(d.run.mock.calls[0][1][1]).toBe('pack');
    expect(fs.existsSync(made[0])).toBe(false);
    vi.advanceTimersByTime(2000);
    expect(d.exit).not.toHaveBeenCalled();
  });

  it('fails and removes the temp dir when npm pack fails', async () => {
    const d = verified(TARBALL, { run: vi.fn(async () => ({ ...ok, code: 1, stderr: 'E404' })) });
    await expect(updateAgent({ version: '0.2.2', integrity: INTEGRITY }, d)).rejects.toMatchObject({ code: 'failed', message: 'npm exited with code 1' });
    expect(d.run).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(made[0])).toBe(false);
  });

  it('fails when npm pack leaves no tarball behind', async () => {
    const d = verified(TARBALL, { run: vi.fn(async () => ok) });
    await expect(updateAgent({ version: '0.2.2', integrity: INTEGRITY }, d)).rejects.toMatchObject({ code: 'failed', message: 'downloaded tarball not found' });
    expect(d.run).toHaveBeenCalledTimes(1);
  });

  it('sha512Integrity matches npm\'s dist.integrity form', async () => {
    const file = path.join(root, 'x.tgz');
    fs.writeFileSync(file, TARBALL);
    await expect(sha512Integrity(file)).resolves.toBe(INTEGRITY);
  });
});
