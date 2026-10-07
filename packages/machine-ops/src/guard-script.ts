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

import { shellQuote } from './shell.js';

export const GUARD_SCRIPT_REL = '.termhub/bin/termhub-guard';

/**
 * Claude Code's PreToolUse hook decision to block a tool call: `permissionDecision: "deny"` with a
 * reason the model sees. Printed on stdout; the script prints nothing to allow (Claude Code reads an
 * empty decision as "no opinion", and the allow list / mode decide).
 */
const DENY_PREFIX = '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"termhub: ';

/**
 * The guard script. Reads the PreToolUse JSON on stdin; `$1` is the run's branch, `$2` the worktree
 * (both server-built and shell-quoted on the launch line). It extracts the tool name, and for `Bash`
 * the command, for a file tool the path, with the same first-key parsing the monitor hook uses, then
 * denies by rule. Every rule errs toward denying: an unknown or unparsable dangerous shape is blocked,
 * never waved through. On allow it prints nothing and exits 0.
 *
 * POSIX sh only (macOS /bin/sh is bash; Linux dash): no arrays, no `[[`, no non-POSIX `grep -P`.
 */
export const GUARD_SCRIPT = `#!/bin/sh
# termhub hard-lock hook — installed by termhub. Denies the actions an automatic run must never take,
# whatever its permission mode. Safe to delete together with the --settings file that points at it.
BRANCH="\${1:-}"
WORKTREE="\${2:-}"
EVENT=$(cat 2>/dev/null)
[ -n "$EVENT" ] || exit 0
deny() {
  printf '%s%s"}}\\n' '${DENY_PREFIX}' "$1"
  exit 0
}
# The tool name is the first "tool_name" of the payload (Claude Code serialises it before tool_input),
# same rule as the monitor hook: cut the shortest prefix so a "tool_name" nested in the input never wins.
REST=\${EVENT#*'"tool_name"'}
[ "$REST" != "$EVENT" ] || exit 0
REST=\${REST#*'"'}
NAME=\${REST%%'"'*}

case "$NAME" in
  Bash)
    # The command, as the first "command" string of tool_input. A command we cannot read is denied:
    # the guard never lets a Bash call through without seeing it.
    C=\${EVENT#*'"command"'}
    [ "$C" != "$EVENT" ] || deny 'comando Bash ilegivel'
    C=\${C#*'"'}
    CMD=\${C%%'"'*}
    # JSON escapes the model may send inside the command string: unescape the ones that change meaning
    # for the matching below (a literal \\" or \\\\ in the command). A newline stays as the two bytes \\n,
    # which the token scan treats as a separator anyway.
    CMD=$(printf '%s' "$CMD" | sed 's/\\\\"/"/g; s/\\\\\\\\/\\\\/g')
    # Squash runs of blanks to one space, so "git   push" reads as "git push".
    SQ=$(printf '%s' "$CMD" | tr '\\t' ' ' | tr -s ' ')
    LOW=$(printf '%s' "$SQ" | tr 'A-Z' 'a-z')

    # 1. git push: only the run's own branch, and only the plain forms. Any other push is denied —
    # force/delete/mirror, a push to another ref, a push with no branch we can see. The allowed forms
    # are the exact ones the server pre-allows (branchPushRules); compared on the squashed command.
    case "$SQ" in
      *'git push'* | *'git '*' push'*)
        ALLOWED=0
        if [ -n "$BRANCH" ]; then
          case "$SQ" in
            "git push -u origin $BRANCH" | "git push origin $BRANCH" | \\
            "git push -u origin HEAD:refs/heads/$BRANCH" | "git push origin HEAD:refs/heads/$BRANCH")
              ALLOWED=1 ;;
          esac
        fi
        [ "$ALLOWED" = 1 ] || deny 'push so para a branch da run'
        ;;
    esac

    # 2. dangerous programs / subcommands, matched on token boundaries (a space on each side of the
    # squashed, lowercased command). Denied whatever the mode: merge/deploy/publish/release, store and
    # EAS, reaching another machine, the database, docker.
    P=" $LOW "
    case "$P" in
      *' gh pr merge '* | *' gh merge '*) deny 'gh pr merge e trava dura' ;;
      *' gh workflow '*) deny 'gh workflow e trava dura' ;;
      *' gh release '*) deny 'gh release e trava dura' ;;
      *' gh secret '*) deny 'gh secret e trava dura' ;;
      *' gh api '*) deny 'gh api e trava dura' ;;
      *' gh repo '*) deny 'gh repo e trava dura' ;;
    esac
    case "$P" in
      *' npm publish '* | *' pnpm publish '* | *' yarn publish '*) deny 'publish e trava dura' ;;
      *' npm run release'* | *' npm run release:'* ) deny 'release e trava dura' ;;
      *' eas '* | *' eas-cli '* | *' npx eas '* | *' fastlane '*) deny 'lojas e EAS e trava dura' ;;
    esac
    case "$P" in
      *' docker '* | *' docker-compose '*) deny 'docker e trava dura' ;;
      *' ssh '* | *' scp '* | *' rsync '* | *' kubectl '*) deny 'acesso a outra maquina e trava dura' ;;
      *' psql '*) deny 'psql e trava dura' ;;
      *' security '*) deny 'security e trava dura' ;;
    esac

    # 3. rm -r / -rf: allowed only wholly inside the worktree (or /tmp). Any rm -r with a path outside,
    # with .. , with ~ or $HOME, or that we cannot pin to the worktree, is denied.
    case "$P" in
      *' rm '*' -r'* | *' rm -r'* | *' rm '*' -fr'* | *' rm '*' -rf'*)
        BAD=0
        # a relative escape or the home via ~ / $HOME; absolute paths are judged per token below
        case "$SQ" in *'..'* | *'~'* | *'$HOME'*) BAD=1 ;; esac
        # an absolute path that is not the worktree, not under it, and not /tmp
        for w in $SQ; do
          case "$w" in
            -*) continue ;;
            /tmp | /tmp/*) continue ;;
            /*)
              case "$w" in "$WORKTREE" | "$WORKTREE"/*) : ;; *) BAD=1 ;; esac
              ;;
          esac
        done
        [ "$BAD" = 0 ] || deny 'rm -rf so dentro da worktree ou em /tmp'
        ;;
    esac

    # 4. credential files, anywhere in the command (a cat/head/tail the read list allows could reach them).
    for w in $SQ; do
      case "$w" in
        *.env | *.env.* | */.env | */.env.* | .env | .env.*) deny 'arquivo .env e trava dura' ;;
        *.npmrc | */.npmrc) deny '.npmrc e trava dura' ;;
        *.netrc | */.netrc) deny '.netrc e trava dura' ;;
        *.git-credentials) deny 'credenciais git e trava dura' ;;
        */.ssh | */.ssh/*) deny '.ssh e trava dura' ;;
        */.termhub/config.json | */.termhub/hook.env | */.termhub/tabs | */.termhub/tabs/*) deny '~/.termhub e trava dura' ;;
        *.credentials.json) deny 'credenciais e trava dura' ;;
      esac
    done
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
