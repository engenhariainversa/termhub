import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunResult } from '../exec.js';

vi.mock('../exec.js', async () => {
  const actual = await vi.importActual<typeof import('../exec.js')>('../exec.js');
  return { ...actual, agentEnv: () => ({ PATH: '/usr/local/bin:/usr/bin:/bin' }) };
});

const { renderPlist, install: launchdInstall, uninstall: launchdUninstall, status: launchdStatus, stopRestartLoop, LABEL } = await import('./launchd.js');
const { renderUnit, refreshUnit, install: systemdInstall, uninstall: systemdUninstall, status: systemdStatus, UNIT_NAME } = await import('./systemd.js');
const { serviceFileOptions } = await import('./index.js');

function ok(stdout = ''): RunResult {
  return { code: 0, stdout, stderr: '', timedOut: false };
}
function fail(stderr = 'boom'): RunResult {
  return { code: 1, stdout: '', stderr, timedOut: false };
}

describe('renderPlist', () => {
  it('matches the expected launchd XML', () => {
    const xml = renderPlist({ label: 'dev.termhub.agent', node: '/usr/local/bin/node', script: '/opt/termhub-agent/dist/cli.js', logPath: '/home/pedro/.termhub/agent.log' });
    expect(xml).toMatchInlineSnapshot(`
      "<?xml version="1.0" encoding="UTF-8"?>
      <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
      <plist version="1.0">
      <dict>
        <key>Label</key>
        <string>dev.termhub.agent</string>
        <key>ProgramArguments</key>
        <array>
          <string>/usr/local/bin/node</string>
          <string>/opt/termhub-agent/dist/cli.js</string>
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
        <string>/home/pedro/.termhub/agent.log</string>
        <key>StandardErrorPath</key>
        <string>/home/pedro/.termhub/agent.log</string>
        <key>EnvironmentVariables</key>
        <dict>
          <key>PATH</key>
          <string>/usr/local/bin:/usr/bin:/bin</string>
        </dict>
        <key>WorkingDirectory</key>
        <string>${process.env.HOME ?? ''}</string>
      </dict>
      </plist>
      "
    `);
  });

  it('contains RunAtLoad, KeepAlive/SuccessfulExit=false and the [node, script, run] argv', () => {
    const xml = renderPlist({ label: 'dev.termhub.agent', node: '/n/node', script: '/s/cli.js', logPath: '/l/agent.log' });
    expect(xml).toContain('<key>RunAtLoad</key>');
    expect(xml).toContain('<key>SuccessfulExit</key>');
    expect(xml).toContain('<false/>');
    expect(xml).toContain('<string>/n/node</string>\n    <string>/s/cli.js</string>\n    <string>run</string>');
  });

  it('XML-escapes special characters in string values', () => {
    const xml = renderPlist({ label: 'a & b', node: '/n/node', script: '/s/cli.js', logPath: '/l/agent.log' });
    expect(xml).toContain('a &amp; b');
  });
});

describe('renderPlist proxy env', () => {
  it('adds the proxy/CA variables next to PATH', () => {
    const xml = renderPlist({ label: 'l', node: '/n', script: '/s', logPath: '/l', env: { HTTPS_PROXY: 'http://p:3128', NODE_EXTRA_CA_CERTS: '/a&b.pem' } });
    expect(xml).toContain('<key>HTTPS_PROXY</key>\n    <string>http://p:3128</string>');
    expect(xml).toContain('<key>NODE_EXTRA_CA_CERTS</key>\n    <string>/a&amp;b.pem</string>');
    expect(xml).not.toContain('NO_PROXY');
  });
});

