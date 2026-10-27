/**
 * The hard-lock PreToolUse hook for automatic tabs (TER-993). Unlike the monitor hook
 * (`hooks.ts`), which never decides, this one answers Claude Code's PreToolUse with a `deny`
 * for the handful of actions an automatic run must never take, whatever its permission mode —
 * so a run in `auto` mode, where Claude Code's own classifier answers what no rule covers, still
 * cannot push to another ref, merge, deploy, publish, reach another machine, delete outside its
 * worktree or read a credential. The `--disallowedTools` list is the first wall and this is the
 * second: it beats the allow list, the classifier and `acceptEdits` alike.
 *
 * It is scoped to automatic tabs by how it is installed: only an automatic run's launch line passes
 * `--settings <the per-tab guard settings file>` (`buildGuardSettings`), which registers this script
 * as a PreToolUse hook with the run's branch and worktree baked into its argv. A manual tab and a
 * `start_agent` tab never get it. The script itself lives at `~/.termhub/bin/termhub-guard`, written
 * by the agent next to the monitor hook.
 */

import { HOOK_ENV_REL } from './hooks.js';
import { shellQuote } from './shell.js';

export const GUARD_SCRIPT_REL = '.termhub/bin/termhub-guard';

/**
 * The guard's version, also written in the script's header (`# termhub-guard v3`). 2 (spec 2026-10-07
 * multi-repo R13): the push rule also takes `git -C <WORKTREE>/<key> push …`, for a multi-repo run, whose
 * `WORKTREE` is the workspace root (`MULTI_REPO_GUARD_MIN_AGENT_VERSION`). 3 (TER-1111): a Bash command is
 * read whole, quotes and escapes included, and split into simple commands (`GUARD_AWK`); v2 cut it at the
 * first `"`, so whatever came after a quote was never checked. The run's push may now end a chain and take
 * `-q`, `2>&1` and `| tail -N`. The server asks for it by agent version (`GUARD_MIN_AGENT_VERSION`).
 */
export const GUARD_SCRIPT_VERSION = 3;

/**
 * Claude Code's PreToolUse hook decision to block a tool call: `permissionDecision: "deny"` with a
 * reason the model sees. Printed on stdout; the script prints nothing to allow (Claude Code reads an
 * empty decision as "no opinion", and the allow list / mode decide).
 */
const DENY_PREFIX = '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"termhub: ';

/**
 * The Bash rules of the guard (v3, TER-1111), as a POSIX awk program: it reads the PreToolUse JSON on
 * stdin, the run's branch in `ENVIRON["B"]` and its worktree in `ENVIRON["W"]`, and prints `OK` or the
 * reason of a deny. Anything it cannot read prints a reason too, and a crash prints nothing, which the
 * script also denies: the guard never lets a Bash call through without having read it.
 *
 * 1. The `command` string of `tool_input`, JSON escapes decoded (`\"`, `\\`, `\n`, `\uXXXX`).
 * 2. A small shell lexer splits it into simple commands (`;`, `&&`, `||`, `|`, `&`, newline), with their
 *    connector and depth: quotes are joined into one word (blanks inside it become `\037`, so a quoted
 *    message never matches a word rule), `$( )`, backticks and `( )` are read as commands one level down,
 *    a heredoc body is data (only its `$( )` is read, when the delimiter is unquoted), and the string of
 *    `sh -c` / `bash -c` / `eval` is read as commands too.
 * 3. The rules, per simple command: the blocked programs on word boundaries; git aliases; `rm -r` only
 *    inside the worktree or /tmp (and no `cd` elsewhere in the same command); credential files in any word;
 *    and every `git … push`, which must be one of the run's exact pushes, at the top level, the last command
 *    (only `| tail -N` after it), with `-q`, `--quiet` and `2>&1` allowed, no `GIT_*=` and no `cd` elsewhere.
 *
 * Written for String.raw: no backtick and no dollar-brace in it, and no single quote, since the script wraps
 * it in one (those characters come from `sprintf("%c")`). `LC_ALL=C` keeps every awk on bytes.
 */
