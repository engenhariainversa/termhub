import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentEnv, run } from '../exec.js';

export const UNIT_NAME = 'termhub-agent';

export interface UnitOptions {
  node: string;
  script: string;
  logPath?: string;
  /** PATH to write into the unit; defaults to the one the agent composes for child processes. */
  pathEnv?: string;
}

/**
 * A systemd user unit that runs `<node> <script> run`, restarting on failure but never after a
 * clean exit(78).
 *
 * `KillMode=process` is what makes an agent restart survivable: the agent spawns the tmux server
 * that holds every terminal of this machine, so with systemd's default (`control-group`) a stop
 * — or the self-update's exit(1) and relaunch — SIGKILLs the whole cgroup and takes the person's
 * sessions, and whatever runs inside them, down with the agent. With `process` systemd signals
 * only the agent itself and leaves tmux running, so the reconnecting agent finds the sessions
 * again. macOS needs no equivalent: launchd does not kill the tmux server tmux daemonised away
 * from the job.
 */
export function renderUnit({ node, script, logPath, pathEnv }: UnitOptions): string {
  const lines = [
    '[Unit]',
    'Description=termhub agent',
    'After=network-online.target',
    '',
    '[Service]',
    `ExecStart=${node} ${script} run`,
    'KillMode=process',
    'Restart=on-failure',
    'RestartSec=2',
    'RestartPreventExitStatus=78',
    `Environment=PATH=${pathEnv ?? agentEnv().PATH ?? ''}`,
  ];
  if (logPath) {
    lines.push(`StandardOutput=append:${logPath}`, `StandardError=append:${logPath}`);
  }
  lines.push('', '[Install]', 'WantedBy=default.target', '');
  return lines.join('\n');
}

export interface ServiceFileOptions {
  node: string;
  script: string;
  logPath: string;
}

export interface SystemdDeps {
  run?: typeof run;
  /** Home the unit lives under; defaults to the real one. Tests pass a temp dir so they never touch the developer's own service file. */
  home?: string;
}

function unitPath(home = os.homedir()): string {
  return path.join(home, '.config', 'systemd', 'user', `${UNIT_NAME}.service`);
}

export async function install(opts: ServiceFileOptions, deps: SystemdDeps = {}): Promise<void> {
  const runFn = deps.run ?? run;
  const file = unitPath(deps.home);
  const unit = renderUnit({ node: opts.node, script: opts.script, logPath: opts.logPath });

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, unit, 'utf8');

  const reload = await runFn('systemctl', ['--user', 'daemon-reload']);
  if (reload.code !== 0) throw new Error(`systemctl daemon-reload failed (code ${reload.code}): ${reload.stderr.trim()}`);

  const enable = await runFn('systemctl', ['--user', 'enable', '--now', UNIT_NAME]);
  if (enable.code !== 0) throw new Error(`systemctl enable --now failed (code ${enable.code}): ${enable.stderr.trim()}`);

  console.log('Para o agente continuar após o logout: loginctl enable-linger $USER');
}

/** The `Environment=PATH=` already in an installed unit, or undefined when it has none. */
function unitPathEnv(unit: string): string | undefined {
  return /^Environment=PATH=(.*)$/m.exec(unit)?.[1];
}

/**
 * Brings an already installed unit up to the current template and daemon-reloads, so a machine
 * that ran `service install` with an older agent still gets template fixes (`KillMode=process`)
 * on the first boot of the new code — `npm i -g` never rewrites the unit by itself. Returns
 * whether the file changed; a machine that does not run the agent as a service is left alone.
 *
 * The PATH is carried over from the existing unit instead of being re-rendered: this runs inside
 * the service, where `agentEnv()` would prefix the extra dirs onto a PATH that already has them,
 * growing the line on every boot.
 */
export async function refreshUnit(opts: ServiceFileOptions, deps: SystemdDeps = {}): Promise<boolean> {
  const file = unitPath(deps.home);
  let current: string;
  try {
    current = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
  const unit = renderUnit({ node: opts.node, script: opts.script, logPath: opts.logPath, pathEnv: unitPathEnv(current) });
  if (unit === current) return false;

  fs.writeFileSync(file, unit, 'utf8');
  const runFn = deps.run ?? run;
  const reload = await runFn('systemctl', ['--user', 'daemon-reload']);
  if (reload.code !== 0) throw new Error(`systemctl daemon-reload failed (code ${reload.code}): ${reload.stderr.trim()}`);
  return true;
}

export async function uninstall(deps: SystemdDeps = {}): Promise<void> {
  const runFn = deps.run ?? run;
  await runFn('systemctl', ['--user', 'disable', '--now', UNIT_NAME]);
  try {
    fs.unlinkSync(unitPath(deps.home));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  await runFn('systemctl', ['--user', 'daemon-reload']);
}

/**
 * First half of `agent.uninstall`, run from inside the service: disables the unit (no `--now` —
 * stopping it would kill this very process before it can reply), deletes the unit file and
 * daemon-reloads. The running instance stays up until `stop()`. Returns whether there was a unit
 * file to remove; throws when disabling or the reload fails.
 */
export async function removeDefinition(deps: SystemdDeps = {}): Promise<boolean> {
  const file = unitPath(deps.home);
  if (!fs.existsSync(file)) return false;
  const runFn = deps.run ?? run;
  const disable = await runFn('systemctl', ['--user', 'disable', UNIT_NAME]);
  if (disable.code !== 0) throw new Error(`systemctl disable failed (code ${disable.code}): ${disable.stderr.trim()}`);
  try {
    fs.unlinkSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const reload = await runFn('systemctl', ['--user', 'daemon-reload']);
  if (reload.code !== 0) throw new Error(`systemctl daemon-reload failed (code ${reload.code}): ${reload.stderr.trim()}`);
  return true;
}

/** Second half of `agent.uninstall`: stops the (already disabled) unit, terminating this process. */
export async function stop(deps: SystemdDeps = {}): Promise<void> {
  const runFn = deps.run ?? run;
  await runFn('systemctl', ['--user', 'stop', UNIT_NAME]);
}

/** True when systemd reports the unit as active. */
export async function status(deps: SystemdDeps = {}): Promise<boolean> {
  const runFn = deps.run ?? run;
  const result = await runFn('systemctl', ['--user', 'is-active', UNIT_NAME]);
  return result.code === 0;
}