describe('renderUnit', () => {
  it('matches the expected systemd unit', () => {
    const unit = renderUnit({ node: '/usr/local/bin/node', script: '/opt/termhub-agent/dist/cli.js', logPath: '/home/pedro/.termhub/agent.log' });
    expect(unit).toMatchInlineSnapshot(`
      "[Unit]
      Description=termhub agent
      After=network-online.target

      [Service]
      ExecStart=/usr/local/bin/node /opt/termhub-agent/dist/cli.js run
      KillMode=process
      Restart=on-failure
      RestartSec=2
      RestartPreventExitStatus=78
      Environment=PATH=/usr/local/bin:/usr/bin:/bin
      StandardOutput=append:/home/pedro/.termhub/agent.log
      StandardError=append:/home/pedro/.termhub/agent.log

      [Install]
      WantedBy=default.target
      "
    `);
  });

  it('contains RestartPreventExitStatus=78 and the ExecStart run argv', () => {
    const unit = renderUnit({ node: '/n/node', script: '/s/cli.js' });
    expect(unit).toContain('RestartPreventExitStatus=78');
    expect(unit).toContain('ExecStart=/n/node /s/cli.js run');
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('RestartSec=2');
  });

  it('omits StandardOutput/StandardError when logPath is not given', () => {
    const unit = renderUnit({ node: '/n/node', script: '/s/cli.js' });
    expect(unit).not.toContain('StandardOutput');
    expect(unit).not.toContain('StandardError');
  });

  // Without it systemd's default (control-group) SIGKILLs everything in the unit's cgroup on
  // stop/restart — including the tmux server the agent spawned, so a self-update would take the
  // person's terminals (and whatever runs in them) down with it.
  it('sets KillMode=process so a restart leaves the tmux server alone', () => {
    expect(renderUnit({ node: '/n/node', script: '/s/cli.js' })).toContain('KillMode=process');
  });

  it('writes the proxy/CA variables, quoted for systemd (\\, " escaped and % doubled)', () => {
    const unit = renderUnit({
      node: '/n/node',
      script: '/s/cli.js',
      env: { HTTPS_PROXY: 'http://me:p%40ss@proxy:3128', NO_PROXY: 'localhost, .corp', NODE_EXTRA_CA_CERTS: '/etc/ssl/corp "ca".pem' },
    });
    expect(unit).toContain('Environment="HTTPS_PROXY=http://me:p%%40ss@proxy:3128"');
    expect(unit).toContain('Environment="NO_PROXY=localhost, .corp"');
    expect(unit).toContain('Environment="NODE_EXTRA_CA_CERTS=/etc/ssl/corp \\"ca\\".pem"');
    expect(unit).not.toContain('HTTP_PROXY=');
  });

  it('takes PATH from pathEnv when given, instead of the current environment', () => {
    const unit = renderUnit({ node: '/n/node', script: '/s/cli.js', pathEnv: '/only/this' });
    expect(unit).toContain('Environment=PATH=/only/this');
    expect(unit).not.toContain('/usr/local/bin:/usr/bin:/bin');
  });
});

// install()/uninstall() write and unlink the service file under `home`. Every call below passes a
// throwaway directory: with the default (`os.homedir()`) these tests would overwrite and then
// delete the developer's real `~/Library/LaunchAgents/dev.termhub.agent.plist` — which is how
// the agent serving this very machine kept vanishing. The launchctl/systemctl calls are faked
// through `run` (and blocked globally by test-setup.ts).
describe('launchd install/uninstall/status', () => {
  let home: string;
  let plist: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'termhub-agent-launchd-home-'));
    plist = path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('install() writes the plist under home, then runs bootout (ignoring failure) and bootstrap on that file', async () => {
    const calls: string[][] = [];
    const run = vi.fn(async (file: string, args: string[]) => {
      calls.push([file, ...args]);
      if (args[0] === 'bootout') return fail('nothing loaded');
      return ok();
    });
    await launchdInstall({ node: '/n/node', script: '/s/cli.js', logPath: '/l/agent.log', env: {} }, { run: run as never, home });

    expect(fs.readFileSync(plist, 'utf8')).toContain('<string>/s/cli.js</string>');
    expect(fs.readFileSync(plist, 'utf8')).not.toContain('HTTPS_PROXY');
    expect(calls[0][0]).toBe('launchctl');
    expect(calls[0][1]).toBe('bootout');
    expect(calls[1][0]).toBe('launchctl');
    expect(calls[1][1]).toBe('bootstrap');
    expect(calls[1]).toContain(plist);
  });

  it('install() throws when bootstrap itself fails', async () => {
    const run = vi.fn(async (_file: string, args: string[]) => (args[0] === 'bootstrap' ? fail('denied') : ok()));
    await expect(launchdInstall({ node: '/n/node', script: '/s/cli.js', logPath: '/l/agent.log' }, { run: run as never, home })).rejects.toThrow(/bootstrap failed/);
  });

  it('uninstall() runs bootout and removes the plist under home', async () => {
    fs.mkdirSync(path.dirname(plist), { recursive: true });
    fs.writeFileSync(plist, '<plist/>', 'utf8');
    const run = vi.fn(async () => ok());
    await expect(launchdUninstall({ run: run as never, home })).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledWith('launchctl', ['bootout', expect.any(String), plist]);
    expect(fs.existsSync(plist)).toBe(false);
  });

  it('uninstall() does not throw when the plist is already gone', async () => {
    const run = vi.fn(async () => ok());
    await expect(launchdUninstall({ run: run as never, home })).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledWith('launchctl', expect.arrayContaining(['bootout']));
  });

  it('status() reflects the launchctl print exit code', async () => {
    const runOk = vi.fn(async () => ok());
    await expect(launchdStatus({ run: runOk as never })).resolves.toBe(true);
    const runFail = vi.fn(async () => fail());
    await expect(launchdStatus({ run: runFail as never })).resolves.toBe(false);
  });
});

