import { homedir } from 'node:os';
import type { RpcParams, RpcResult } from '@termhub/agent-protocol';
import { resolveConfigDir } from '@termhub/claude-cli';
import { RpcFailure, agentEnv, run, tmuxPath } from '../exec.js';
import { ENTER_PAUSE_MS, processFailure } from './tmux.js';

/**
 * Re-login of a machine's Claude Code / Codex CLI from a modal (TER-1047, since agent 0.26.0). The CLI's
 * own login runs in a hidden tmux session the server names (`termhub-login-<id>`, never a work tab), under
 * the account's config dir. The agent reads the login URL (and Codex's device code) off the pane, types
 * the code the person pasted back, and asks the CLI's status command whether the login took.
 *
 * Nothing here is ever logged: the URL carries an OAuth state, the code is a credential, and the pane
 * text may hold either. The only text that goes back to the server is `failureMessage`, which drops
 * every line containing the submitted code.
 */

type LoginProvider = 'claude' | 'chatgpt';

interface CliSpec {
  /** The binary's name (or absolute path, in tests). */
  bin: string;
  /** The variable that points the CLI at an account's config dir. */
  envVar: 'CLAUDE_CONFIG_DIR' | 'CODEX_HOME';
  status: string[];
  login: string[];
  /** The CLI waits for a code pasted back (Claude); Codex's device flow polls on its own. */
  needsCode: boolean;
}

export interface AiLoginDeps {
  /** The environment the CLIs run with; the tmux session gets its PATH. */
  env: () => NodeJS.ProcessEnv;
  /** Binary per provider (`claude`, `codex`), resolved through that environment's PATH. */
  bins: Record<LoginProvider, string>;
  /** `ai.login.start`: how often and how long the pane is read for the URL. */
  startPollMs: number;
  startTimeoutMs: number;
  /** `ai.login.submit`: how often and how long the status is checked after the code went in. */
  submitPollMs: number;
  submitTimeoutMs: number;
}

const DEFAULT_DEPS: AiLoginDeps = {
  env: () => agentEnv(),
  bins: { claude: 'claude', chatgpt: 'codex' },
  startPollMs: 300,
  startTimeoutMs: 30_000,
  submitPollMs: 1_000,
  submitTimeoutMs: 45_000,
};

/** `claude auth status` / `codex login status` answer locally; a slow one is a stuck CLI. */
const STATUS_TIMEOUT_MS = 15_000;
/** Codex prints the URL a moment before the code: a couple more reads before giving up on the code. */
const CODE_EXTRA_POLLS = 3;
const MESSAGE_MAX_CHARS = 300;
/** Wide enough that the OAuth URL (a few hundred characters) never wraps. */
const PANE_WIDTH = '400';
const PANE_HEIGHT = '50';

const SUBMIT_TIMEOUT_MESSAGE = 'Timed out waiting for the login to finish';
const SESSION_GONE_MESSAGE = 'The login session ended before the login finished';

function spec(provider: RpcParams<'ai.login.status'>['provider'], deps: AiLoginDeps): CliSpec | null {
  if (provider === 'claude') return { bin: deps.bins.claude, envVar: 'CLAUDE_CONFIG_DIR', status: ['auth', 'status'], login: ['auth', 'login'], needsCode: true };
  if (provider === 'chatgpt') return { bin: deps.bins.chatgpt, envVar: 'CODEX_HOME', status: ['login', 'status'], login: ['login', '--device-auth'], needsCode: false };
  return null;
}

function requireSpec(provider: RpcParams<'ai.login.status'>['provider'], deps: AiLoginDeps): CliSpec {
  const s = spec(provider, deps);
  if (!s) throw new RpcFailure('invalid', `login of ${provider} is not supported on the machine`);
  return s;
}

/** The account's config dir with `~` expanded, or null for the machine's default login. */
function configDir(dir: string | null, env: NodeJS.ProcessEnv): string | null {
  return dir === null ? null : resolveConfigDir(dir, env.HOME || homedir());
}

/** The CLI's environment: the variable set to the account's dir, or removed so an inherited one can't stand in for the default login. */
function cliEnv(cli: CliSpec, dir: string | null, deps: AiLoginDeps): NodeJS.ProcessEnv {
  const env = { ...deps.env() };
  const resolved = configDir(dir, env);
  if (resolved === null) delete env[cli.envVar];
  else env[cli.envVar] = resolved;
  return env;
}

// ---------- pure parsing (unit-tested) ----------

