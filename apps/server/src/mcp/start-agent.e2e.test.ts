import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashApiToken } from '../auth/api-tokens.js';
import { canAccess } from '../auth/permissions.js';
import { withLessonsReminder, withOriginReminder } from '../control/agents.js';
import { config } from '../config.js';
import type { Repositories } from '../db/repositories/index.js';
import { normalizeSetup } from '../setup/schema.js';
import { applyErrorHandler } from '../lib/errors.js';
import { mcpRoutes } from './route.js';
import { removeTempDir } from '../../test/temp-dir.js';

vi.mock('../auth/permissions.js', async (orig) => ({ ...(await orig<typeof import('../auth/permissions.js')>()), canAccess: vi.fn(async () => true) }));

/**
 * start_agent end to end (spec §7): a real tmux on its own socket, and a fake "agent" script in
 * place of the CLI — no login, no network, so it runs in CI. What only a real shell can prove is
 * that the launch line §4.4 builds arrives at the CLI as **one** argument with the prompt intact
 * and nothing in it interpreted, that the account travels in the provider's config-dir variable,
 * and that the session really is in the project's cwd.
 */
const SOCKET = `termhub-start-agent-${process.pid}`;
const SECRET = 'thb_pat_' + 'B'.repeat(43);

const realTmux = (() => {
  try {
    return execFileSync('sh', ['-c', 'command -v tmux'], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
})();

/** Reports what it was given and exits; stands in for `claude` / `codex`, which would need a login. */
const FAKE_CLI = `#!/bin/sh
echo "fake-cli args=$#"
echo "fake-cli cfg=$CLAUDE_CONFIG_DIR$CODEX_HOME"
echo "fake-cli cwd=$(pwd)"
printf 'fake-cli prompt=[%s]\\n' "$1"
for a; do last=$a; done
printf 'fake-cli last=[%s]\\n' "$last"
printf 'fake-cli argv=[%s]\\n' "$*"
echo "fake-cli toklen=\${#TERMHUB_MCP_TOKEN}"
`;

const machine = { id: 'm1', name: 'jarvis', type: 'local', os: 'linux', capabilities: ['tmux', 'claude', 'codex'], owner_id: 'u1' };
const accounts = [
  { id: 'a1', provider: 'claude', label: 'pedrogoiania', machine_id: 'm1', config_dir: '', created_at: '' },
  { id: 'a2', provider: 'chatgpt', label: 'ChatGPT', machine_id: 'm1', config_dir: '', created_at: '' },
  // Stored the way the app stores it: relative to the machine's home, expanded on the machine.
  { id: 'a3', provider: 'claude', label: 'til', machine_id: 'm1', config_dir: '~/cfg', created_at: '' },
];

function build(cwd: string) {
  const tabs = new Map<string, Record<string, unknown>>();
  const apiTokens = {
    findActiveByHash: vi.fn(async (h: string) => (h === hashApiToken(SECRET) ? { id: 'tok1', user_id: 'u1', name: 'e2e', scopes: ['read', 'terminals'], expires_at: null, revoked_at: null, last_used_at: null, created_at: '' } : undefined)),
    touchLastUsed: vi.fn(async () => {}),
    recordEvent: vi.fn(async () => {}),
    // the tab token start_agent mints when MCP_URL is set (TER-212)
    create: vi.fn(async (userId: string, input: { name: string; tabId?: string | null }) => ({ id: `tt-${input.tabId}`, user_id: userId, name: input.name, tab_id: input.tabId ?? null })),
    revokeForTab: vi.fn(async () => 1),
  };
  const link = { id: 'l1', project_id: 'p1', machine_id: 'm1', cwd, position: 0, created_at: '' };
  const repos = {
    apiTokens,
    users: { findById: vi.fn(async () => ({ id: 'u1', role_id: 'r' })) },
    machines: { findById: vi.fn(async () => machine), list: vi.fn(async () => [machine]) },
    projects: { findById: vi.fn(async () => ({ id: 'p1', name: 'app', status: 'active', owner_id: 'u1', key: 'APP', next_task_number: 1 })) },
    projectMachines: {
      find: vi.fn(async () => link),
      listByProject: vi.fn(async () => [link]),
    },
    aiAccounts: { findById: vi.fn(async (id: string) => accounts.find((a) => a.id === id)), list: vi.fn(async () => accounts) },
    // no project AI accounts configured (TER-589): start_agent behaves as before
    projectSetup: { get: vi.fn(async (projectId: string) => ({ project_id: projectId, version: 2, data: normalizeSetup({}, 2), updated_at: null })) },
    tabs: {
      listByProject: vi.fn(async () => [...tabs.values()]),
      countOpenByToken: vi.fn(async () => 0),
      findById: vi.fn(async (id: string) => tabs.get(id)),
      create: vi.fn(async (projectId: string, machineId: string, name: string, opts: { created_by_token_id?: string | null } = {}) => {
        const id = `t${tabs.size + 1}`;
        const tab = { id, project_id: projectId, machine_id: machineId, name, kind: 'terminal', tmux_session: `termhub-${SOCKET}-${id}`, simulator_udid: null, position: 0, state: null, state_text: null, state_tool: null, state_at: null, state_seen_at: null, created_at: '', created_by_token_id: opts.created_by_token_id ?? null };
        tabs.set(id, tab);
        return tab;
      }),
      // The account swap (TER-55) records which account runs the tab, best effort.
      setAgentFields: vi.fn(async (id: string, fields: Record<string, unknown>) => {
        const tab = tabs.get(id);
        if (tab) Object.assign(tab, fields);
      }),
    },
  } as unknown as Repositories;

  const app = Fastify();
  applyErrorHandler(app);
  app.register((a) => mcpRoutes(a, { repos, version: '0.0.0-test' }));
  return { app, apiTokens, repos };
}

const callTool = (app: ReturnType<typeof Fastify>, name: string, args: object) =>
  app.inject({
    method: 'POST',
    url: '/mcp',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${SECRET}` },
    payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
  });

const payloadOf = (res: { json(): { result: { content: { text: string }[]; isError?: boolean } } }) => JSON.parse(res.json().result.content[0].text);

/** The pane as one string: an 80-column pane wraps the lines we assert on, and only their text matters. */
const flatten = (text: string) => text.replace(/\n/g, '');

/** Polls the screen through read_screen (the tool a caller would use) until the CLI has answered. */
async function screenWith(app: ReturnType<typeof Fastify>, tabId: string, needle: string, timeoutMs = 15_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let flat = '';
  for (;;) {
    flat = flatten(payloadOf(await callTool(app, 'read_screen', { tab_id: tabId, lines: 50 })).text);
    if (flat.includes(needle) || Date.now() >= deadline) return flat;
    await new Promise((r) => setTimeout(r, 250));
  }
}

describe.skipIf(!realTmux)('start_agent against a real tmux and a fake CLI', () => {
  let home: string;
  let cwd: string;
  let cfg: string;
  let path: string | undefined;
  let homeEnv: string | undefined;

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'termhub-start-agent-'));
    mkdirSync(join(home, 'proj'));
    // realpath: on macOS /tmp is a symlink, so `pwd` inside the session reports the resolved path.
    cwd = realpathSync(join(home, 'proj'));
    cfg = join(home, 'cfg');
    mkdirSync(cfg);

    const bin = join(home, 'bin');
    mkdirSync(bin);
    // The pane's shell must be ours, not the developer's: a login bash would source ~/.bashrc and put
    // the machine's real `claude` ahead of the fake one. /bin/sh reads no rc file, and default-command
    // pins a PATH with nothing on it but the fakes and the system binaries.
    const conf = join(home, 'tmux.conf');
    writeFileSync(conf, `set -g default-shell /bin/sh\nset -g default-command "export PATH=${bin}:/usr/bin:/bin; exec /bin/sh"\n`);
    // Wrapper pinned to our own socket and config: the real tmux by absolute path, since this one shadows it in PATH.
    writeFileSync(join(bin, 'tmux'), `#!/bin/sh\nexec ${realTmux} -L ${SOCKET} -f ${conf} "$@"\n`);
    chmodSync(join(bin, 'tmux'), 0o755);
    for (const cli of ['claude', 'codex']) {
      writeFileSync(join(bin, cli), FAKE_CLI);
      chmodSync(join(bin, cli), 0o755);
    }
    // Both the shell scripts session-ops runs and the tmux server they start inherit this PATH.
    path = process.env.PATH;
    process.env.PATH = `${bin}:${path ?? ''}`;
    // The session's $HOME, so an account stored as "~/cfg" resolves to a directory we control.
    homeEnv = process.env.HOME;
    process.env.HOME = home;
    accounts[0].config_dir = cfg;
    accounts[1].config_dir = cfg;
  });

  afterAll(() => {
    try {
      execFileSync(realTmux, ['-L', SOCKET, 'kill-server'], { stdio: 'ignore' });
    } catch {
      /* no server to kill */
    }
    process.env.PATH = path;
    process.env.HOME = homeEnv;
    removeTempDir(home);
  });

  beforeEach(() => {
    vi.mocked(canAccess).mockResolvedValue(true);
  });

  it('starts the CLI in the project with the prompt as one inert argument', async () => {
    const { app, apiTokens, repos } = build(cwd);
    // Everything a shell would love to interpret: quotes, a command separator and a substitution.
    const prompt = `spec do "XPTO"; $(echo 9) 'ok'`;

    const started = await callTool(app, 'start_agent', { project_id: 'p1', account_id: 'a1', prompt });
    const out = payloadOf(started);
    expect(started.json().result.isError).toBeUndefined();
    expect(out).toMatchObject({ tab_id: 't1', project_id: 'p1', command: 'claude', task_id: null });
    expect(repos.tabs.setAgentFields).toHaveBeenCalledWith('t1', { ai_account_id: 'a1' }); // the account swap knows who runs it

    const flat = await screenWith(app, out.tab_id, 'fake-cli args=');
    expect(flat).toContain('fake-cli args=1'); // the prompt is a single argument, not a command line
    // …and arrives exactly as it was sent, with the lessons reminder appended in the same argument (D13).
    expect(flat).toContain(`fake-cli prompt=[${flatten(withOriginReminder(withLessonsReminder(prompt)))}]`);
    expect(flat).toContain(`fake-cli cfg=${cfg}`); // the account chosen through CLAUDE_CONFIG_DIR
    expect(flat).toContain(`fake-cli cwd=${cwd}`); // the session runs in the project's directory
    // If the shell had split at `;` or run the substitution, the rest would have been executed.
    expect(flat).not.toContain('not found');

    await new Promise((r) => setTimeout(r, 0));
    const rows = apiTokens.recordEvent.mock.calls.map((c) => c[0]);
    expect(rows[0]).toMatchObject({ tool: 'start_agent', ok: true });
    // Metadata only (spec §3.1): the prompt is never stored, not even in the audit row.
    expect(JSON.stringify(rows)).not.toContain('XPTO');
  }, 30_000);

  it('keeps a prompt with newlines whole', async () => {
    const { app } = build(cwd);
    const prompt = 'linha um\nlinha dois';

    const out = payloadOf(await callTool(app, 'start_agent', { project_id: 'p1', account_id: 'a1', prompt }));
    const flat = await screenWith(app, out.tab_id, 'fake-cli args=');
    // The newline only makes the shell show its continuation prompt; the argument stays one, and the
    // lessons reminder (D13) still lands inside it, right after the user's own text.
    expect(flat).toContain('fake-cli args=1');
    expect(flat).toContain(`fake-cli prompt=[${flatten(withOriginReminder(withLessonsReminder(prompt)))}]`);
  }, 30_000);

  it("expands a config dir stored as ~/x on the machine, not here", async () => {
    const { app } = build(cwd);

    const out = payloadOf(await callTool(app, 'start_agent', { project_id: 'p1', account_id: 'a3', prompt: 'ola' }));
    const flat = await screenWith(app, out.tab_id, 'fake-cli args=');
    // Quoting the tilde along with the path made the CLI take "~" for a directory name: it started
    // logged out, in onboarding, and wrote its config into <cwd>/~/ instead of the account's dir.
    expect(flat).toContain(`fake-cli cfg=${cfg}`);
    expect(flat).not.toContain('fake-cli cfg=~');
  }, 30_000);

  describe('with MCP_URL set', () => {
    const cfg = config as { mcpUrl: string | null };
    const MCP_URL = 'https://termhub.test/mcp';
    let saved: string | null;
    beforeAll(() => {
      saved = cfg.mcpUrl;
      cfg.mcpUrl = MCP_URL;
    });
    afterAll(() => {
      cfg.mcpUrl = saved;
    });

    it('writes the tab config under $HOME (0700/0600) and starts claude with it, the prompt still one argument', async () => {
      const { app, apiTokens } = build(cwd);
      const prompt = `lição "X"; $(echo 9)`;

      const out = payloadOf(await callTool(app, 'start_agent', { project_id: 'p1', account_id: 'a1', prompt }));
      expect(out.note).toContain('A aba tem o MCP termhub_tab');
      const dir = join(home, '.termhub', 'tabs', out.tab_id);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(join(dir, 'mcp.json')).mode & 0o777).toBe(0o600);
      const written = JSON.parse(readFileSync(join(dir, 'mcp.json'), 'utf8'));
      const token = written.mcpServers.termhub_tab.headers.Authorization.replace('Bearer ', '');
      expect(token).toMatch(/^thb_pat_/);
      expect(written.mcpServers.termhub_tab.url).toBe(MCP_URL);
      expect(apiTokens.create).toHaveBeenCalledWith('u1', expect.objectContaining({ tabId: out.tab_id }), expect.any(String));

      const flat = await screenWith(app, out.tab_id, 'fake-cli toklen=');
      expect(flat).toContain(`fake-cli argv=[--mcp-config ${dir}/mcp.json --allowedTools mcp__termhub_tab__search_memory mcp__termhub_tab__record_lesson mcp__termhub_tab__get_automation_policy mcp__termhub_tab__report_card mcp__termhub_tab__get_card -- ${flatten(withOriginReminder(withLessonsReminder(prompt)))}]`);
      expect(flat).toContain(`fake-cli last=[${flatten(withOriginReminder(withLessonsReminder(prompt)))}]`);
      // the pane shows the typed line too: the token is in neither
      expect(flat).not.toContain(token);
      expect(JSON.stringify(out)).not.toContain(token);
    }, 30_000);

    it('writes the bare token file for codex (0600) and starts it with the -c overrides, the token in no typed line (TER-356)', async () => {
      const { app, apiTokens } = build(cwd);

      const out = payloadOf(await callTool(app, 'start_agent', { project_id: 'p1', account_id: 'a2', prompt: 'arrume o teste' }));
      expect(out.note).toContain('A aba tem o MCP termhub_tab');
      expect(apiTokens.create).toHaveBeenCalledWith('u1', expect.objectContaining({ tabId: out.tab_id }), expect.any(String));
      const dir = join(home, '.termhub', 'tabs', out.tab_id);
      expect(statSync(join(dir, 'token')).mode & 0o777).toBe(0o600);
      const token = readFileSync(join(dir, 'token'), 'utf8').trim();
      expect(token).toMatch(/^thb_pat_/);

      // the pane still shows the earlier tests' runs, each ending in its own `fake-cli toklen=`: wait for this one's
      const flat = await screenWith(app, out.tab_id, `fake-cli toklen=${token.length}`);
      expect(flat).toContain('mcp_servers.termhub_tab.bearer_token_env_var');
      expect(flat).not.toContain(token);
      expect(JSON.stringify(out)).not.toContain(token);
    }, 30_000);
  });

  it('starts codex under CODEX_HOME for a ChatGPT account', async () => {
    const { app } = build(cwd);

    const prompt = 'arrume o teste';
    const out = payloadOf(await callTool(app, 'start_agent', { project_id: 'p1', account_id: 'a2', prompt }));
    expect(out.command).toBe('codex');

    const flat = await screenWith(app, out.tab_id, 'fake-cli args=');
    // --no-alt-screen puts the transcript in the pane's history, where the wheel scrolls it (TER-465)
    expect(flat).toContain('fake-cli args=2');
    expect(flat).toContain('fake-cli prompt=[--no-alt-screen]');
    expect(flat).toContain(`fake-cli last=[${flatten(withLessonsReminder(prompt))}]`);
    expect(flat).toContain(`fake-cli cfg=${cfg}`);
  }, 30_000);
});
