import { EXPAND_HOME } from './fs-script.js';
import { REMOTE_PATH_PREFIX, shellQuote } from './shell.js';

/**
 * Current rules as pinned ai-memory pages (TER-1019): the script that writes and deletes termhub's
 * `_rules/termhub-*.md` pages in one checkout through the local `ai-memory` CLI, which talks to the
 * ai-memory server at `AI_MEMORY_SERVER_URL` and resolves the ai-memory project from the cwd.
 */

/** The only pages termhub ever writes or deletes: `_rules/termhub-<slug>-<note id>.md`. The same regex
 *  lives in `@termhub/agent-protocol` (`AI_MEMORY_RULE_PATH_RE`), which this package cannot import. */
export const AI_MEMORY_RULE_PATH_RE = /^_rules\/termhub-[a-z0-9-]{1,40}-[A-Za-z0-9_-]{1,64}\.md$/;

/** The marker that says the person set ai-memory up for this checkout. termhub never creates it. */
export const AI_MEMORY_MARKER = '.ai-memory.toml';

export interface AiMemoryPageWrite {
  path: string;
  title: string;
  body: string;
}

export interface AiMemorySyncInput {
  cwd: string;
  server_url: string;
  writes: AiMemoryPageWrite[];
  deletes: string[];
}

function checkPath(path: string): string {
  if (!AI_MEMORY_RULE_PATH_RE.test(path)) throw new Error('caminho de página do ai-memory inválido');
  return path;
}

/**
 * awk program that sets `inject_on_session_start = true` in the marker's `[briefing]` section: replaces
 * the key when it is there (whatever its value), adds it at the end of the section when it is not, and
 * appends the whole section when the file has none. Every other line is kept as it is.
 */
export const BRIEFING_AWK = [
  'BEGIN { inb = 0; done = 0; seen = 0 }',
  '/^[ \\t]*\\[/ {',
  '  if (inb && !done) { print "inject_on_session_start = true"; done = 1 }',
  '  inb = ($0 ~ /^[ \\t]*\\[briefing\\][ \\t]*(#.*)?$/)',
  '  if (inb) seen = 1',
  '  print; next',
  '}',
  'inb && /^[ \\t]*inject_on_session_start[ \\t]*=/ {',
  '  if (!done) { print "inject_on_session_start = true"; done = 1 }',
  '  next',
  '}',
  '{ print }',
  'END {',
  '  if (inb && !done) { print "inject_on_session_start = true"; done = 1 }',
  '  if (!seen) { print ""; print "[briefing]"; print "inject_on_session_start = true" }',
  '}',
].join('\n');

/**
 * Shell snippet (cwd already the checkout): rewrites the marker with `BRIEFING_AWK` into a temp file and
 * copies it back only when something changed (`cat >` keeps the file's mode and a symlinked marker's
 * target). Prints `ok briefing` or `fail briefing`.
 */
const ENSURE_BRIEFING = [
  `t=$(mktemp "\${TMPDIR:-/tmp}/termhub-aim.XXXXXX") || t=''`,
  `if [ -n "$t" ] && awk ${shellQuote(BRIEFING_AWK)} ${AI_MEMORY_MARKER} > "$t" && { cmp -s "$t" ${AI_MEMORY_MARKER} || cat "$t" > ${AI_MEMORY_MARKER}; }; then echo 'ok briefing'; else echo 'fail briefing'; fi`,
  `[ -z "$t" ] || rm -f "$t"`,
].join('\n');

/**
 * POSIX sh, always exits 0; every value is `shellQuote`d here and each path must match
 * `AI_MEMORY_RULE_PATH_RE` (throws before anything runs otherwise). Steps, each reported on its own line:
 * `skip no_cwd` (cd failed), `skip no_binary` (`ai-memory` not on the PATH), `skip no_marker` (no
 * `.ai-memory.toml` in the checkout: the person did not set ai-memory up here, so nothing is touched);
 * then, only when there are writes, the briefing flag (`ok|fail briefing`); then one
 * `ok|fail write <path>` per write and one `ok|fail delete <path>` per delete. The CLI's own output
 * (stderr logs, `✓ wrote …`) is dropped. `parseAiMemorySync` reads the lines back.
 */
