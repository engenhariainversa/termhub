# Chat: allowed by default, the person lists what it must not do (TER-1164)

Status: approved by Pedro on 2026-11-06 ("vamos no recomendado"): option A, block effect "pedir antes" by
default, the concierge prompt fix first in its own PR (#563). Ships behind the `chat_open_permissions` flag.

## Why

In a new project (piki-digital-app) the chat asked a confirmation for every text it typed into a tab, and
Pedro approved many cards in a row. Today's model asks by default and lifts per grant (tab, project,
"Liberar sem prazo", command rules, defaults). Grants are per project, so a new project starts close to
zero. Pedro: «precisamos mudar a ideia do sistema de permissivo para restritivo. ao inves de pedir
permissao pra tudo, o usuário é quem vai dizer o que nao pode fazer».

What Phase 1 found (read only): the only tab of the project was `waiting_permission`, so the texts were
most likely answers to Claude Code permission dialogs, which no grant ever covers
(`gate.ts` `grantable`/`terminalGrantable`, `gate-runtime.ts` `staleApproval`). And the concierge told the
person "the rules only cover commands", which was wrong: fixed in #563.

## The model

With the flag on for a person, `applyGate` (apps/server/src/chat/gate-runtime.ts) asks `openGrantCovering`
instead of every grant and default:

1. **Kind** (`openKindOf`, chat/open-permissions.ts): `open_tab`, `close_tab`, `start_agent`, `board`,
   `link_tab_task`, `terminal` (send_input, send_key), `run_command`, `share_file`, `machines`
   (link/cwd/wake/update agent/hooks, unlink without closing tabs), `tickets` (sync/import), `automation`
   (resume, a machine accepting automatic work). Any other tool is **core**.
2. **Core, always a card**: delete a card, close a working tab, C-c/Escape, answering a CLI permission
   (except below), the run_command "never" list (chained, redirections, sudo, rm, kill, push --force,
   reset --hard, git clean, secrets) plus wrapper programs (ssh, shells, xargs, npx…), merge and raising
   the automation level, ticket status, integrations and set_project_repo, AI account login, exclusivity
   and setup, another user's data, lifting a block, and every tool not mapped to a kind.
3. **Guards**: the target resolves owner-scoped (else a card); a command is one simple command off the
   list; text typed into a shell is such a command; `!` in Claude Code runs the rest in bash and is held to
   the same list; control characters ask; a key into a shell asks (it could replay a command); a
   permission dialog on screen asks; a stopped tab only is closed.
4. **Permission answered with the person's words**: `send_input` with `answering_permission` and
   `on_behalf_of` passes when one quoted message is ≤ 30 min old and newer than the tab's
   `waiting_permission`. Audited as `default:open-quoted:<user>`; `staleApproval` lets it through to the
   prompt-changed check.
5. **Blocks** (`chat_blocks`): kind, project or every project, for run_command optionally the command's
   first words, effect `ask` (default, a card) or `never` (refused, `BLOCKED_BY_PERSON`, no card).
   "Nunca" wins over "pedir antes". A block wins over any grant given before it.
6. **Budgets** per user, kind and hour (`OPEN_BUDGETS`): past it, a card.
7. **Screen** last: a dialog, or an agent's prompt where a shell command would be typed, asks.

Every call that runs is still a `chat_actions` row (`grant_id` `default:open-<kind>:<user>`), shown in the
chat as "liberado por padrão".

## How the person adds and sees blocks

- **In the chat**: "não deixa o chat dar push no piki" → `block_action` (self-mediated: a brake, no card).
  `list_blocks` lists them; `unblock_action` lifts one through a card. The project prompt tells the model
  the core, the blocks that apply there and these tools.
- **On the screen**: `/api/chat/blocks` (GET, POST, DELETE; 404 while the flag is off) for Configurações ›
  Permissões do chat. The web screen comes in its own PR.

## Migration

Nothing is copied. `effectiveBlocks` reads the person's `chat_default_restrictions` as blocks for every
project ("pedir antes"; `read_commands` as a run_command block), so turning the flag off and on changes
nothing. Grants, command rules and folder grants stay in their tables and are not read while the flag is
on; they are the model again if it is turned off. The migration only adds `chat_blocks`, which the
previous release never reads.

## Rollout

1. Flag on for Pedro only (an override in Configurações › Recursos em teste).
2. About a week of his daily use, then on for the beta with a one-time notice in the chat linking to the
   blocks; people who had restricted defaults keep them as blocks.
3. Once on for everyone, a later card removes the grants UI and its tables.

## Impact on other users

None while the flag is off, which is the default for everyone: the gate, the prompt and the screens stay
as they are. For a person with it on (opt-in per user, set by an admin), the chat asks far fewer
confirmations and acts on their machines without showing each action first; the fixed core, the budgets
and the audit trail are what is left between an injected prompt and their machine.
