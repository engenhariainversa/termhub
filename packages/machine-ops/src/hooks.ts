/**
 * Monitor hooks: the small POSIX script under ~/.termhub/bin that forwards Claude Code / Codex /
 * Cursor CLI hook payloads to termhub, and the pure merge/strip of the config files that make the
 * tools call it. Shared by the server (ssh/local machines, written through `sh -s`) and the
 * agent (`hooks.install` RPC, written with node:fs on the machine itself).
 */

import { shellQuote } from './shell.js';

export const HOOK_SCRIPT_REL = '.termhub/bin/termhub-hook';
export const HOOK_ENV_REL = '.termhub/hook.env';
/** Substring that marks an entry as ours in settings.json / config.toml. */
export const HOOK_MARK = 'termhub-hook';

/** Claude Code's default config dir; an account can use another one (CLAUDE_CONFIG_DIR). */
export const CLAUDE_DEFAULT_DIR = '~/.claude';

/**
 * The Claude config dirs to hook, as "~/x" or "/abs": the default first, then each account's
 * own dir once (a bare "x" is taken as "~/x"). The home itself and odd paths are dropped.
 */
export function claudeConfigDirs(accountDirs: readonly (string | null | undefined)[]): string[] {
  const out = [CLAUDE_DEFAULT_DIR];
  for (const raw of accountDirs) {
    let d = (raw ?? '').trim().replace(/\/+$/, '');
    if (!d || d === '~' || /[\0\n\r]/.test(d)) continue;
    if (!d.startsWith('~/') && !d.startsWith('/')) d = `~/${d}`;
    if (!out.includes(d)) out.push(d);
  }
  return out;
}

/** "~/x" on a machine whose $HOME is `home`; absolute paths stay as they are. */
export function expandHome(dir: string, home: string): string {
  return dir.startsWith('~/') ? `${home}/${dir.slice(2)}` : dir;
}

/** Claude Code hook events we subscribe to (see the server's monitor/state.ts for what each one means).
 * `PermissionRequest` is taken for its tool name only; the script prints nothing, which Claude Code
 * reads as "no decision" — our hook never allows or denies (hook-script.test.ts keeps stdout empty).
 * The one exception to the empty stdout is `UserPromptSubmit` (TER-851): when the server answers with an
 * origin note for a prompt termhub typed, the script prints it, and Claude Code adds it to the context
 * (`hookSpecificOutput.additionalContext`). It never blocks the prompt.
 * `StopFailure` fires when an API error — a usage limit, an auth failure — ends the turn instead of
 * a normal `Stop` (spec 2026-09-26 account swap).
 * `SubagentStop` is taken for the subagent's id only (spec 2026-09-30 tab questions per subagent): it is
 * what closes the card of a subagent that ends after its dialog.
 * Minimum Claude Code: **2.0.45**, the first release with the `PermissionRequest` hook. An older one may
 * reject this hooks block, and before 2.1.122 a malformed hooks entry invalidated the whole settings.json.
 * Deliberately not gated on the version (spec 2026-09-26 §4.6): Claude Code updates itself by default, and
 * asking every machine and config dir for `claude --version` costs a remote call per install for a case
 * not seen in the field. */
export const CLAUDE_HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'Notification', 'Stop', 'StopFailure', 'SessionEnd', 'SubagentStop'] as const;

/** Events Claude Code runs per tool: their entry needs a matcher ('*' = every tool). */
const CLAUDE_TOOL_EVENTS: ReadonlySet<string> = new Set(['PreToolUse', 'PermissionRequest']);

/**
 * Codex hook events we subscribe to (~/.codex/hooks.json; Codex reads the same shape as Claude Code's
 * settings.json; see the server's monitor/state.ts). `notify` in config.toml stays as well: it needs no
 * trust and keeps reporting the end of each turn until the person trusts these hooks.
 * No `SessionStart`: it fires when Codex opens, with nobody's turn behind it, and would read as working.
 * `Interrupt` is what Esc sends, and nothing else (no `Stop`, no notify) tells the monitor the turn is over;
 * Codex clamps its timeout to 3 s and warns at startup about a longer one, so ours is 3.
 * The script prints nothing on every path, so none of these ever answers a permission check.
 * Hooks need the person's review: a new or changed one opens "Hooks need review" the next time Codex
 * starts, and termhub does not write that trust (it is Codex's safety check, and the person's call).
 */
