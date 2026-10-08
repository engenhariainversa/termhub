import {
  CLAUDE_DEFAULT_DIR,
  CODEX_HOOKS_REL,
  claudeDirsFromHome,
  configDirsFromRc,
  HOOK_ENV_REL,
  HOOK_HINT_REL,
  HOOK_MARK,
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
import { agentRpc, requireAgentVersion } from '../agent/errors.js';
import { tk } from '../i18n/index.js';
import { conflict } from '../lib/errors.js';
import type { Machine } from '../db/repositories/types.js';
import { REMOTE_PATH_PREFIX, runOnMachine, runOnMachineWithInput, shellQuote } from '../terminal/machine-exec.js';

/**
 * Installs the monitor hooks on a machine: a small POSIX script under ~/.termhub/bin that
 * forwards the tools' hook payloads to termhub, and the entries that make Claude Code, Codex
 * and the Cursor CLI call it. On ssh/local machines everything is written by one `sh -s` fed through
 * stdin; the Claude settings are read first and merged here (JSON), so nothing the user
 * configured is lost. Agent machines do the same through the `hooks.install` RPC (the agent
 * merges and writes the files itself, with the shared code in @termhub/machine-ops).
 */

/** First agent release that answers `hooks.install` / `hooks.uninstall`. */
export const HOOKS_MIN_AGENT_VERSION = '0.1.4';
/** First agent release that also hooks the accounts' own Claude config dirs (`claude_dirs`). */
export const HOOKS_CONFIG_DIRS_MIN_AGENT_VERSION = '0.1.5';

export interface HookInstallReport {
  home: string;
  claude: 'installed' | 'skipped';
  codex: 'installed' | 'skipped';
  /** `agent_outdated`: an agent older than 0.4.3 does not know the Cursor CLI yet */
  cursor: 'installed' | 'skipped' | 'agent_outdated';
  /** the Claude config dirs that got the entries ("~/.claude", "~/.claude_work", …) */
  claude_dirs: string[];
  hooks_url: string;
}

/** POSIX `sh -s` on the machine: local and remote take the same script on stdin. */
function shOnMachine(machine: Machine, script: string, timeoutMs = 20_000) {
  return runOnMachineWithInput(machine, { file: 'sh', args: ['-s'] }, `${REMOTE_PATH_PREFIX}sh -s`, Buffer.from(script, 'utf8'), timeoutMs);
}

const SEP = '__TERMHUB_SEP__';

/** A dir as a shell word: "~/x" stays relative to the machine's $HOME, "/abs" is quoted as is. */
const shDir = (d: string) => (d.startsWith('~/') ? `"$HOME"/${shellQuote(d.slice(2))}` : shellQuote(d));

/** `absent`: nothing there. `present`: a regular file we can read. `unreadable`: there, but not ours to read (no permission, a directory in its place, a dangling link). */
type FileStatus = 'absent' | 'present' | 'unreadable';

interface MachineConfigs {
  home: string;
  /** each Claude dir to hook, with whether it exists there and its current settings.json */
  claude: { dir: string; exists: boolean; status: FileStatus; settings: string }[];
  codexConfig: string;
  codexStatus: FileStatus;
  codexHooks: string;
  codexHooksStatus: FileStatus;
  hasCodex: boolean;
  cursorHooks: string;
  cursorStatus: FileStatus;
  hasCursor: boolean;
}

/**
 * One status word for a file, then its content. `cat … 2>/dev/null` alone answers the same empty
 * chunk for a file that is not there and for one we cannot read, and an install that takes the
 * second for the first writes a fresh file over what the person had. `file` is already a shell word.
 */
const probeFile = (file: string) =>
  `printf '${SEP}\\n'; if [ ! -e ${file} ] && [ ! -L ${file} ]; then echo absent; elif [ -f ${file} ] && [ -r ${file} ]; then echo present; else echo unreadable; fi; printf '${SEP}\\n'; cat ${file} 2>/dev/null`;

/** A word we do not know is read as `unreadable`: refusing is the side that loses nothing. */
const fileStatus = (chunk: string | undefined): FileStatus => {
  const word = (chunk ?? '').trim();
  return word === 'absent' || word === 'present' ? word : 'unreadable';
};

/** $HOME, the settings.json of each Claude dir, the Codex config and the Cursor hooks.json (each with whether it is absent, present or unreadable), in one round trip. */
async function readMachineConfigs(machine: Machine, claudeDirs: string[]): Promise<MachineConfigs> {
  const parts = [`printf '%s\\n' "$HOME"`];
  for (const d of claudeDirs) {
    parts.push(`printf '${SEP}\\n'; [ -d ${shDir(d)} ] && echo yes || echo no; ${probeFile(`${shDir(d)}/settings.json`)}; printf '\\n'`);
  }
  parts.push(`printf '${SEP}\\n'; [ -d "$HOME/.codex" ] && echo yes || echo no; ${probeFile('"$HOME/.codex/config.toml"')}; ${probeFile(`"$HOME/${CODEX_HOOKS_REL}"`)}`);
  parts.push(`printf '${SEP}\\n'; [ -d "$HOME/.cursor" ] && echo yes || echo no; ${probeFile('"$HOME/.cursor/hooks.json"')}`);
  // a missing file is part of the answer, not a failure: the last `cat` must not set the exit code
  const script = `${parts.join('; ')}; true`;
  const r = await runOnMachine(machine, { file: 'sh', args: ['-c', script] }, script);
  if (r.code !== 0) throw new Error(r.timedOut ? 'A máquina não respondeu a tempo' : 'Não foi possível ler a configuração da máquina');
  const chunks = r.stdout.split(`${SEP}\n`);
  const home = (chunks[0] ?? '').trim();
  if (!home.startsWith('/')) throw new Error('Não foi possível descobrir o $HOME da máquina');
  // three chunks per file: whether its dir is there, the status of the file, its content
  const claude = claudeDirs.map((dir, i) => ({
    dir,
    exists: (chunks[1 + i * 3] ?? '').trim() === 'yes',
    status: fileStatus(chunks[2 + i * 3]),
    settings: (chunks[3 + i * 3] ?? '').replace(/\n$/, ''),
  }));
  const base = 1 + claudeDirs.length * 3;
  return {
    home,
    claude,
    hasCodex: (chunks[base] ?? '').trim() === 'yes',
    codexStatus: fileStatus(chunks[base + 1]),
    codexConfig: chunks[base + 2] ?? '',
    codexHooksStatus: fileStatus(chunks[base + 3]),
    codexHooks: chunks[base + 4] ?? '',
    hasCursor: (chunks[base + 5] ?? '').trim() === 'yes',
    cursorStatus: fileStatus(chunks[base + 6]),
    cursorHooks: chunks[base + 7] ?? '',
  };
}

/** The files install would write over that are there but could not be read: writing would lose what the person has in them. */
function unreadableTargets(configs: MachineConfigs): string[] {
  const out: string[] = [];
  for (const c of configs.claude) {
    if ((c.dir === CLAUDE_DEFAULT_DIR || c.exists) && c.status === 'unreadable') out.push(`${c.dir}/settings.json`);
  }
  if (configs.hasCodex && configs.codexStatus === 'unreadable') out.push('~/.codex/config.toml');
  if (configs.hasCodex && configs.codexHooksStatus === 'unreadable') out.push('~/.codex/hooks.json');
  if (configs.hasCursor && configs.cursorStatus === 'unreadable') out.push('~/.cursor/hooks.json');
  return out;
}

/** Quoted heredoc: the body is taken literally; the delimiter never appears in what we write. */
const heredoc = (path: string, body: string) => `cat > ${path} <<'__TERMHUB_EOF__'\n${body.endsWith('\n') ? body : `${body}\n`}__TERMHUB_EOF__\n`;

/** Writes `body` over `file` through a temp file + mv (readers never see half a file). */
const replaceFile = (file: string, body: string) => [heredoc(shellQuote(`${file}.termhub-new`), body), `mv ${shellQuote(`${file}.termhub-new`)} ${shellQuote(file)}`];

/** The account dirs that are not the default one; agents need 0.1.5 to take them. */
function extraDirs(accountDirs: string[]): string[] {
  return claudeConfigDirs(accountDirs).filter((d) => d !== CLAUDE_DEFAULT_DIR);
}

/** The `.claude*` dirs of the home (with the marker files inside each) and the rc files, in one round trip. */
const DISCOVERY_SCRIPT = [
  `for d in "$HOME"/.claude*; do [ -d "$d" ] || continue; printf '%s' "\${d##*/}"; for m in settings.json projects .credentials.json; do [ -e "$d/$m" ] && printf '\\t%s' "$m"; done; printf '\\n'; done`,
  `printf '${SEP}\\n'`,
  `for f in .zshrc .bashrc .bash_profile .profile .config/fish/config.fish; do cat "$HOME/$f" 2>/dev/null; printf '\\n'; done`,
  'true',
].join('; ');

/**
 * The Claude config dirs the machine itself knows about, so a person who runs Claude Code through
 * a CLAUDE_CONFIG_DIR alias is hooked without registering anything. A machine that cannot answer
 * is not an error: we simply hook what was registered (the agent path does the same on its own).
 */
async function discoverOnMachine(machine: Machine): Promise<string[]> {
  let stdout: string;
  try {
    const r = await runOnMachine(machine, { file: 'sh', args: ['-c', DISCOVERY_SCRIPT] }, DISCOVERY_SCRIPT);
    if (r.code !== 0) return [];
    stdout = r.stdout;
  } catch {
    return [];
  }
  const [listing = '', rc = ''] = stdout.split(`${SEP}\n`);
  const entries = listing
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      const [name, ...files] = line.split('\t');
      return { name, files };
    });
  return [...claudeDirsFromHome(entries), ...configDirsFromRc(rc)];
}

