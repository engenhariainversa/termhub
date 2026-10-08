import { EXPAND_HOME } from './fs-script.js';

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
