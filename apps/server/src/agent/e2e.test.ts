import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import type { FastifyBaseLogger } from 'fastify';
import type { AuthContext } from '../auth/index.js';
import { createUpgradeRouter } from '../ws/router.js';
import type { Repositories } from '../db/repositories/index.js';
import type { Machine, Project, Tab } from '../db/repositories/types.js';
import { newAgentToken } from './token.js';
import { registerAgentWs } from './ws.js';
import { registerTerminalWs } from '../terminal/ws.js';
import { agents } from './registry.js';
import { captureScreen } from './screen.js';
// Agent-side modules, imported straight from the sibling package's source: this suite proves
// the whole chain (browser <-> server <-> agent <-> real tmux) works end to end, so it needs
// the real agent runtime, not a mock of it. See task-15-brief.md for why this lives here
// instead of in apps/agent (the harness — real http.Server + createUpgradeRouter — is the
// server test suite's, not the agent's).
import { runAgent } from '../../../agent/src/run.js';
import type { AgentConfig } from '../../../agent/src/config.js';

const { resolveUserMock, canAccessMock } = vi.hoisted(() => ({
  resolveUserMock: vi.fn(),
  canAccessMock: vi.fn(),
}));

// Same stubbing style as terminal/ws.test.ts: the cookie/permission plumbing isn't what this
// suite is about, only the real createPtySession -> agent registry -> tmux wiring is.
vi.mock('../auth/permissions.js', () => ({ canAccess: (...args: unknown[]) => canAccessMock(...args) }));
vi.mock('../auth/index.js', () => ({
  parseCookies: () => ({}),
  resolveUser: (...args: unknown[]) => resolveUserMock(...args),
}));

