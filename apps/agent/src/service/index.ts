import path from 'node:path';
import { agentHome } from '../config.js';
import { resolveScriptPath } from '../paths.js';
import * as launchd from './launchd.js';
import * as systemd from './systemd.js';

export interface ServiceFileOptions {
  node: string;
  script: string;
  logPath: string;
}

/**
 * `script` must be the path to the running `dist/cli.js`, not `import.meta.url` — tsup bundles
 * the CLI into a single file, so `import.meta.url` inside any module of that bundle already
 * points at the bundle itself, but `process.argv[1]` is the more direct source of truth for
 * "the file node was invoked with" and works the same whether this runs from `dist/cli.js` or
 * (in dev) `tsx src/cli.ts`. Resolved through `resolveScriptPath()` (realpath, following
 * symlinks) rather than a plain `path.resolve()`: when the agent is installed via
 * `npm i -g`, `process.argv[1]` is the symlink npm drops in the global bin dir, and a launchd
 * plist / systemd unit pointing at that symlink instead of the real `dist/cli.js` would break
 * the moment the global package is reinstalled/upgraded and the symlink is recreated.
 */
export function serviceFileOptions(): ServiceFileOptions {
  return {
    node: process.execPath,
    script: resolveScriptPath(process.argv[1]),
    logPath: path.join(agentHome(), 'agent.log'),
  };
}

export type ServicePlatform = 'darwin' | 'linux';

function assertSupported(platform: NodeJS.Platform): asserts platform is ServicePlatform {
  if (platform !== 'darwin' && platform !== 'linux') throw new Error('Sistema não suportado');
}

export async function install(): Promise<void> {
  const platform = process.platform;
  assertSupported(platform);
  const opts = serviceFileOptions();
  if (platform === 'darwin') await launchd.install(opts);
  else await systemd.install(opts);
}

/**
 * Best effort, run at agent startup: bring an already installed service definition up to the
 * current template (see `systemd.renderUnit` — `KillMode=process` is why it matters). An update
 * only replaces the code, so without this a unit written months ago would keep its old
 * semantics. Linux only: launchd already leaves the tmux server alone, and rewriting a plist
 * would mean booting the running job out. Returns whether anything changed.
 */
export async function refresh(): Promise<boolean> {
  if (process.platform !== 'linux') return false;
  return systemd.refreshUnit(serviceFileOptions());
}

export async function uninstall(): Promise<void> {
  const platform = process.platform;
  assertSupported(platform);
  if (platform === 'darwin') await launchd.uninstall();
  else await systemd.uninstall();
}

export async function status(): Promise<boolean> {
  const platform = process.platform;
  assertSupported(platform);
  if (platform === 'darwin') return launchd.status();
  return systemd.status();
}

/**
 * `agent.uninstall`, step one: removes the service definition without stopping the service (this
 * process may be that service and still has to reply). Returns whether a definition was there;
 * `false` on platforms without a service layer.
 */
export async function removeDefinition(platform: NodeJS.Platform = process.platform): Promise<boolean> {
  if (platform === 'darwin') return launchd.removeDefinition();
  if (platform === 'linux') return systemd.removeDefinition();
  return false;
}

/** `agent.uninstall`, last step: stops the service whose definition `removeDefinition()` removed. */
export async function stop(platform: NodeJS.Platform = process.platform): Promise<void> {
  if (platform === 'darwin') await launchd.stop();
  else if (platform === 'linux') await systemd.stop();
}
