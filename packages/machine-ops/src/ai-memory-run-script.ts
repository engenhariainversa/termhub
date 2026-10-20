import { AI_MEMORY_MARKER } from './ai-memory-script.js';
import { EXPAND_HOME } from './fs-script.js';
import { shellQuote } from './shell.js';

/**
 * ai-memory in termhub's runs (TER-1020): what is typed before an automatic run's Claude Code, in the
 * run's worktree, so the session gets ai-memory's hooks (and with them the brief with the project's pinned
 * `_rules` pages) without touching the person's global `~/.claude`.
 */

/** Where ai-memory's `install-hooks --scope project` writes Claude Code's hooks: the checkout's local settings. */
export const CLAUDE_LOCAL_SETTINGS = '.claude/settings.local.json';

/**
 * POSIX sh, one line (it is typed into the tab), run with the worktree as cwd as
 * `sh -c <script> termhub-ai-memory <checkout> <server url>`. Always exits 0 and never blocks the run:
 * 1. no `ai-memory` on the PATH: nothing.
 * 2. the worktree has no marker but the project's checkout does (an untracked marker): copies it, with a
 *    top-level `project = "<checkout's folder name>"` added when it names none, so the worktree resolves to
 *    the checkout's ai-memory project (by default ai-memory takes the cwd's basename, which here is the
 *    card's folder). No marker anywhere: nothing — termhub never creates one (TER-1019).
 * 3. Claude Code's hooks in the worktree's `.claude/settings.local.json`, through ai-memory's own installer
 *    (`--scope project --no-capture-prompts`). It runs with `CLAUDE_CONFIG_DIR` pointed at a throwaway
 *    folder, so an installer that ignored the scope could still never write the person's own config.
 *    Skipped when that settings file is tracked by git (the run would commit the change).
 * 4. Both files, when termhub just created them and git would show them, go to the repository's
 *    `info/exclude`, so the run never commits them.
 */
export function buildAiMemoryRunPrepScript(): string {
  const m = AI_MEMORY_MARKER;
  const s = CLAUDE_LOCAL_SETTINGS;
  // a top-level `project =` line before the first [section]
  const hasProject = `awk '/^[ \\t]*\\[/{exit} /^[ \\t]*project[ \\t]*=/{f=1} END{exit !f}'`;
  const tracked = (f: string) => `git ls-files --error-unmatch -- ${f} >/dev/null 2>&1`;
  return [
    'command -v ai-memory >/dev/null 2>&1 || exit 0',
    'P=$1',
    EXPAND_HOME,
    'c=$P',
    'u=$2',
    'n=$(basename "$c")',
    `if [ ! -f ${m} ] && [ -f "$c/${m}" ]; then case $n in ''|*[\\"\\\\]*) exit 0;; esac; if ${hasProject} "$c/${m}"; then cp "$c/${m}" ${m}; else { printf 'project = "%s"\\n' "$n"; cat "$c/${m}"; } > ${m}; fi || exit 0; fi`,
    `[ -f ${m} ] || exit 0`,
    `if ! ${tracked(s)}; then t=$(mktemp -d "\${TMPDIR:-/tmp}/termhub-aim.XXXXXX") && { CLAUDE_CONFIG_DIR="$t" AI_MEMORY_SERVER_URL="$u" ai-memory install-hooks --agent claude-code --scope project --no-capture-prompts --apply; rm -rf "$t"; }; fi`,
    'x=$(git rev-parse --git-path info/exclude 2>/dev/null) || exit 0',
    `for f in ${m} ${s}; do [ -e "$f" ] || continue; ${tracked('"$f"')} && continue; git check-ignore -q -- "$f" && continue; mkdir -p "$(dirname "$x")" && printf '/%s\\n' "$f" >> "$x"; done`,
    'exit 0',
  ].join('; ');
}

/** `$0` of the prep script, so a `ps` line says what it is. */
const PREP_NAME = 'termhub-ai-memory';

/**
 * The prep as typed before the CLI line: every value quoted, all output dropped, and `;` after it, so the
 * agent starts whether the prep worked or not.
 */
export function aiMemoryRunPrepLine(checkout: string, serverUrl: string): string {
  return `sh -c ${shellQuote(buildAiMemoryRunPrepScript())} ${PREP_NAME} ${shellQuote(checkout)} ${shellQuote(serverUrl)} >/dev/null 2>&1 ; `;
}
