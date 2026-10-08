/** Everything a runner needs to spawn `claude -p` the one way the permission gate allows: the
 * exact argv and the MCP config it points at. The runner (the agent, on the user's own machine)
 * builds its command line from here, and the argv tests pin it. No spawning, no file I/O, no
 * process handling — that stays with the runner.
 *
 * `ClaudeRunSpec` has no prompt field: the prompt never becomes an argument here, so a prompt
 * beginning with "-" can never be read as a flag. The runner writes it to the child's stdin
 * instead, and that guarantee is exercised end to end where the runner exists — the agent's
 * fake-CLI test in apps/agent/src/claude/run.test.ts. */

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

/**
 * The built-in tools the concierge may use: only the subagent tool (TER-127). Everything else it
 * does goes through the termhub MCP (`--allowed-tools mcp__termhub__*`), where the permission gate
 * lives (spec 2026-09-21 §4.1). An allowlist, because a denylist rots with every CLI release: 2.1.283
 * ships Glob and Grep, which read any file under the working directory without asking — and the
 * agent's working directory is the person's home. The CLI applies it to the subagents too.
 * Left out on purpose: ToolSearch (the MCP tools load without it), TaskStop (cancelling a subagent
 * is TER-64/65's design to add), SendMessage (the CLI's background-launch result mentions it, but
 * the orchestrator prompt starts a new subagent instead), Skill, Workflow and the cron and task-list tools.
 */
export const CONCIERGE_TOOLS = 'Agent';

/** The second layer: every built-in that reads or writes the machine's files, runs code on it, or
 * reaches the network, denied by name. Deny rules win over the account's own `permissions.allow`,
 * and naming a tool the CLI does not have is harmless, so this still holds if a future CLI changes
 * what `--tools` means for a custom subagent. */
export const DISALLOWED_TOOLS =
  'Bash,PowerShell,Monitor,Read,Write,Edit,NotebookEdit,Glob,Grep,EnterWorktree,WebFetch,WebSearch,RemoteTrigger';

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

/**
 * The config dir as the CLI must receive it in `CLAUDE_CONFIG_DIR`. The chat spawns the CLI without
 * a shell, so nothing expands `~` or `$HOME` there: the CLI reads `~/.claude_x` as relative to its cwd
 * and creates a literal `~` directory with no login in it (TER-613). A tab's command line goes
 * through the shell (`configDirPrefix`), so this expands the same forms, against the run's HOME.
 * `~user` and other variables are left alone: there is no way to resolve them here.
 */
export function resolveConfigDir(dir: string, home: string): string {
  const raw = dir.trim();
  const base = home.endsWith('/') ? home.slice(0, -1) : home;
  const match = /^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/.exec(raw);
  return match ? base + raw.slice(match[0].length) : raw;
}

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
    '--tools', CONCIERGE_TOOLS,
    ...(spec.stream_input ? ['--input-format', 'stream-json', '--replay-user-messages', '--settings', CONCIERGE_SETTINGS] : []),
    ...(spec.model ? ['--model', spec.model] : []),
    // Last, and only when set: the account-wide chat's argv stays exactly what it was. It is our own
    // server-composed text (a project's name, key and paths), never the user's prompt, which still
    // travels on stdin only.
    ...(spec.append_system_prompt ? ['--append-system-prompt', spec.append_system_prompt] : []),
  ];
}

/** The MCP config file's contents, so both runners write the same shape: one HTTP server, the
 * token in the header. `name` is the server's name as the CLI sees it (its tools become
 * `mcp__<name>__<tool>`): an agent tab uses its own, so it never collides with a `termhub` server
 * the person configured themselves. */
export function mcpConfig(url: string, token: string, name = 'termhub'): string {
  return JSON.stringify({ mcpServers: { [name]: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } } });
}

/**
 * Why a run failed, in a form the callers are allowed to act on. Derived from the CLI's stderr,
 * which never leaves the machine it ran on: it can carry the prompt and terminal content (spec
 * §7.1), so only this label travels. A label is not text — it names an outcome the server acts on,
 * which is why the classification lives here beside the argv.
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
  // A CLI older than one of our flags (`--tools`, TER-127) refuses it in commander's wording.
  if (/^error: unknown option/m.test(stderr)) return 'cli_rejected';
  return 'run_failed';
}
