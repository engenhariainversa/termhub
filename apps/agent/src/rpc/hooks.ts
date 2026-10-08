import { chmod, lstat, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RpcParams, RpcResult } from '@termhub/agent-protocol';
import {
  CLAUDE_DEFAULT_DIR,
  CODEX_HOOKS_REL,
  HOOK_ENV_REL,
  HOOK_HINT_REL,
  HOOK_MARK,
  GUARD_SCRIPT,
  GUARD_SCRIPT_REL,
  HOOK_SCRIPT,
  HOOK_SCRIPT_REL,
  claudeConfigDirs,
  expandHome,
  hookEnvFile,
  isBareCodexHooks,
  isBareCursorHooks,
  mergeClaudeSettings,
  mergeCodexConfig,
  mergeCodexHooks,
  mergeCursorHooks,
  stripClaudeSettings,
  stripCodexConfig,
  stripCodexHooks,
  stripCursorHooks,
} from '@termhub/machine-ops';
import { discoverClaudeDirs } from '../claude-dirs.js';
import { RpcFailure } from '../exec.js';

/**
 * Monitor hooks on this machine, written with node:fs (no shell): the forwarding script under
 * ~/.termhub/bin, its env file (url + token, 0600), our entries in the settings.json of each
 * Claude config dir (~/.claude, plus the accounts' own dirs that exist here) and, when Codex
 * or the Cursor CLI is installed, ~/.codex/config.toml and ~/.cursor/hooks.json. The merge/strip logic is the same the server uses for
 * ssh machines (@termhub/machine-ops), so both paths leave the files identical.
 */

const CODEX_DIR_REL = '.codex';
const CODEX_CONFIG_REL = '.codex/config.toml';
const CURSOR_DIR_REL = '.cursor';
const CURSOR_HOOKS_REL = '.cursor/hooks.json';

const isEnoent = (err: unknown) => (err as NodeJS.ErrnoException)?.code === 'ENOENT';

/** A symlink whose target is gone: `readFile` answers ENOENT for it, exactly as for a path with nothing there. */
async function isDanglingLink(file: string): Promise<boolean> {
  try {
    return (await lstat(file)).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * The file's content, or '' when nothing is there. A dangling symlink is not "nothing": writing to
 * that path would replace the link (one a dotfiles tool manages, say) by a plain file, so it is
 * reported as a failure, the same way the ssh/local probe answers `unreadable` for it.
 */
async function readOrEmpty(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8');
  } catch (err) {
    if (!isEnoent(err)) throw err;
    if (await isDanglingLink(file)) throw Object.assign(new Error('link simbólico quebrado'), { code: 'EDANGLING' });
    return '';
  }
}

async function isDir(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/** Same rename-over-temp the ssh path uses: readers never see a half-written settings file. */
async function writeAtomic(file: string, body: string, mode: number): Promise<void> {
  const tmp = `${file}.termhub-new`;
  await writeFile(tmp, body, { encoding: 'utf8', mode });
  await chmod(tmp, mode);
  await rename(tmp, file);
}

/** "~/x" → "x" (the RpcFailure path is home-relative when it can be); absolute paths stay. */
const relPath = (shown: string) => (shown.startsWith('~/') ? shown.slice(2) : shown);

/** Turns a filesystem error into an RpcFailure the server shows as-is; `shown` names what could not be written ("~/x" or "/abs"). */
function fsFailure(err: unknown, shown: string): RpcFailure {
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === 'EACCES' || code === 'EPERM') return new RpcFailure('eperm', `sem permissão em ${shown}`, relPath(shown));
  return new RpcFailure('failed', `não foi possível escrever ${shown}: ${err instanceof Error ? err.message : String(err)}`, relPath(shown));
}

/**
 * The read side of `fsFailure`: a file that is there but cannot be read, named so the person knows
 * which one. Always `failed`, the code whose message the server shows as it is: `eperm` is answered
 * with one fixed sentence about the folder, which would drop the name again.
 */
function readFailure(err: unknown, shown: string): RpcFailure {
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === 'EACCES' || code === 'EPERM') return new RpcFailure('failed', `sem permissão para ler ${shown}`, relPath(shown));
  return new RpcFailure('failed', `não foi possível ler ${shown}: ${err instanceof Error ? err.message : String(err)}`, relPath(shown));
}

