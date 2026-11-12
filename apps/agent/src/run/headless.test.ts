import type { AgentMessage, RunOpenParams } from '@termhub/agent-protocol';
import { buildCodexExecArgs } from '@termhub/claude-cli';
import { GUARD_SCRIPT, GUARD_SCRIPT_REL } from '@termhub/machine-ops';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentSocket } from '../client.js';
import { createRunManager } from './headless.js';

/**
 * Every test runs a *fake* `claude` or `codex`: a shell script first on the run's PATH. Nothing here
 * spawns a real CLI, so these pass on a machine that never installed one, and in CI.
 */

const PROMPT = '-p não é uma flag aqui: liste os arquivos';

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-run-'));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

interface Fake {
  bin: string;
  out: string;
  runs: string;
  cwd: string;
  home: string;
}

function fakeCli(name: 'claude' | 'codex', body: (out: string) => string): Fake {
  const out = mkdtempSync(join(root, 'out-'));
  const bin = mkdtempSync(join(root, 'bin-'));
  const runs = mkdtempSync(join(root, 'runs-'));
  const cwd = mkdtempSync(join(root, 'cwd-'));
  const home = mkdtempSync(join(root, 'home-'));
  const script = join(bin, name);
  writeFileSync(script, `#!/bin/sh\n${body(out)}`);
  chmodSync(script, 0o755);
  return { bin, out, runs, cwd, home };
}

/** argv one per line, cwd, the config env vars, the files the argv points at, stdin; then two lines. */
const RECORDER = (out: string) => `printf '%s\\n' "$@" > ${out}/argv
pwd > ${out}/pwd
printf '%s' "\${CLAUDE_CONFIG_DIR-UNSET}" > ${out}/claude_cfg
printf '%s' "\${CODEX_HOME-UNSET}" > ${out}/codex_home
take=""
for a in "$@"; do
  if [ "$take" = mcp ]; then cat "$a" > ${out}/mcp.json; fi
  if [ "$take" = settings ]; then cat "$a" > ${out}/settings.json; fi
  take=""
  if [ "$a" = "--mcp-config" ]; then take=mcp; fi
  if [ "$a" = "--settings" ]; then take=settings; fi
done
cat > ${out}/stdin
echo '{"type":"first"}'
echo 'secret on stderr' >&2
printf '%s' '{"type":"last"}'
`;

function pathEnv(f: Fake, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { PATH: `${f.bin}:/usr/bin:/bin`, HOME: f.home, ...extra };
}