/** Our entries merged into ~/.cursor/hooks.json, or null when the Cursor CLI is not on the machine. Refuses a file it cannot parse. */
function mergedCursorHooks(configs: MachineConfigs, scriptPath: string): string | null {
  if (!configs.hasCursor) return null;
  try {
    return mergeCursorHooks(configs.cursorHooks, scriptPath, '~/.cursor/hooks.json');
  } catch (err) {
    throw new Error(err instanceof SyntaxError || (err instanceof Error && err.message.includes('não é um objeto JSON')) ? '~/.cursor/hooks.json não é JSON válido' : err instanceof Error ? err.message : String(err));
  }
}

/** Our entries merged into ~/.codex/hooks.json, or null when Codex is not on the machine. Refuses a file it cannot parse. */
function mergedCodexHooks(configs: MachineConfigs, scriptPath: string): string | null {
  if (!configs.hasCodex) return null;
  try {
    return mergeCodexHooks(configs.codexHooks, scriptPath, '~/.codex/hooks.json');
  } catch (err) {
    throw new Error(err instanceof SyntaxError || (err instanceof Error && err.message.includes('não é um objeto JSON')) ? '~/.codex/hooks.json não é JSON válido' : err instanceof Error ? err.message : String(err));
  }
}

/** Uninstall steps for ~/.codex/hooks.json: our entries out, the file removed when nothing of the person is left; an unparseable file stays. */
function codexHooksUninstallSteps(configs: MachineConfigs): string[] {
  if (!configs.hasCodex || !configs.codexHooks.includes(HOOK_MARK)) return [];
  let stripped: string;
  try {
    stripped = stripCodexHooks(configs.codexHooks);
  } catch {
    return []; // unreadable JSON: leave the file alone
  }
  const file = `${configs.home}/${CODEX_HOOKS_REL}`;
  return isBareCodexHooks(stripped) ? [`rm -f ${shellQuote(file)}`] : replaceFile(file, stripped);
}