/** `readOrEmpty` for install and uninstall: a missing file is empty, any other failure names the file. */
async function readNamed(file: string, shown: string): Promise<string> {
  try {
    return await readOrEmpty(file);
  } catch (err) {
    throw readFailure(err, shown);
  }
}

/** A Claude config dir to hook: how it is shown ("~/.claude") and its settings.json here. */
interface ClaudeTarget {
  dir: string;
  file: string;
  shown: string;
}

/**
 * ~/.claude always (created when missing); every other dir only when it exists here. Besides the
 * ones termhub registered, the machine's own config dirs are found here (see claude-dirs.ts), so a
 * person who runs Claude through a CLAUDE_CONFIG_DIR alias is hooked without configuring anything.
 */
async function claudeTargets(dirs: string[] | undefined, home: string): Promise<ClaudeTarget[]> {
  const out: ClaudeTarget[] = [];
  for (const d of claudeConfigDirs([...(dirs ?? []), ...(await discoverClaudeDirs(home))])) {
    const dir = expandHome(d, home);
    if (d !== CLAUDE_DEFAULT_DIR && !(await isDir(dir))) continue;
    out.push({ dir, file: path.join(dir, 'settings.json'), shown: `${d}/settings.json` });
  }
  return out;
}

/** Our entries merged into ~/.cursor/hooks.json, or null when the Cursor CLI is not here. Refuses a file it cannot parse, before anything is written. */
async function mergedCursorHooks(home: string, scriptPath: string): Promise<string | null> {
  if (!(await isDir(path.join(home, CURSOR_DIR_REL)))) return null;
  const current = await readNamed(path.join(home, CURSOR_HOOKS_REL), `~/${CURSOR_HOOKS_REL}`);
  try {
    return mergeCursorHooks(current, scriptPath, `~/${CURSOR_HOOKS_REL}`);
  } catch (err) {
    const message = err instanceof SyntaxError || (err instanceof Error && err.message.includes('não é um objeto JSON')) ? `~/${CURSOR_HOOKS_REL} não é JSON válido` : err instanceof Error ? err.message : String(err);
    throw new RpcFailure('failed', message, CURSOR_HOOKS_REL);
  }
}

/** Our entries merged into ~/.codex/hooks.json, or null when Codex is not here. Refuses a file it cannot parse, before anything is written. */
async function mergedCodexHooks(home: string, scriptPath: string): Promise<string | null> {
  if (!(await isDir(path.join(home, CODEX_DIR_REL)))) return null;
  const current = await readNamed(path.join(home, CODEX_HOOKS_REL), `~/${CODEX_HOOKS_REL}`);
  try {
    return mergeCodexHooks(current, scriptPath, `~/${CODEX_HOOKS_REL}`);
  } catch (err) {
    const message = err instanceof SyntaxError || (err instanceof Error && err.message.includes('não é um objeto JSON')) ? `~/${CODEX_HOOKS_REL} não é JSON válido` : err instanceof Error ? err.message : String(err);
    throw new RpcFailure('failed', message, CODEX_HOOKS_REL);
  }
}

