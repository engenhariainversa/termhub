import type { AgentMessage, ClaudeOpenParams } from '@termhub/agent-protocol';
import { CAPABILITY_CLAUDE_STREAM_INPUT, CAPABILITY_CLAUDE_SYSTEM_PROMPT, HEADER_BYTES, MAX_FRAME, STREAM_END_INPUT_LINE } from '@termhub/agent-protocol';
import { buildClaudeArgs, mcpConfig } from '@termhub/claude-cli';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentSocket } from '../client.js';
import { CAPABILITIES } from '../run.js';
import { createClaudeManager } from './run.js';

/**
 * Every test here runs a *fake* `claude`: a shell script first on the run's PATH that reports what
 * it received (argv, `CLAUDE_CONFIG_DIR`, stdin, the MCP config it was pointed at). Nothing spawns
 * the real CLI — these must pass on a machine that has never installed it, and in CI.
 */

const TOKEN = `thb_pat_${'A'.repeat(43)}`;
const PROMPT = 'o que está rodando?';

const baseParams: ClaudeOpenParams = {
  session_id: '3f1e9b1e-0000-4000-8000-000000000001',
  resume: false,
  config_dir: null,
  mcp_url: 'https://termhub.dev/mcp',
  token: TOKEN,
  model: null,
};

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-claude-'));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

interface Fake {
  /** Directory holding the fake `claude`; goes first on the run's PATH. */
  bin: string;
  /** Where the fake writes what it saw. */
  out: string;
  /** The per-run private dir the manager creates its MCP config under. */
  runs: string;
}

function fakeCli(body: (out: string) => string): Fake {
  const out = mkdtempSync(join(root, 'out-'));
  const bin = mkdtempSync(join(root, 'bin-'));
  const runs = mkdtempSync(join(root, 'runs-'));
  const script = join(bin, 'claude');
  writeFileSync(script, `#!/bin/sh\n${body(out)}`);
  chmodSync(script, 0o755);
  return { bin, out, runs };
}

/** Reports argv, the config dir, the MCP config (contents and mode) and stdin, then prints one line.
 *  Every file is appended to and each run adds a line to `starts`, so a second CLI cannot hide
 *  behind a truncating `>`. */
const RECORDER = (out: string) => `echo started >> ${out}/starts
printf '%s\\n' "$@" >> ${out}/argv
printf '%s' "\${CLAUDE_CONFIG_DIR-UNSET}" >> ${out}/cfg
take=0
mcp=""
for a in "$@"; do
  if [ "$take" = 1 ]; then mcp="$a"; take=0; fi
  if [ "$a" = "--mcp-config" ]; then take=1; fi
done
cat "$mcp" >> ${out}/mcp.json
ls -l "$mcp" | cut -c1-10 >> ${out}/mcp.mode
cat >> ${out}/stdin
echo '{"type":"result","subtype":"success"}'
`;