describe('launchd stopRestartLoop (exit 78)', () => {
  const uid = process.getuid ? process.getuid() : 0;

  it('on darwin boots the agent job out so KeepAlive stops restarting it', async () => {
    const run = vi.fn(async () => ok());
    await stopRestartLoop({ run, platform: 'darwin' });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith('launchctl', ['bootout', `gui/${uid}/${LABEL}`]);
  });

  it('on linux does nothing (systemd honours RestartPreventExitStatus=78 by itself)', async () => {
    const run = vi.fn(async () => ok());
    await stopRestartLoop({ run, platform: 'linux' });
    expect(run).not.toHaveBeenCalled();
  });

  it('never throws: a failing or missing launchctl is ignored', async () => {
    await expect(stopRestartLoop({ run: vi.fn(async () => fail('no such job')), platform: 'darwin' })).resolves.toBeUndefined();
    await expect(
      stopRestartLoop({
        run: vi.fn(async () => {
          throw new Error('spawn failed');
        }),
        platform: 'darwin',
      }),
    ).resolves.toBeUndefined();
  });
});

describe('systemd install/uninstall/status', () => {
  let home: string;
  let unit: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'termhub-agent-systemd-home-'));
    unit = path.join(home, '.config', 'systemd', 'user', `${UNIT_NAME}.service`);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('install() writes the unit under home, daemon-reloads, then enables --now', async () => {
    const calls: string[][] = [];
    const run = vi.fn(async (file: string, args: string[]) => {
      calls.push([file, ...args]);
      return ok();
    });
    await systemdInstall({ node: '/n/node', script: '/s/cli.js', logPath: '/l/agent.log' }, { run: run as never, home });

    expect(fs.readFileSync(unit, 'utf8')).toContain('/s/cli.js');
    expect(calls[0]).toEqual(['systemctl', '--user', 'daemon-reload']);
    expect(calls[1]).toEqual(['systemctl', '--user', 'enable', '--now', UNIT_NAME]);
  });

  it('install() carries the proxy variables and keeps a unit holding a proxy password private', async () => {
    const run = vi.fn(async () => ok());
    await systemdInstall({ node: '/n/node', script: '/s/cli.js', logPath: '/l/agent.log', env: { HTTPS_PROXY: 'http://me:pw@proxy:3128' } }, { run: run as never, home });
    expect(fs.readFileSync(unit, 'utf8')).toContain('Environment="HTTPS_PROXY=http://me:pw@proxy:3128"');
    expect(fs.statSync(unit).mode & 0o777).toBe(0o600);
  });

  it('install() throws when enable --now fails', async () => {
    const run = vi.fn(async (_file: string, args: string[]) => (args.includes('enable') ? fail('denied') : ok()));
    await expect(systemdInstall({ node: '/n/node', script: '/s/cli.js', logPath: '/l/agent.log' }, { run: run as never, home })).rejects.toThrow(/enable --now failed/);
  });

  it('uninstall() disables --now and removes the unit file under home', async () => {
    fs.mkdirSync(path.dirname(unit), { recursive: true });
    fs.writeFileSync(unit, '[Unit]\n', 'utf8');
    const run = vi.fn(async () => ok());
    await expect(systemdUninstall({ run: run as never, home })).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledWith('systemctl', ['--user', 'disable', '--now', UNIT_NAME]);
    expect(fs.existsSync(unit)).toBe(false);
  });

  it('status() reflects `systemctl --user is-active`', async () => {
    const runOk = vi.fn(async () => ok('active'));
    await expect(systemdStatus({ run: runOk as never })).resolves.toBe(true);
    const runFail = vi.fn(async () => fail('inactive'));
    await expect(systemdStatus({ run: runFail as never })).resolves.toBe(false);
  });
});