/** `claude auth status` prints JSON with `loggedIn`; anything else reads as logged out. */
export function parseClaudeStatus(stdout: string): boolean {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (parsed && typeof parsed === 'object' && 'loggedIn' in parsed) return (parsed as { loggedIn: unknown }).loggedIn === true;
  } catch {
    /* not JSON: fall through to the text check */
  }
  return /"loggedIn"\s*:\s*true/.test(stdout);
}

/** `codex login status` exits 0 and says "Logged in using …" when logged in. Case matters: "Not logged in". */
export function parseCodexStatus(code: number | null, output: string): boolean {
  return code === 0 && /\bLogged in\b/.test(output);
}

/** The OAuth URL `claude auth login` prints ("If the browser didn't open, visit: https://…/oauth/authorize?…"). */
export function parseClaudeLoginScreen(text: string): { url: string | null } {
  const m = /https:\/\/\S*oauth\/authorize\S*/.exec(text);
  return { url: m ? m[0] : null };
}

/** The device page and one-time code `codex login --device-auth` prints. */
export function parseCodexLoginScreen(text: string): { url: string | null; userCode: string | null } {
  const url = /https:\/\/\S+/.exec(text);
  let userCode: string | null = null;
  for (const line of text.split('\n')) {
    const m = /^\s*([A-Z0-9]{4}-[A-Z0-9]{4,6})\s*$/.exec(line);
    if (m) {
      userCode = m[1];
      break;
    }
  }
  return { url: url ? url[0] : null, userCode };
}

/**
 * The last few meaningful lines of the pane, for an error the person reads. Drops every line that
 * contains `secret` (the submitted code: the CLI may echo it after its prompt), URLs (the OAuth state)
 * and tmux's own "Pane is dead" footer. Null when nothing is left.
 */