export function buildAiMemoryRulesScript(input: AiMemorySyncInput): string {
  const writes = input.writes.map((w) => ({ ...w, path: checkPath(w.path) }));
  const deletes = input.deletes.map(checkPath);
  const lines = [
    `P=${shellQuote(input.cwd)}`,
    EXPAND_HOME,
    `cd -- "$P" 2>/dev/null || { echo 'skip no_cwd'; exit 0; }`,
    REMOTE_PATH_PREFIX.trim(),
    `command -v ai-memory >/dev/null 2>&1 || { echo 'skip no_binary'; exit 0; }`,
    `[ -f ${AI_MEMORY_MARKER} ] || { echo 'skip no_marker'; exit 0; }`,
    `AI_MEMORY_SERVER_URL=${shellQuote(input.server_url)}; export AI_MEMORY_SERVER_URL`,
  ];
  if (writes.length > 0) lines.push(ENSURE_BRIEFING);
  for (const w of writes) {
    const p = shellQuote(w.path);
    lines.push(
      `printf '%s' ${shellQuote(w.body)} | ai-memory write-page --path=${p} --kind=rule --pinned --title=${shellQuote(w.title)} -t termhub --body - >/dev/null 2>&1 && echo 'ok write' ${p} || echo 'fail write' ${p}`,
    );
  }
  for (const d of deletes) {
    const p = shellQuote(d);
    lines.push(`ai-memory delete-page --path=${p} >/dev/null 2>&1 && echo 'ok delete' ${p} || echo 'fail delete' ${p}`);
  }
  lines.push('exit 0');
  return lines.join('\n');
}

export type AiMemorySkip = 'no_cwd' | 'no_binary' | 'no_marker';

export interface AiMemorySyncOutcome {
  /** Why nothing ran, or null. */
  skip: AiMemorySkip | null;
  /** `ok` / `fail` of the briefing flag, null when it was not attempted. */
  briefing: 'ok' | 'fail' | null;
  written: string[];
  deleted: string[];
  failed: number;
}

/** Reads `buildAiMemoryRulesScript`'s stdout back. Unknown lines (and paths outside termhub's own) are ignored. */
export function parseAiMemorySync(stdout: string): AiMemorySyncOutcome {
  const out: AiMemorySyncOutcome = { skip: null, briefing: null, written: [], deleted: [], failed: 0 };
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (line === 'skip no_cwd' || line === 'skip no_binary' || line === 'skip no_marker') {
      out.skip = line.slice(5) as AiMemorySkip;
      continue;
    }
    if (line === 'ok briefing' || line === 'fail briefing') {
      out.briefing = line === 'ok briefing' ? 'ok' : 'fail';
      continue;
    }
    const m = /^(ok|fail) (write|delete) (\S+)$/.exec(line);
    if (!m || !AI_MEMORY_RULE_PATH_RE.test(m[3]!)) continue;
    if (m[1] === 'fail') out.failed++;
    else if (m[2] === 'write') out.written.push(m[3]!);
    else out.deleted.push(m[3]!);
  }
  return out;
}

/**
 * ai-memory on a machine (TER-1018): is the binary there, its version, and does its local server
 * answer. The script prints tags only (`BIN:`, `VERSION:`, `STATUS:`, `SERVER:`), never what
 * `ai-memory status` writes: nothing ai-memory stores may leave the machine.
 *
 * - `STATUS:ok|fail`: exit code of `ai-memory status`, cut after 4 s.
 * - `SERVER:up|down|unknown`: any HTTP answer at the configured URL counts as up (curl, 3 s);
 *   `unknown` when the machine has no curl, then `STATUS` decides.
 *
 * `quotedUrl` must already be shell-quoted (`shellQuote`) and validated as a loopback or private origin.
 */
export function buildAiMemoryStatusScript(quotedUrl: string): string {
  return [
    'command -v ai-memory >/dev/null 2>&1 || { echo BIN:no; exit 0; }',
    'echo BIN:yes',
    'echo "VERSION:$(ai-memory --version 2>/dev/null | head -n 1)"',
    'ai-memory status >/dev/null 2>&1 </dev/null & p=$!',
    '{ sleep 4; kill $p 2>/dev/null; } >/dev/null 2>&1 & w=$!',
    'if wait $p; then echo STATUS:ok; else echo STATUS:fail; fi',
    'kill $w 2>/dev/null',
    'if command -v curl >/dev/null 2>&1; then',
    `  c=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 ${quotedUrl} 2>/dev/null)`,
    '  case "$c" in ""|000) echo SERVER:down ;; *) echo SERVER:up ;; esac',
    'else echo SERVER:unknown; fi',
    'exit 0',
  ].join('\n');
}

export interface AiMemoryProbe {
  installed: boolean;
  /** `2.6.0` out of `ai-memory 2.6.0`; null when the binary does not say */
  version: string | null;
  server_up: boolean;
}

const VERSION_RE = /\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?/;

export function parseAiMemoryStatus(stdout: string): AiMemoryProbe {
  let installed = false;
  let version: string | null = null;
  let status = false;
  let server: 'up' | 'down' | 'unknown' = 'unknown';
  for (const raw of stdout.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line === 'BIN:yes') installed = true;
    else if (line.startsWith('VERSION:')) version = VERSION_RE.exec(line.slice(8))?.[0].slice(0, 32) ?? null;
    else if (line === 'STATUS:ok') status = true;
    else if (line === 'SERVER:up') server = 'up';
    else if (line === 'SERVER:down') server = 'down';
  }
  if (!installed) return { installed: false, version: null, server_up: false };
  return { installed, version, server_up: server === 'unknown' ? status : server === 'up' };
}