const GUARD_AWK = String.raw`
function fail(why) { if (ERR == "") ERR = why; return "" }
function base(p) { sub(/.*\//, "", p); return p }
function unsp(p) { gsub(/\037/, " ", p); return p }

function jcmd(ev,   i, s, n, j, c, e, h, out) {
  i = index(ev, "\"tool_input\"")
  if (!i) return fail("comando Bash ilegivel")
  s = substr(ev, i + 12)
  while (1) {
    i = index(s, "\"command\"")
    if (!i) return fail("comando Bash ilegivel")
    s = substr(s, i + 9)
    if (match(s, /^[ \t\r\n]*:[ \t\r\n]*"/)) break
  }
  s = substr(s, RLENGTH + 1)
  n = length(s); out = ""
  for (j = 1; j <= n; j++) {
    c = substr(s, j, 1)
    if (c == "\"") return out
    if (c != "\\") { out = out c; continue }
    j++; e = substr(s, j, 1)
    if (e == "\"" || e == "\\" || e == "/") out = out e
    else if (e == "n") out = out "\n"
    else if (e == "t" || e == "r" || e == "b" || e == "f") out = out " "
    else if (e == "u") {
      h = tolower(substr(s, j + 1, 4)); j += 4
      if (h == "000a") out = out "\n"
      else if (h ~ /^00[01][0-9a-f]$/) out = out " "
      else return fail("comando Bash ilegivel")
    } else return fail("comando Bash ilegivel")
  }
  return fail("comando Bash ilegivel")
}

function endword() { if (INW) WS = WS " " W; W = ""; INW = 0 }
function endseg(conn, depth) {
  endword()
  if (WS != "") { SEGN++; SEGW[SEGN] = substr(WS, 2); SEGC[SEGN] = conn; SEGD[SEGN] = depth }
  WS = ""
}
function sub_parse(depth, closer,   w0, i0, ws0, r) {
  w0 = W; i0 = INW; ws0 = WS
  W = ""; INW = 0; WS = ""
  r = parse(depth, closer)
  W = w0; INW = i0; WS = ws0
  return r
}
function sub_text(t, depth, dq,   s0, l0, p0, w0, i0, ws0, r) {
  s0 = S; l0 = L; p0 = P; w0 = W; i0 = INW; ws0 = WS
  S = t; L = length(t); P = 1; W = ""; INW = 0; WS = ""
  r = dq ? dquote(depth, 0) : parse(depth, "")
  S = s0; L = l0; P = p0; W = w0; INW = i0; WS = ws0
  return r
}

function parse(depth, closer,   c, n, conn) {
  if (depth > 40) { fail("comando Bash ilegivel"); return 0 }
  conn = "S"
  while (P <= L) {
    c = substr(S, P, 1); n = substr(S, P + 1, 1)
    if (closer != "" && c == closer) { endseg(conn, depth); P++; return 1 }
    if (c == " " || c == "\t" || c == "\r") { endword(); P++; continue }
    if (c == "\n") { endseg(conn, depth); conn = "S"; P++; if (!heredocs(depth)) return 0; continue }
    if (c == ";") { endseg(conn, depth); conn = "S"; P++; continue }
    if (c == "&" && n == "&") { endseg(conn, depth); conn = "A"; P += 2; continue }
    if (c == "|" && n == "|") { endseg(conn, depth); conn = "O"; P += 2; continue }
    if (c == "|") { endseg(conn, depth); conn = "P"; P += (n == "&") ? 2 : 1; continue }
    if (c == "&" && n != ">") { endseg(conn, depth); conn = "B"; P++; continue }
    if (c == "(") { endseg(conn, depth); P++; if (!sub_parse(depth + 1, ")")) return 0; conn = "S"; continue }
    if (c == ")") { endseg(conn, depth); conn = "S"; P++; continue }
    if (c == "<" || c == ">" || c == "&") { if (!redir()) return 0; continue }
    if (c == "#" && !INW) { while (P <= L && substr(S, P, 1) != "\n") P++; continue }
    if (!wordpart(depth)) return 0
  }
  if (closer != "") { fail("comando Bash ilegivel"); return 0 }
  endseg(conn, depth)
  return 1
}

function redir(   fd, op, two) {
  fd = ""
  if (INW && W ~ /^[0-9]+$/) { fd = W; W = ""; INW = 0 } else endword()
  two = substr(S, P, 2)
  if (two == "<<") {
    P += 2
    if (substr(S, P, 1) == "-") { P++; return heredoc_delim(1) }
    return heredoc_delim(0)
  }
  if (two == ">>" || two == ">&" || two == ">|" || two == "<&" || two == "<>" || two == "&>") { op = two; P += 2 } else { op = substr(S, P, 1); P++ }
  if (op == "&>" && substr(S, P, 1) == ">") { op = "&>>"; P++ }
  while (P <= L && (substr(S, P, 1) == " " || substr(S, P, 1) == "\t")) P++
  W = fd op; INW = 1
  return 1
}

function heredoc_delim(dash,   c, d, q, e) {
  while (P <= L && (substr(S, P, 1) == " " || substr(S, P, 1) == "\t")) P++
  d = ""; q = 0
  while (P <= L) {
    c = substr(S, P, 1)
    if (c == " " || c == "\t" || c == "\n" || index(";&|<>()", c)) break
    if (c == SQ || c == "\"") {
      e = index(substr(S, P + 1), c)
      if (!e) { fail("comando Bash ilegivel"); return 0 }
      d = d substr(S, P + 1, e - 1); P += e + 1; q = 1; continue
    }
    if (c == "\\") { d = d substr(S, P + 1, 1); P += 2; q = 1; continue }
    d = d c; P++
  }
  if (d == "") { fail("comando Bash ilegivel"); return 0 }
  NHD++; HD[NHD] = d; HDQ[NHD] = q; HDT[NHD] = dash
  W = "<<" d; INW = 1; endword()
  return 1
}

function heredocs(depth,   i, e, line, body) {
  for (i = 1; i <= NHD; i++) {
    body = ""
    while (P <= L) {
      e = index(substr(S, P), "\n")
      if (e) { line = substr(S, P, e - 1); P += e } else { line = substr(S, P); P = L + 1 }
      if (HDT[i]) sub(/^\t+/, "", line)
      if (line == HD[i]) break
      body = body line "\n"
    }
    if (!HDQ[i] && (index(body, "$(") || index(body, BQ))) { if (!sub_text(body, depth + 1, 1)) return 0 }
  }
  NHD = 0
  return 1
}

function wordpart(depth,   c, n, e, t) {
  c = substr(S, P, 1); n = substr(S, P + 1, 1)
  if (c == "\\") { if (n != "\n") { W = W n; INW = 1 }; P += 2; return 1 }
  if (c == SQ) {
    e = index(substr(S, P + 1), SQ)
    if (!e) { fail("comando Bash ilegivel"); return 0 }
    t = substr(S, P + 1, e - 1); gsub(/[ \t\r\n]/, "\037", t)
    W = W t; INW = 1; P += e + 1; return 1
  }
  if (c == "\"") { P++; INW = 1; return dquote(depth, 1) }
  if (c == "$" && (n == SQ || n == "\"")) { fail("comando Bash ilegivel"); return 0 }
  if (c == "$" && n == "(") { P += 2; W = W "$()"; INW = 1; return sub_parse(depth + 1, ")") }
  if (c == "$" && n == "{") {
    e = index(substr(S, P), "}")
    t = substr(S, P, e)
    if (!e || index(t, "$(") || index(t, BQ)) { fail("comando Bash ilegivel"); return 0 }
    W = W t; INW = 1; P += e; return 1
  }
  if (c == BQ) { P++; W = W "$()"; INW = 1; return sub_parse(depth + 1, BQ) }
  W = W c; INW = 1; P++
  return 1
}

function dquote(depth, term,   c, n) {
  while (P <= L) {
    c = substr(S, P, 1); n = substr(S, P + 1, 1)
    if (term && c == "\"") { P++; return 1 }
    if (c == "\\" && (n == "\"" || n == "\\" || n == "$" || n == BQ)) { W = W n; P += 2; continue }
    if (c == "\\" && n == "\n") { P += 2; continue }
    if (c == "$" && n == "(") { P += 2; W = W "$()"; if (!sub_parse(depth + 1, ")")) return 0; continue }
    if (c == BQ) { P++; W = W "$()"; if (!sub_parse(depth + 1, BQ)) return 0; continue }
    if (c == " " || c == "\t" || c == "\r" || c == "\n") c = "\037"
    W = W c; P++
  }
  if (term) { fail("comando Bash ilegivel"); return 0 }
  return 1
}

function pathok(p) {
  if (index(p, "..") || index(p, "~") || index(p, "$")) return 0
  if (p !~ /^\//) return 1
  if (p == "/tmp" || index(p, "/tmp/") == 1) return 1
  return WT != "" && (p == WT || index(p, WT "/") == 1)
}
function repokey(k) { return k ~ /^[A-Za-z0-9][A-Za-z0-9._-]*$/ && !index(k, "..") }
function pushdir(p,   k) {
  if (WT == "") return 0
  if (p == WT || p == WT "/") return 1
  if (index(p, WT "/") != 1) return 0
  k = substr(p, length(WT) + 2); sub(/\/$/, "", k)
  return repokey(k)
}

function cred(p) {
  if (p !~ /process\.env|meta\.env/ && (p ~ /\.env$/ || p ~ /\.env\./)) return "arquivo .env e trava dura"
  if (p ~ /\.npmrc$/) return ".npmrc e trava dura"
  if (p ~ /\.netrc$/) return ".netrc e trava dura"
  if (p ~ /\.git-credentials$/) return "credenciais git e trava dura"
  if (p ~ /\/\.ssh(\/|$)/) return ".ssh e trava dura"
  if (p ~ /\/\.termhub\/(config\.json|hook\.env|tabs)(\/|$)/) return "~/.termhub e trava dura"
  if (p ~ /\.credentials\.json$/) return "credenciais e trava dura"
  return ""
}

function programs(line) {
  if (index(line, " gh pr merge ") || index(line, " gh merge ")) return "gh pr merge e trava dura"
  if (index(line, " gh workflow ")) return "gh workflow e trava dura"
  if (index(line, " gh release ")) return "gh release e trava dura"
  if (index(line, " gh secret ")) return "gh secret e trava dura"
  if (index(line, " gh api ")) return "gh api e trava dura"
  if (index(line, " gh repo ")) return "gh repo e trava dura"
  if (index(line, " npm publish ") || index(line, " pnpm publish ") || index(line, " yarn publish ")) return "publish e trava dura"
  if (index(line, " npm run release")) return "release e trava dura"
  if (index(line, " eas ") || index(line, " eas-cli ") || index(line, " npx eas ") || index(line, " fastlane ")) return "lojas e EAS e trava dura"
  if (index(line, " docker ") || index(line, " docker-compose ")) return "docker e trava dura"
  if (index(line, " ssh ") || index(line, " scp ") || index(line, " rsync ") || index(line, " kubectl ")) return "acesso a outra maquina e trava dura"
  if (index(line, " psql ")) return "psql e trava dura"
  if (index(line, " security ")) return "security e trava dura"
  return ""
}

function pushok(s,   w, n, i, t, rest, key) {
  if (BR == "") return 0
  n = split(s, w, " ")
  if (w[1] != "git") return 0
  t = "git"
  for (i = 2; i <= n; i++) if (w[i] != "-q" && w[i] != "--quiet" && w[i] != "2>&1") t = t " " w[i]
  if (WT != "" && index(t, "git -C " WT "/") == 1) {
    rest = substr(t, length("git -C " WT "/") + 1)
    key = rest; sub(/ .*/, "", key)
    if (repokey(key)) t = "git " substr(rest, length(key) + 2)
  }
  return t == "git push -u origin " BR || t == "git push origin " BR || t == "git push -u origin HEAD:refs/heads/" BR || t == "git push origin HEAD:refs/heads/" BR
}
function tailok(s,   w, n) {
  n = split(s, w, " ")
  if (w[1] != "tail") return 0
  return (n == 2 && w[2] ~ /^-n?[0-9]+$/) || (n == 3 && w[2] == "-n" && w[3] ~ /^[0-9]+$/)
}
function pushmsg(   b) {
  if (BR == "") return "push negado: esta run nao tem branch"
  b = BR ~ /^[A-Za-z0-9._\/-]+$/ ? BR : "<branch da run>"
  return "push so para a branch da run: use exatamente git push -u origin " b " como ultimo comando (no fim so -q, 2>&1 ou | tail -N; nada depois com && ou ;)"
}

function rules(   k, n, w, i, j, b, s, line, r, np, pk, rmk, rmbad, cdbad, cdpush, gitenv) {
  np = 0; pk = 0; rmk = 0; rmbad = 0; cdbad = 0; cdpush = 0; gitenv = 0
  for (k = 1; k <= SEGN; k++) {
    n = split(SEGW[k], w, " ")
    for (i = 1; i <= n; i++) {
      b = base(w[i])
      if ((b == "sh" || b == "bash" || b == "zsh" || b == "dash" || b == "ksh") && i + 2 <= n && w[i + 1] ~ /^-[a-z]*c[a-z]*$/)
        if (!sub_text(unsp(w[i + 2]), SEGD[k] + 10, 0)) return ERR
      if (b == "eval" && i < n) {
        s = ""
        for (j = i + 1; j <= n; j++) s = s " " unsp(w[j])
        if (!sub_text(s, SEGD[k] + 10, 0)) return ERR
      }
      if (w[i] ~ /^GIT_[A-Za-z0-9_]*=/) gitenv = 1
      r = cred(w[i]); if (r != "") return r
    }

    line = " " tolower(base(w[1]))
    for (i = 2; i <= n; i++) line = line " " tolower(w[i])
    r = programs(line " "); if (r != "") return r

    for (i = 1; i <= n; i++) if (base(w[i]) == "git") break
    for (j = i + 1; j <= n; j++) {
      s = tolower(w[j])
      if (s ~ /^(-c)?alias\./ || s ~ /^--config-env=alias\./) return "alias de git e trava dura"
      if (w[j] == "push") { np++; pk = k }
    }

    b = base(w[1])
    if (b == "cd" || b == "pushd" || b == "popd") {
      if (n < 2 || w[2] == "-" || !pathok(w[2])) cdbad = 1
      if (n != 2 || !pushdir(w[2])) cdpush = 1
    }

    for (i = 1; i <= n; i++) if (base(w[i]) == "rm") break
    if (i <= n) {
      r = 0
      for (j = i + 1; j <= n; j++) if (w[j] ~ /^-[A-Za-z]*[rR]/ || w[j] == "--recursive") r = 1
      if (r) {
        rmk = 1
        for (j = i + 1; j <= n; j++) if (w[j] !~ /^-/ && !pathok(w[j])) rmbad = 1
      }
    }
  }

  if (np > 0) {
    if (np > 1 || SEGD[pk] != 0 || gitenv || cdpush || !pushok(SEGW[pk])) return pushmsg()
    if (pk < SEGN && (pk + 1 < SEGN || SEGC[pk + 1] != "P" || SEGD[pk + 1] != 0 || !tailok(SEGW[pk + 1]))) return pushmsg()
  }
  if (rmk && (rmbad || cdbad)) return "rm -rf so dentro da worktree ou em /tmp"
  return ""
}

BEGIN { SQ = sprintf("%c", 39); BQ = sprintf("%c", 96) }
{ EV = EV (NR > 1 ? "\n" : "") $0 }
END {
  BR = ENVIRON["B"]; WT = ENVIRON["W"]; sub(/\/+$/, "", WT)
  S = jcmd(EV)
  if (ERR != "") { print ERR; exit }
  L = length(S); P = 1
  if (!parse(0, "")) { print (ERR != "" ? ERR : "comando Bash ilegivel"); exit }
  r = rules()
  print (r != "" ? r : (ERR != "" ? ERR : "OK"))
}
`;