export function failureMessage(text: string, secret: string | null = null, maxChars = MESSAGE_MAX_CHARS): string | null {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .filter((l) => !(secret && l.includes(secret)))
    .filter((l) => !/https?:\/\//.test(l))
    .filter((l) => !/^Pane is dead\b/.test(l));
  const tail = lines.slice(-4).join('\n');
  if (!tail) return null;
  return tail.length > maxChars ? tail.slice(tail.length - maxChars) : tail;
}

// ---------- tmux helpers ----------

const pane = (session: string) => `=${session}:`;

async function tmux(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const r = await run(tmuxPath(), args);
  const failure = processFailure(r);
  if (failure) throw failure;
  return r;
}

async function killSession(session: string): Promise<boolean> {
  return (await tmux(['kill-session', '-t', `=${session}`])).code === 0;
}

/** The pane's text with wrapped lines joined, scrollback included; null when the session is gone. */
async function capturePane(session: string): Promise<string | null> {
  const r = await tmux(['capture-pane', '-p', '-J', '-S', '-200', '-t', pane(session)]);
  return r.code === 0 ? r.stdout : null;
}

/** 'alive', 'dead' (the CLI exited; the pane stays thanks to remain-on-exit) or 'gone' (no session). */
async function paneState(session: string): Promise<'alive' | 'dead' | 'gone'> {
  const r = await tmux(['display-message', '-p', '-t', pane(session), '#{pane_dead}']);
  if (r.code !== 0) return 'gone';
  return r.stdout.trim() === '1' ? 'dead' : 'alive';
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- handlers ----------

async function checkStatus(cli: CliSpec, dir: string | null, deps: AiLoginDeps): Promise<boolean> {
  const r = await run(cli.bin, cli.status, { env: cliEnv(cli, dir, deps), timeoutMs: STATUS_TIMEOUT_MS });
  if (r.error === 'enoent') throw new RpcFailure('notfound', `${cli.bin} not found on this machine`);
  if (r.timedOut) throw new RpcFailure('timeout', `${cli.bin} did not answer in time`);
  return cli.envVar === 'CLAUDE_CONFIG_DIR' ? parseClaudeStatus(r.stdout) : parseCodexStatus(r.code, `${r.stdout}\n${r.stderr}`);
}

export function createAiLogin(overrides: Partial<AiLoginDeps> = {}) {
  const deps: AiLoginDeps = { ...DEFAULT_DEPS, ...overrides };

  async function status(params: RpcParams<'ai.login.status'>): Promise<RpcResult<'ai.login.status'>> {
    const cli = spec(params.provider, deps);
    if (!cli) return { supported: false, logged_in: false };
    return { supported: true, logged_in: await checkStatus(cli, params.config_dir, deps) };
  }

  async function start(params: RpcParams<'ai.login.start'>): Promise<RpcResult<'ai.login.start'>> {
    const cli = requireSpec(params.provider, deps);
    const env = deps.env();
    const dir = configDir(params.config_dir, env);
    await killSession(params.session);

    // The variable goes in through `-e`; for the default login, `env -u` removes it, since the tmux
    // server's global environment (whatever shell first started it) could otherwise carry one in.
    // BROWSER=true: a CLI that tries to open a browser on the machine gets a no-op instead.
    const command = dir === null ? ['env', '-u', cli.envVar, cli.bin, ...cli.login] : [cli.bin, ...cli.login];
    // `remain-on-exit` rides in the same tmux invocation (`;` separates commands), so tmux applies it
    // before its event loop can notice the CLI exiting: a CLI that fails at once still leaves its
    // output on the pane for the error message. A second `set-option` call would race that exit.
    const created = await tmux([
      'new-session', '-d', '-s', params.session, '-x', PANE_WIDTH, '-y', PANE_HEIGHT, '-c', env.HOME || homedir(),
      '-e', `PATH=${env.PATH ?? ''}`,
      ...(dir === null ? [] : ['-e', `${cli.envVar}=${dir}`]),
      '-e', 'BROWSER=true',
      '--', ...command,
      ';', 'set-option', '-w', '-t', pane(params.session), 'remain-on-exit', 'on',
    ]);
    if (created.code !== 0) throw new RpcFailure('failed', created.stderr.trim().split('\n')[0] || 'tmux new-session failed');

    const deadline = Date.now() + deps.startTimeoutMs;
    let text = '';
    let extraPolls = 0;
    for (;;) {
      const state = await paneState(params.session);
      text = (await capturePane(params.session)) ?? text;
      if (cli.needsCode) {
        const { url } = parseClaudeLoginScreen(text);
        if (url) return { url: url.slice(0, 4000), user_code: null, needs_code: true };
      } else {
        const { url, userCode } = parseCodexLoginScreen(text);
        if (url && (userCode || extraPolls >= CODE_EXTRA_POLLS || state !== 'alive')) return { url: url.slice(0, 4000), user_code: userCode, needs_code: false };
        if (url) extraPolls++;
      }
      if (state !== 'alive' || Date.now() >= deadline) {
        await killSession(params.session);
        throw new RpcFailure('failed', failureMessage(text) ?? (state === 'alive' ? 'The login page did not show up in time' : SESSION_GONE_MESSAGE));
      }
      await sleep(deps.startPollMs);
    }
  }

  async function submit(params: RpcParams<'ai.login.submit'>): Promise<RpcResult<'ai.login.submit'>> {
    const cli = requireSpec(params.provider, deps);
    if (params.code !== null) {
      // `-l` types the code literally (no key names); Enter goes on its own after a pause, since a TUI
      // reads one burst of bytes as a paste. A session that is already gone is found by the loop below.
      const typed = await tmux(['send-keys', '-t', pane(params.session), '-l', '--', params.code]);
      if (typed.code === 0) {
        await sleep(ENTER_PAUSE_MS);
        await tmux(['send-keys', '-t', pane(params.session), 'Enter']);
      }
    }

    const deadline = Date.now() + deps.submitTimeoutMs;
    for (;;) {
      // The pane state is read before the status: a CLI that saved the login and exited in between
      // is then seen as logged in, never as a failure.
      const state = await paneState(params.session);
      let loggedIn = false;
      try {
        loggedIn = await checkStatus(cli, params.config_dir, deps);
      } catch (err) {
        if (!(err instanceof RpcFailure && err.code === 'timeout')) throw err;
      }
      if (loggedIn) {
        await killSession(params.session);
        return { logged_in: true, message: null };
      }
      if (state !== 'alive') {
        const text = state === 'dead' ? await capturePane(params.session) : null;
        await killSession(params.session);
        return { logged_in: false, message: (text && failureMessage(text, params.code)) || SESSION_GONE_MESSAGE };
      }
      if (Date.now() >= deadline) {
        // A Claude session already took its one paste: a second would land nowhere useful, so it goes.
        // Codex keeps polling on its own until its code expires, so its session stays for another submit.
        if (cli.needsCode) await killSession(params.session);
        return { logged_in: false, message: SUBMIT_TIMEOUT_MESSAGE };
      }
      await sleep(deps.submitPollMs);
    }
  }

  async function cancel(params: RpcParams<'ai.login.cancel'>): Promise<RpcResult<'ai.login.cancel'>> {
    return { cancelled: await killSession(params.session) };
  }

  return { status, start, submit, cancel };
}

const defaults = createAiLogin();
export const status = defaults.status;
export const start = defaults.start;
export const submit = defaults.submit;
export const cancel = defaults.cancel;