function makeSocket() {
  const sendControl = vi.fn();
  const sendStream = vi.fn();
  return { socket: { sendControl, sendStream } as AgentSocket, sendControl, sendStream };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(what: string, cond: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await sleep(20);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function controlOf(sendControl: ReturnType<typeof vi.fn>, type: AgentMessage['type']): AgentMessage | undefined {
  return sendControl.mock.calls.map(([msg]) => msg as AgentMessage).find((msg) => msg.type === type);
}

async function waitForClosed(sendControl: ReturnType<typeof vi.fn>, timeoutMs?: number): Promise<AgentMessage> {
  await waitFor('the closed control message', () => controlOf(sendControl, 'closed') !== undefined, timeoutMs);
  return controlOf(sendControl, 'closed') as AgentMessage;
}

function frames(sendStream: ReturnType<typeof vi.fn>): string[] {
  return sendStream.mock.calls.map(([, data]) => (data as Buffer).toString('utf8'));
}

function argvOf(out: string): string[] {
  return readFileSync(join(out, 'argv'), 'utf8').split('\n').slice(0, -1);
}

function dead(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`not a pid: ${pid}`);
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

function pidIn(file: string): number | null {
  if (!existsSync(file)) return null;
  const pid = Number(readFileSync(file, 'utf8').trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

const claudeRun = (f: Fake, over: Partial<RunOpenParams> = {}): RunOpenParams => ({
  provider: 'claude',
  config_dir: null,
  cwd: f.cwd,
  model: 'sonnet',
  tools: ['Read', 'Grep', 'Glob'],
  timeout_ms: 60_000,
  guard: null,
  ...over,
});

const codexRun = (f: Fake, over: Partial<RunOpenParams> = {}): RunOpenParams => ({
  provider: 'codex',
  config_dir: null,
  cwd: f.cwd,
  model: null,
  sandbox: 'read-only',
  timeout_ms: 60_000,
  guard: null,
  ...over,
});

describe('createRunManager', () => {
  it('claude: closed tool list, empty MCP config, prompt on stdin only, in the run folder', async () => {
    const f = fakeCli('claude', RECORDER);
    const { socket, sendControl, sendStream } = makeSocket();
    const runs = createRunManager({ log: vi.fn(), env: pathEnv(f, { CLAUDE_CONFIG_DIR: '/agent/own' }), tmpDir: f.runs });

    await runs.open(1, claudeRun(f), socket);
    expect(controlOf(sendControl, 'opened')).toEqual({ type: 'opened', ch: 1 });
    runs.write(1, Buffer.from(PROMPT));
    const closed = await waitForClosed(sendControl);

    expect(closed).toEqual({ type: 'closed', ch: 1, code: 0 });
    const argv = argvOf(f.out);
    expect(argv.slice(0, 6)).toEqual(['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--no-session-persistence']);
    expect(argv[argv.indexOf('--tools') + 1]).toBe('Read,Grep,Glob');
    expect(argv[argv.indexOf('--allowed-tools') + 1]).toBe('Read,Grep,Glob');
    expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('dontAsk');
    expect(argv).toContain('--strict-mcp-config');
    expect(argv).not.toContain('--settings');
    expect(argv).not.toContain(PROMPT);
    expect(JSON.parse(readFileSync(join(f.out, 'mcp.json'), 'utf8'))).toEqual({ mcpServers: {} });
    expect(readFileSync(join(f.out, 'stdin'), 'utf8')).toBe(PROMPT);
    expect(readFileSync(join(f.out, 'pwd'), 'utf8').trim()).toBe(realpathSync(f.cwd));
    // null is the machine's default login: the agent's own CLAUDE_CONFIG_DIR must not leak in.
    expect(readFileSync(join(f.out, 'claude_cfg'), 'utf8')).toBe('UNSET');
    // Lines in order, one per frame, with the unterminated last one flushed on exit.
    expect(frames(sendStream)).toEqual(['{"type":"first"}\n', '{"type":"last"}\n']);
    // The private dir is gone.
    expect(readdirSync(f.runs)).toEqual([]);
  });

  it('never puts stderr in a frame or in a log line', async () => {
    const f = fakeCli('claude', RECORDER);
    const { socket, sendControl, sendStream } = makeSocket();
    const log = vi.fn();
    const runs = createRunManager({ log, env: pathEnv(f), tmpDir: f.runs });

    await runs.open(1, claudeRun(f), socket);
    runs.write(1, Buffer.from(PROMPT));
    await waitForClosed(sendControl);

    expect(frames(sendStream).join('')).not.toContain('secret on stderr');
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret on stderr');
    expect(JSON.stringify(log.mock.calls)).not.toContain(PROMPT);
  });

  it('claude edit run: the guard settings for the branch and worktree, and the guard script installed', async () => {
    const f = fakeCli('claude', RECORDER);
    const { socket, sendControl } = makeSocket();
    const runs = createRunManager({ log: vi.fn(), env: pathEnv(f), tmpDir: f.runs });

    await runs.open(1, claudeRun(f, { tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write'], guard: { branch: 'run-abc', worktree: f.cwd } }), socket);
    runs.write(1, Buffer.from(PROMPT));
    await waitForClosed(sendControl);

    const settings = readFileSync(join(f.out, 'settings.json'), 'utf8');
    expect(settings).toContain('termhub-guard');
    expect(settings).toContain('run-abc');
    expect(readFileSync(join(f.home, GUARD_SCRIPT_REL), 'utf8')).toBe(GUARD_SCRIPT);
    expect(readdirSync(f.runs)).toEqual([]);
  });

  it('expands ~ in config_dir into CLAUDE_CONFIG_DIR / CODEX_HOME', async () => {
    const f = fakeCli('codex', RECORDER);
    const { socket, sendControl } = makeSocket();
    const runs = createRunManager({ log: vi.fn(), env: pathEnv(f), tmpDir: f.runs });

    await runs.open(1, codexRun(f, { config_dir: '~/.codex_work' }), socket);
    runs.write(1, Buffer.from(PROMPT));
    await waitForClosed(sendControl);

    expect(readFileSync(join(f.out, 'codex_home'), 'utf8')).toBe(join(f.home, '.codex_work'));
  });

  it('codex: the argv buildCodexExecArgs makes, prompt on stdin, no temp dir', async () => {
    const f = fakeCli('codex', RECORDER);
    const { socket, sendControl, sendStream } = makeSocket();
    const runs = createRunManager({ log: vi.fn(), env: pathEnv(f, { CODEX_HOME: '/agent/own' }), tmpDir: f.runs });

    await runs.open(2, codexRun(f, { sandbox: 'workspace-write', model: 'gpt-5.5' }), socket);
    runs.write(2, Buffer.from(PROMPT));
    expect(await waitForClosed(sendControl)).toEqual({ type: 'closed', ch: 2, code: 0 });

    expect(argvOf(f.out)).toEqual(buildCodexExecArgs({ cwd: f.cwd, sandbox: 'workspace-write', model: 'gpt-5.5' }));
    expect(readFileSync(join(f.out, 'stdin'), 'utf8')).toBe(PROMPT);
    expect(readFileSync(join(f.out, 'codex_home'), 'utf8')).toBe('UNSET');
    expect(frames(sendStream)).toEqual(['{"type":"first"}\n', '{"type":"last"}\n']);
    expect(readdirSync(f.runs)).toEqual([]);
  });

  it('ignores a second data frame', async () => {
    const f = fakeCli('codex', RECORDER);
    const { socket, sendControl } = makeSocket();
    const runs = createRunManager({ log: vi.fn(), env: pathEnv(f), tmpDir: f.runs });

    await runs.open(1, codexRun(f), socket);
    expect(runs.write(1, Buffer.from(PROMPT))).toBe(true);
    expect(runs.write(1, Buffer.from('more'))).toBe(true);
    await waitForClosed(sendControl);
    expect(readFileSync(join(f.out, 'stdin'), 'utf8')).toBe(PROMPT);
  });

  it('write answers false for a channel that is not a run', () => {
    const runs = createRunManager({ log: vi.fn() });
    expect(runs.write(42, Buffer.from('x'))).toBe(false);
  });

  it('close kills the whole process group and acks killed', async () => {
    const f = fakeCli('claude', (out) => `sleep 30 &
echo $! > ${out}/grandchild
echo $$ > ${out}/pid
cat > /dev/null
wait
`);
    const { socket, sendControl } = makeSocket();
    const runs = createRunManager({ log: vi.fn(), env: pathEnv(f), tmpDir: f.runs });

    await runs.open(1, claudeRun(f), socket);
    await waitFor('the fake pid', () => pidIn(join(f.out, 'pid')) !== null && pidIn(join(f.out, 'grandchild')) !== null);
    const pid = pidIn(join(f.out, 'pid')) as number;
    const grandchild = pidIn(join(f.out, 'grandchild')) as number;
    runs.close(1);

    expect(controlOf(sendControl, 'closed')).toEqual({ type: 'closed', ch: 1, code: null, reason: 'killed' });
    await waitFor('the run to die', () => dead(pid) && dead(grandchild));
    expect(readdirSync(f.runs)).toEqual([]);
  });

  it('kills a run past its deadline and closes it as timeout', async () => {
    const f = fakeCli('codex', (out) => `echo $$ > ${out}/pid
cat > /dev/null
exec sleep 30
`);
    const { socket, sendControl } = makeSocket();
    const runs = createRunManager({ log: vi.fn(), env: pathEnv(f), tmpDir: f.runs });

    // Below the protocol's 10 s floor on purpose: the manager trusts the parsed frame.
    await runs.open(1, codexRun(f, { timeout_ms: 300 }), socket);
    runs.write(1, Buffer.from(PROMPT));
    const closed = await waitForClosed(sendControl);

    expect(closed).toEqual({ type: 'closed', ch: 1, code: null, reason: 'timeout' });
    const pid = pidIn(join(f.out, 'pid'));
    if (pid) await waitFor('the run to die', () => dead(pid));
  });

  it('closes as run_failed when no prompt arrives', async () => {
    const f = fakeCli('codex', () => `cat > /dev/null\n`);
    const { socket, sendControl } = makeSocket();
    const runs = createRunManager({ log: vi.fn(), env: pathEnv(f), tmpDir: f.runs, promptTimeoutMs: 200 });

    await runs.open(1, codexRun(f), socket);
    expect(await waitForClosed(sendControl)).toEqual({ type: 'closed', ch: 1, code: null, reason: 'run_failed' });
  });

  it('names a usage limit on stderr usage_limit, and other failures run_failed', async () => {
    const limited = fakeCli('claude', () => `cat > /dev/null\necho "Claude AI usage limit reached|1760000000" >&2\nexit 1\n`);
    const a = makeSocket();
    const runsA = createRunManager({ log: vi.fn(), env: pathEnv(limited), tmpDir: limited.runs });
    await runsA.open(1, claudeRun(limited), a.socket);
    runsA.write(1, Buffer.from(PROMPT));
    expect(await waitForClosed(a.sendControl)).toEqual({ type: 'closed', ch: 1, code: 1, reason: 'usage_limit' });

    const broken = fakeCli('codex', () => `cat > /dev/null\necho "boom" >&2\nexit 2\n`);
    const b = makeSocket();
    const runsB = createRunManager({ log: vi.fn(), env: pathEnv(broken), tmpDir: broken.runs });
    await runsB.open(1, codexRun(broken), b.socket);
    runsB.write(1, Buffer.from(PROMPT));
    expect(await waitForClosed(b.sendControl)).toEqual({ type: 'closed', ch: 1, code: 2, reason: 'run_failed' });
  });

  it('closes as cli_missing on a machine without the CLI', async () => {
    const f = fakeCli('claude', () => 'exit 0\n');
    const { socket, sendControl } = makeSocket();
    const runs = createRunManager({ log: vi.fn(), env: pathEnv(f), tmpDir: f.runs });

    // Only `claude` is on this PATH: a codex run cannot find its CLI.
    await runs.open(1, codexRun(f), socket);
    expect(await waitForClosed(sendControl)).toEqual({ type: 'closed', ch: 1, code: null, reason: 'cli_missing' });
  });

  it('refuses a channel already in use', async () => {
    const f = fakeCli('codex', () => `cat > /dev/null\n`);
    const { socket, sendControl } = makeSocket();
    const runs = createRunManager({ log: vi.fn(), env: pathEnv(f), tmpDir: f.runs });

    await runs.open(1, codexRun(f), socket);
    await runs.open(1, codexRun(f), socket);
    expect(controlOf(sendControl, 'open_error')).toMatchObject({ type: 'open_error', ch: 1 });
    runs.closeAll();
  });

  it('closeAll kills every run without acking', async () => {
    const f = fakeCli('codex', (out) => `echo $$ > ${out}/pid\ncat > /dev/null\nexec sleep 30\n`);
    const { socket, sendControl } = makeSocket();
    const runs = createRunManager({ log: vi.fn(), env: pathEnv(f), tmpDir: f.runs });

    await runs.open(1, codexRun(f), socket);
    await waitFor('the fake pid', () => pidIn(join(f.out, 'pid')) !== null);
    const pid = pidIn(join(f.out, 'pid')) as number;
    runs.closeAll();

    expect(controlOf(sendControl, 'closed')).toBeUndefined();
    await waitFor('the run to die', () => dead(pid));
  });
});
