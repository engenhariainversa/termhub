/** Everything a runner needs to spawn `claude -p` the one way the permission gate allows: the
 * exact argv and the MCP config it points at. Two runners (the server's container today, the
 * user's own machine tomorrow) build the same command line from here, so neither can drift from
 * the other. No spawning, no file I/O, no process handling — that stays with each runner.
 *
 * `ClaudeRunSpec` has no prompt field: the prompt never becomes an argument here, so a prompt
 * beginning with "-" can never be read as a flag. Each runner writes it to the child's stdin
 * instead, and that guarantee is exercised end to end where the runner exists — the concierge's
 * fake-CLI test in apps/concierge/src/run.test.ts, and the agent's equivalent once Task 3 adds it. */

export interface ClaudeRunSpec {
  session_id: string;
  resume: boolean;
  mcp_config_path: string;
  model?: string | null;
  append_system_prompt?: string | null;
  /**
   * The chat that never blocks (spec 2026-09-26): the CLI reads `stream-json` user messages from stdin
   * for as long as it stays open, replays each one when its turn starts (that is how the server knows
   * which message an answer belongs to), and loads `CONCIERGE_SETTINGS`, the hook that keeps every
   * subagent in the background.
   */
  stream_input?: boolean;
}

/** Tools the concierge must never have: with any of them it could reach a machine outside the MCP,
 * where the permission gate lives (spec §4.1). The CLI applies this list to the whole session, so the
 * subagents the concierge launches do not have them either. */
export const DISALLOWED_TOOLS = 'Bash,Read,Write,Edit,WebFetch,WebSearch';

/**
 * The `PreToolUse` hook that refuses a foreground subagent. A subagent in the foreground holds the
 * concierge's turn until it ends, and a turn in progress is what used to keep the person out of their
 * own chat. In the background it runs on its own, and the CLI notifies the concierge when it is done.
 * Exit code 2 blocks the call and hands stderr to the model, which then repeats the call the right way.
 *
 * POSIX `sh` and `grep` only: it runs on the person's own machine (macOS or Linux), where neither `jq`
 * nor a particular Node can be assumed. A call made from inside a subagent (`agent_id` in the payload)
 * is left alone, since that subagent is already off the concierge's turn. The pattern only matches
 * the payload's own key: inside a JSON string the quotes are escaped and never match.
 */
export const BACKGROUND_AGENT_HOOK =
  `input=$(cat); case "$input" in *'"agent_id"'*) exit 0;; esac; ` +
  `printf '%s' "$input" | grep -Eq '"run_in_background"[[:space:]]*:[[:space:]]*true' && exit 0; ` +
  `echo 'No chat do termhub todo subagente roda em segundo plano: repita esta chamada do Agent com run_in_background: true.' >&2; exit 2`;

/** The settings a streamed chat run loads with `--settings`: the hook above, on the subagent tool
 *  under both of its names (`Task` on older CLIs). The CLI merges them with the account's own. */
export const CONCIERGE_SETTINGS = JSON.stringify({
  hooks: { PreToolUse: [{ matcher: 'Agent|Task', hooks: [{ type: 'command', command: BACKGROUND_AGENT_HOOK }] }] },
});

/** Every flag the concierge must run with, in a fixed order. */
export function buildClaudeArgs(spec: ClaudeRunSpec): string[] {
  return [
    '-p',
    // Exactly one of the two, never both: the CLI answers "--session-id can only be used with
    // --continue or --resume if --fork-session is also specified" and exits 1 before doing any
    // work, which broke every message after the first. --session-id is how the server names a new
    // session; --resume is how it continues one it already named.
    ...(spec.resume ? ['--resume', spec.session_id] : ['--session-id', spec.session_id]),
    '--output-format', 'stream-json',
    // required by the CLI: with --print, --output-format=stream-json refuses to run without it
    // ("Error: When using --print, --output-format=stream-json requires --verbose"). It only
    // changes what the CLI writes to stdout, never logging the prompt.
    '--verbose',
    '--include-partial-messages',
    '--mcp-config', spec.mcp_config_path,
    '--strict-mcp-config',
    '--allowed-tools', 'mcp__termhub__*',
    '--disallowed-tools', DISALLOWED_TOOLS,
    ...(spec.stream_input ? ['--input-format', 'stream-json', '--replay-user-messages', '--settings', CONCIERGE_SETTINGS] : []),
    ...(spec.model ? ['--model', spec.model] : []),
    // Last, and only when set: the account-wide chat's argv stays exactly what it was. It is our own
    // server-composed text (a project's name, key and paths), never the user's prompt, which still
    // travels on stdin only.
    ...(spec.append_system_prompt ? ['--append-system-prompt', spec.append_system_prompt] : []),
  ];
}

/** The MCP config file's contents, so both runners write the same shape: one HTTP server, the
 * token in the header. */
export function mcpConfig(url: string, token: string): string {
  return JSON.stringify({ mcpServers: { termhub: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } } });
}

/**
 * Why a run failed, in a form the callers are allowed to act on. Derived from the CLI's stderr,
 * which never leaves the machine it ran on: it can carry the prompt and terminal content (spec
 * §7.1), so only this label travels. A label is not text — it names an outcome, and both runners
 * need the same names for the same stderr, which is why the classification lives here beside the
 * argv rather than once in the container and again in the agent.
 */
export type ClaudeFailureReason = 'missing_session' | 'cli_rejected' | 'run_failed';

/**
 * The CLI prints "No conversation found with session ID <uuid>" when `--resume` names a session the
 * config dir does not have (a rotated account, a pruned history). Anchored on that exact phrase
 * only: a broader match (anything mentioning "session ID") would also catch unrelated failures and
 * make the caller throw away a perfectly good session.
 */
export function classifyFailure(stderr: string): ClaudeFailureReason {
  if (/No conversation found/i.test(stderr)) return 'missing_session';
  // The CLI rejecting our own flags is our bug, not the user's, and it exits before doing any work.
  // Classifying it apart is what makes it findable in one query instead of a container probe.
  if (/^Error: --/m.test(stderr)) return 'cli_rejected';
  return 'run_failed';
}