/**
 * Reading what an agent wrote on purpose into ai-memory (TER-1021, spike TER-1008): the machine-side
 * half. ai-memory keeps one markdown wiki per machine (`<data_dir>/wiki/`), one directory per project
 * (optionally under a workspace directory), and its page families are directories: `_rules/`,
 * `gotchas/`, `decisions/` hold pages someone wrote deliberately, while `sessions/`, observations
 * (SQLite, never in the wiki) and handoffs hold captured tool and terminal output. Only the three
 * deliberate families are ever read here — the rest of the wiki never leaves the machine.
 */

/** The page families that are read (spike TER-1008: "never `sessions/`, observations or handoffs"). */
export const AI_MEMORY_FAMILIES = ['_rules', 'gotchas', 'decisions'] as const;
/** At most this many pages per call, the first by project directory, family and name. */
export const AI_MEMORY_MAX_PAGES = 50;
/** A page larger than this is skipped (a deliberate rule/gotcha/decision page is short). */
export const AI_MEMORY_PAGE_MAX_BYTES = 64 * 1024;
/** Cumulative raw bytes per call: the result travels as one agent control frame (≤ 1 MiB), the same
 *  budget and reasoning as `DOCS_READ_MAX_BYTES` (base64 + JSON escaping stay well under the frame). */
export const AI_MEMORY_MAX_BYTES = 600 * 1024;

/**
 * A page path relative to the wiki: `[<workspace>/]<project>/<family>/<name>.md`, one name segment per
 * level, never `.`/`..` (checked separately in `isAiMemoryPagePath`).
 */
export const AI_MEMORY_PAGE_RE = /^(?:[A-Za-z0-9._-]{1,100}\/)?[A-Za-z0-9._-]{1,100}\/(?:_rules|gotchas|decisions)\/[A-Za-z0-9._-]{1,200}\.md$/;

export function isAiMemoryPagePath(path: string): boolean {
  return AI_MEMORY_PAGE_RE.test(path) && !path.split('/').some((s) => s === '.' || s === '..');
}

/** One page as the script reports it: `path` relative to the wiki, the file's sha256 and its text. */
export interface AiMemoryPage {
  path: string;
  sha256: string;
  text: string;
}

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const SIZE_RE = /^\d+$/;

/**
 * POSIX sh, portable to Linux and macOS; always exits 0. From the project's checkout (`cwd`):
 *
 * 1. The ai-memory project name: `project = "…"` in the checkout's `.ai-memory.toml` marker, else the
 *    main repository root's directory name (so a linked worktree maps to the same project, as
 *    ai-memory's own `repo-root` strategy does), else the cwd's basename. A name outside
 *    `A-Za-z0-9._-` is refused (`ERR:noproject`).
 * 2. The data dir: `data_dir` from `ai-memory status --json` when the binary is on `PATH` (a few
 *    usual install dirs added), else `$AI_MEMORY_DATA_DIR`, `$XDG_DATA_HOME/ai-memory` (default
 *    `~/.local/share/ai-memory`) or `~/Library/Application Support/ai-memory` — the first with a
 *    `wiki/` directory. None: `ERR:nowiki`.
 * 3. The pages: `wiki/<project>/<family>/<name>.md` and `wiki/<workspace>/<project>/<family>/<name>.md` for the families
 *    in `AI_MEMORY_FAMILIES`, not recursively, skipping symlinked directories and files, names outside
 *    the character class, pages over `AI_MEMORY_PAGE_MAX_BYTES`, and `_rules/termhub-*.md` (the
 *    rules termhub itself publishes, TER-1019: importing them back would loop). Stops at
 *    `AI_MEMORY_MAX_PAGES` pages or before crossing `AI_MEMORY_MAX_BYTES`.
 *
 * Per page: `F\t<sha256>\t<size>\t<relpath>\n` + base64 body + `E\n`. `cwd` comes `shellQuote`d;
 * `"~"`/`"~/…"` are expanded on the machine. `parseAiMemoryPages` reads the output back.
 */