/**
 * The guard script. Reads the PreToolUse JSON on stdin; `$1` is the run's branch, `$2` the worktree
 * (both server-built and shell-quoted on the launch line; for a multi-repo run `$2` is the workspace
 * root, which holds one worktree per repo). It extracts the tool name; a `Bash` command goes to
 * `GUARD_AWK`, which reads it whole; for a file tool it takes the path with the same first-key parsing the
 * monitor hook uses. Then it denies by rule. Every rule errs toward denying: an unknown or unparsable
 * dangerous shape is blocked, never waved through. On allow it prints nothing and exits 0.
 *
 * POSIX sh and awk only (macOS /bin/sh is bash; Linux dash; mawk, gawk, BWK awk): no arrays in sh, no `[[`,
 * no non-POSIX `grep -P`.
 */
export const GUARD_SCRIPT = `#!/bin/sh
# termhub-guard v${GUARD_SCRIPT_VERSION}
# termhub hard-lock hook — installed by termhub. Denies the actions an automatic run must never take,
# whatever its permission mode. Safe to delete together with the --settings file that points at it.
BRANCH="\${1:-}"
WORKTREE="\${2:-}"
EVENT=$(cat 2>/dev/null)
[ -n "$EVENT" ] || exit 0
# The tool name is the first "tool_name" of the payload (Claude Code serialises it before tool_input),
# same rule as the monitor hook: cut the shortest prefix so a "tool_name" nested in the input never wins.
REST=\${EVENT#*'"tool_name"'}
[ "$REST" != "$EVENT" ] || exit 0
REST=\${REST#*'"'}
NAME=\${REST%%'"'*}
case "$NAME" in '' | *[!A-Za-z0-9_.-]*) NAME= ;; esac
# Tell termhub a block happened (TER-993), so the feed shows it: the tool and a short reason, never the
# command. Best effort, in the background, and only when the monitor hook's env and a tmux session are
# here (the guard runs inside Claude Code, which sets TMUX_PANE). The URL is the monitor's with /events
# swapped for /guard. Any failure is silent: a block must never depend on the network.
report() {
  [ -n "$NAME" ] || return 0
  [ -f "$HOME/${HOOK_ENV_REL}" ] || return 0
  ( . "$HOME/${HOOK_ENV_REL}" 2>/dev/null
    [ -n "$TERMHUB_HOOK_URL" ] && [ -n "$TERMHUB_HOOK_TOKEN" ] && [ -n "$TMUX_PANE" ] || exit 0
    PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
    S=$(tmux display-message -p -t "$TMUX_PANE" '#{session_name}' 2>/dev/null) || exit 0
    [ -n "$S" ] || exit 0
    GURL=\${TERMHUB_HOOK_URL%/events}/guard
    printf '{"session":"%s","tool":"%s","reason":"%s"}' "$S" "$NAME" "$1" |
      curl -s -m 5 -o /dev/null -X POST "$GURL" \\
        -H "authorization: Bearer $TERMHUB_HOOK_TOKEN" -H 'content-type: application/json' --data-binary @- >/dev/null 2>&1 &
  ) >/dev/null 2>&1
}
deny() {
  report "$1"
  printf '%s%s"}}\\n' '${DENY_PREFIX}' "$1"
  exit 0
}

case "$NAME" in
  Bash)
    # v3 (TER-1111): the whole command, read by the awk program below, which prints OK or why it denies:
    # the run's own push only (as the last command), the blocked programs, rm -r outside the worktree,
    # credential files. No output at all (awk missing or crashed) is a deny too: a command we cannot read
    # never goes through.
    R=$(printf '%s' "$EVENT" | B="$BRANCH" W="$WORKTREE" LC_ALL=C awk '${GUARD_AWK}' 2>/dev/null)
    case "$R" in
      OK) ;;
      '') deny 'comando Bash ilegivel' ;;
      *) deny "$R" ;;
    esac
    ;;

  Read | Edit | Write | MultiEdit | NotebookEdit)
    # The path is the first "file_path" (Edit/Write/Read) or "notebook_path" of tool_input.
    F=\${EVENT#*'"file_path"'}
    if [ "$F" = "$EVENT" ]; then F=\${EVENT#*'"notebook_path"'}; fi
    [ "$F" != "$EVENT" ] || exit 0
    F=\${F#*'"'}
    FP=\${F%%'"'*}
    FP=$(printf '%s' "$FP" | sed 's/\\\\"/"/g; s/\\\\\\\\/\\\\/g')
    case "$FP" in
      *.env | *.env.* | .env | .env.*) deny 'arquivo .env e trava dura' ;;
      *.npmrc) deny '.npmrc e trava dura' ;;
      *.netrc) deny '.netrc e trava dura' ;;
      *.git-credentials) deny 'credenciais git e trava dura' ;;
      */.ssh/* | */.ssh) deny '.ssh e trava dura' ;;
      */.termhub/config.json | */.termhub/hook.env | */.termhub/tabs | */.termhub/tabs/*) deny '~/.termhub e trava dura' ;;
      *.credentials.json) deny 'credenciais e trava dura' ;;
    esac
    # Writes/edits outside the worktree (an absolute path not under it) are denied; /tmp is allowed, and
    # a relative path resolves against the worktree (the tab's cwd) so it is fine. A path with .. is denied.
    case "$NAME" in
      Read) : ;;
      *)
        case "$FP" in
          *'..'*) deny 'escrita fora da worktree e trava dura' ;;
          /tmp | /tmp/*) : ;;
          /*)
            case "$FP" in "$WORKTREE" | "$WORKTREE"/*) : ;; *) deny 'escrita fora da worktree e trava dura' ;; esac
            ;;
        esac
        ;;
    esac
    ;;
esac
exit 0
`;

/**
 * The per-tab `--settings` file an automatic run's launch line points at (TER-993): a settings JSON that
 * registers `~/.termhub/bin/termhub-guard` as a PreToolUse hook for every tool (`matcher: "*"`), with the
 * run's `branch` and `worktree` as its argv. `$HOME` is left for the machine's shell to expand (the file
 * is JSON, so the command is a plain string); the branch and worktree are JSON-escaped. A short timeout:
 * the script is local and does no network call.
 */
export function buildGuardSettings(branch: string | null, worktree: string): string {
  const command = `"$HOME/${GUARD_SCRIPT_REL}" ${shellQuote(branch ?? '')} ${shellQuote(worktree)}`;
  const settings = {
    hooks: {
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command, timeout: 10 }] }],
    },
  };
  return `${JSON.stringify(settings, null, 2)}\n`;
}
