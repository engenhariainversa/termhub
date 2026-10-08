import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAiLogin } from './ai-login.js';

// Every tmux call goes to a private socket (TMUX_PATH wrapper, like tmux.real.test.ts) and every CLI is
// a fake script under a temp dir, called by absolute path: the real `claude` / `codex` logins and the
// real ~/.claude* / ~/.codex are never touched.
const SOCKET = `termhub-login-test-${process.pid}`;

const hasTmux = (() => {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const fakeClaude = (defaultDir: string) => `#!/bin/sh
dir="\${CLAUDE_CONFIG_DIR:-${defaultDir}}"
if [ "$1" = auth ] && [ "$2" = status ]; then
  if [ -f "$dir/logged-in" ]; then echo '{"loggedIn": true}'; exit 0; fi
  echo '{"loggedIn": false}'; exit 1
fi
if [ "$1" = auth ] && [ "$2" = login ]; then
  printf '%s' "\${CLAUDE_CONFIG_DIR-UNSET}" > "$dir/login-env"
  echo "Opening browser to sign in..."
  echo "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&state=x"
  printf 'Paste code here if prompted > '
  read code
  if [ "$code" = good-code ]; then touch "$dir/logged-in"; echo "Login successful."; exit 0; fi
  echo "Invalid code: $code"
  echo "OAuth error: invalid_grant"
  exit 1
fi
exit 2
`;

const fakeCodex = (defaultDir: string) => `#!/bin/sh
dir="\${CODEX_HOME:-${defaultDir}}"
if [ "$1" = login ] && [ "$2" = status ]; then
  if [ -f "$dir/logged-in" ]; then echo "Logged in using ChatGPT"; exit 0; fi
  echo "Not logged in"; exit 1
fi
if [ "$1" = login ] && [ "$2" = --device-auth ]; then
  echo "Welcome to Codex [v0.159.2]"
  echo "1. Open this link in your browser and sign in to your account"
  echo "   https://auth.openai.com/codex/device"
  echo "2. Enter this one-time code (expires in 15 minutes)"
  echo "   LCWQ-WSPV8"
  while [ ! -f "$dir/approve" ]; do sleep 0.1; done
  touch "$dir/logged-in"
  echo "Successfully logged in"
  exit 0
fi
exit 2
`;

const FAILING_CLAUDE = `#!/bin/sh
echo "error: network unreachable"
exit 1
`;

/** The machine's own browser took the callback before any URL was printed (TER-1054, macOS). */
const BROWSER_CLAUDE = (defaultDir: string) => `#!/bin/sh
dir="\${CLAUDE_CONFIG_DIR:-${defaultDir}}"
if [ "$1" = auth ] && [ "$2" = status ]; then
  if [ -f "$dir/logged-in" ]; then echo '{"loggedIn": true}'; exit 0; fi
  echo '{"loggedIn": false}'; exit 1
fi
echo "Opening browser to sign in…"
printf 'Paste code here if prompted > '
sleep 0.3
touch "$dir/logged-in"
echo "Login successful."
exit 0
`;

/** Prints the URL, then the machine's browser finishes the login on its own after a moment. */
const LATE_BROWSER_CLAUDE = (defaultDir: string) => `#!/bin/sh
dir="\${CLAUDE_CONFIG_DIR:-${defaultDir}}"
if [ "$1" = auth ] && [ "$2" = status ]; then
  if [ -f "$dir/logged-in" ]; then echo '{"loggedIn": true}'; exit 0; fi
  echo '{"loggedIn": false}'; exit 1
fi
echo "Opening browser to sign in…"
echo "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&state=y"
printf 'Paste code here if prompted > '
while [ ! -f "$dir/approve" ]; do sleep 0.1; done
touch "$dir/logged-in"
echo "Login successful."
exit 0
`;

/** Says it logged in, but its status never agrees. */
const LYING_CLAUDE = `#!/bin/sh
if [ "$1" = auth ] && [ "$2" = status ]; then echo '{"loggedIn": false}'; exit 1; fi
echo "Opening browser to sign in…"
echo "Login successful."
exit 0
`;

describe.skipIf(!hasTmux)('ai.login against a real tmux and fake CLIs', () => {
  let root: string;
  let bin: string;
  let defaultDir: string;
  let login: ReturnType<typeof createAiLogin>;
  const savedClaudeDir = process.env.CLAUDE_CONFIG_DIR;

  function script(name: string, body: string): string {
    const p = join(bin, name);
    writeFileSync(p, body);
    chmodSync(p, 0o755);
    return p;
  }

  function hasSession(session: string): boolean {
    try {
      execFileSync(process.env.TMUX_PATH!, ['has-session', '-t', `=${session}`], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  function accountDir(name: string): string {
    const d = join(root, name);
    mkdirSync(d);
    return d;
  }

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'termhub-ai-login-'));
    bin = join(root, 'bin');
    mkdirSync(bin);
    defaultDir = accountDir('default');
    const wrapper = join(bin, 'tmux');
    writeFileSync(wrapper, `#!/bin/sh\nexec tmux -L ${SOCKET} "$@"\n`);
    chmodSync(wrapper, 0o755);
    process.env.TMUX_PATH = wrapper;
    // Starts the private tmux server with a CLAUDE_CONFIG_DIR in its global environment: the default
    // login (config_dir null) must not inherit it.
    process.env.CLAUDE_CONFIG_DIR = join(root, 'leaked');
    login = createAiLogin({
      env: () => ({ ...process.env, HOME: root, PATH: `${bin}:/usr/bin:/bin` }),
      bins: { claude: script('claude', fakeClaude(defaultDir)), chatgpt: script('codex', fakeCodex(defaultDir)) },
      startPollMs: 100,
      startTimeoutMs: 10_000,
      submitPollMs: 100,
      submitTimeoutMs: 10_000,
    });
  });

  afterAll(() => {
    try {
      execFileSync('tmux', ['-L', SOCKET, 'kill-server'], { stdio: 'ignore' });
    } catch {
      /* no server to kill */
    }
    rmSync(root, { recursive: true, force: true });
    delete process.env.TMUX_PATH;
    if (savedClaudeDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = savedClaudeDir;
  });

  it('claude: start shows the URL, a good code logs in and the session goes away', async () => {
    const dir = accountDir('claude-good');
    const session = 'termhub-login-good';
    expect(await login.status({ provider: 'claude', config_dir: dir })).toEqual({ supported: true, logged_in: false });

    const started = await login.start({ provider: 'claude', config_dir: dir, session });
    expect(started).toEqual({ url: 'https://claude.com/cai/oauth/authorize?code=true&state=x', user_code: null, needs_code: true, logged_in: false });

    expect(await login.submit({ provider: 'claude', config_dir: dir, session, code: 'good-code' })).toEqual({ logged_in: true, message: null });
    expect(existsSync(join(dir, 'logged-in'))).toBe(true);
    expect(hasSession(session)).toBe(false);
    expect(await login.status({ provider: 'claude', config_dir: dir })).toEqual({ supported: true, logged_in: true });
  });

  it('claude: a bad code fails with the CLI message, never the code', async () => {
    const dir = accountDir('claude-bad');
    const session = 'termhub-login-bad';
    await login.start({ provider: 'claude', config_dir: dir, session });
    const r = await login.submit({ provider: 'claude', config_dir: dir, session, code: 'bad-code-123' });
    expect(r.logged_in).toBe(false);
    expect(r.message).toContain('invalid_grant');
    expect(r.message).not.toContain('bad-code-123');
    expect(hasSession(session)).toBe(false);
  });

  it('claude: the default login runs with CLAUDE_CONFIG_DIR unset', async () => {
    const session = 'termhub-login-default';
    await login.start({ provider: 'claude', config_dir: null, session });
    expect(await login.submit({ provider: 'claude', config_dir: null, session, code: 'good-code' })).toEqual({ logged_in: true, message: null });
    expect(execFileSync('cat', [join(defaultDir, 'login-env')], { encoding: 'utf8' })).toBe('UNSET');
    expect(await login.status({ provider: 'claude', config_dir: null })).toEqual({ supported: true, logged_in: true });
  });

  it('claude: a CLI that exits before the URL fails the start with its output', async () => {
    const failing = createAiLogin({
      env: () => ({ ...process.env, HOME: root, PATH: `${bin}:/usr/bin:/bin` }),
      bins: { claude: script('claude-failing', FAILING_CLAUDE), chatgpt: join(bin, 'codex') },
      startPollMs: 100,
      startTimeoutMs: 5_000,
    });
    const session = 'termhub-login-failing';
    await expect(failing.start({ provider: 'claude', config_dir: accountDir('claude-failing'), session })).rejects.toMatchObject({
      code: 'failed',
      message: 'error: network unreachable',
    });
    expect(hasSession(session)).toBe(false);
  });

  it('claude: a login the machine\'s browser finished before any URL is a login, not an error (TER-1054)', async () => {
    const dir = accountDir('claude-browser');
    const browser = createAiLogin({
      env: () => ({ ...process.env, HOME: root, PATH: `${bin}:/usr/bin:/bin` }),
      bins: { claude: script('claude-browser', BROWSER_CLAUDE(defaultDir)), chatgpt: join(bin, 'codex') },
      startPollMs: 100,
      startTimeoutMs: 5_000,
    });
    const session = 'termhub-login-browser';
    expect(await browser.start({ provider: 'claude', config_dir: dir, session })).toEqual({ url: null, user_code: null, needs_code: false, logged_in: true });
    expect(hasSession(session)).toBe(false);
  });

  it('claude: after the URL, the machine\'s browser finishing the login is seen by a submit without a code', async () => {
    const dir = accountDir('claude-late-browser');
    const late = createAiLogin({
      env: () => ({ ...process.env, HOME: root, PATH: `${bin}:/usr/bin:/bin` }),
      bins: { claude: script('claude-late-browser', LATE_BROWSER_CLAUDE(defaultDir)), chatgpt: join(bin, 'codex') },
      startPollMs: 100,
      startTimeoutMs: 5_000,
      submitPollMs: 100,
      submitTimeoutMs: 5_000,
    });
    const session = 'termhub-login-late-browser';
    const started = await late.start({ provider: 'claude', config_dir: dir, session });
    expect(started).toMatchObject({ needs_code: true, logged_in: false });
    writeFileSync(join(dir, 'approve'), '');
    expect(await late.submit({ provider: 'claude', config_dir: dir, session, code: null })).toEqual({ logged_in: true, message: null });
    expect(hasSession(session)).toBe(false);
  });

  it('claude: "Login successful" that the status never confirms is still a failure', async () => {
    const lying = createAiLogin({
      env: () => ({ ...process.env, HOME: root, PATH: `${bin}:/usr/bin:/bin` }),
      bins: { claude: script('claude-lying', LYING_CLAUDE), chatgpt: join(bin, 'codex') },
      startPollMs: 100,
      startTimeoutMs: 5_000,
    });
    await expect(lying.start({ provider: 'claude', config_dir: accountDir('claude-lying'), session: 'termhub-login-lying' })).rejects.toMatchObject({
      code: 'failed',
      message: 'Opening browser to sign in…\nLogin successful.',
    });
  }, 15_000);

  it('codex: device flow shows URL and code, a timed-out submit keeps the session, approval logs in', async () => {
    const dir = accountDir('codex');
    const session = 'termhub-login-codex';
    const started = await login.start({ provider: 'chatgpt', config_dir: dir, session });
    expect(started).toEqual({ url: 'https://auth.openai.com/codex/device', user_code: 'LCWQ-WSPV8', needs_code: false, logged_in: false });

    const impatient = createAiLogin({
      env: () => ({ ...process.env, HOME: root, PATH: `${bin}:/usr/bin:/bin` }),
      bins: { claude: join(bin, 'claude'), chatgpt: join(bin, 'codex') },
      submitPollMs: 100,
      submitTimeoutMs: 800,
    });
    expect(await impatient.submit({ provider: 'chatgpt', config_dir: dir, session, code: null })).toEqual({
      logged_in: false,
      message: 'Timed out waiting for the login to finish',
    });
    expect(hasSession(session)).toBe(true);

    writeFileSync(join(dir, 'approve'), '');
    expect(await login.submit({ provider: 'chatgpt', config_dir: dir, session, code: null })).toEqual({ logged_in: true, message: null });
    expect(hasSession(session)).toBe(false);
  });

  it('cancel kills the session; status of a missing CLI is notfound', async () => {
    const session = 'termhub-login-cancel';
    await login.start({ provider: 'chatgpt', config_dir: accountDir('codex-cancel'), session });
    expect(await login.cancel({ session })).toEqual({ cancelled: true });
    expect(await login.cancel({ session })).toEqual({ cancelled: false });

    const missing = createAiLogin({ env: () => ({ ...process.env, PATH: bin }), bins: { claude: join(root, 'nope', 'claude'), chatgpt: 'codex' } });
    await expect(missing.status({ provider: 'claude', config_dir: null })).rejects.toMatchObject({ code: 'notfound' });
  });
});
