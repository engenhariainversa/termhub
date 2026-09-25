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
 * reads as "no decision" — our hook never allows or denies (hook-script.test.ts keeps stdout empty). */
export const CLAUDE_HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'Notification', 'Stop', 'SessionEnd'] as const;

/** Events Claude Code runs per tool: their entry needs a matcher ('*' = every tool). */
const CLAUDE_TOOL_EVENTS: ReadonlySet<string> = new Set(['PreToolUse', 'PermissionRequest']);

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
# Safe to delete (also remove the entries in ~/.claude/settings.json, ~/.codex/config.toml and
# ~/.cursor/hooks.json).
TOOL="\${1:-claude}"
[ -f "$HOME/${HOOK_ENV_REL}" ] || exit 0
. "$HOME/${HOOK_ENV_REL}"
[ -n "$TERMHUB_HOOK_URL" ] && [ -n "$TERMHUB_HOOK_TOKEN" ] || exit 0
[ -n "$TMUX_PANE" ] || exit 0
PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
SESSION=$(tmux display-message -p -t "$TMUX_PANE" '#{session_name}' 2>/dev/null) || exit 0
[ -n "$SESSION" ] || exit 0
if [ "$TOOL" = codex ]; then EVENT="$2"; else EVENT=$(cat 2>/dev/null); fi
[ -n "$EVENT" ] || EVENT='{}'
# Tool calls: only the tool's name travels (never its input), with the spinner's verb when one is on
# screen, and only when the pair changed since the last one for this session — twenty edits in a row
# are one request as long as the verb stays the same (a new verb mid-run is a new request). The marker is per tmux
# session, under TMPDIR, with the session name reduced to filename-safe characters.
# AskUserQuestion is the one exception (below).
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
case "$KIND" in
  PreToolUse)
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
    # AskUserQuestion's input is the question itself, written to be shown to the person (spec
    # 2026-09-25 §4.1): the whole event goes as it came — the server keeps tool_use_id and
    # tool_input and drops the rest — and the marker is neither read nor written, so two questions
    # in a row are two questions. NAME is real only when $REST (everything from the first "tool_name"
    # on) holds no SECOND "tool_name": a real question never repeats that key, so a second one means
    # the first was actually nested inside another tool's tool_input (tool_input serialised before
    # tool_name) and NAME does not name the real tool — fall back to the ordinary name-only path below
    # (which, worst case, mislabels that one event; it never forwards the input).
    ASK=false
    if [ "$NAME" = AskUserQuestion ]; then
      case "$REST" in
        *'"tool_name"'*) ;;
        *) ASK=true ;;
      esac
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
      VERB=$(tmux capture-pane -p -t "$TMUX_PANE" 2>/dev/null | LC_ALL=C grep -v '^[[:space:]]*$' 2>/dev/null | tail -n 24 |
        LC_ALL=C sed -n -E 's/^(·|✢|✳|✶|✻|✽|\\*) ([A-Za-z]{2,24})(…|\\.\\.\\.)( .*)?$/\\2/p' | tail -n 1)
      case "$VERB" in *[!A-Za-z]*) VERB= ;; esac
      [ "\${#VERB}" -le 24 ] || VERB=
      KEY="$NAME\${VERB:+ $VERB}"
      [ "$(cat "$MARK" 2>/dev/null)" = "$KEY" ] && exit 0
      printf '%s' "$KEY" 2>/dev/null > "$MARK"
      if [ -n "$VERB" ]; then
        EVENT=$(printf '{"hook_event_name":"PreToolUse","tool_name":"%s","verb":"%s"}' "$NAME" "$VERB")
      else
        EVENT=$(printf '{"hook_event_name":"PreToolUse","tool_name":"%s"}' "$NAME")
      fi
    fi
    ;;
  PermissionRequest)
    # A permission prompt: only the tool's name travels, exactly like a tool call (never its input,
    # never the suggestions). AskUserQuestion's own prompt is dropped — its PreToolUse already carried
    # the question. Same first-"tool_name" rule and character set as above.
    REST=\${EVENT#*'"tool_name"'}
    [ "$REST" != "$EVENT" ] || exit 0
    REST=\${REST#*'"'}
    NAME=\${REST%%'"'*}
    case "$NAME" in '' | *[!A-Za-z0-9_.-]* | AskUserQuestion) exit 0 ;; esac
    EVENT=$(printf '{"hook_event_name":"PermissionRequest","tool_name":"%s"}' "$NAME")
    ;;
  # A new turn starts fresh, and so does an answered notification: a permission prompt takes the tab
  # out of working, and the tool the person approves is the same one that set the marker, so without
  # this reset the retry is suppressed and nothing says the tab is working again.
  SessionStart | UserPromptSubmit | Notification)
    rm -f "$MARK"
    ;;
esac
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

/** Merges our entries into Claude Code's settings.json; keeps everything else. Throws on a file that is not a JSON object. */
export function mergeClaudeSettings(current: string, scriptPath: string, shown = '~/.claude/settings.json'): string {
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
  for (const event of CLAUDE_HOOK_EVENTS) {
    const list = (Array.isArray(next[event]) ? next[event] : []) as HookEntry[];
    const others = list.filter((e) => !isOurs(e));
    const entry: HookEntry = { hooks: [{ type: 'command', command: `${scriptPath} claude`, timeout: 10 } as { type: string; command: string }] };
    // A tool event's entry is filtered by tool name; '*' says every tool explicitly (so would no matcher).
    if (CLAUDE_TOOL_EVENTS.has(event)) entry.matcher = '*';
    others.push(entry);
    next[event] = others;
  }
  settings.hooks = next;
  return `${JSON.stringify(settings, null, 2)}\n`;
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
