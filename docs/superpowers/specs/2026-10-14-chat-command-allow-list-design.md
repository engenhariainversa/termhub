# Chat: allow list of commands for `run_command` — design

Card: **TER-1081** (epic TER-1 · Chat). Builds on the standing grants (2026-09-28, TER-386) and the
default allowances (TER-627). Decided without the user, in an automatic run; each decision has its reason.

## 1. Problem

Every `run_command` of the concierge was a confirmation card, whatever the command: `git status`,
`gh pr checks`, `ls`, `df -h` and a routine `git push` in a shell tab all stopped the work until the person
clicked. No grant covered `run_command`, by design (it types anything into a shell).

## 2. Decisions

| Topic | Decision | Why |
|---|---|---|
| Parsing | `chat/command-rules.ts` splits the command like a POSIX shell (single and double quotes) and **refuses** anything else: `; & \| < > ( )`, `$`, backticks, `{ }`, `#`, `^`, a leading `~`, globs, a backslash, `!` anywhere (even quoted), and any control character or Unicode line break. Refused means "ask", never an error. | The card asks for a shell parser, not `startsWith`. A parser that refuses what it does not understand cannot be talked past with quoting tricks; the cost is that some harmless commands (`git log HEAD^`) still ask. |
| Matching | A rule holds the command's **words**. `exact`: the same words. `prefix`: the rule's words start the command, whole words only (`git s` never covers `git status`). Quotes and spaces are normalised away before matching. No regex or glob rules. | Word prefixes cover every example of the card (`git push`, `gh pr checks`, `df -h`). A regex is easy to get wrong in the permissive direction, and the card made it optional ("ou"). |
| Never covered | Assignment before the program (`GIT_SSH_COMMAND=…`), `sudo`/`su`/`doas`/`pkexec`, `rm`/`rmdir`/`shred`/`unlink`, `kill`/`pkill`/`killall`, power and disk tools, `eval`/`exec`/`source`/`env`/`printenv`/`export`/`set`/`alias`, macOS `security`; `git push` with `--force*`, `-f`, `--mirror`, `--delete`/`-d`, `--prune`, `+ref`, `:ref`; `git reset --hard`; `git clean`; git's `-c`/`--config-env`/`--exec-path`; `find -exec/-execdir/-ok/-delete/-fprint*`; any word whose path segment names a secret (`.env*`, `*.env`, `.ssh`, `.gnupg`, `.aws`, `.kube`, `.netrc`, `.npmrc`, `.pgpass`, `.git-credentials`, `id_rsa*`…, `*.pem`/`*.key`/…, `*credential*`, `*secret*`, `*token*`, `*passw*`, `shadow`, `environ`). Checked before every rule and the default list. | The card's list, plus the obvious equivalents (`pkill`, `-uf`, `+main`) and the ways git or find run another program. |
| Wrappers | A **prefix** rule never covers `ssh`, a shell, `xargs`, `nohup`, `timeout`, `watch`, `npx`… (programs that run the rest of their arguments). An **exact** rule can (`ssh hulk uptime`). The card offers no prefix button for them. | `ssh hulk` as a prefix would cover `ssh hulk rm -rf /`, a command the never list cannot see inside the remote string. |
| Tab | Only a terminal tab of the person's (owner-scoped) whose state is `null` (never reported) or `idle` (the agent ended), and whose screen shows neither an agent's input box nor a dialog (`claudeScreenState` null). A failed capture asks. | Typed into an agent, a command is a prompt; the rule is about shells. |
| Default list | New default kind `read_commands` in "Liberadas por padrão", on for everyone, off per user (`chat_default_restrictions`): `git status/log/diff/show` (no `--output`), `git branch` with listing flags only, `gh pr view/checks/list`, `gh run view/list`, `ls`, `pwd`, `df`, `du`, `ps`, `uptime`, `which`, `whoami`, `uname`, `cat/head/tail` of relative paths without `..`, `<program> --version`. | The card's list. Reuses the existing switch so the person has one place for defaults. `git branch` is restricted to listing because `git branch -D` deletes. |
| Rule data | Table `chat_command_rules`: user, project (null = every project), words, match, machine ids (empty = all), conversation and source card, created, expiry, revoked. Same rule in force again returns the existing one. | The card's fields. A project FK with cascade, so a deleted project ends its rules. |
| Creating a rule | (a) Two buttons on a pending `run_command` card: "Permitir sempre este comando neste projeto" (exact) and "Permitir sempre comandos que começam com «…»" (the suggested prefix: the program, plus its subcommand words for git, gh, npm, docker… — `git push origin main` → `git push`). Project = the tab's; all machines; no expiry. The server sends the offer as `command_rule` on the card, so the browser never parses. (b) `propose_command_rule` (MCP, class write, always a card): pattern, match, project or all, machines, expiry. | "Only a click creates a grant" (TER-386). The card offers the common case in one click; the tool covers the rest (global, machines, expiry) behind one confirmation. |
| Precedence and budgets | After every other grant and before the TER-627 defaults: the person's rules first (60 commands per rule per hour), then the read-only list (120 per user per hour). An open card or a denial in force still decides first. | Same brake as every other grant. |
| Audit and feed | A covered command is an approved `chat_actions` row with `grant_id` = the rule id (or `default:read_commands:<user>`), the command in `args`, the tab, its project and now its machine; the trail shows it live ("Executado · liberado por regra" / "por padrão"). | The existing audit and `granted_action` event; nothing silent. |
| Listing and revoking | `GET /api/chat/command-rules` (active and ended), `DELETE /api/chat/command-rules/:id`; a "Comandos liberados" section in Permissões do chat; "Revogar" on the card that created the rule. `GET /api/chat` returns `command_rules` for that. No new bus events: other open screens see a new rule on their next read. | Keeps the mobile contract untouched (a new event type would have to be added to the app's schema in the same release). |
| Telling the model | `run_command`'s description; `list_command_rules`; a line in the project prompt with the project's rules; a sentence injected after the approval that created one; the defaults line now says which `run_command` still asks. | The concierge proposes without "vou precisar da sua confirmação" when a rule covers it. |
| Mobile app | Not in this delivery: the app shows the card without the two buttons (approving still works) and the rules are managed on the web. Follow-up card. | Keeps the PR inside server + web; the app needs its own PIN flow for the new decision words. |

## 3. Residual risks

- The gate cannot see what is actually running in a shell tab: an `ssh` session left open, a REPL, `less`.
  A covered command then reaches that program. Mitigated by "shell tabs only", the screen check, budgets and
  the trail.
- A prefix rule trusts the arguments that follow (`git push origin anything`); the never list removes the
  destructive spellings, the rest is the person's choice when they click.

## Impact on other users

Everyone gets the read-only default list: `git status`, `ls`, `gh pr checks` and the like in a shell tab
stop asking. It is a default, switchable per user in Permissões do chat › Liberadas por padrão. Nothing that
changes state runs without a card until the person creates a rule for it (per user; project or every
project).
