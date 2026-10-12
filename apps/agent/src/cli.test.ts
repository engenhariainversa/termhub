import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isMainModule } from './paths.js';
import { AGENT_VERSION } from './version.js';

let home: string;
const ORIGINAL_ENV = process.env.TERMHUB_AGENT_HOME;

/** cli.ts re-imported fresh isn't needed (main() reads env lazily through config.ts), but keep the pattern consistent with config.test.ts. */
async function freshCli() {
  return import('./cli.js');
}

// cli.ts's bottom-of-file "am I the entry point?" guard (`isMainModule(import.meta.url,
// process.argv[1])`) is exactly what makes `termhub-agent`'s global-bin symlink case a no-op if
// it compares raw (non-realpath'd) paths — see paths.test.ts for the full symlink coverage;
// this reproduces the exact expression cli.ts evaluates, standing in for "run through the npm
// global bin symlink".
describe('cli.ts entry-point guard (npm global bin symlink)', () => {
  let dir: string;
  let realTarget: string;
  let symlink: string;

  beforeEach(() => {
    // realpath'd: on macOS os.tmpdir() is a symlink (/var → /private/var), see paths.test.ts.
    dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'termhub-agent-cli-guard-'));
    realTarget = path.join(dir, 'dist', 'cli.js');
    fs.mkdirSync(path.dirname(realTarget), { recursive: true });
    fs.writeFileSync(realTarget, '// fake dist/cli.js\n', 'utf8');
    symlink = path.join(dir, 'bin', 'termhub-agent');
    fs.mkdirSync(path.dirname(symlink), { recursive: true });
    fs.symlinkSync(realTarget, symlink);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('matches when argv[1] is the npm-global-bin symlink and import.meta.url is the real dist/cli.js it points at', () => {
    const importMetaUrl = pathToFileURL(realTarget).href;
    expect(isMainModule(importMetaUrl, symlink)).toBe(true);
  });
});

