import os from 'node:os';
import type { HelloMessage } from '@termhub/agent-protocol';
import { CAPABILITY_CLAUDE, CAPABILITY_CLAUDE_STREAM_INPUT, CAPABILITY_CLAUDE_SYSTEM_PROMPT, CAPABILITY_SIM, CLOSE } from '@termhub/agent-protocol';
import { connectOnce, runForever, RevokedError, ProtocolMismatchError, UpgradeRejectedError } from './client.js';
import { heal } from './rpc/hooks.js';
import type { AgentConfig } from './config.js';
import { createClaudeManager } from './claude/run.js';
import { createDispatcher } from './dispatch.js';
import { createPtyManager } from './pty.js';
import { createTcpManager } from './tcp.js';
import { ensureSpawnHelperExecutable } from './pty-health.js';
import { handlers } from './rpc/index.js';
import { stopRestartLoop } from './service/launchd.js';
import { AGENT_VERSION } from './version.js';

export type SupportedOs = 'macos' | 'linux';

/** `darwin` → `macos`, `linux` → `linux`; anything else (win32, …) isn't supported yet. */
export function detectOs(platform: NodeJS.Platform = process.platform): SupportedOs | null {
  if (platform === 'darwin') return 'macos';
  if (platform === 'linux') return 'linux';
  return null;
}

export type HelloFields = Omit<HelloMessage, 'type' | 'protocol'>;

/**
 * What this agent understands beyond the baseline `pty` channel. The server reads it from `hello`
 * and only opens a `claude` channel on a machine that claims it — an agent too old to know the
 * kind sends no `capabilities` at all, which reads as `[]` (see the protocol's `helloMessage`).
 */
export const CAPABILITIES = [CAPABILITY_CLAUDE, CAPABILITY_CLAUDE_SYSTEM_PROMPT, CAPABILITY_CLAUDE_STREAM_INPUT];

/** What this agent understands beyond a terminal. The simulator (`sim`) needs Xcode's simctl and the WDA
 *  runner, which only exist on macOS, so a Linux agent never claims it. */
export function capabilitiesFor(osName: SupportedOs): string[] {
  return osName === 'macos' ? [...CAPABILITIES, CAPABILITY_SIM] : [...CAPABILITIES];
}

/** Builds the `hello` fields, probing `tools.detect` for the tool list (empty on failure). */
export async function buildHello(osName: SupportedOs): Promise<HelloFields> {
  let tools: string[] = [];
  try {
    const result = await handlers['tools.detect']({});
    tools = result.tools;
  } catch {
    tools = [];
  }
  return {
    agent_version: AGENT_VERSION,
    os: osName,
    arch: process.arch,
    hostname: os.hostname(),
    tmux: tools.includes('tmux'),
    tools,
    capabilities: capabilitiesFor(osName),
  };
}

export const REVOKED_MESSAGE = 'Token inválido ou revogado';
export const UPGRADE_MESSAGE = 'Atualize o agente: npm i -g @termhub/agent';

/**
 * Reachability check used by `status`/`doctor`: a `hello` with `probe: true`, which the server
 * validates (token, protocol) and answers by closing 1000 `probe-ok` without attaching — so a
 * probe never replaces the live session the service holds on this machine. Any other outcome
 * (401 upgrade, 4401/4409 close, no answer within `timeoutMs`) is "not connected".
 */
