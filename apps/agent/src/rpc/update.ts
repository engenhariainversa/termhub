import { createHash } from 'node:crypto';
import { createReadStream, existsSync, realpathSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RpcParams, RpcResult } from '@termhub/agent-protocol';
import { RpcFailure, run, type RunResult } from '../exec.js';
import { resolveScriptPath } from '../paths.js';
import * as service from '../service/index.js';
import { AGENT_VERSION } from '../version.js';

/**
 * Self-update, driven by the server, then, when this process runs under launchd/systemd, exit 1
 * so the service relaunches the freshly installed code. `npm i -g` overwrites the same directory
 * the service file points at, so the restart picks the new version up without touching the
 * service definition. npm always runs in argv form: the version and integrity are validated by
 * the RPC schema and never reach a shell.
 *
 * With `integrity` (since 0.20.0, spec 2026-10-07 agent release trust): the server has verified
 * the release's provenance and sends the `sha512-…` it vouches for. The agent downloads the
 * tarball with `npm pack @termhub/agent@<version>` into a private temp dir, checks its SHA-512
 * against `integrity`, and installs that very file (`npm install -g <abs>.tgz`); a mismatch
 * fails the update without installing anything. The temp dir is always removed.
 * Without `integrity` (older servers): `npm install -g @termhub/agent@<version>`, as before.
 */
const PACKAGE = '@termhub/agent';
const NPM_TIMEOUT_MS = 150_000;
/** `npm pack` only downloads one small tarball; keeps pack + install inside the RPC's 180 s. */
const NPM_PACK_TIMEOUT_MS = 25_000;
/** Enough for the rpc_result frame to leave the socket before the process goes away. */
const EXIT_DELAY_MS = 750;

export interface UpdateDeps {
  run: (file: string, args: string[], opts?: { timeoutMs?: number }) => Promise<RunResult>;
  execPath: string;
  npmCli: () => string | null;
  installedVersion: () => Promise<string | null>;
  serviceInstalled: () => Promise<boolean>;
  /** Creates a private (0700) temp dir for the downloaded tarball. */
  makeTempDir: () => Promise<string>;
  removeDir: (dir: string) => Promise<void>;
  listDir: (dir: string) => Promise<string[]>;
  /** `sha512-<base64>` of a file, in npm's `dist.integrity` form. */
  fileIntegrity: (file: string) => Promise<string>;
  exit: (code: number) => void;
  log: (msg: string, meta?: object) => void;
}

/**
 * Absolute path of npm's entry script (`npm-cli.js`), shipped next to the running node (nvm,
 * Homebrew and the official installer all do that). We run it as `node <npm-cli.js>` instead of
 * executing the `npm` file directly: that file is a `#!/usr/bin/env node` script, so running it
 * would resolve its interpreter — and therefore npm's global install prefix — from PATH, which
 * can point at a different node than the one running this agent (wrong prefix) or none at all.
 * Resolves the `npm` symlink beside node to its real target, falling back to the conventional
 * `../lib/node_modules/npm/bin/npm-cli.js` layout, and `null` when neither exists.
 */
export function npmCliBesideNode(execPath = process.execPath): string | null {
  const dir = path.dirname(execPath);
  const symlink = path.join(dir, 'npm');
  if (existsSync(symlink)) return realpathSync(symlink);
  const fallback = path.join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  return existsSync(fallback) ? fallback : null;
}

