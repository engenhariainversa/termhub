// @vitest-environment node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { APT_LOCK_WAIT_S, LINUX_INSTALL_COMMAND, MACOS_INSTALL_COMMAND, MIN_NODE_MAJOR, linuxInstallCommand, macosInstallCommand } from './AgentEnrollment';

/**
 * Runs the copy-paste install commands for real, in sh and bash, with every external command
 * replaced by a stub on an isolated PATH. Each stub appends its argv to a log and exits with the
 * code the test gives it, so the tests prove which steps ran — above all that npm never runs
 * after a failed package-manager step.
 */
const SHELLS = ['/bin/sh', '/bin/bash'].filter((s) => fs.existsSync(s));
const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function run(shell: string, command: string, stubs: Record<string, number | string>, links: Record<string, string> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'th-install-'));
  dirs.push(dir);
  const log = path.join(dir, 'calls.log');
  for (const [name, behavior] of Object.entries(stubs)) {
    const body = typeof behavior === 'number' ? `exit ${behavior}` : behavior;
    fs.writeFileSync(path.join(dir, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\n${body}\n`, { mode: 0o755 });
  }
  for (const [name, target] of Object.entries(links)) fs.symlinkSync(target, path.join(dir, name));
  let status = 0;
  let stdout = '';
  try {
    stdout = execFileSync(shell, ['-c', command], { env: { PATH: dir }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    const e = err as { status: number; stdout: string };
    status = e.status;
    stdout = e.stdout;
  }
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [];
  // the steps that change the machine (or wait), without the probes around them
  const steps = calls.filter((c) => !/^(id|env|date|node|ps) /.test(c));
  return { status, stdout, calls, steps };
}

/** `env VAR=value command…`, as the real one: exports the assignments and runs the command. */
const ENV = 'while :; do case "$1" in *=*) export "$1"; shift;; *) break;; esac; done\nexec "$@"';
/** Succeeds from the second call on (a lock that another process releases in the meantime). */
const FAILS_ONCE = 'f="${0%/*}/count"; n=0; [ -f "$f" ] && read -r n < "$f"; echo $((n + 1)) > "$f"; [ "$n" -ge 1 ]';
/** A clock that jumps a minute per reading, so the lock wait runs out after two tries. */
const TICKING = 'f="${0%/*}/clock"; n=0; [ -f "$f" ] && read -r n < "$f"; n=$((n + 60)); echo $n > "$f"; echo $n';
/** What Ubuntu always has running: unrelated processes and the unattended-upgrades shutdown daemon. */
const IDLE_PS =
  'echo "    1 99-00:00:00 systemd /sbin/init"; echo "  700 00:10 bash -bash"; echo " 1847 1-09:01:19 unattended-upgr /usr/bin/python3 /usr/share/unattended-upgrades/unattended-upgrade-shutdown --wait-for-signal"; echo "  900 05:00 apt-cacher-ng /usr/sbin/apt-cacher-ng -c /etc/apt-cacher-ng"';
/** `ps -eo pid=,etime=,comm=,args=` with an apt-get stuck for 36 days on top of that. */
const STUCK_APT = `${IDLE_PS}; echo "169063 36-04:12:10 apt-get apt-get -qq -y update"`;
const TOOLS = { tmux: 0, make: 0, 'g++': 0, python3: 0 };

const APT = `apt-get -o DPkg::Lock::Timeout=${APT_LOCK_WAIT_S}`;
const APT_STEPS = [`${APT} update`, `${APT} install -y build-essential python3 tmux`];
const AGENT_STEPS = ['npm i -g @termhub/agent', 'termhub-agent --version'];

const catalog = (locale: string) => JSON.parse(fs.readFileSync(path.resolve(__dirname, `../locales/${locale}/machines.json`), 'utf8')) as Record<string, string>;
const translate = (locale: string) => {
  const entries = catalog(locale);
  return (key: string) => {
    const text = entries[key];
    if (!text) throw new Error(`no ${locale} entry for: ${key}`);
    return text;
  };
};

describe.each(SHELLS)('LINUX_INSTALL_COMMAND in %s', (shell) => {
  const base = { id: 'echo 0', env: ENV, date: 'echo 0', node: 0, npm: 0, 'termhub-agent': 0 };

  it('as root on apt: installs the build tools and tmux without sudo, then the agent', () => {
    const r = run(shell, LINUX_INSTALL_COMMAND, { ...base, 'apt-get': 0 });
    expect(r.status).toBe(0);
    expect(r.steps).toEqual([...APT_STEPS, ...AGENT_STEPS]);
  });

  it('as a regular user on apt: uses sudo', () => {
    const r = run(shell, LINUX_INSTALL_COMMAND, { ...base, id: 'echo 1000', 'apt-get': 0, sudo: '"$@"' });
    expect(r.status).toBe(0);
    expect(r.calls).toContain(`sudo env DEBIAN_FRONTEND=noninteractive ${APT} install -y build-essential python3 tmux`);
    expect(r.steps).toContain('npm i -g @termhub/agent');
  });

  it('runs apt without prompts, as root and through sudo', () => {
    const noPrompts = '[ "$DEBIAN_FRONTEND" = noninteractive ]';
    expect(run(shell, LINUX_INSTALL_COMMAND, { ...base, 'apt-get': noPrompts }).status).toBe(0);
    expect(run(shell, LINUX_INSTALL_COMMAND, { ...base, id: 'echo 1000', 'apt-get': noPrompts, sudo: '"$@"' }).status).toBe(0);
  });

  it('stops before npm when apt fails, and does not fall through to another manager', () => {
    const r = run(shell, LINUX_INSTALL_COMMAND, { ...base, 'apt-get': 'case "$*" in *update) exit 0;; *) exit 100;; esac', dnf: 0, pacman: 0, sleep: 0, ps: IDLE_PS });
    expect(r.status).not.toBe(0);
    // no other apt process around: a real failure, not retried
    expect(r.steps).toEqual(APT_STEPS);
    expect(r.stdout).toBe('');
  });

  it('takes a running unattended upgrade as the holder of the lock', () => {
    const upgrade = 'echo " 2200 03:10 unattended-upgr /usr/bin/python3 /usr/bin/unattended-upgrade"';
    const r = run(shell, LINUX_INSTALL_COMMAND, { ...base, 'apt-get': 100, ps: `${IDLE_PS}; ${upgrade}`, sleep: 0, date: TICKING });
    expect(r.stdout).toContain('  PID 2200 (unattended-upgr) 03:10');
    expect(r.stdout).not.toContain('1847');
  });

  it('uses dnf and pacman with their own package names', () => {
    const dnf = run(shell, LINUX_INSTALL_COMMAND, { ...base, dnf: 0 });
    expect(dnf.steps).toEqual(['dnf group install -y Development Tools', 'dnf install -y python3 tmux', ...AGENT_STEPS]);
    const pacman = run(shell, LINUX_INSTALL_COMMAND, { ...base, pacman: 0 });
    expect(pacman.steps).toEqual(['pacman -S --noconfirm --needed base-devel python tmux', ...AGENT_STEPS]);
  });

  it('without a known package manager: explains and never runs npm', () => {
    const r = run(shell, LINUX_INSTALL_COMMAND, base);
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain('Instale tmux, make, g++ e python3');
    expect(r.steps).toEqual([]);
  });

  it('does not print the version when npm fails', () => {
    const r = run(shell, LINUX_INSTALL_COMMAND, { ...base, 'apt-get': 0, npm: 1 });
    expect(r.status).not.toBe(0);
    expect(r.steps).not.toContain('termhub-agent --version');
  });

  it('skips the package manager when tmux, make, g++ and python3 are already there', () => {
    for (const manager of ['apt-get', 'dnf', 'pacman']) {
      const r = run(shell, LINUX_INSTALL_COMMAND, { ...base, ...TOOLS, [manager]: 1 });
      expect(r.status).toBe(0);
      expect(r.steps).toEqual(AGENT_STEPS);
    }
  });

  it('still calls the package manager when one of the tools is missing', () => {
    const { 'g++': _missing, ...rest } = TOOLS;
    const r = run(shell, LINUX_INSTALL_COMMAND, { ...base, ...rest, 'apt-get': 0 });
    expect(r.steps).toEqual([...APT_STEPS, ...AGENT_STEPS]);
  });

  it('waits for another apt run to release the lock, then goes on', () => {
    const r = run(shell, LINUX_INSTALL_COMMAND, { ...base, 'apt-get': FAILS_ONCE, ps: STUCK_APT, sleep: 0 });
    expect(r.status).toBe(0);
    expect(r.stdout.match(/esperando liberar/g)).toHaveLength(1);
    expect(r.steps).toEqual([APT_STEPS[0], 'sleep 5', ...APT_STEPS, ...AGENT_STEPS]);
  });

  it('when the lock is never released: names the holder, says what to do and never runs npm', () => {
    const r = run(shell, LINUX_INSTALL_COMMAND, { ...base, 'apt-get': 100, ps: STUCK_APT, sleep: 0, date: TICKING });
    expect(r.status).not.toBe(0);
    expect(r.steps).toEqual([APT_STEPS[0], 'sleep 5', APT_STEPS[0]]);
    expect(r.stdout).toContain('O apt continua em uso por outro processo');
    expect(r.stdout).toContain('  PID 169063 (apt-get) 36-04:12:10');
    expect(r.stdout).not.toMatch(/systemd|bash|1847|cacher/);
    expect(r.stdout).toContain('dpkg --configure -a');
    expect(r.stdout).not.toMatch(/\brm\b|lock/);
  });

  it('without npm or node: says so first and installs nothing', () => {
    const { npm: _npm, node: _node, ...noNode } = base;
    for (const stubs of [noNode, { ...noNode, node: 0 }, { ...noNode, npm: 0 }]) {
      const r = run(shell, LINUX_INSTALL_COMMAND, { ...stubs, 'apt-get': 0 });
      expect(r.status).not.toBe(0);
      expect(r.stdout).toContain(`Node ${MIN_NODE_MAJOR} ou mais novo`);
      expect(r.steps).toEqual([]);
    }
  });

  it('with a Node older than the agent needs: says so first and installs nothing', () => {
    const r = run(shell, LINUX_INSTALL_COMMAND, { ...base, node: 1, 'apt-get': 0 });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain(`Node ${MIN_NODE_MAJOR} ou mais novo`);
    expect(r.steps).toEqual([]);
  });

  it('accepts the Node running these tests', () => {
    const { node: _node, ...rest } = base;
    const r = run(shell, LINUX_INSTALL_COMMAND, { ...rest, ...TOOLS }, { node: process.execPath });
    expect(r.status).toBe(0);
    expect(r.steps).toEqual(AGENT_STEPS);
  });

  it('prints its messages in the language it was built for, whatever the translation holds', () => {
    const en = run(shell, linuxInstallCommand(translate('en')), base);
    expect(en.stdout).toContain('Install tmux, make, g++ and python3');
    const quoted = run(shell, linuxInstallCommand((key) => `it's "$HOME" \`id\`: ${key}`), base);
    expect(quoted.stdout).toContain('it\'s "$HOME" `id`: Instale tmux');
  });
});