export async function install(params: RpcParams<'hooks.install'>, home = os.homedir()): Promise<RpcResult<'hooks.install'>> {
  const scriptPath = path.join(home, HOOK_SCRIPT_REL);
  const codexFile = path.join(home, CODEX_CONFIG_REL);

  // every settings file is merged before anything is written: one bad file leaves the machine as it was
  const targets = await claudeTargets(params.claude_dirs, home);
  const merged: { target: ClaudeTarget; body: string }[] = [];
  for (const target of targets) {
    const current = await readNamed(target.file, target.shown);
    try {
      merged.push({ target, body: mergeClaudeSettings(current, scriptPath, target.shown) });
    } catch (err) {
      // Not a JSON object (or not JSON at all): refuse rather than clobber what the user has there.
      const message = err instanceof SyntaxError || (err instanceof Error && err.message.includes('não é um objeto JSON')) ? `${target.shown} não é JSON válido` : err instanceof Error ? err.message : String(err);
      throw new RpcFailure('failed', message, relPath(target.shown));
    }
  }
  const hasCodex = await isDir(path.join(home, CODEX_DIR_REL));
  const mergedCodex = hasCodex ? mergeCodexConfig(await readNamed(codexFile, `~/${CODEX_CONFIG_REL}`), scriptPath) : null;
  const mergedCodexHooksBody = await mergedCodexHooks(home, scriptPath);
  const mergedCursor = await mergedCursorHooks(home, scriptPath);

  let current = `~/${HOOK_SCRIPT_REL}`;
  try {
    await mkdir(path.dirname(scriptPath), { recursive: true });
    current = `~/${HOOK_ENV_REL}`;
    await writeAtomic(path.join(home, HOOK_ENV_REL), hookEnvFile(params.hooks_url, params.token), 0o600);
    current = `~/${HOOK_SCRIPT_REL}`;
    await writeAtomic(scriptPath, HOOK_SCRIPT, 0o755);
    // The hard-lock PreToolUse hook for automatic runs (TER-993). Written next to the monitor hook; a
    // run's launch line points `--settings` at it. Harmless on a machine that never runs automatic work.
    current = `~/${GUARD_SCRIPT_REL}`;
    await writeAtomic(path.join(home, GUARD_SCRIPT_REL), GUARD_SCRIPT, 0o755);
    current = `~/${HOOK_SCRIPT_REL}`;
    for (const { target, body } of merged) {
      current = target.shown;
      await mkdir(target.dir, { recursive: true });
      await writeAtomic(target.file, body, 0o644);
    }
    if (mergedCodex !== null) {
      current = `~/${CODEX_CONFIG_REL}`;
      await writeAtomic(codexFile, mergedCodex, 0o644);
    }
    if (mergedCodexHooksBody !== null) {
      current = `~/${CODEX_HOOKS_REL}`;
      await writeAtomic(path.join(home, CODEX_HOOKS_REL), mergedCodexHooksBody, 0o644);
    }
    if (mergedCursor !== null) {
      current = `~/${CURSOR_HOOKS_REL}`;
      await writeAtomic(path.join(home, CURSOR_HOOKS_REL), mergedCursor, 0o644);
    }
  } catch (err) {
    throw fsFailure(err, current);
  }
  return {
    home,
    claude: 'installed',
    codex: mergedCodex !== null ? 'installed' : 'skipped',
    cursor: mergedCursor !== null ? 'installed' : 'skipped',
    claude_dirs: merged.map(({ target }) => target.shown.replace(/\/settings\.json$/, '')),
  };
}

/**
 * Brings this machine's hooks back up to what this agent carries, reusing the url and token already
 * installed here: the forwarding script when the one on disk differs, and our entries wherever they
 * are missing — each Claude config dir, the Cursor CLI's hooks.json, Codex's notify. The agent calls
 * it on startup and on every reconnect, so a config dir or a CLI that showed up after the install
 * starts notifying on its own, and a script from an older agent is replaced. A machine without our
 * hooks is left untouched: installing is the server's call, not ours.
 *
 * Answers the dirs it repaired ("~/.claude-x", "~/.cursor", "~/.codex").
 */
export async function heal(home = os.homedir()): Promise<string[]> {
  const scriptPath = path.join(home, HOOK_SCRIPT_REL);
  const env = await readOrEmpty(path.join(home, HOOK_ENV_REL));
  const script = await readOrEmpty(scriptPath);
  if (!env.trim() || !script) return [];

  // The agent bundles the script, so an agent that updated itself can find an older one here while
  // the entries below already name the events only the new one handles — the script goes first, and
  // only when it really differs (same atomic 0o755 write `install` uses; comparing the content, not
  // a version, is what keeps every later change to the script reaching machines by itself).
  if (script !== HOOK_SCRIPT) await writeAtomic(scriptPath, HOOK_SCRIPT, 0o755);
  // The guard script (TER-993) ships with the agent too: bring it up to what this agent carries, so a
  // change to it reaches machines on the next reconnect, like the monitor hook above.
  const guardPath = path.join(home, GUARD_SCRIPT_REL);
  if ((await readOrEmpty(guardPath)) !== GUARD_SCRIPT) await writeAtomic(guardPath, GUARD_SCRIPT, 0o755);

  // One failing repair must not take the others down: a settings.json on a read-only mount, or one
  // owned by somebody else, would otherwise reject before Cursor and Codex are even looked at, and
  // the machine would go on missing their hooks at every reconnect - what heal exists to prevent.
  // Each step logs its own skips (deduped); the catch here is only a last resort so startup never dies.
  const steps = [healClaudeDirs, healCursor, healCodex];
  const healed: string[] = [];
  for (const step of steps) {
    try {
      healed.push(...(await step(home, scriptPath)));
    } catch {
      /* steps that still throw after their own handling */
    }
  }
  return healed;
}