// Machines that installed the service with an older agent keep that old unit forever — nothing
// rewrites it on `npm i -g`. refreshUnit() is what carries a template fix (KillMode=process) to
// them, and it runs from inside the service, so it must never grow the PATH it inherited.
describe('systemd refreshUnit', () => {
  let home: string;
  let unit: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'termhub-agent-systemd-refresh-'));
    unit = path.join(home, '.config', 'systemd', 'user', `${UNIT_NAME}.service`);
    fs.mkdirSync(path.dirname(unit), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  const opts = { node: '/n/node', script: '/s/cli.js', logPath: '/l/agent.log' };

  it('rewrites a unit installed by an older agent and daemon-reloads', async () => {
    fs.writeFileSync(unit, '[Unit]\nDescription=termhub agent\n\n[Service]\nExecStart=/n/node /s/cli.js run\nRestart=on-failure\nEnvironment=PATH=/keep/me:/usr/bin\n', 'utf8');
    const run = vi.fn(async () => ok());
    await expect(refreshUnit(opts, { run: run as never, home })).resolves.toBe(true);
    expect(fs.readFileSync(unit, 'utf8')).toContain('KillMode=process');
    expect(run).toHaveBeenCalledWith('systemctl', ['--user', 'daemon-reload']);
  });

  it('keeps the PATH already in the unit, so refreshing from inside the service never grows it', async () => {
    fs.writeFileSync(unit, '[Service]\nEnvironment=PATH=/keep/me:/usr/bin\n', 'utf8');
    const run = vi.fn(async () => ok());
    await refreshUnit(opts, { run: run as never, home });
    const written = fs.readFileSync(unit, 'utf8');
    expect(written).toContain('Environment=PATH=/keep/me:/usr/bin');
    expect(written.match(/Environment=PATH=/g)).toHaveLength(1);
  });

  it('keeps the proxy/CA variables written by `service install`, whatever this process has', async () => {
    const env = { HTTPS_PROXY: 'http://me:p%40ss@proxy:3128', NO_PROXY: 'localhost', NODE_EXTRA_CA_CERTS: '/etc/c "x".pem' };
    fs.writeFileSync(unit, renderUnit({ ...opts, pathEnv: '/keep/me', env }).replace('KillMode=process\n', ''), 'utf8');
    const run = vi.fn(async () => ok());
    await expect(refreshUnit(opts, { run: run as never, home })).resolves.toBe(true);
    expect(fs.readFileSync(unit, 'utf8')).toBe(renderUnit({ ...opts, pathEnv: '/keep/me', env }));
  });

  it('does nothing when the service was never installed', async () => {
    const run = vi.fn(async () => ok());
    await expect(refreshUnit(opts, { run: run as never, home })).resolves.toBe(false);
    expect(run).not.toHaveBeenCalled();
    expect(fs.existsSync(unit)).toBe(false);
  });

  it('does nothing when the unit already matches the template', async () => {
    fs.writeFileSync(unit, renderUnit({ ...opts, pathEnv: '/keep/me' }), 'utf8');
    const run = vi.fn(async () => ok());
    await expect(refreshUnit(opts, { run: run as never, home })).resolves.toBe(false);
    expect(run).not.toHaveBeenCalled();
  });
});

describe('serviceFileOptions()', () => {
  let dir: string;
  let realTarget: string;
  let symlink: string;
  const originalArgv1 = process.argv[1];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termhub-agent-service-paths-'));
    realTarget = path.join(dir, 'dist', 'cli.js');
    fs.mkdirSync(path.dirname(realTarget), { recursive: true });
    fs.writeFileSync(realTarget, '// fake dist/cli.js\n', 'utf8');
    // Mirrors `npm i -g`: the global bin dir gets a symlink pointing at dist/cli.js, so
    // process.argv[1] is the symlink, not the real file, when the installed CLI runs.
    symlink = path.join(dir, 'bin', 'termhub-agent');
    fs.mkdirSync(path.dirname(symlink), { recursive: true });
    fs.symlinkSync(realTarget, symlink);
  });

  afterEach(() => {
    process.argv[1] = originalArgv1;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('resolves script through the npm-global-bin symlink to the real dist/cli.js path — a plist/unit built from argv[1] as-is would point at a symlink that breaks on reinstall', () => {
    process.argv[1] = symlink;
    const opts = serviceFileOptions();
    expect(opts.script).toBe(fs.realpathSync(realTarget));
    expect(opts.script).not.toBe(symlink);

    // And renderPlist/renderUnit faithfully carry that resolved path into the service file.
    expect(renderPlist({ label: LABEL, node: '/n/node', script: opts.script, logPath: '/l/agent.log' })).toContain(`<string>${opts.script}</string>`);
    expect(renderUnit({ node: '/n/node', script: opts.script })).toContain(`ExecStart=/n/node ${opts.script} run`);
  });
});