export const CODEX_HOOK_EVENTS = ['UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'Stop', 'Interrupt'] as const;

/** Where Codex reads its hooks from, relative to $HOME. */
export const CODEX_HOOKS_REL = '.codex/hooks.json';

/** Events Codex runs per tool: their entry needs a matcher ('*' = every tool). */
const CODEX_TOOL_EVENTS: ReadonlySet<string> = new Set(['PreToolUse', 'PermissionRequest', 'PostToolUse']);

/**
 * Cursor CLI hook events we subscribe to (~/.cursor/hooks.json; see the server's monitor/state.ts).
 * No hook that answers a permission check: `beforeShellExecution`, `beforeMCPExecution`,
 * `beforeReadFile` and `preToolUse` can allow or deny, and ours must never be in that position.
 * `beforeSubmitPrompt` is blocking too — its stdout can cancel the prompt — and is taken on purpose:
 * it is the only signal that a new turn started. The script prints nothing, which Cursor reads as
 * "go on" (checked against cursor-agent 2026.09.18; hook-script.test.ts keeps stdout empty).
 */
export const CURSOR_HOOK_EVENTS = ['sessionStart', 'beforeSubmitPrompt', 'afterAgentResponse', 'stop', 'sessionEnd'] as const;

/** The script itself. Reads the hook JSON (stdin for Claude and Cursor, argv for Codex), tags it with the tmux session and posts it in the background. */
export const HOOK_SCRIPT = `#!/bin/sh
# termhub monitor hook — installed by termhub; forwards Claude Code / Codex / Cursor CLI hook
# events to termhub tagged with the tmux session, so the app knows which tab is waiting for you.
# Safe to delete (also remove the entries in ~/.claude/settings.json, ~/.codex/config.toml,
# ~/.codex/hooks.json and ~/.cursor/hooks.json).
TOOL="\${1:-claude}"
[ -f "$HOME/${HOOK_ENV_REL}" ] || exit 0
. "$HOME/${HOOK_ENV_REL}"
[ -n "$TERMHUB_HOOK_URL" ] && [ -n "$TERMHUB_HOOK_TOKEN" ] || exit 0
[ -n "$TMUX_PANE" ] || exit 0
PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
SESSION=$(tmux display-message -p -t "$TMUX_PANE" '#{session_name}' 2>/dev/null) || exit 0
[ -n "$SESSION" ] || exit 0
# Codex's notify passes the payload as an argument; its hooks (like Claude's and Cursor's) send it on stdin.
if [ "$TOOL" = codex ] && [ -n "$2" ]; then EVENT="$2"; else EVENT=$(cat 2>/dev/null); fi
[ -n "$EVENT" ] || EVENT='{}'
# Tool calls (Claude's PreToolUse, Codex's PreToolUse and PostToolUse): only the tool's name travels (never its input), with the spinner's verb when one is on
# screen, and only when the pair changed since the last one for this session — twenty edits in a row
# are one request as long as the verb stays the same (a new verb mid-run is a new request). The marker is per tmux
# session, under TMPDIR, with the session name reduced to filename-safe characters. A Claude subagent's
# key starts with its id (AGENT, below), so one agent's tool call never swallows another's.
# AskUserQuestion (Claude) and request_user_input (Codex) are the exceptions (below).
MARK="\${TMPDIR:-/tmp}/termhub-hook-$(printf '%s' "$SESSION" | tr -c 'A-Za-z0-9_-' '_')"
# The branch below is picked on the event's OWN hook_event_name — the FIRST "hook_event_name" key of
# the payload (Claude Code serialises it before tool_input, same reasoning as tool_name below) —
# never a value a substring search could find nested inside a tool's input (e.g. a PermissionRequest
# whose tool_input happened to contain the text "hook_event_name":"PreToolUse").
KIND_REST=\${EVENT#*'"hook_event_name"'}
if [ "$KIND_REST" != "$EVENT" ]; then
  KIND_REST=\${KIND_REST#*'"'}
  KIND=\${KIND_REST%%'"'*}
else
  KIND=
fi
# A subagent's event (Claude Code 2.1.69+) carries an "agent_id" key before its own "hook_event_name" —
# the order is session_id, transcript_path, cwd, prompt_id, permission_mode, agent_id, agent_type,
# hook_event_name, … — and the main thread's never does. Only that prefix is searched, and only for the
# key form: a value holding the text "agent_id": would have its quotes escaped. The reduced bodies below
# carry the flag (spec 2026-09-26 §4.5) and, for Claude, the subagent's id, which is what lets the
# server tell one subagent's card from another's.
BEFORE_KIND=\${EVENT%%'"hook_event_name"'*}
SUB=
case "$BEFORE_KIND" in *'"agent_id":'*) SUB=',"subagent":true' ;; esac
# The subagent's id, as a value (spec 2026-09-30 tab questions per subagent §2): what lets the server
# close one subagent's card and not another's. Claude only. The id is the first "agent_id" of that
# same prefix; only 1 to 64 characters of A-Za-z0-9_- travel — anything else is dropped and the flag
# alone remains, which the server reads as it always did.
AGENT=
if [ "$TOOL" = claude ] && [ -n "$SUB" ]; then
  AGENT=\${BEFORE_KIND#*'"agent_id":"'}
  [ "$AGENT" != "$BEFORE_KIND" ] || AGENT=
  AGENT=\${AGENT%%'"'*}
  # Spelled out, not A-Za-z0-9: sh matches a range by the locale's collation, and under a UTF-8 locale
  # (macOS /bin/sh is bash) "é" sits inside a-z.
  case "$AGENT" in *[!ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-]*) AGENT= ;; esac
  [ "\${#AGENT}" -le 64 ] || AGENT=
  [ -z "$AGENT" ] || SUB="$SUB,\\"agent_id\\":\\"$AGENT\\""
fi
case "$KIND" in
  PreToolUse | PostToolUse)
    # The event's own tool name is the FIRST "tool_name" of the payload (Claude Code serialises it
    # before tool_input), so the shortest prefix is cut — a "tool_name" nested in a tool's input
    # must not win. Only letters, digits, "_", "." and "-" are posted (a bare Claude Code tool name,
    # or an MCP tool name such as mcp__claude-in-chrome__click): anything else (a number, a name with
    # a quote or a backslash) is dropped rather than sent — those are the only characters the
    # hand-built JSON body below cannot survive as-is.
    REST=\${EVENT#*'"tool_name"'}
    [ "$REST" != "$EVENT" ] || exit 0
    REST=\${REST#*'"'}
    NAME=\${REST%%'"'*}
    case "$NAME" in '' | *[!A-Za-z0-9_.-]*) exit 0 ;; esac
    # A PostToolUse (Codex only) is reduced exactly like a PreToolUse and shares its marker: the pair
    # of one tool call is one request, and it is the marker that stops a tool's own PostToolUse from
    # repeating what its PreToolUse just said. The reduced body keeps the event's own name.
    # AskUserQuestion's input is the question itself, written to be shown to the person (spec
    # 2026-09-25 §4.1): the whole event goes as it came — the server keeps tool_use_id and
    # tool_input and drops the rest — and the marker is neither read nor written, so two questions
    # in a row are two questions. NAME is real only when $REST (everything from the first "tool_name"
    # on) holds no SECOND "tool_name": a real question never repeats that key, so a second one means
    # the first was actually nested inside another tool's tool_input (tool_input serialised before
    # tool_name) and NAME does not name the real tool — fall back to the ordinary name-only path below
    # (which, worst case, mislabels that one event; it never forwards the input).
    ASK=false
    # Claude's AskUserQuestion, and Codex's request_user_input (its equivalent, shown in Plan mode; the
    # payload is Claude-shaped). Each name counts for its own agent only: the other agent's tool of that
    # name is reduced like any other.
    if [ "$KIND" = PreToolUse ]; then
      if { [ "$TOOL" = claude ] && [ "$NAME" = AskUserQuestion ]; } || { [ "$TOOL" = codex ] && [ "$NAME" = request_user_input ]; }; then
        case "$REST" in
          *'"tool_name"'*) ;;
          *) ASK=true ;;
        esac
      fi
    fi
    # A Codex question also clears the marker: the PostToolUse of the previous question left
    # "request_user_input" there, and without the reset the next question's PostToolUse would match it
    # and be suppressed. (Claude's AskUserQuestion has no PostToolUse hook, so its rule is unchanged.)
    # The server rejects a body over 256 KB (HOOK_BODY_LIMIT): past 200000 characters the question
    # goes reduced instead.
    if [ "$ASK" = true ] && [ "$TOOL" = codex ]; then
      rm -f "$MARK"
      if [ "\${#EVENT}" -gt 200000 ]; then
        EVENT=$(printf '{"hook_event_name":"PreToolUse","tool_name":"%s"%s}' "$NAME" "$SUB")
      fi
    fi
    if [ "$ASK" != true ]; then
      # Claude Code's spinner verb ("✻ Moonwalking… (12s · esc to interrupt)"): the visible pane is
      # read here, on the machine, and only the verb may leave it — one word of 2 to 24 ASCII letters
      # right after a spinner glyph at column 0 and a single space, immediately followed by "…" or
      # "...", then the end of the line or a space. Column 0 because Claude Code draws its spinner
      # there, while a draft in the input box or indented tool output can look just like one. The
      # lowest such line of the last 24 non-blank rows wins (the live spinner sits above the todo list
      # and the input box; blank rows under a short session are skipped). Both grep and sed run under
      # LC_ALL=C: bytes the locale calls invalid then neither trip grep's "binary file matches" (which
      # would also swallow the rest of the screen) nor sed's "illegal byte sequence" on macOS, and
      # the match works the same on GNU, BSD and busybox. ASCII only on purpose: a customised verb
      # with accents is dropped rather than half-matched. The case below checks the result again, so
      # the hand-built JSON only ever gets letters.
      # Codex has no such spinner: its tool calls skip the capture (one less tmux call per tool, and no
      # stray line of its screen that happens to look like one).
      VERB=
      if [ "$TOOL" = claude ]; then
        VERB=$(tmux capture-pane -p -t "$TMUX_PANE" 2>/dev/null | LC_ALL=C grep -v '^[[:space:]]*$' 2>/dev/null | tail -n 24 |
          LC_ALL=C sed -n -E 's/^(·|✢|✳|✶|✻|✽|\\*) ([A-Za-z]{2,24})(…|\\.\\.\\.)( .*)?$/\\2/p' | tail -n 1)
      fi
      case "$VERB" in *[!A-Za-z]*) VERB= ;; esac
      [ "\${#VERB}" -le 24 ] || VERB=
      KEY="\${AGENT:+$AGENT:}$NAME\${VERB:+ $VERB}"
      [ "$(cat "$MARK" 2>/dev/null)" = "$KEY" ] && exit 0
      printf '%s' "$KEY" 2>/dev/null > "$MARK"
      if [ -n "$VERB" ]; then
        EVENT=$(printf '{"hook_event_name":"%s","tool_name":"%s","verb":"%s"%s}' "$KIND" "$NAME" "$VERB" "$SUB")
      else
        EVENT=$(printf '{"hook_event_name":"%s","tool_name":"%s"%s}' "$KIND" "$NAME" "$SUB")
      fi
    fi
    ;;
  PermissionRequest)
    # A permission prompt. Claude's: only the tool's name travels, exactly like a tool call (never its
    # input, never the suggestions). AskUserQuestion's own prompt is dropped — its PreToolUse already
    # carried the question. Same first-"tool_name" rule and character set as above.
    # Codex's travels whole (spec 2026-09-29 D2), once NAME passed the same check: its "description" is
    # the question Codex shows above the approval menu, written to be shown to the person, and the
    # server keeps only that and the tool name. It also clears the marker: the tool the person approves
    # is the one that set it, and without the reset its PostToolUse would be suppressed and nothing
    # would say the tab is working again.
    REST=\${EVENT#*'"tool_name"'}
    [ "$REST" != "$EVENT" ] || exit 0
    REST=\${REST#*'"'}
    NAME=\${REST%%'"'*}
    case "$NAME" in '' | *[!A-Za-z0-9_.-]* | AskUserQuestion) exit 0 ;; esac
    if [ "$TOOL" = codex ]; then
      rm -f "$MARK"
      # The server rejects a body over 256 KB (HOOK_BODY_LIMIT) and the whole event carries the command
      # (a big patch or heredoc can pass that): past 200000 characters the reduced body goes instead, so
      # the approval is still seen — the server then words it from the tool name alone.
      if [ "\${#EVENT}" -gt 200000 ]; then
        EVENT=$(printf '{"hook_event_name":"PermissionRequest","tool_name":"%s"%s}' "$NAME" "$SUB")
      fi
    else
      # The tool call after an answered dialog is what closes its card: it must never be deduped
      # against the call before the dialog (same tool, and no spinner verb while the dialog is up).
      rm -f "$MARK"
      EVENT=$(printf '{"hook_event_name":"PermissionRequest","tool_name":"%s"%s}' "$NAME" "$SUB")
    fi
    ;;
  SubagentStop)
    # Claude only. A subagent ended: only its id travels (its payload carries the subagent's last
    # message), and only when there is one — the server uses it to close that subagent's card and
    # nothing else (spec 2026-09-30 tab questions per subagent §2).
    [ -n "$AGENT" ] || exit 0
    EVENT=$(printf '{"hook_event_name":"SubagentStop"%s}' "$SUB")
    ;;
  # A new turn starts fresh, and so does an answered notification: a permission prompt takes the tab
  # out of working, and the tool the person approves is the same one that set the marker, so without
  # this reset the retry is suppressed and nothing says the tab is working again.
  SessionStart | UserPromptSubmit | Notification)
    rm -f "$MARK"
    ;;
esac
# A prompt Claude Code is about to submit (TER-851) is the one event posted in the foreground, for at
# most 2 s: when termhub typed that text, the server answers with a note saying who wrote it, and the
# script prints it on stdout, where Claude Code reads it as context for the session. Only a 200 whose
# body starts with {"hookSpecificOutput" is printed; anything else (no note, an error, a timeout, an
# older server) prints nothing, exactly as before.
if [ "$TOOL" = claude ] && [ "$KIND" = UserPromptSubmit ] && [ -z "$SUB" ]; then
  OUT=$({ printf '{"tool":"%s","session":"%s","event":' "$TOOL" "$SESSION"; printf '%s' "$EVENT"; printf '}'; } |
    curl -s -m 2 -w '\\n%{http_code}' -X POST "$TERMHUB_HOOK_URL" \\
      -H "authorization: Bearer $TERMHUB_HOOK_TOKEN" -H 'content-type: application/json' --data-binary @- 2>/dev/null)
  CODE=$(printf '%s\\n' "$OUT" | tail -n 1)
  REPLY=$(printf '%s\\n' "$OUT" | sed '$d')
  if [ "$CODE" = 200 ]; then
    case "$REPLY" in '{"hookSpecificOutput"'*) printf '%s\\n' "$REPLY" ;; esac
  fi
  exit 0
fi
{ printf '{"tool":"%s","session":"%s","event":' "$TOOL" "$SESSION"; printf '%s' "$EVENT"; printf '}'; } |
  curl -s -m 5 -o /dev/null -X POST "$TERMHUB_HOOK_URL" \\
    -H "authorization: Bearer $TERMHUB_HOOK_TOKEN" -H 'content-type: application/json' --data-binary @- >/dev/null 2>&1 &
exit 0
`;

/** Body of ~/.termhub/hook.env: sourced by the script, so the values are single-quoted for sh. */
export function hookEnvFile(hooksUrl: string, token: string): string {
  return `TERMHUB_HOOK_URL=${shellQuote(hooksUrl)}\nTERMHUB_HOOK_TOKEN=${shellQuote(token)}\n`;
}

type HookEntry = { matcher?: string; hooks?: { type?: string; command?: string }[] };

const asObject = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/**
 * `hooks` we can merge into: a real object, or nothing to lose (absent, null, or `[]`).
 * A non-empty array / string / number would be replaced by ours alone — refuse those.
 */
const asHooksRecord = (v: unknown): Record<string, unknown> | null => {
  if (v == null || (Array.isArray(v) && v.length === 0)) return {};
  return asObject(v);
};

const isOurs = (e: HookEntry) => !!e && typeof e === 'object' && Array.isArray(e.hooks) && e.hooks.some((h) => typeof h?.command === 'string' && h.command.includes(HOOK_MARK));

/** What one of our entries looks like for an event: whether it filters by tool, and its timeout. */
type EntryShape = { matcher?: string; timeout: number };

/**
 * Merges our entry for each of `events` into a settings-shaped JSON file (`{ hooks: { Event: [{ matcher?,
 * hooks: [{ type, command, timeout }] }] } }`: Claude Code's settings.json and Codex's hooks.json);
 * keeps everything else. Throws on a file that is not a JSON object.
 */
function mergeHooksFile(current: string, shown: string, events: readonly string[], command: string, shape: (event: string) => EntryShape): string {
  let settings: Record<string, unknown> = {};
  if (current.trim()) {
    const parsed = JSON.parse(current) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${shown} não é um objeto JSON`);
    settings = parsed as Record<string, unknown>;
  }
  // a `hooks` we cannot read would be replaced by ours alone, and uninstall could not give it back
  const hooks = asHooksRecord(settings.hooks);
  if (settings.hooks != null && hooks === null) throw new Error(`${shown}: o campo "hooks" não é um objeto`);
  const next = hooks ?? {};
  for (const event of events) {
    const list = (Array.isArray(next[event]) ? next[event] : []) as HookEntry[];
    const others = list.filter((e) => !isOurs(e));
    const { matcher, timeout } = shape(event);
    const entry: HookEntry = { hooks: [{ type: 'command', command, timeout } as { type: string; command: string }] };
    if (matcher !== undefined) entry.matcher = matcher;
    others.push(entry);
    next[event] = others;
  }
  settings.hooks = next;
  return `${JSON.stringify(settings, null, 2)}\n`;
}

/** Merges our entries into Claude Code's settings.json; keeps everything else. Throws on a file that is not a JSON object. */
export function mergeClaudeSettings(current: string, scriptPath: string, shown = '~/.claude/settings.json'): string {
  // A tool event's entry is filtered by tool name; '*' says every tool explicitly (so would no matcher).
  return mergeHooksFile(current, shown, CLAUDE_HOOK_EVENTS, `${scriptPath} claude`, (event) => ({
    ...(CLAUDE_TOOL_EVENTS.has(event) ? { matcher: '*' } : {}),
    timeout: 10,
  }));
}

/** Merges our entries into Codex's ~/.codex/hooks.json (Claude-shaped); keeps everything else. Throws on a file that is not a JSON object. */
export function mergeCodexHooks(current: string, scriptPath: string, shown = '~/.codex/hooks.json'): string {
  return mergeHooksFile(current, shown, CODEX_HOOK_EVENTS, `${scriptPath} codex`, (event) => ({
    ...(CODEX_TOOL_EVENTS.has(event) ? { matcher: '*' } : {}),
    timeout: event === 'Interrupt' ? 3 : 10,
  }));
}

/** Removes our entries; drops `hooks` keys left empty. Leaves anything that is not a JSON object alone. */
export function stripClaudeSettings(current: string): string {
  if (!current.trim()) return current;
  const parsed = JSON.parse(current) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return current;
  const settings = parsed as Record<string, unknown>;
  const hooks = settings.hooks;
  if (hooks && typeof hooks === 'object' && !Array.isArray(hooks)) {
    const h = hooks as Record<string, unknown>;
    for (const key of Object.keys(h)) {
      if (!Array.isArray(h[key])) continue;
      const kept = (h[key] as HookEntry[]).filter((e) => !isOurs(e));
      if (kept.length) h[key] = kept;
      else delete h[key];
    }
    if (Object.keys(h).length === 0) delete settings.hooks;
  }
  return `${JSON.stringify(settings, null, 2)}\n`;
}

/** Removes our entries from Codex's hooks.json: the format is Claude's, so it is the same strip. */
export const stripCodexHooks = stripClaudeSettings;

/**
 * True when a Codex hooks.json holds nothing but an empty object: what `stripCodexHooks` leaves of a
 * file termhub created itself. Uninstall deletes such a file instead of writing it back. Anything the
 * person has in it makes this false, and so does a file that is empty or that we cannot parse: those
 * are never ours to delete.
 */
export function isBareCodexHooks(body: string): boolean {
  if (!body.trim()) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }
  const file = asObject(parsed);
  return file !== null && Object.keys(file).length === 0;
}

/** Codex reads `notify = [...]` from config.toml: replaces an existing line or prepends ours. */
export function mergeCodexConfig(current: string, scriptPath: string): string {
  const line = `notify = [${JSON.stringify(scriptPath)}, "codex"]`;
  const lines = current.split('\n');
  const idx = lines.findIndex((l) => /^\s*notify\s*=/.test(l));
  if (idx !== -1) lines[idx] = line;
  else lines.unshift(line);
  const out = lines.join('\n');
  return out.endsWith('\n') ? out : `${out}\n`;
}

export function stripCodexConfig(current: string): string {
  const lines = current.split('\n').filter((l) => !(/^\s*notify\s*=/.test(l) && l.includes(HOOK_MARK)));
  return lines.join('\n');
}

type CursorEntry = { command?: unknown };

const isOurCursorEntry = (e: CursorEntry) => !!e && typeof e === 'object' && typeof e.command === 'string' && e.command.includes(HOOK_MARK);


/** Merges our entries into Cursor's ~/.cursor/hooks.json (`{ version, hooks: { event: [{ command }] } }`); keeps everything else. Throws on a file that is not a JSON object. */
export function mergeCursorHooks(current: string, scriptPath: string, shown = '~/.cursor/hooks.json'): string {
  let file: Record<string, unknown> = {};
  if (current.trim()) {
    const parsed = asObject(JSON.parse(current) as unknown);
    if (!parsed) throw new Error(`${shown} não é um objeto JSON`);
    file = parsed;
  }
  // a `hooks` we cannot read would be replaced by ours alone, and uninstall could not give it back
  const hooks = asHooksRecord(file.hooks);
  if (file.hooks != null && hooks === null) throw new Error(`${shown}: o campo "hooks" não é um objeto`);
  const next = hooks ?? {};
  for (const event of CURSOR_HOOK_EVENTS) {
    const others = ((Array.isArray(next[event]) ? next[event] : []) as CursorEntry[]).filter((e) => !isOurCursorEntry(e));
    others.push({ command: `${scriptPath} cursor` });
    next[event] = others;
  }
  return `${JSON.stringify({ ...file, version: typeof file.version === 'number' ? file.version : 1, hooks: next }, null, 2)}\n`;
}

/** Removes our entries; drops events left empty, and `hooks` when nothing is left. Leaves anything that is not a JSON object alone. */
export function stripCursorHooks(current: string): string {
  if (!current.trim()) return current;
  const file = asObject(JSON.parse(current) as unknown);
  if (!file) return current;
  const hooks = asObject(file.hooks);
  if (hooks) {
    for (const key of Object.keys(hooks)) {
      if (!Array.isArray(hooks[key])) continue;
      const kept = (hooks[key] as CursorEntry[]).filter((e) => !isOurCursorEntry(e));
      if (kept.length) hooks[key] = kept;
      else delete hooks[key];
    }
    if (Object.keys(hooks).length === 0) delete file.hooks;
  }
  return `${JSON.stringify(file, null, 2)}\n`;
}

/**
 * True when a hooks.json holds nothing but Cursor's own `version`: what `stripCursorHooks` leaves of
 * a file termhub created itself. Uninstall deletes such a file instead of writing it back. Anything
 * the person has in it (another key, a hook of their own) makes this false, and so does a file that
 * is empty or that we cannot parse: those are never ours to delete.
 */
export function isBareCursorHooks(body: string): boolean {
  if (!body.trim()) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }
  const file = asObject(parsed);
  return file !== null && Object.keys(file).every((key) => key === 'version');
}