/** Paths we already told the log about — heal runs on every reconnect (backoff ≥ 1s). */
const healSkipLogged = new Set<string>();

function logHealSkip(shown: string, err: unknown, key = shown): void {
  if (healSkipLogged.has(key)) return;
  healSkipLogged.add(key);
  const code = (err as NodeJS.ErrnoException)?.code;
  console.error(
    `[termhub-agent] monitor hooks heal skipped ${JSON.stringify({ path: shown, error: code ?? (err instanceof Error ? err.message : String(err)) })}`,
  );
}

/** Our entries in the Claude config dirs that lack them; answers the dirs it wrote. */
async function healClaudeDirs(home: string, scriptPath: string): Promise<string[]> {
  const healed: string[] = [];
  for (const dir of await discoverClaudeDirs(home)) {
    const file = path.join(expandHome(dir, home), 'settings.json');
    try {
      // read stays inside the try: EACCES / EISDIR on one dir must not abort the siblings
      const current = await readOrEmpty(file);
      const body = mergeClaudeSettings(current, scriptPath, `${dir}/settings.json`);
      if (body === current) continue;
      await writeAtomic(file, body, 0o644);
    } catch (err) {
      logHealSkip(dir, err, file);
      continue; // not a settings file we understand, or one we cannot write: leave it where it is
    }
    healed.push(dir);
  }
  return healed;
}

/**
 * Our entries back in ~/.cursor/hooks.json when the Cursor CLI is here and they are missing — it
 * was installed after the hooks, or Cursor rewrote a file its own UI manages. The merge keeps the
 * person's own hooks; a file it cannot parse is left alone.
 */
async function healCursor(home: string, scriptPath: string): Promise<string[]> {
  if (!(await isDir(path.join(home, CURSOR_DIR_REL)))) return [];
  const file = path.join(home, CURSOR_HOOKS_REL);
  const shown = `~/${CURSOR_DIR_REL}`;
  try {
    const current = await readOrEmpty(file);
    const body = mergeCursorHooks(current, scriptPath);
    if (body === current) return [];
    await writeAtomic(file, body, 0o644);
  } catch (err) {
    logHealSkip(shown, err, file);
    return []; // a file we cannot read or write: leave it where it is
  }
  return [shown];
}

/**
 * Codex, two independent repairs (one failing must not block the other): our entries in
 * ~/.codex/hooks.json when they are missing (the person's own hooks are kept; a file it cannot
 * parse is left alone), and our notify in ~/.codex/config.toml only when there is no notify at
 * all: Codex takes a single one, so a notify the person set for something else is theirs to keep,
 * and replacing it is the install's call (the machine form), never a silent repair on every start.
 * Answers "~/.codex" once when either was repaired.
 */
async function healCodex(home: string, scriptPath: string): Promise<string[]> {
  if (!(await isDir(path.join(home, CODEX_DIR_REL)))) return [];
  const shown = `~/${CODEX_DIR_REL}`;
  let healed = false;
  const hooksFile = path.join(home, CODEX_HOOKS_REL);
  try {
    const current = await readOrEmpty(hooksFile);
    const body = mergeCodexHooks(current, scriptPath, `~/${CODEX_HOOKS_REL}`);
    if (body !== current) {
      await writeAtomic(hooksFile, body, 0o644);
      healed = true;
    }
  } catch (err) {
    logHealSkip(shown, err, hooksFile);
  }
  const configFile = path.join(home, CODEX_CONFIG_REL);
  try {
    const current = await readOrEmpty(configFile);
    if (!/^\s*notify\s*=/m.test(current)) {
      await writeAtomic(configFile, mergeCodexConfig(current, scriptPath), 0o644);
      healed = true;
    }
  } catch (err) {
    logHealSkip(shown, err, configFile);
  }
  return healed ? [shown] : [];
}