function commandExists(cmd: string): boolean {
  try {
    execFileSync('which', [cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Docker runners without tmux (node.sh) must still pass green: this whole suite is a no-op
// there, proving the skip itself works rather than failing on a missing binary.
const hasTmux = commandExists('tmux');

function fakeLog(): FastifyBaseLogger {
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    silent: vi.fn(),
    child: vi.fn(() => log),
    level: 'info',
  };
  return log as unknown as FastifyBaseLogger;
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

function shutdown(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

describe.skipIf(!hasTmux)('agent e2e: browser <-> server <-> agent <-> real tmux', () => {
  let server: http.Server;
  let port: number;
  let tmuxTmpDir: string;
  let projectCwd: string;
  let agentController: AbortController;
  let agentRunPromise: Promise<void>;
  let machine: Machine;
  let prevTmuxTmpDir: string | undefined;
  let prevTmuxPath: string | undefined;
  let prevTmux: string | undefined;
  let agentHome: string;
  let prevHome: string | undefined;

  beforeAll(async () => {
    tmuxTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'thtest-tmux-'));
    projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'thtest-cwd-'));

    // The agent's home, seeded like a machine with termhub hooks installed and Codex present.
    agentHome = fs.mkdtempSync(path.join(os.tmpdir(), 'thtest-home-'));
    fs.mkdirSync(path.join(agentHome, '.termhub', 'bin'), { recursive: true });
    fs.mkdirSync(path.join(agentHome, '.codex'));
    fs.writeFileSync(path.join(agentHome, '.termhub', 'hook.env'), "TERMHUB_HOOK_URL='http://127.0.0.1:1/x'\nTERMHUB_HOOK_TOKEN='t'\n");
    fs.writeFileSync(path.join(agentHome, '.termhub', 'bin', 'termhub-hook'), '#!/bin/sh\n# placeholder\n', { mode: 0o755 });
    // `runAgent` heals the monitor hooks (~/.termhub/bin/termhub-hook, ~/.codex/hooks.json, ...) of
    // the HOME it runs in, and os.homedir() reads $HOME: without this the suite rewrote the
    // developer's real hooks. Restored in afterAll.
    prevHome = process.env.HOME;
    process.env.HOME = agentHome;

    // Set before anything spawns tmux: the agent's own tmux calls (pty open + tmux.capture RPC)
    // build their env from process.env at call time, so this keeps the real tmux server the
    // dev/CI machine might have running completely out of reach. Saved so afterAll can put the
    // process env back the way it found it (other test files in the same worker may care).
    // $TMUX (set inside any tmux pane) names the socket of the server that pane belongs to and
    // takes precedence over TMUX_TMPDIR, so with it in the env every tmux call — including the
    // kill-server in afterAll — would hit the developer's real server instead of the sandbox.
    prevTmuxTmpDir = process.env.TMUX_TMPDIR;
    prevTmuxPath = process.env.TMUX_PATH;
    prevTmux = process.env.TMUX;
    process.env.TMUX_TMPDIR = tmuxTmpDir;
    delete process.env.TMUX_PATH;
    delete process.env.TMUX;

    const { token, hash } = newAgentToken();

    machine = {
      id: 'm1',
      name: 'e2e-agent',
      host: null,
      ssh_user: null,
      ssh_port: 22,
      type: 'agent',
      os: 'linux',
      capabilities: [],
      checked_at: null,
      agent_version: null,
      agent_last_seen_at: null,
      agent_auto_update: false,
      is_local: false,
      owner_id: 'u1',
      owner_name: null,
      created_at: new Date().toISOString(),
    } as unknown as Machine;

    const project: Project = {
      id: 'p1',
      owner_id: 'u1',
      key: 'E2E',
      next_task_number: 1,
      name: 'e2e-project',
      status: 'active',
      description: null,
      last_terminal_at: null,
      created_at: new Date().toISOString(),
    } as unknown as Project;

    const tabs: Record<string, Tab> = {};
    for (const [id, name, session, position] of [
      ['t1', 'main', 'thtest-e2e', 0],
      ['t2', 'second', 'thtest-e2e-2', 1],
    ] as const) {
      tabs[id] = {
        id,
        project_id: 'p1',
        machine_id: 'm1',
        name,
        kind: 'terminal',
        tmux_session: session,
        simulator_udid: null,
        position,
        created_at: new Date().toISOString(),
      } as unknown as Tab;
    }

    resolveUserMock.mockResolvedValue({ id: 'u1' });
    canAccessMock.mockResolvedValue(true);

    const repos = {
      tabs: { findById: vi.fn(async (id: string) => tabs[id]) },
      projects: {
        findById: vi.fn(async () => project),
        touchTerminal: vi.fn(async () => {}),
      },
      projectMachines: {
        find: vi.fn(async () => ({ id: 'l1', project_id: 'p1', machine_id: 'm1', cwd: projectCwd, position: 0, created_at: '' })),
      },
      machines: {
        findById: vi.fn(async () => machine),
        findByAgentTokenHash: vi.fn(async (h: string) => (h === hash ? machine : undefined)),
        touchAgent: vi.fn(async () => {}),
      },
    } as unknown as Repositories;

    server = http.createServer();
    const router = createUpgradeRouter(server, { auth: {} as AuthContext });
    registerAgentWs(router, { repos, log: fakeLog() });
    registerTerminalWs(router, { repos, log: fakeLog() });
    port = await listen(server);

    const agentConfig: AgentConfig = {
      url: `http://127.0.0.1:${port}`,
      token,
      machine_id: '',
      machine_name: '',
      created_at: new Date().toISOString(),
    };
    agentController = new AbortController();
    agentRunPromise = runAgent(agentConfig, { signal: agentController.signal, log: () => {} }).catch((err) => {
      if (!agentController.signal.aborted) throw err;
    });

    await vi.waitFor(() => expect(agents.isOnline('m1')).toBe(true), { timeout: 10_000, interval: 100 });
  });

  afterAll(async () => {
    agentController?.abort();
    await agentRunPromise?.catch(() => {});
    try {
      execFileSync('tmux', ['kill-server'], { env: { ...process.env, TMUX_TMPDIR: tmuxTmpDir, TMUX: undefined } });
    } catch {
      /* no session left, or tmux server already gone — fine */
    }
    if (server) await shutdown(server);
    fs.rmSync(tmuxTmpDir, { recursive: true, force: true });
    fs.rmSync(projectCwd, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    // the tmux shells killed above may still be writing their history into this HOME: retry ENOTEMPTY
    try {
      fs.rmSync(agentHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch (err) {
      // DIAGNOSTIC (temporary): names and sizes only, never contents
      console.error('[e2e-home-diag] left behind:', execFileSync('sh', ['-c', `find ${agentHome} -exec ls -ld {} +; ps -eo pid,ppid,etime,args | grep -v grep | grep -E 'tmux|thtest|sh -c|node' | cut -c1-160`], { encoding: 'utf8' }));
      throw err;
    }

    if (prevTmuxTmpDir === undefined) delete process.env.TMUX_TMPDIR;
    else process.env.TMUX_TMPDIR = prevTmuxTmpDir;
    if (prevTmuxPath === undefined) delete process.env.TMUX_PATH;
    else process.env.TMUX_PATH = prevTmuxPath;
    if (prevTmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = prevTmux;
  });

  interface BrowserTab {
    ws: WebSocket;
    /** Everything the pty streamed so far (test-only buffer; never logged). */
    output(): string;
  }

  /** Opens the browser-side socket for `tabId` and resolves once the server reports `ready`. */
  async function openTab(tabId: string): Promise<BrowserTab> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/tabs/${tabId}?cols=80&rows=24`);
    let received = '';
    const ready = new Promise<void>((resolve, reject) => {
      ws.once('error', reject);
      ws.on('message', (data, isBinary) => {
        if (isBinary) {
          received += Buffer.from(data as Buffer).toString('utf8');
          return;
        }
        const msg = JSON.parse(data.toString());
        if (msg.type === 'ready') resolve();
      });
    });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    await ready;
    return { ws, output: () => received };
  }

  /**
   * Types `echo <marker>` and waits for the marker to show up twice: the pty echoes the typed
   * command first, then the shell prints the real output line — passing on the input echo
   * alone would prove nothing about the shell.
   */
  async function expectEcho(tab: BrowserTab, marker: string): Promise<void> {
    tab.ws.send(Buffer.from(`echo ${marker}\n`), { binary: true });
    await vi.waitFor(
      () => {
        const occurrences = tab.output().split(marker).length - 1;
        expect(occurrences).toBeGreaterThanOrEqual(2);
      },
      { timeout: 15_000, interval: 100 },
    );
  }

  it('heals the monitor hooks of the temporary HOME it runs in, never the real one (TER-491)', { timeout: 15_000 }, async () => {
    await vi.waitFor(
      () => expect(fs.readFileSync(path.join(agentHome, '.codex', 'hooks.json'), 'utf8')).toContain('termhub-hook codex'),
      { timeout: 8_000, interval: 100 },
    );
  });

  it(
    'echoes a command through a real tmux session on the agent side',
    { timeout: 30_000 },
    async () => {
      const tab = await openTab('t1');
      await expectEcho(tab, 'E2E_OK');

      const screen = await captureScreen(machine, 'thtest-e2e', 50);
      expect(screen).toContain('E2E_OK');

      tab.ws.close();
    },
  );

  it(
    'closing one tab keeps the agent connection and the other tab alive',
    { timeout: 30_000 },
    async () => {
      // Two tabs → two tmux sessions over the same agent connection.
      const tabA = await openTab('t1');
      const tabB = await openTab('t2');
      await expectEcho(tabB, 'E2E_B_BEFORE');

      // Closing tab A's browser socket makes the server close its channel; the agent kills
      // that pty (tmux emits "[lost tty]" and friends on the way out). None of that may tear
      // down the whole agent connection — before the close handshake, it did.
      tabA.ws.close();
      await new Promise((r) => setTimeout(r, 500));

      expect(agents.isOnline('m1')).toBe(true);
      expect(tabB.ws.readyState).toBe(WebSocket.OPEN);
      await expectEcho(tabB, 'E2E_B_AFTER');

      tabB.ws.close();
    },
  );
});
