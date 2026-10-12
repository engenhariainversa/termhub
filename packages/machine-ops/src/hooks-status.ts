/**
 * What the monitor hooks look like on a machine right now (TER-1023): for each CLI, whether it is
 * there, whether our entries are, and whether they match what an install would write today; for
 * Codex, whether the person trusted them. Pure: the agent (`hooks.status` RPC, node:fs) and the server
 * (ssh/local, one `sh -c` round trip) read the files their own way and both answer with this.
 *
 * Only states come out of here — never a file's content, the env file's token or a hook command.
 */

import { createHash } from 'node:crypto';
import { CODEX_HOOK_EVENTS, HOOK_MARK, HOOK_SCRIPT, mergeClaudeSettings, mergeCodexHooks, mergeCursorHooks } from './hooks.js';

/** `absent`: nothing there. `present`: a regular file we read. `unreadable`: there, but not ours to read. */
export type HookFileStatus = 'absent' | 'present' | 'unreadable';

export interface HookFile {
  status: HookFileStatus;
  /** the content when `present`; '' otherwise */
  content: string;
}

/**
 * Our entries in one config file. `missing`: none of ours. `outdated`: some, but not exactly what an
 * install writes now (an event added since, a changed timeout). `current`: exactly ours. `unreadable`:
 * the file is there and we cannot read or parse it — an install refuses it too.
 */
export type HookEntriesState = 'missing' | 'outdated' | 'current' | 'unreadable';

export interface HooksStatusInput {
  /** absolute path of the forwarding script on the machine (what the entries call) */
  scriptPath: string;
  /** ~/.termhub/bin/termhub-hook */
  script: HookFile;
  /** ~/.termhub/hook.env (url + token): only whether it is there and not empty is used */
  env: HookFile;
  /** each Claude config dir that exists on the machine ("~/.claude", …) with its settings.json */
  claude: { dir: string; settings: HookFile }[];
  /** null when ~/.codex is not there (Codex not installed) */
  codex: { config: HookFile; hooks: HookFile; hooksPath: string } | null;
  /** null when ~/.cursor is not there (Cursor CLI not installed) */
  cursor: { hooks: HookFile } | null;
}

export interface HooksStatus {
  /** the forwarding script: `version` is a short hash of the one on disk (null = not there) */
  script: { installed: boolean; version: string | null; expected_version: string; outdated: boolean };
  claude: { present: boolean; state: HookEntriesState; dirs: { dir: string; state: HookEntriesState }[] };
  /**
   * `notify`: our notify line in config.toml. `trusted`: how many of our hooks Codex has a trust
   * record for (`[hooks.state."…"] trusted_hash`) — `all`, `some` or `none`; null when ours are not
   * installed. Codex drops a trust when the hook changes; the hash itself is Codex's and not checked here.
   */
  codex: { present: boolean; state: HookEntriesState; notify: boolean; trusted: 'all' | 'some' | 'none' | null };
  cursor: { present: boolean; state: HookEntriesState };
}

/** Short, stable id of a script body: what `version` compares. */
export const hookScriptVersion = (body: string): string => createHash('sha256').update(body).digest('hex').slice(0, 12);

/** The version of the script this code installs. */
export const HOOK_SCRIPT_VERSION = hookScriptVersion(HOOK_SCRIPT);

const asObject = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** JSON with sorted keys, so two entries compare by meaning and not by key order. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = asObject(v);
  if (o) return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}

/** An entry is ours when one of its commands names our script (Claude/Codex `{ hooks: [{ command }] }`, Cursor `{ command }`). */
function isOurs(entry: unknown): boolean {
  const e = asObject(entry);
  if (!e) return false;
  if (typeof e.command === 'string') return e.command.includes(HOOK_MARK);
  return Array.isArray(e.hooks) && e.hooks.some((h) => typeof asObject(h)?.command === 'string' && (asObject(h)!.command as string).includes(HOOK_MARK));
}

/** event → our entries in it, canonical; null when the file is not a JSON object with a readable `hooks`. */
function ourEntries(body: string): Map<string, string[]> | null {
  if (!body.trim()) return new Map();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const file = asObject(parsed);
  if (!file) return null;
  if (file.hooks == null) return new Map();
  const hooks = asObject(file.hooks);
  if (!hooks) return Array.isArray(file.hooks) && file.hooks.length === 0 ? new Map() : null;
  const out = new Map<string, string[]>();
  for (const [event, list] of Object.entries(hooks)) {
    if (!Array.isArray(list)) continue;
    const ours = list.filter(isOurs).map(canonical);
    if (ours.length) out.set(event, ours);
  }
  return out;
}

