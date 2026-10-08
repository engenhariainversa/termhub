import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentEnv, run } from '../exec.js';
import { PROXY_ENV_KEYS, proxyEnvFrom, writeServiceFile, type ProxyEnv } from '../proxy.js';

export const UNIT_NAME = 'termhub-agent';

export interface UnitOptions {
  node: string;
  script: string;
  logPath?: string;
  /** PATH to write into the unit; defaults to the one the agent composes for child processes. */
  pathEnv?: string;
  /** Proxy/CA variables to carry into the service (`HTTPS_PROXY`, `NO_PROXY`, `NODE_EXTRA_CA_CERTS`, …). */
  env?: ServiceEnv;
}

export type ServiceEnv = ProxyEnv;

/** `Environment="KEY=value"` with systemd's quoting: `\` and `"` escaped, `%` doubled (it starts a specifier). */
function environmentLine(key: string, value: string): string {
  return `Environment="${key}=${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;
}

/** The proxy/CA variables an installed unit sets, read back from the lines `environmentLine` writes. */
function unitServiceEnv(unit: string): ServiceEnv {
  const env: ServiceEnv = {};
  for (const key of PROXY_ENV_KEYS) {
    const m = new RegExp(`^Environment="${key}=(.*)"$`, 'm').exec(unit);
    if (m) env[key] = m[1]!.replace(/%%/g, '%').replace(/\\(["\\])/g, '$1');
  }
  return env;
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
export function renderUnit({ node, script, logPath, pathEnv, env = {} }: UnitOptions): string {
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
  for (const key of PROXY_ENV_KEYS) {
    const value = env[key];
    if (value) lines.push(environmentLine(key, value));
  }
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
  /** Proxy/CA variables for `install`; defaults to the ones set in this process's environment. */
  env?: ServiceEnv;
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
  const env = opts.env ?? proxyEnvFrom();
  const unit = renderUnit({ node: opts.node, script: opts.script, logPath: opts.logPath, env });

  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeServiceFile(file, unit, env);

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
 * growing the line on every boot. The proxy/CA variables are carried over the same way: they are
 * whatever the person had when they ran `service install`, not this process's environment.
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
  const env = unitServiceEnv(current);
  const unit = renderUnit({ node: opts.node, script: opts.script, logPath: opts.logPath, pathEnv: unitPathEnv(current), env });
  if (unit === current) return false;

  writeServiceFile(file, unit, env);
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

/** True when systemd reports the unit as active. */
export async function status(deps: SystemdDeps = {}): Promise<boolean> {
  const runFn = deps.run ?? run;
  const result = await runFn('systemctl', ['--user', 'is-active', UNIT_NAME]);
  return result.code === 0;
}