/** Our entries taken out of ~/.cursor/hooks.json, or null when there is nothing of ours to take (or the file cannot be parsed). */
function strippedCursorHooks(configs: MachineConfigs): string | null {
  if (!configs.hasCursor || !configs.cursorHooks.includes(HOOK_MARK)) return null;
  try {
    return stripCursorHooks(configs.cursorHooks);
  } catch {
    return null; // unreadable JSON: leave the file alone
  }
}

/** Writes what is left of hooks.json back, or removes the file when nothing of the person is left in it. */
function cursorUninstallSteps(home: string, stripped: string | null): string[] {
  if (stripped === null) return [];
  const file = `${home}/.cursor/hooks.json`;
  return isBareCursorHooks(stripped) ? [`rm -f ${shellQuote(file)}`] : replaceFile(file, stripped);
}

/**
 * `accountDirs`: config dirs of the Claude accounts registered for this machine (CLAUDE_CONFIG_DIR);
 * they get the entries too, besides ~/.claude, when they exist on the machine.
 */
export async function installHooks(machine: Machine, token: string, hooksUrl: string, accountDirs: string[] = []): Promise<HookInstallReport> {
  if (!/^https?:\/\/[^\s'"]+$/.test(hooksUrl)) throw new Error('HOOKS_URL inválida');
  const extra = extraDirs(accountDirs);
  if (machine.type === 'agent') {
    requireAgentVersion(machine, extra.length ? HOOKS_CONFIG_DIRS_MIN_AGENT_VERSION : HOOKS_MIN_AGENT_VERSION);
    const r = await agentRpc(machine, 'hooks.install', { hooks_url: hooksUrl, token, ...(extra.length ? { claude_dirs: extra } : {}) });
    return { home: r.home, claude: r.claude, codex: r.codex, cursor: r.cursor ?? 'agent_outdated', claude_dirs: r.claude_dirs ?? [CLAUDE_DEFAULT_DIR], hooks_url: hooksUrl };
  }
  const configs = await readMachineConfigs(machine, claudeConfigDirs([...accountDirs, ...(await discoverOnMachine(machine))]));
  const unreadable = unreadableTargets(configs);
  if (unreadable.length) throw new Error(`Não foi possível ler ${unreadable.join(', ')} na máquina; nada foi alterado`);
  const { home, claude, codexConfig, hasCodex } = configs;
  const scriptPath = `${home}/${HOOK_SCRIPT_REL}`;
  // ~/.claude is created when missing; an account's dir only when it is already there
  const targets = claude.filter((c) => c.dir === CLAUDE_DEFAULT_DIR || c.exists);
  const merged = targets.map((c) => {
    try {
      return { dir: c.dir, file: `${expandHome(c.dir, home)}/settings.json`, body: mergeClaudeSettings(c.settings, scriptPath, `${c.dir}/settings.json`) };
    } catch (err) {
      throw new Error(err instanceof SyntaxError || (err instanceof Error && err.message.includes('não é um objeto JSON')) ? `${c.dir}/settings.json não é JSON válido` : err instanceof Error ? err.message : String(err));
    }
  });
  const mergedCodex = hasCodex ? mergeCodexConfig(codexConfig, scriptPath) : null;
  const mergedCodexHooksBody = mergedCodexHooks(configs, scriptPath);
  const mergedCursor = mergedCursorHooks(configs, scriptPath);

  const q = shellQuote;
  const script = [
    'set -e',
    `mkdir -p "$HOME/.termhub/bin" "$HOME/.claude"`,
    `umask 077`,
    heredoc(q(`${home}/${HOOK_ENV_REL}`), hookEnvFile(hooksUrl, token)),
    `umask 022`,
    heredoc(q(scriptPath), HOOK_SCRIPT),
    `chmod 755 ${q(scriptPath)}`,
    ...merged.flatMap((m) => replaceFile(m.file, m.body)),
    ...(mergedCodex !== null ? replaceFile(`${home}/.codex/config.toml`, mergedCodex) : []),
    ...(mergedCodexHooksBody !== null ? replaceFile(`${home}/${CODEX_HOOKS_REL}`, mergedCodexHooksBody) : []),
    ...(mergedCursor !== null ? replaceFile(`${home}/.cursor/hooks.json`, mergedCursor) : []),
    'echo ok',
  ].join('\n');
  const r = await shOnMachine(machine, script);
  if (r.code !== 0 || !r.stdout.includes('ok')) throw new Error(r.timedOut ? 'A máquina não respondeu a tempo' : `Instalação falhou: ${r.stderr.trim().split('\n').pop() || 'erro desconhecido'}`);
  return {
    home,
    claude: 'installed',
    codex: mergedCodex !== null ? 'installed' : 'skipped',
    cursor: mergedCursor !== null ? 'installed' : 'skipped',
    claude_dirs: merged.map((m) => m.dir),
    hooks_url: hooksUrl,
  };
}

export async function uninstallHooks(machine: Machine, accountDirs: string[] = []): Promise<void> {
  const extra = extraDirs(accountDirs);
  if (machine.type === 'agent') {
    requireAgentVersion(machine, extra.length ? HOOKS_CONFIG_DIRS_MIN_AGENT_VERSION : HOOKS_MIN_AGENT_VERSION);
    await agentRpc(machine, 'hooks.uninstall', extra.length ? { claude_dirs: extra } : {});
    return;
  }
  const configs = await readMachineConfigs(machine, claudeConfigDirs([...accountDirs, ...(await discoverOnMachine(machine))]));
  const { home, claude, codexConfig, hasCodex } = configs;
  const strippedCursor = strippedCursorHooks(configs);
  const stripped: { file: string; body: string }[] = [];
  for (const c of claude) {
    if (!c.settings.trim()) continue;
    try {
      stripped.push({ file: `${expandHome(c.dir, home)}/settings.json`, body: stripClaudeSettings(c.settings) });
    } catch {
      // unreadable JSON: leave the file alone
    }
  }
  const q = shellQuote;
  const script = [
    'set -e',
    `rm -f ${q(`${home}/${HOOK_SCRIPT_REL}`)} ${q(`${home}/${HOOK_ENV_REL}`)} ${q(`${home}/${HOOK_HINT_REL}`)}`,
    ...stripped.flatMap((s) => replaceFile(s.file, s.body)),
    ...(hasCodex && codexConfig.includes(HOOK_MARK) ? replaceFile(`${home}/.codex/config.toml`, stripCodexConfig(codexConfig)) : []),
    ...codexHooksUninstallSteps(configs),
    ...cursorUninstallSteps(home, strippedCursor),
    'echo ok',
  ].join('\n');
  const r = await shOnMachine(machine, script);
  if (r.code !== 0 || !r.stdout.includes('ok')) throw new Error(r.timedOut ? 'A máquina não respondeu a tempo' : `Remoção falhou: ${r.stderr.trim().split('\n').pop() || 'erro desconhecido'}`);
}

/** First agent release that answers `hooks.hint` (TER-614). */
export const PERMISSION_HINT_MIN_AGENT_VERSION = '0.20.0';

/**
 * Writes or removes the machine's opt-in to permission hints (TER-614), ~/.termhub/permission-hint: the
 * file the hook script checks before it lets a Claude permission prompt travel whole. Throws when the
 * machine cannot be reached or refused, so the switch is only saved once the machine agrees with it.
 */
export async function setPermissionHintOnMachine(machine: Machine, enabled: boolean): Promise<void> {
  if (machine.type === 'agent') {
    requireAgentVersion(machine, PERMISSION_HINT_MIN_AGENT_VERSION);
    await agentRpc(machine, 'hooks.hint', { enabled });
    return;
  }
  const file = `"$HOME"/${shellQuote(HOOK_HINT_REL)}`;
  const script = enabled ? ['set -e', 'mkdir -p "$HOME/.termhub"', 'umask 077', `: > ${file}`, 'echo ok'] : ['set -e', `rm -f ${file}`, 'echo ok'];
  const r = await shOnMachine(machine, script.join('\n'));
  if (r.code !== 0 || !r.stdout.includes('ok')) throw conflict(tk('Não foi possível mudar a opção na máquina'));
}