/** Version of the package this process was started from: <pkg>/dist/cli.js → <pkg>/package.json. */
export async function installedAgentVersion(argv1 = process.argv[1]): Promise<string | null> {
  const script = resolveScriptPath(argv1);
  if (!script) return null;
  try {
    const pkg = JSON.parse(await readFile(path.join(path.dirname(script), '..', 'package.json'), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

/** SHA-512 of a file as npm writes `dist.integrity`: `sha512-` plus the base64 digest. */
export function sha512Integrity(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha512');
    createReadStream(file)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(`sha512-${hash.digest('base64')}`));
  });
}

const defaultDeps: UpdateDeps = {
  run,
  execPath: process.execPath,
  npmCli: npmCliBesideNode,
  installedVersion: installedAgentVersion,
  serviceInstalled: () => service.status(),
  makeTempDir: () => mkdtemp(path.join(os.tmpdir(), 'termhub-agent-update-')),
  removeDir: (dir) => rm(dir, { recursive: true, force: true }),
  listDir: (dir) => readdir(dir),
  fileIntegrity: sha512Integrity,
  exit: (code) => process.exit(code),
  log: (msg, meta) => console.error(meta ? `[termhub-agent] ${msg} ${JSON.stringify(meta)}` : `[termhub-agent] ${msg}`),
};

let inFlight: Promise<RpcResult<'agent.update'>> | null = null;

export async function updateAgent(params: RpcParams<'agent.update'>, deps: UpdateDeps = defaultDeps): Promise<RpcResult<'agent.update'>> {
  if (inFlight) throw new RpcFailure('failed', 'update already running');
  inFlight = doUpdate(params.version, params.integrity, deps);
  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

async function doUpdate(version: string, integrity: string | undefined, deps: UpdateDeps): Promise<RpcResult<'agent.update'>> {
  deps.log('update starting', { from: AGENT_VERSION, to: version, verified: integrity !== undefined });
  const npmCli = deps.npmCli();
  if (!npmCli) throw new RpcFailure('notfound', 'npm not found beside node');
  if (integrity) await installVerified(npmCli, version, integrity, deps);
  else await npm(npmCli, ['install', '-g', '--no-fund', '--no-audit', `${PACKAGE}@${version}`], 'install', version, deps);
  const installed = await deps.installedVersion();
  if (installed !== version) throw new RpcFailure('failed', `installed version mismatch (${installed ?? 'unknown'})`);
  const restart = (await deps.serviceInstalled()) ? 'service' : 'manual';
  deps.log('update installed', { from: AGENT_VERSION, to: version, restart });
  if (restart === 'service') {
    // Reply first; exit 1 (never 78, which would stop the restart loop) so launchd/systemd relaunch us.
    setTimeout(() => deps.exit(1), EXIT_DELAY_MS);
  }
  return { installed_version: installed, restart };
}

/** Runs npm; its own output is never logged: it can echo paths and registry details. */
async function npm(npmCli: string, args: string[], step: 'pack' | 'install', version: string, deps: UpdateDeps): Promise<void> {
  const r = await deps.run(deps.execPath, [npmCli, ...args], { timeoutMs: step === 'pack' ? NPM_PACK_TIMEOUT_MS : NPM_TIMEOUT_MS });
  if (r.error === 'enoent') throw new RpcFailure('notfound', 'npm not found on this machine');
  if (r.timedOut) throw new RpcFailure('timeout', `npm ${step} timed out`);
  if (r.code !== 0) {
    deps.log('update failed', { to: version, step, code: r.code });
    throw new RpcFailure('failed', `npm exited with code ${r.code ?? 'unknown'}`);
  }
}

/** Downloads the release tarball, checks it against the integrity the server verified, installs that file. */
async function installVerified(npmCli: string, version: string, integrity: string, deps: UpdateDeps): Promise<void> {
  const dir = await deps.makeTempDir();
  try {
    await npm(npmCli, ['pack', `${PACKAGE}@${version}`, '--pack-destination', dir, '--json'], 'pack', version, deps);
    const tarballs = (await deps.listDir(dir)).filter((f) => f.endsWith('.tgz'));
    if (tarballs.length !== 1) throw new RpcFailure('failed', 'downloaded tarball not found');
    const tarball = path.resolve(dir, tarballs[0]);
    if ((await deps.fileIntegrity(tarball)) !== integrity) {
      deps.log('update failed', { to: version, step: 'verify' });
      throw new RpcFailure('failed', 'integrity mismatch');
    }
    await npm(npmCli, ['install', '-g', '--no-fund', '--no-audit', tarball], 'install', version, deps);
  } finally {
    await deps.removeDir(dir).catch(() => {});
  }
}

export const update = (params: RpcParams<'agent.update'>): Promise<RpcResult<'agent.update'>> => updateAgent(params);
