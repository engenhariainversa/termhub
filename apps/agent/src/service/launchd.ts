import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentEnv, run } from '../exec.js';

export const LABEL = 'dev.termhub.agent';

export interface PlistOptions {
  label: string;
  node: string;
  script: string;
  logPath: string;
}

/** XML for a macOS LaunchAgent that runs `<node> <script> run` at load and restarts on any non-zero exit. */
export function renderPlist({ label, node, script, logPath }: PlistOptions): string {
  const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escape(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escape(node)}</string>
    <string>${escape(script)}</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${escape(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escape(logPath)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${escape(agentEnv().PATH ?? '')}</string>
  </dict>
  <key>WorkingDirectory</key>
  <string>${escape(os.homedir())}</string>
</dict>
</plist>
`;
}

export interface ServiceFileOptions {
  node: string;
  script: string;
  logPath: string;
}

export interface LaunchdDeps {
  run?: typeof run;
  /** Home the plist lives under; defaults to the real one. Tests pass a temp dir so they never touch the developer's own service file. */
  home?: string;
}

function plistPath(home = os.homedir()): string {
  return path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
}

function gui(): string {
  return `gui/${process.getuid ? process.getuid() : 0}`;
}

export async function install(opts: ServiceFileOptions, deps: LaunchdDeps = {}): Promise<void> {
  const runFn = deps.run ?? run;
  const file = plistPath(deps.home);
  const plist = renderPlist({ label: LABEL, node: opts.node, script: opts.script, logPath: opts.logPath });

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, plist, 'utf8');

  // bootout can legitimately fail (nothing was loaded yet) — ignore it, only bootstrap matters.
  await runFn('launchctl', ['bootout', gui(), file]);
  const result = await runFn('launchctl', ['bootstrap', gui(), file]);
  if (result.code !== 0) {
    throw new Error(`launchctl bootstrap failed (code ${result.code}): ${result.stderr.trim() || result.stdout.trim()}`);
  }
}

export async function uninstall(deps: LaunchdDeps = {}): Promise<void> {
  const runFn = deps.run ?? run;
  const file = plistPath(deps.home);
  await runFn('launchctl', ['bootout', gui(), file]);
  try {
    fs.unlinkSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/**
 * First half of `agent.uninstall`, run from inside the service: deletes the plist WITHOUT booting
 * the job out — that would SIGTERM this very process before it can reply. The job stays loaded
 * until `stop()`; with the file gone, launchd will not load it again at the next login. Returns
 * whether there was a plist to remove.
 */
export async function removeDefinition(deps: LaunchdDeps = {}): Promise<boolean> {
  try {
    fs.unlinkSync(plistPath(deps.home));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

/** Second half of `agent.uninstall`: unloads the job (and so terminates this process). Best effort. */
export async function stop(deps: LaunchdDeps = {}): Promise<void> {
  const runFn = deps.run ?? run;
  await runFn('launchctl', ['bootout', `${gui()}/${LABEL}`]);
}

/**
 * Called right before `process.exit(78)` (revoked token, protocol mismatch, no config).
 * launchd's `KeepAlive.SuccessfulExit=false` restarts the job on ANY non-zero exit — unlike
 * systemd's `RestartPreventExitStatus=78` there is no per-code opt-out — so a revoked token
 * would loop forever (3×401 every backoff). Booting the job out unloads it until the user
 * runs `connect`/`service install` again. Best-effort: failures (not under launchd, job not
 * loaded, launchctl missing) are ignored; a no-op off macOS.
 */
export async function stopRestartLoop(deps: LaunchdDeps & { platform?: NodeJS.Platform } = {}): Promise<void> {
  const platform = deps.platform ?? process.platform;
  if (platform !== 'darwin') return;
  const runFn = deps.run ?? run;
  try {
    await runFn('launchctl', ['bootout', `${gui()}/${LABEL}`]);
  } catch {
    /* best effort */
  }
}

/** True when launchd currently has the agent's service loaded. */
export async function status(deps: LaunchdDeps = {}): Promise<boolean> {
  const runFn = deps.run ?? run;
  const result = await runFn('launchctl', ['print', `${gui()}/${LABEL}`]);
  return result.code === 0;
}