export async function uninstall(params: RpcParams<'hooks.uninstall'>, home = os.homedir()): Promise<RpcResult<'hooks.uninstall'>> {
  const codexFile = path.join(home, CODEX_CONFIG_REL);

  const stripped: { target: ClaudeTarget; body: string }[] = [];
  for (const target of await claudeTargets(params.claude_dirs, home)) {
    const current = await readNamed(target.file, target.shown);
    try {
      const body = current.trim() ? stripClaudeSettings(current) : current;
      if (body !== current) stripped.push({ target, body });
    } catch {
      // unreadable JSON: leave the file alone
    }
  }
  const codexConfig = (await isDir(path.join(home, CODEX_DIR_REL))) ? await readNamed(codexFile, `~/${CODEX_CONFIG_REL}`) : '';
  const codexHooksFile = path.join(home, CODEX_HOOKS_REL);
  const codexHooks = (await isDir(path.join(home, CODEX_DIR_REL))) ? await readNamed(codexHooksFile, `~/${CODEX_HOOKS_REL}`) : '';
  let strippedCodexHooks: string | null = null;
  try {
    strippedCodexHooks = codexHooks.includes(HOOK_MARK) ? stripCodexHooks(codexHooks) : null;
  } catch {
    // unreadable JSON: leave the file alone
  }
  const cursorFile = path.join(home, CURSOR_HOOKS_REL);
  const cursorHooks = (await isDir(path.join(home, CURSOR_DIR_REL))) ? await readNamed(cursorFile, `~/${CURSOR_HOOKS_REL}`) : '';
  let strippedCursor: string | null = null;
  try {
    strippedCursor = cursorHooks.includes(HOOK_MARK) ? stripCursorHooks(cursorHooks) : null;
  } catch {
    // unreadable JSON: leave the file alone
  }

  let current = `~/${HOOK_SCRIPT_REL}`;
  try {
    await rm(path.join(home, HOOK_SCRIPT_REL), { force: true });
    current = `~/${HOOK_ENV_REL}`;
    await rm(path.join(home, HOOK_ENV_REL), { force: true });
    current = `~/${HOOK_HINT_REL}`;
    await rm(path.join(home, HOOK_HINT_REL), { force: true });
    for (const { target, body } of stripped) {
      current = target.shown;
      await writeAtomic(target.file, body, 0o644);
    }
    if (codexConfig.includes(HOOK_MARK)) {
      current = `~/${CODEX_CONFIG_REL}`;
      await writeAtomic(codexFile, stripCodexConfig(codexConfig), 0o644);
    }
    if (strippedCodexHooks !== null) {
      current = `~/${CODEX_HOOKS_REL}`;
      // nothing of the person is left in it: the file only exists because we created it
      if (isBareCodexHooks(strippedCodexHooks)) await rm(codexHooksFile, { force: true });
      else await writeAtomic(codexHooksFile, strippedCodexHooks, 0o644);
    }
    if (strippedCursor !== null) {
      current = `~/${CURSOR_HOOKS_REL}`;
      // nothing of the person is left in it: the file only exists because we created it
      if (isBareCursorHooks(strippedCursor)) await rm(cursorFile, { force: true });
      else await writeAtomic(cursorFile, strippedCursor, 0o644);
    }
  } catch (err) {
    throw fsFailure(err, current);
  }
  return { removed: true };
}

/**
 * The machine's opt-in to permission hints (TER-614): the file the hook script looks for before it lets
 * a Claude permission prompt travel whole. Empty, 0600; removing it is the way back to name-only prompts.
 */
export async function hint(params: RpcParams<'hooks.hint'>, home = os.homedir()): Promise<RpcResult<'hooks.hint'>> {
  const file = path.join(home, HOOK_HINT_REL);
  try {
    if (params.enabled) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeAtomic(file, '', 0o600);
    } else {
      await rm(file, { force: true });
    }
  } catch (err) {
    throw fsFailure(err, `~/${HOOK_HINT_REL}`);
  }
  return { enabled: params.enabled };
}