describe('cli main()', () => {
  let logs: string[];
  let errors: string[];

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'termhub-agent-cli-'));
    process.env.TERMHUB_AGENT_HOME = home;
    process.exitCode = undefined;
    logs = [];
    errors = [];
    vi.spyOn(console, 'log').mockImplementation((msg?: unknown) => {
      logs.push(String(msg));
    });
    vi.spyOn(console, 'error').mockImplementation((msg?: unknown) => {
      errors.push(String(msg));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (ORIGINAL_ENV === undefined) delete process.env.TERMHUB_AGENT_HOME;
    else process.env.TERMHUB_AGENT_HOME = ORIGINAL_ENV;
    fs.rmSync(home, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  it('--version prints AGENT_VERSION and exits 0', async () => {
    const { main } = await freshCli();
    await main(['--version']);
    expect(logs.join('\n')).toContain(AGENT_VERSION);
    expect(process.exitCode).toBeUndefined();
  });

  it('--help prints pt-BR usage and exits 0', async () => {
    const { main } = await freshCli();
    await main(['--help']);
    expect(logs.join('\n')).toContain('Uso: termhub-agent');
    expect(process.exitCode).toBe(0);
  });

  it('no arguments prints usage and exits 2', async () => {
    const { main } = await freshCli();
    await main([]);
    expect(logs.join('\n')).toContain('Uso: termhub-agent');
    expect(process.exitCode).toBe(2);
  });

  it('an unknown command exits 2 with a usage message', async () => {
    const { main } = await freshCli();
    await main(['bogus']);
    expect(errors.join('\n')).toContain('Comando desconhecido: bogus');
    expect(process.exitCode).toBe(2);
  });

  it('an unknown flag exits 2', async () => {
    const { main } = await freshCli();
    await main(['status', '--nope']);
    expect(process.exitCode).toBe(2);
  });

  it('"service" with no subcommand exits 2 with usage', async () => {
    const { main } = await freshCli();
    await main(['service']);
    expect(errors.join('\n')).toContain('service install|uninstall|status');
    expect(process.exitCode).toBe(2);
  });

  it('"run" without a config stops the launchd restart loop and exits 78 (EX_CONFIG)', async () => {
    // Tests runCommand() directly (not through main()) so the mocked process.exit()'s thrown
    // sentinel is observed here, rather than being swallowed by main()'s catch-all around
    // command dispatch — a real process.exit() never returns, so that catch never sees it in
    // production; only the mock makes it throw.
    const { runCommand } = await import('./commands/run.js');
    const launchd = await import('./service/launchd.js');
    const stopRestartLoop = vi.spyOn(launchd, 'stopRestartLoop').mockResolvedValue(undefined);
    const exitCodes: (number | undefined)[] = [];
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exitCodes.push(code);
      throw new Error(`__process_exit_${code}__`);
    }) as never);

    await expect(runCommand(() => {})).rejects.toThrow('__process_exit_78__');

    expect(exitCodes).toEqual([78]);
    expect(errors.join('\n')).toContain('Nenhuma configuração. Rode: termhub-agent connect --url <url>');
    // launchd's KeepAlive restarts on any non-zero exit, so the job must be booted out first.
    expect(stopRestartLoop).toHaveBeenCalledTimes(1);
  });

  // The unit/plist is written once, by `service install`; an update only swaps the code. Startup
  // is therefore the only moment a definition from an older agent can be corrected, and a
  // failure there must not keep the agent from connecting.
  it('"run" refreshes the service definition before connecting, and connects anyway when that fails', async () => {
    const { runCommand } = await import('./commands/run.js');
    const { writeConfig } = await import('./config.js');
    const service = await import('./service/index.js');
    const connect = await import('./commands/connect.js');
    writeConfig({ url: 'wss://app.termhub.dev/agent', token: 'tok', machine_id: '', machine_name: '', created_at: new Date().toISOString() });
    const foreground = vi.spyOn(connect, 'runForegroundUntilSignal').mockResolvedValue(undefined as never);
    const refresh = vi.spyOn(service, 'refresh').mockResolvedValue(true);
    const messages: string[] = [];

    await runCommand((msg) => messages.push(msg));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(messages).toContain('service definition refreshed');
    expect(foreground).toHaveBeenCalledTimes(1);

    refresh.mockRejectedValue(new Error('daemon-reload failed'));
    await expect(runCommand((msg) => messages.push(msg))).resolves.toBeUndefined();
    expect(foreground).toHaveBeenCalledTimes(2);
  });

  it('main(["run"]) without a config calls process.exit(78)', async () => {
    const { main } = await freshCli();
    // exitWithoutRestart() boots the real launchd job out before exiting; unmocked, this test
    // SIGTERMs and unloads the agent serving the developer's own machine (test-setup.ts now
    // fails any test that gets that far).
    const launchd = await import('./service/launchd.js');
    const stopRestartLoop = vi.spyOn(launchd, 'stopRestartLoop').mockResolvedValue(undefined);
    const exitCodes: (number | undefined)[] = [];
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exitCodes.push(code);
      throw new Error(`__process_exit_${code}__`);
    }) as never);

    await main(['run']);

    expect(exitCodes).toEqual([78]);
    expect(stopRestartLoop).toHaveBeenCalledTimes(1);
  });

  it('"disconnect" removes the config and prints the pt-BR confirmation', async () => {
    const { main } = await freshCli();
    const { writeConfig } = await import('./config.js');
    writeConfig({ url: 'https://app.termhub.dev', token: 'thb_ag_' + 'a'.repeat(43), machine_id: '', machine_name: '', created_at: new Date().toISOString() });

    await main(['disconnect']);

    expect(logs.join('\n')).toContain('Configuração removida. Revogue o acesso no app');
    const { readConfig } = await import('./config.js');
    expect(readConfig()).toBeNull();
  });
});
