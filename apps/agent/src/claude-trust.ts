import { readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CLAUDE_DEFAULT_DIR, claudeConfigDirs, expandHome } from '@termhub/machine-ops';
import { discoverClaudeDirs } from './claude-dirs.js';

/*
 * Claude Code's trust question ("Quick safety check: Is this a project you created or one you trust?")
 * comes before any hook in a folder it has not seen, so every new worktree of automatic work stopped on it
 * (TER-1025). The worktree is a folder termhub itself made for the run, so the agent marks it trusted in
 * every Claude config of this machine, the way Claude does when the person answers "Yes":
 * `projects[<folder>].hasTrustDialogAccepted` in the account's `.claude.json`. Claude Code 2.1.x checks the
 * git root of the session (the worktree) and does not take trust from a folder above a git repository, so
 * each worktree gets its own entry. Where this does not reach (an account set up later, a file Claude
 * rewrote meanwhile), the server answers the question on screen instead.
 */

/** A project entry as Claude Code writes a new one (2.1.x defaults), already trusted. */
const NEW_PROJECT = {
  allowedTools: [],
  mcpContextUris: [],
  mcpServers: {},
  enabledMcpjsonServers: [],
  disabledMcpjsonServers: [],
  hasTrustDialogAccepted: true,
  hasClaudeMdExternalIncludesApproved: false,
  hasClaudeMdExternalIncludesWarningShown: false,
};

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * The `.claude.json` of each Claude account here: `~/.claude.json` for the default one (`~/.claude`, no
 * CLAUDE_CONFIG_DIR), `<dir>/.claude.json` for every other config dir. Only files that exist: an account
 * Claude never started has no file, and creating one would look like a fresh install to it.
 */
export async function claudeConfigFiles(home: string): Promise<string[]> {
  const out: string[] = [];
  for (const d of claudeConfigDirs(await discoverClaudeDirs(home))) {
    const file = d === CLAUDE_DEFAULT_DIR ? path.join(home, '.claude.json') : path.join(expandHome(d, home), '.claude.json');
    if (out.includes(file)) continue;
    try {
      if ((await stat(file)).isFile()) out.push(file);
    } catch {
      // no such account here
    }
  }
  return out;
}

/**
 * Marks `keys` trusted in one config file. A file that is not a JSON object is never rewritten. Written to
 * a temporary file and renamed over the old one (Claude reads it at any time), with the old file's mode.
 * True when it changed.
 */
export async function trustIn(file: string, keys: string[]): Promise<boolean> {
  let cfg: unknown;
  try {
    cfg = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return false;
  }
  if (!isObject(cfg)) return false;
  if (!isObject(cfg.projects)) cfg.projects = {};
  const projects = cfg.projects as Record<string, unknown>;
  let dirty = false;
  for (const key of keys) {
    const entry = projects[key];
    if (isObject(entry) && entry.hasTrustDialogAccepted === true) continue;
    projects[key] = isObject(entry) ? { ...entry, hasTrustDialogAccepted: true } : { ...NEW_PROJECT };
    dirty = true;
  }
  if (!dirty) return false;
  const mode = (await stat(file)).mode & 0o777;
  const tmp = `${file}.termhub-${process.pid}-${Date.now()}`;
  await writeFile(tmp, `${JSON.stringify(cfg, null, 2)}\n`, { mode });
  await rename(tmp, file);
  return true;
}

/**
 * Marks a worktree termhub made trusted in every Claude account of this machine, under its path and, when
 * different, its real path (a symlinked home). Best effort: a file it cannot read or write is skipped, and
 * nothing here ever fails the worktree call. Returns how many files changed.
 */
export async function trustWorktree(dir: string, home: string): Promise<number> {
  const keys = [dir];
  const real = await realpath(dir).catch(() => dir);
  if (real !== dir) keys.push(real);
  let changed = 0;
  for (const file of await claudeConfigFiles(home).catch(() => [])) {
    if (await trustIn(file, keys).catch(() => false)) changed++;
  }
  return changed;
}
