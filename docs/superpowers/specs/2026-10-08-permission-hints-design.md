# Permission hints — design

Card: **TER-614**, follow-up of TER-179 (spec `2026-09-30-tab-questions-per-subagent-design.md` §7, §9).

## 1. Decision

The card offered three options: not doing it, doing it as an opt-in per machine or project (off by
default) with a secret filter, or doing it for everyone. **Option 2**, as an opt-in **per machine**, off by
default, decided on 2026-10-08 (the automatic run recommended it; Pedro asked for the decision to be taken
and recorded in the PR).

| Topic | Decision | Why |
|---|---|---|
| Level | Per machine (`machines.permission_hint`, default false), switched in the machine form's Monitor tab. Not per project. | What the switch controls is what leaves the machine, and only the machine's hook script can enforce that: it does not know the project. A per-project switch would still send every prompt whole from the machine. |
| Machine side | The script sends a Claude `PermissionRequest` of `Bash`, `Edit`, `MultiEdit`, `Write` or `NotebookEdit` whole (≤ 200 000 characters, like Codex's) only while `~/.termhub/permission-hint` exists. Without it, nothing changes: the tool's name only. | The rule "only the tool's name travels" (spec 2026-09-25 §4.1) stays the default; the person who turns this on accepts the exception. Parsing JSON and filtering secrets in POSIX sh is not something to trust; the server does both, tested. |
| The switch | `PUT /api/machines/:id/permission-hint {enabled}`: the machine first (agent RPC `hooks.hint`, agent 0.20.0; `sh -s` on ssh/local), then the row. A reinstall of the hooks writes the file back when the switch is on; an uninstall removes it. | The switch must never say on while the machine sends names only, nor off while it sends whole prompts. |
| Server gate | The ingest drops a hint from a machine whose switch is off, whatever arrived. | The file lives on the machine: one left behind (switch turned off while offline) must not put commands on cards. |
| What is kept | `payload.hint` on the permission row, at most 60 code points: a command's first non-blank line, or a file's path relative to the event's `cwd` (absolute outside it, tail kept when long). The rest of the payload is dropped on arrival; nothing goes to meta, text or logs. | The card needs to tell two dialogs apart, not the whole command. |
| Secret filter | `chat/permission-hint.ts`, before the cut: values of credential-looking env vars, JSON/YAML keys and query parameters, credential flags (`--token`, `--password`…), `Authorization`/`Cookie` headers, `Bearer`/`Basic`, URL passwords, `curl -u`, `sshpass -p`, `mysql -p`, PEM headers, known token shapes (GitHub, GitLab, Slack, OpenAI/Anthropic-style, Stripe, AWS, Google, npm, termhub, JWT) and any 32+ character token-looking word become `•••`. Best effort, and the switch's text says so. | Over-redaction only costs a less useful hint; a leak costs a secret. |
| Heredocs, accents, paths | Only the first line of a command (a heredoc's body never travels further); text NFC-normalised, accents kept; files named relative to `cwd` as the dialog names them. | The three ways the 2026-09-30 review saw a character filter miss real dialogs. |
| Live check | `promptVisible` (and so the automatic answer's `permissionToolOnScreen`) also requires the hint in the dialog: from the lowest box rule down, each run of the hint between `•••`/`…` in order (a file: its last path segment), both sides NFC and reduced to letters and digits. A capture with no rule passes. | This is what tells two "Bash command" dialogs apart. Reading only under the lowest rule keeps the transcript (where the same command may sit) out. A dialog taller than the screen fails open, like `dialogTool`. |
| Screens | The web and mobile permission cards show the hint under the title, in monospace. | — |

## 2. Impact on other users

Opt-in per machine, off by default: nobody who does not turn it on sees any change, and their machines
keep sending only the tool's name. The hook script changes for every machine (agent 0.20.0, rewritten by
`heal()` on reconnect), but its behaviour only differs where the opt-in file exists. Someone who turns it
on sends Claude's permission prompts of command and file tools whole to the termhub server, which stores a
filtered excerpt on the card; Codex and Cursor are unchanged.