describe.each(SHELLS)('MACOS_INSTALL_COMMAND in %s', (shell) => {
  const agent = { npm: 0, 'termhub-agent': 0 };

  it('installs tmux with brew when it is missing, then the agent', () => {
    const r = run(shell, MACOS_INSTALL_COMMAND, { 'xcode-select': 0, brew: 0, ...agent });
    expect(r.status).toBe(0);
    expect(r.calls).toEqual(['xcode-select -p', 'brew install tmux', 'npm i -g @termhub/agent', 'termhub-agent --version']);
  });

  it('skips brew when tmux is already there', () => {
    const r = run(shell, MACOS_INSTALL_COMMAND, { 'xcode-select': 0, tmux: 0, brew: 0, ...agent });
    expect(r.calls).not.toContain('brew install tmux');
    expect(r.calls).toContain('npm i -g @termhub/agent');
  });

  it('stops before npm when brew fails', () => {
    const r = run(shell, MACOS_INSTALL_COMMAND, { 'xcode-select': 0, brew: 1, ...agent });
    expect(r.status).not.toBe(0);
    expect(r.calls.some((c) => c.startsWith('npm'))).toBe(false);
  });

  it('opens the Command Line Tools installer and stops when the compiler is missing', () => {
    const r = run(shell, MACOS_INSTALL_COMMAND, { 'xcode-select': 'case "$1" in -p) exit 2;; *) exit 0;; esac', brew: 0, ...agent });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain('Conclua a instalação das Command Line Tools');
    expect(r.calls).toEqual(['xcode-select -p', 'xcode-select --install']);
  });
});

describe('the Node the agent needs', () => {
  it('is the one apps/agent/package.json declares', () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../agent/package.json'), 'utf8')) as { engines: { node: string } };
    expect(pkg.engines.node).toBe(`>=${MIN_NODE_MAJOR}`);
  });
});

describe('apps/agent/README.md', () => {
  it('shows the same install commands as the Add machine screen, in English', () => {
    const readme = fs.readFileSync(path.resolve(__dirname, '../../../agent/README.md'), 'utf8');
    expect(readme).toContain(linuxInstallCommand(translate('en')));
    expect(readme).toContain(macosInstallCommand(translate('en')));
  });
});