/** PATH with the fake `claude` first and nothing on it but the binaries the fakes themselves need. */
function pathEnv(bin: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { PATH: `${bin}:/usr/bin:/bin`, ...extra };
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

async function waitForClosed(sendControl: ReturnType<typeof vi.fn>): Promise<AgentMessage> {
  await waitFor('the closed control message', () => controlOf(sendControl, 'closed') !== undefined);
  return controlOf(sendControl, 'closed') as AgentMessage;
}

/** One entry per channel frame the manager wrote, decoded as text. */
function frames(sendStream: ReturnType<typeof vi.fn>): string[] {
  return sendStream.mock.calls.map(([, data]) => (data as Buffer).toString('utf8'));
}

/** How many times the recorder fake was started. */
function startCount(out: string): number {
  return existsSync(join(out, 'starts')) ? readFileSync(join(out, 'starts'), 'utf8').split('\n').filter(Boolean).length : 0;
}

function argvOf(out: string): string[] {
  // The fake prints one argument per line; the trailing newline leaves an empty last element.
  return readFileSync(join(out, 'argv'), 'utf8').split('\n').slice(0, -1);
}

/** True once `pid` is gone. `process.kill(pid, 0)` throws ESRCH for a process that no longer exists. */
function dead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

describe('createClaudeManager', () => {
  it('spawns `claude` from the run PATH with the argv buildClaudeArgs produced, under the config dir it was given', async () => {
    const { bin, out, runs } = fakeCli(RECORDER);
    const { socket, sendControl } = makeSocket();
    const configDir = join(root, 'cfg-account');
    const claude = createClaudeManager({ log: vi.fn(), env: pathEnv(bin), tmpDir: runs });

    await claude.open(1, { ...baseParams, config_dir: configDir, model: 'sonnet' }, socket);
    claude.write(1, Buffer.from(PROMPT));
    await waitForClosed(sendControl);

    const argv = argvOf(out);
    const mcpPath = argv[argv.indexOf('--mcp-config') + 1];
    expect(argv).toEqual(buildClaudeArgs({ session_id: baseParams.session_id, resume: false, mcp_config_path: mcpPath, model: 'sonnet' }));
    expect(readFileSync(join(out, 'cfg'), 'utf8')).toBe(configDir);
    // The token reaches the CLI only through the config file, which is the run's alone to read…
    expect(readFileSync(join(out, 'mcp.json'), 'utf8')).toBe(mcpConfig(baseParams.mcp_url, TOKEN));
    expect(readFileSync(join(out, 'mcp.mode'), 'utf8').trim()).toBe('-rw-------');
    // …and does not outlive it.
    expect(readdirSync(runs)).toEqual([]);
  });

  it('forwards append_system_prompt from the open params onto the CLI argv, as its last flag pair', async () => {
    const { bin, out, runs } = fakeCli(RECORDER);
    const { socket, sendControl } = makeSocket();
    const claude = createClaudeManager({ log: vi.fn(), env: pathEnv(bin), tmpDir: runs });

    await claude.open(1, { ...baseParams, append_system_prompt: 'foco' }, socket);
    claude.write(1, Buffer.from(PROMPT));
    await waitForClosed(sendControl);

    expect(argvOf(out).slice(-2)).toEqual(['--append-system-prompt', 'foco']);
  });

  it('declares the claude system-prompt capability, without which the server refuses a project chat', () => {
    expect(CAPABILITIES).toContain(CAPABILITY_CLAUDE_SYSTEM_PROMPT);
  });

  it('does not leak this process own CLAUDE_CONFIG_DIR when config_dir is null', async () => {
    const { bin, out, runs } = fakeCli(RECORDER);
    const { socket, sendControl } = makeSocket();
    const claude = createClaudeManager({
      log: vi.fn(),
      env: pathEnv(bin, { CLAUDE_CONFIG_DIR: '/home/agent/.claude_operator' }),
      tmpDir: runs,
    });

    await claude.open(1, { ...baseParams, config_dir: null }, socket);
    claude.write(1, Buffer.from(PROMPT));
    await waitForClosed(sendControl);

    // `null` means "this machine's default account", which is not the same as the account the
    // agent process itself happens to be pointed at.
    expect(readFileSync(join(out, 'cfg'), 'utf8')).toBe('UNSET');
  });

  it('feeds the prompt in on stdin, byte for byte, and never through argv', async () => {
    for (const prompt of ['-rf --resume /etc/passwd', 'x'.repeat(100 * 1024)]) {
      const { bin, out, runs } = fakeCli(RECORDER);
      const { socket, sendControl } = makeSocket();
      const claude = createClaudeManager({ log: vi.fn(), env: pathEnv(bin), tmpDir: runs });

      await claude.open(1, baseParams, socket);
      expect(claude.write(1, Buffer.from(prompt))).toBe(true);
      // A channel this manager does not own is the pty manager's: the caller routes it there.
      expect(claude.write(9, Buffer.from('x'))).toBe(false);
      await waitForClosed(sendControl);

      expect(readFileSync(join(out, 'stdin'), 'utf8')).toBe(prompt);
      expect(argvOf(out)).not.toContain(prompt);
    }
  });

  it('sends one frame per stdout line, joining a line the CLI wrote in two pieces', async () => {
    const { bin, runs } = fakeCli(() => `printf 'hel'
sleep 0.4
printf 'lo\\n'
printf 'a\\nb\\n'
`);
    const { socket, sendControl, sendStream } = makeSocket();
    const claude = createClaudeManager({ log: vi.fn(), env: pathEnv(bin), tmpDir: runs });

    await claude.open(1, baseParams, socket);
    await waitForClosed(sendControl);

    // Not one frame per chunk: the split line arrives whole, and the chunk holding two lines
    // becomes two frames.
    expect(frames(sendStream)).toEqual(['hello\n', 'a\n', 'b\n']);
  });

  it('ends the channel with the CLI exit code: bare on a clean run, with run_failed on a bad one', async () => {
    const clean = fakeCli(() => `echo '{"type":"result"}'\n`);
    const cleanSocket = makeSocket();
    await createClaudeManager({ log: vi.fn(), env: pathEnv(clean.bin), tmpDir: clean.runs }).open(1, baseParams, cleanSocket.socket);
    expect(await waitForClosed(cleanSocket.sendControl)).toEqual({ type: 'closed', ch: 1, code: 0 });

    const failing = fakeCli(() => `echo 'Credit balance is too low' >&2\nexit 7\n`);
    const failSocket = makeSocket();
    await createClaudeManager({ log: vi.fn(), env: pathEnv(failing.bin), tmpDir: failing.runs }).open(4, baseParams, failSocket.socket);
    expect(await waitForClosed(failSocket.sendControl)).toEqual({ type: 'closed', ch: 4, code: 7, reason: 'run_failed' });
  });

  it('kills the whole run on close, leaving nothing of it alive on the machine', async () => {
    const { bin, out, runs } = fakeCli((o) => `echo $$ > ${o}/pid
sh -c 'echo $$ > ${o}/child-pid; exec sleep 30' &
echo '{"type":"result"}'
exec sleep 30
`);
    const { socket, sendControl } = makeSocket();
    const claude = createClaudeManager({ log: vi.fn(), env: pathEnv(bin), tmpDir: runs });

    await claude.open(2, baseParams, socket);
    await waitFor('the fake CLI and its own child to report their pids', () => existsSync(join(out, 'pid')) && existsSync(join(out, 'child-pid')));
    const pid = Number(readFileSync(join(out, 'pid'), 'utf8').trim());
    const childPid = Number(readFileSync(join(out, 'child-pid'), 'utf8').trim());

    claude.close(2);

    // Not "close() returned": the CLI and everything it started must be gone from this machine.
    await waitFor('the CLI process to die', () => dead(pid));
    await waitFor('the process the CLI started to die', () => dead(childPid));
    expect(await waitForClosed(sendControl)).toEqual({ type: 'closed', ch: 2, code: null, reason: 'killed' });
    expect(readdirSync(runs)).toEqual([]);
  }, 10_000);

  it('kills every run when the server connection drops, without acking a channel nobody holds', async () => {
    const { bin, out, runs } = fakeCli((o) => `echo $$ > ${o}/pid\nexec sleep 30\n`);
    const { socket, sendControl } = makeSocket();
    const claude = createClaudeManager({ log: vi.fn(), env: pathEnv(bin), tmpDir: runs });

    await claude.open(3, baseParams, socket);
    await waitFor('the fake CLI to report its pid', () => existsSync(join(out, 'pid')));
    const pid = Number(readFileSync(join(out, 'pid'), 'utf8').trim());

    claude.closeAll();

    await waitFor('the CLI process to die', () => dead(pid));
    expect(controlOf(sendControl, 'closed')).toBeUndefined();
    expect(readdirSync(runs)).toEqual([]);
  }, 10_000);

  it('kills a run that overstays its deadline and reports it as a failed run', async () => {
    const { bin, out, runs } = fakeCli((o) => `echo $$ > ${o}/pid\nexec sleep 30\n`);
    const { socket, sendControl } = makeSocket();
    const claude = createClaudeManager({ log: vi.fn(), env: pathEnv(bin), tmpDir: runs, timeoutMs: 300 });

    await claude.open(1, baseParams, socket);
    await waitFor('the fake CLI to report its pid', () => existsSync(join(out, 'pid')));
    const pid = Number(readFileSync(join(out, 'pid'), 'utf8').trim());

    expect(await waitForClosed(sendControl)).toMatchObject({ type: 'closed', ch: 1, reason: 'run_failed' });
    await waitFor('the CLI process to die', () => dead(pid));
    expect(readdirSync(runs)).toEqual([]);
  }, 10_000);

  it('reports a machine without the CLI as its own outcome, naming what is missing', async () => {
    const empty = mkdtempSync(join(root, 'no-cli-'));
    const runs = mkdtempSync(join(root, 'runs-'));
    const { socket, sendControl, sendStream } = makeSocket();
    const log = vi.fn();
    // Nothing but an empty dir on PATH: `claude` cannot be found, which is this feature's most
    // likely first failure on someone's machine.
    const claude = createClaudeManager({ log, env: { PATH: empty }, tmpDir: runs });

    await claude.open(1, baseParams, socket);

    expect(await waitForClosed(sendControl)).toEqual({ type: 'closed', ch: 1, code: null, reason: 'cli_missing' });
    expect(sendStream).not.toHaveBeenCalled();
    // A person reading the agent log must see *what* is missing, not just that something failed:
    // every line in this file starts with "claude", so the assertion is on one call saying both the
    // binary's name and that it was not found.
    const missingLine = log.mock.calls.find(([msg]) => /not found/i.test(String(msg)));
    expect(missingLine?.[0]).toMatch(/\bclaude\b/);
    expect(readdirSync(runs)).toEqual([]);
  });

  it('answers a channel already in use with open_error, without starting a second CLI', async () => {
    const { bin, out, runs } = fakeCli(RECORDER);
    const { socket, sendControl } = makeSocket();
    const claude = createClaudeManager({ log: vi.fn(), env: pathEnv(bin), tmpDir: runs });

    await claude.open(1, baseParams, socket);
    await claude.open(1, baseParams, socket);

    expect(sendControl).toHaveBeenCalledWith({ type: 'open_error', ch: 1, error: { code: 'invalid', message: 'channel in use' } });
    // The first CLI must have recorded its start before the close kills it: on a busy runner the
    // kill could land before its first line, and the count below would read 0.
    await waitFor('the first CLI to start', () => startCount(out) >= 1);
    claude.close(1);
    await waitForClosed(sendControl);
    // Counted, not merely "a file exists": the fake appends one line per start, so a second CLI
    // behind the refused open would show up here.
    expect(startCount(out)).toBe(1);
    expect(readdirSync(runs)).toEqual([]);
  });

  it('writes neither the prompt nor the token to any log line', async () => {
    const log = vi.fn();
    const ok = fakeCli(RECORDER);
    const okSocket = makeSocket();
    const okManager = createClaudeManager({ log, env: pathEnv(ok.bin), tmpDir: ok.runs });
    await okManager.open(1, baseParams, okSocket.socket);
    okManager.write(1, Buffer.from(PROMPT));
    await waitForClosed(okSocket.sendControl);

    const failing = fakeCli(() => `cat > /dev/null\necho "${PROMPT}" >&2\nexit 7\n`);
    const failSocket = makeSocket();
    const failManager = createClaudeManager({ log, env: pathEnv(failing.bin), tmpDir: failing.runs });
    await failManager.open(2, baseParams, failSocket.socket);
    failManager.write(2, Buffer.from(PROMPT));
    await waitForClosed(failSocket.sendControl);

    const missingSocket = makeSocket();
    const missing = createClaudeManager({ log, env: { PATH: mkdtempSync(join(root, 'no-cli-')) }, tmpDir: mkdtempSync(join(root, 'runs-')) });
    await missing.open(3, baseParams, missingSocket.socket);
    await waitForClosed(missingSocket.sendControl);

    // Spying the logger rather than reading the code: the CLI's stderr can carry the prompt back,
    // and argv is visible to every process on this machine, so both strings must be absent from
    // every line the handler writes — on the happy path and on both failures.
    expect(log).toHaveBeenCalled();
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).not.toContain(PROMPT);
    expect(logged).not.toContain(TOKEN);
  });
  it('kills the run outright when the agent itself is stopping, with no timer left to escalate', async () => {
    // Ignores SIGTERM and keeps running: only SIGKILL ends it. The agent's own shutdown (an
    // auto-update, on every machine, every release) calls `process.exit` right after closeAll, so a
    // run that needs the 2 s escalation timer would be orphaned on the person's laptop.
    const { bin, out, runs } = fakeCli((o) => `trap '' TERM
echo $$ > ${o}/pid
while :; do sleep 0.1; done
`);
    const { socket } = makeSocket();
    const claude = createClaudeManager({ log: vi.fn(), env: pathEnv(bin), tmpDir: runs });

    await claude.open(1, baseParams, socket);
    await waitFor('the fake CLI to report its pid', () => existsSync(join(out, 'pid')));
    const pid = Number(readFileSync(join(out, 'pid'), 'utf8').trim());

    claude.closeAll();

    // Well inside the escalation window: nothing but a SIGKILL sent by closeAll itself can have
    // killed a process that ignores SIGTERM this soon.
    await waitFor('the CLI process to die', () => dead(pid), 1_000);
    expect(readdirSync(runs)).toEqual([]);
  }, 10_000);

  it('reports a session the CLI cannot resume as missing_session, keeping the stderr on this machine', async () => {
    const { bin, runs } = fakeCli(() => `cat > /dev/null
echo 'No conversation found with session ID 3f1e9b1e-0000-4000-8000-000000000001' >&2
exit 1
`);
    const { socket, sendControl } = makeSocket();
    const log = vi.fn();
    const claude = createClaudeManager({ log, env: pathEnv(bin), tmpDir: runs });

    await claude.open(1, { ...baseParams, resume: true }, socket);
    claude.write(1, Buffer.from(PROMPT));

    // A local history the user pruned or rotated is not a broken conversation: the server retries
    // once on a fresh session when it hears this reason.
    expect(await waitForClosed(sendControl)).toEqual({ type: 'closed', ch: 1, code: 1, reason: 'missing_session' });
    // The label travelled; the text it was read from did not.
    expect(JSON.stringify(log.mock.calls)).not.toContain('No conversation found');
  });

  it('reports a CLI that refused our own flags as cli_rejected, not as a generic failed run', async () => {
    // The real complaint, on stderr, from a `claude` too old (or too new) for the argv we build. On
    // the user's own machine that is whatever version they installed, so this is no longer the rare
    // case it was on the pinned container image — and it is the one failure with an instruction
    // attached: collapsed into `run_failed` the person reads "the answer failed" and retries for ever.
    const { bin, runs } = fakeCli(() => `cat > /dev/null
echo 'Error: --session-id can only be used with --continue or --resume if --fork-session is also specified' >&2
exit 1
`);
    const { socket, sendControl } = makeSocket();
    const log = vi.fn();
    const claude = createClaudeManager({ log, env: pathEnv(bin), tmpDir: runs });

    await claude.open(1, { ...baseParams, resume: true }, socket);
    claude.write(1, Buffer.from(PROMPT));

    expect(await waitForClosed(sendControl)).toEqual({ type: 'closed', ch: 1, code: 1, reason: 'cli_rejected' });
    // The label travelled; the stderr it was read from stayed on this machine.
    expect(JSON.stringify(log.mock.calls)).not.toContain('--session-id can only be used');
  });

  it('drops a line too large for a frame instead of closing the machine whole socket', async () => {
    // 1.2 MB on one line: framed as-is it would trip the server's 1 MiB maxPayload and close the
    // socket with 1009, dropping every terminal on this machine along with the chat.
    const { bin, runs } = fakeCli(() => `head -c 1200000 /dev/zero | tr '\\0' x
printf '\\n'
echo '{"type":"result"}'
`);
    const { socket, sendControl, sendStream } = makeSocket();
    const log = vi.fn();
    const claude = createClaudeManager({ log, env: pathEnv(bin), tmpDir: runs });

    await claude.open(1, baseParams, socket);
    expect(await waitForClosed(sendControl)).toEqual({ type: 'closed', ch: 1, code: 0 });

    expect(frames(sendStream)).toEqual(['{"type":"result"}\n']);
    for (const [, data] of sendStream.mock.calls) expect((data as Buffer).length).toBeLessThanOrEqual(MAX_FRAME - HEADER_BYTES);
    expect(JSON.stringify(log.mock.calls)).toContain('too large');
  }, 10_000);

  it('does not sit on a live token when the prompt never arrives', async () => {
    const { bin, out, runs } = fakeCli((o) => `echo $$ > ${o}/pid\nexec sleep 30\n`);
    const { socket, sendControl } = makeSocket();
    const claude = createClaudeManager({ log: vi.fn(), env: pathEnv(bin), tmpDir: runs, promptTimeoutMs: 200 });

    await claude.open(1, baseParams, socket);
    await waitFor('the fake CLI to report its pid', () => existsSync(join(out, 'pid')));
    const pid = Number(readFileSync(join(out, 'pid'), 'utf8').trim());

    // The prompt follows the open by one frame in practice: a channel nobody writes to must not hold
    // the 0600 config — a live token — for the whole run deadline.
    expect(await waitForClosed(sendControl)).toEqual({ type: 'closed', ch: 1, code: null, reason: 'run_failed' });
    await waitFor('the CLI process to die', () => dead(pid));
    expect(readdirSync(runs)).toEqual([]);
  }, 10_000);

  it('declares the streamed-input capability', () => {
    expect(CAPABILITIES).toContain(CAPABILITY_CLAUDE_STREAM_INPUT);
  });

  it('in a streamed run keeps stdin open across writes, line by line, until the end-of-input line', async () => {
    const { bin, out, runs } = fakeCli(RECORDER);
    const { socket, sendControl } = makeSocket();
    const log = vi.fn();
    const claude = createClaudeManager({ log, env: pathEnv(bin), tmpDir: runs });

    await claude.open(1, { ...baseParams, stream_input: true }, socket);
    // The first message, then a second one split across two frames, then the end.
    claude.write(1, Buffer.from('{"type":"user","n":1}\n'));
    claude.write(1, Buffer.from('{"type":"user",'));
    claude.write(1, Buffer.from('"n":2}\n'));
    await sleep(100);
    // stdin is still open: the recorder is still in `cat`, so it has not printed its result.
    expect(controlOf(sendControl, 'closed')).toBeUndefined();
    claude.write(1, Buffer.from(`${STREAM_END_INPUT_LINE}\n`));
    await waitForClosed(sendControl);

    expect(readFileSync(join(out, 'stdin'), 'utf8')).toBe('{"type":"user","n":1}\n{"type":"user","n":2}\n');
    const argv = argvOf(out);
    expect(argv).toEqual(buildClaudeArgs({ session_id: baseParams.session_id, resume: false, mcp_config_path: argv[argv.indexOf('--mcp-config') + 1], model: null, stream_input: true }));
    // Nothing of what the lines said reaches a log.
    expect(JSON.stringify(log.mock.calls)).not.toContain('"n":2');
  });

  it('drops what arrives after the end-of-input line, logging only its size', async () => {
    const { bin, out, runs } = fakeCli(RECORDER);
    const { socket, sendControl } = makeSocket();
    const log = vi.fn();
    const claude = createClaudeManager({ log, env: pathEnv(bin), tmpDir: runs });

    await claude.open(1, { ...baseParams, stream_input: true }, socket);
    claude.write(1, Buffer.from(`{"a":1}\n${STREAM_END_INPUT_LINE}\n{"late":true}\n`));
    expect(claude.write(1, Buffer.from('{"later":true}\n'))).toBe(true);
    await waitForClosed(sendControl);

    expect(readFileSync(join(out, 'stdin'), 'utf8')).toBe('{"a":1}\n');
    expect(JSON.stringify(log.mock.calls)).not.toContain('late');
  });

  it('drops an input line over the cap to its very end, so its tail never reaches the CLI', async () => {
    const { bin, out, runs } = fakeCli(RECORDER);
    const { socket, sendControl } = makeSocket();
    const log = vi.fn();
    const claude = createClaudeManager({ log, env: pathEnv(bin), tmpDir: runs, maxPendingInputBytes: 16 });

    await claude.open(1, { ...baseParams, stream_input: true }, socket);
    claude.write(1, Buffer.from(`{"big":"${'segredo'.repeat(5)}`)); // over the cap, no newline yet
    claude.write(1, Buffer.from('rabo"}\n{"ok":1}\n'));
    claude.write(1, Buffer.from(`${STREAM_END_INPUT_LINE}\n`));
    await waitForClosed(sendControl);

    expect(readFileSync(join(out, 'stdin'), 'utf8')).toBe('{"ok":1}\n');
    // Sizes only: nothing the line said reaches a log.
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/segredo|rabo/);
    expect(log.mock.calls.some(([m]) => /too large/.test(m))).toBe(true);
  });

  it('keeps the one-shot run exactly as it was when stream_input is absent', async () => {
    const { bin, out, runs } = fakeCli(RECORDER);
    const { socket, sendControl } = makeSocket();
    const claude = createClaudeManager({ log: vi.fn(), env: pathEnv(bin), tmpDir: runs });

    await claude.open(1, baseParams, socket);
    claude.write(1, Buffer.from('linha sem quebra'));
    await waitForClosed(sendControl);
    expect(readFileSync(join(out, 'stdin'), 'utf8')).toBe('linha sem quebra');
    expect(argvOf(out)).not.toContain('--input-format');
  });
});