export function buildAiMemoryPagesScript(cwdQuoted: string): string {
  return [
    `P=${cwdQuoted}`,
    EXPAND_HOME,
    `cd -- "$P" 2>/dev/null || { echo 'ERR:notfound'; exit 0; }`,
    `if command -v sha256sum >/dev/null 2>&1; then H='sha256sum'`,
    `elif command -v shasum >/dev/null 2>&1; then H='shasum -a 256'`,
    `else echo 'ERR:nohash'; exit 0`,
    `fi`,
    `N=''`,
    `if [ -f .ai-memory.toml ] && [ ! -L .ai-memory.toml ]; then`,
    `  N=$(sed -n 's/^[[:space:]]*project[[:space:]]*=[[:space:]]*"\\([^"]*\\)".*/\\1/p' .ai-memory.toml | head -n 1)`,
    `fi`,
    `if [ -z "$N" ]; then`,
    `  G=$(git rev-parse --git-common-dir 2>/dev/null)`,
    `  case "$G" in`,
    `    .git) N=$(basename "$PWD") ;;`,
    `    /*/.git) N=$(basename "$(dirname "$G")") ;;`,
    `  esac`,
    `fi`,
    `[ -n "$N" ] || N=$(basename "$PWD")`,
    `case "$N" in ''|.|..|*[!A-Za-z0-9._-]*) echo 'ERR:noproject'; exit 0;; esac`,
    `PATH="$PATH:$HOME/.local/bin:$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin"`,
    `D=''`,
    `if command -v ai-memory >/dev/null 2>&1; then`,
    `  D=$(ai-memory status --json 2>/dev/null </dev/null | sed -n 's/.*"data_dir"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' | head -n 1)`,
    `fi`,
    `W=''`,
    `for c in "$D" "\${AI_MEMORY_DATA_DIR:-}" "\${XDG_DATA_HOME:-$HOME/.local/share}/ai-memory" "$HOME/Library/Application Support/ai-memory"; do`,
    `  [ -n "$c" ] && [ -d "$c/wiki" ] && { W="$c/wiki"; break; }`,
    `done`,
    `[ -n "$W" ] && cd -- "$W" 2>/dev/null || { echo 'ERR:nowiki'; exit 0; }`,
    `n=0; total=0`,
    `for base in "$N" */"$N"; do`,
    `  [ -d "$base" ] && [ ! -L "$base" ] || continue`,
    `  [ ! -L "\${base%%/*}" ] || continue`,
    `  for fam in ${AI_MEMORY_FAMILIES.join(' ')}; do`,
    `    d="$base/$fam"`,
    `    [ -d "$d" ] && [ ! -L "$d" ] || continue`,
    `    for f in "$d"/*.md; do`,
    `      [ -f "$f" ] && [ ! -L "$f" ] && [ -r "$f" ] || continue`,
    `      case "$f" in *[!A-Za-z0-9._/-]*) continue;; esac`,
    `      case "$f" in */_rules/termhub-*) continue;; esac`,
    `      s=$(wc -c < "$f" | tr -d ' ')`,
    `      [ -n "$s" ] || continue`,
    `      [ "$s" -le ${AI_MEMORY_PAGE_MAX_BYTES} ] || continue`,
    `      n=$((n+1)); [ "$n" -le ${AI_MEMORY_MAX_PAGES} ] || exit 0`,
    `      total=$((total + s)); [ "$total" -le ${AI_MEMORY_MAX_BYTES} ] || exit 0`,
    `      h=$($H "$f" | cut -d' ' -f1)`,
    `      printf 'F\\t%s\\t%s\\t%s\\n' "$h" "$s" "$f"`,
    `      base64 < "$f"`,
    `      echo E`,
    `    done`,
    `  done`,
    `done`,
  ].join('\n');
}

/**
 * Reads `buildAiMemoryPagesScript`'s stdout back. `err` is the `ERR:` tag's payload (`notfound`,
 * `nohash`, `noproject`, `nowiki`), or null. A page whose body was cut off (no `E`), whose sha256 or
 * size is malformed, whose path is not a deliberate-family page (`isAiMemoryPagePath`) or whose
 * decoded length does not match its size is dropped — so whatever the machine prints, nothing outside
 * `_rules/`, `gotchas/` and `decisions/` comes out of here.
 */
export function parseAiMemoryPages(stdout: string): { pages: AiMemoryPage[]; err: string | null } {
  const pages: AiMemoryPage[] = [];
  let err: string | null = null;
  const lines = stdout.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    i++;
    if (line.startsWith('ERR:')) {
      err = line.slice('ERR:'.length);
      continue;
    }
    if (!line.startsWith('F\t')) continue;
    const [, sha256, sizeText, path] = line.split('\t');
    const b64: string[] = [];
    let terminated = false;
    while (i < lines.length) {
      const l = lines[i]!;
      i++;
      if (l === 'E') {
        terminated = true;
        break;
      }
      b64.push(l);
    }
    if (!terminated || sha256 === undefined || sizeText === undefined || path === undefined) continue;
    if (!SHA256_HEX_RE.test(sha256) || !SIZE_RE.test(sizeText) || !isAiMemoryPagePath(path)) continue;
    const buf = Buffer.from(b64.join(''), 'base64');
    if (buf.length !== Number(sizeText)) continue;
    pages.push({ path, sha256, text: buf.toString('utf8') });
  }
  return { pages, err };
}