/** How our entries in `file` compare with `expected` (what the merge writes into an empty file). */
function entriesState(file: HookFile, expected: string): HookEntriesState {
  if (file.status === 'unreadable') return 'unreadable';
  if (file.status === 'absent') return 'missing';
  const have = ourEntries(file.content);
  if (have === null) return 'unreadable';
  if (have.size === 0) return 'missing';
  const want = ourEntries(expected) ?? new Map<string, string[]>();
  if (have.size !== want.size) return 'outdated';
  for (const [event, entries] of want) {
    const got = have.get(event);
    if (!got || got.length !== entries.length || got.some((e, i) => e !== entries[i])) return 'outdated';
  }
  return 'current';
}

/** The worst of several dirs' states, for the CLI as a whole: one dir missing its entries is enough to say so. */
function worst(states: HookEntriesState[]): HookEntriesState {
  for (const s of ['unreadable', 'outdated', 'missing'] as const) if (states.includes(s)) return s;
  return states.length ? 'current' : 'missing';
}

/** "UserPromptSubmit" → "user_prompt_submit": how Codex names an event in its trust keys. */
const snake = (event: string) => event.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

/** The `[hooks.state."<key>"]` tables of config.toml that carry a `trusted_hash`. */
function trustedKeys(config: string): Set<string> {
  const out = new Set<string>();
  let current: string | null = null;
  for (const line of config.split('\n')) {
    const header = /^\s*\[\s*hooks\.state\.(?:"((?:[^"\\]|\\.)*)"|'([^']*)')\s*\]\s*$/.exec(line);
    if (header) {
      current = header[1] !== undefined ? header[1].replace(/\\(.)/g, '$1') : header[2];
      continue;
    }
    if (/^\s*\[/.test(line)) current = null;
    else if (current !== null && /^\s*trusted_hash\s*=\s*["']sha256:[^"']+["']/.test(line)) out.add(current);
  }
  return out;
}

/** How many of our Codex hooks carry a trust record: keys are "<hooks.json path>:<event>:<group>:<handler>". */
function codexTrust(hooksBody: string, hooksPath: string, config: string): 'all' | 'some' | 'none' {
  let hooks: Record<string, unknown> | null = null;
  try {
    hooks = asObject(asObject(JSON.parse(hooksBody))?.hooks);
  } catch {
    hooks = null;
  }
  const trusted = trustedKeys(config);
  let ours = 0;
  let ok = 0;
  for (const event of CODEX_HOOK_EVENTS) {
    const groups = hooks && Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
    groups.forEach((group, g) => {
      const handlers = asObject(group)?.hooks;
      if (!Array.isArray(handlers)) return;
      handlers.forEach((h, i) => {
        const command = asObject(h)?.command;
        if (typeof command !== 'string' || !command.includes(HOOK_MARK)) return;
        ours++;
        if (trusted.has(`${hooksPath}:${snake(event)}:${g}:${i}`)) ok++;
      });
    });
  }
  return ok === 0 ? 'none' : ok === ours ? 'all' : 'some';
}

export function hooksStatus(input: HooksStatusInput): HooksStatus {
  const scriptThere = input.script.status === 'present' && input.script.content.length > 0;
  const version = scriptThere ? hookScriptVersion(input.script.content) : null;
  const envThere = input.env.status === 'present' && input.env.content.trim().length > 0;
  const scriptOutdated = scriptThere && version !== HOOK_SCRIPT_VERSION;

  const claudeExpected = mergeClaudeSettings('', input.scriptPath);
  const dirs = input.claude.map((c) => ({ dir: c.dir, state: entriesState(c.settings, claudeExpected) }));

  let codex: HooksStatus['codex'] = { present: false, state: 'missing', notify: false, trusted: null };
  if (input.codex) {
    const state = entriesState(input.codex.hooks, mergeCodexHooks('', input.scriptPath));
    const config = input.codex.config.status === 'present' ? input.codex.config.content : '';
    const notify = config.split('\n').some((l) => /^\s*notify\s*=/.test(l) && l.includes(HOOK_MARK));
    const trusted = state === 'current' || state === 'outdated' ? codexTrust(input.codex.hooks.content, input.codex.hooksPath, config) : null;
    codex = { present: true, state, notify, trusted };
  }

  const cursor: HooksStatus['cursor'] = input.cursor ? { present: true, state: entriesState(input.cursor.hooks, mergeCursorHooks('', input.scriptPath)) } : { present: false, state: 'missing' };

  return {
    script: { installed: scriptThere && envThere, version, expected_version: HOOK_SCRIPT_VERSION, outdated: scriptOutdated },
    claude: { present: dirs.length > 0, state: worst(dirs.map((d) => d.state)), dirs },
    codex,
    cursor,
  };
}
