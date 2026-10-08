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