export async function checkServerConnection(
  config: Pick<AgentConfig, 'url' | 'token'>,
  timeoutMs = 5_000,
): Promise<{ ok: boolean; error?: string }> {
  const osName = detectOs() ?? 'linux';
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const { closed } = await connectOnce(
      {
        url: config.url,
        token: config.token,
        hello: { agent_version: AGENT_VERSION, os: osName, arch: process.arch, hostname: os.hostname(), tmux: false, tools: [], capabilities: capabilitiesFor(osName), probe: true },
        onServerMessage: () => {},
        onStream: () => {},
        log: () => {},
      },
      controller.signal,
    );
    const info = await closed;
    if (info.code === 1000 && info.reason === 'probe-ok') return { ok: true };
    if (info.code === CLOSE.UNAUTHORIZED) return { ok: false, error: REVOKED_MESSAGE };
    if (info.code === CLOSE.CONFLICT && info.reason === 'protocol') return { ok: false, error: UPGRADE_MESSAGE };
    if (timedOut) return { ok: false, error: 'O servidor não respondeu' };
    return { ok: false, error: `Conexão encerrada (${info.code}${info.reason ? ` ${info.reason}` : ''})` };
  } catch (err) {
    if (err instanceof UpgradeRejectedError && err.status === 401) {
      return { ok: false, error: REVOKED_MESSAGE };
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

export interface RunAgentOptions {
  signal?: AbortSignal;
  log: (msg: string, meta?: object) => void;
}

/**
 * Prints a pt-BR reason, stops the service manager from restarting us and exits 78
 * (`EX_CONFIG`). systemd honours `RestartPreventExitStatus=78` on its own; launchd does not
 * (`KeepAlive.SuccessfulExit=false` restarts on any failure), so the job is booted out first.
 * The message goes out before the bootout, which may SIGTERM this very process.
 */
export async function exitWithoutRestart(message: string): Promise<never> {
  console.error(message);
  await stopRestartLoop();
  process.exit(78);
}

/**
 * Runs the agent in the foreground until `signal` aborts (or forever, if none is given):
 * builds `hello`, wires the PTY manager + dispatcher into `runForever()`, and drops every PTY
 * channel (`pty.closeAll()`) on each disconnect so a reconnect never inherits a stale session.
 *
 * `RevokedError`/`ProtocolMismatchError` end in `exitWithoutRestart()` (pt-BR message, exit 78,
 * service manager told not to restart — see `service/*.ts`).
 */
export async function runAgent(config: AgentConfig, opts: RunAgentOptions): Promise<void> {
  const osName = detectOs();
  if (!osName) {
    console.error('Sistema não suportado');
    process.exit(1);
  }

  const hello = await buildHello(osName);
  // Repair node-pty's spawn-helper before the first tab opens (see pty-health.ts).
  const helper = ensureSpawnHelperExecutable();
  if (helper.repaired) opts.log('spawn-helper exec bit repaired', { path: helper.path });
  else if (!helper.executable) opts.log('spawn-helper is not executable and could not be fixed', { path: helper.path, error: helper.error });
  const pty = createPtyManager({ log: opts.log });
  const claude = createClaudeManager({ log: opts.log });
  const tcp = createTcpManager({ log: opts.log });
  const dispatch = createDispatcher({ handlers, pty, claude, tcp, log: opts.log });

  /**
   * Config dirs come and go on a machine (a new account, a new CLAUDE_CONFIG_DIR alias), and a dir
   * without our entries is a tool that never tells termhub it is waiting for the person. Repairing
   * on startup and on every session keeps that from needing a visit to the machine. It reuses what
   * is already installed here, so it does nothing on a machine that has no hooks.
   */
  const healHooks = () => {
    heal()
      .then((dirs) => {
        if (dirs.length) opts.log('monitor hooks repaired', { dirs: dirs.length });
      })
      .catch((err: unknown) => opts.log('monitor hooks could not be repaired', { error: err instanceof Error ? err.message : String(err) }));
  };
  healHooks();

  try {
    await runForever(
      {
        url: config.url,
        token: config.token,
        hello,
        onServerMessage: dispatch,
        // A frame belongs to whichever manager holds that channel: the claude one says so, and
        // anything it does not own is a terminal's.
        onStream: (ch, data) => {
          if (!claude.write(ch, data) && !tcp.write(ch, data)) pty.write(ch, data);
        },
        onConnect: healHooks,
        onDisconnect: () => {
          pty.closeAll();
          claude.closeAll();
          tcp.closeAll();
        },
        log: opts.log,
      },
      opts.signal,
    );
  } catch (err) {
    if (err instanceof RevokedError) {
      await exitWithoutRestart('Token revogado. Rode: termhub-agent connect --url <url>');
    }
    if (err instanceof ProtocolMismatchError) {
      await exitWithoutRestart(UPGRADE_MESSAGE);
    }
    throw err;
  }
}
