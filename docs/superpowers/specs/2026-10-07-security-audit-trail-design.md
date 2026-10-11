# Security audit trail (TER-577)

Origin: TER-543. A corporate IT team's standard question ("who signed in, who changed whose
permissions, who looked at whose terminal?") had no answer: only `chat_actions`, `device_events`,
`api_token_events` (recorded but never shown) and `tab_events` existed, and the rest lived in process
logs or nowhere.

## What is recorded

One append-only table, `security_events`: actor (id + e-mail snapshot), the person an admin was
viewing as (`view_as_id`, `*` for "all"), action, target (type, id, label snapshot), IP, `meta`
(ids, names, counts and flags only), time. No foreign keys: the trail outlives the accounts and rows
it names. A trigger refuses `UPDATE`; rows leave only through the hourly retention purge.

| Action | Where |
| --- | --- |
| `auth.login` (method password, email_code, google) | `auth/routes.ts` |
| `auth.login_failed` (address tried, method, reason) | same; a wrong password/code, and the failure that sets a lock. Refusals while already locked are not recorded, so a brute force cannot fill the table. Never the password or code. |
| `auth.logout` | same |
| `auth.view_as`, `auth.view_as_end` | `POST /auth/view-as` |
| `user.invite`, `user.role_change` (from/to), `user.delete` | `routes/users.ts` |
| `user.deletion_requested`, `user.deletion_canceled` | `routes/account.ts` (web and the public link) |
| `role.create`, `role.update`, `role.delete`, `role.permission_toggle` | `routes/roles.ts` |
| `machine.create`, `machine.delete`, `machine.transfer`, `machine.agent_token_rotate` | `routes/machines.ts` |
| `api_token.create`, `api_token.revoke` | `routes/api-tokens.ts` (never the token) |
| `integration.create`, `integration.delete` | `routes/integrations.ts` |
| `terminal.input` | `POST /api/tabs/:id/input` and the tab chat's message route: tab, machine, length; never the text |
| `terminal.view_as_open` | `terminal/ws.ts`: a terminal socket opened on someone else's project through "view as", with whether it could type |
| `audit.export` | the export route itself |

Writes are best effort (`auth/audit.ts`): a failed write is logged by action and never fails the
request; a sign-in must not break because the trail could not be written.

## Reading it

- `GET /api/security-events`: filters `action` (an action or its group, `auth`), `actor_id`, `q`
  (actor e-mail, target label or IP), `from`/`to`; keyset pages of up to 200.
- `GET /api/security-events/export?format=csv|json`: same filters, up to 10 000 rows, as a download.
  CSV cells starting with `= + - @` are prefixed with `'` (formula injection: target labels are text
  other people chose).
- Guarded as the new resource `security_events`: admins see it; any other role only when an admin
  grants `security_events:read` in Permissões. It is instance-wide and not narrowed by "view as".
- Web: Configurações → Administração → **Auditoria**.
- `GET /api/api-tokens/:id/events`: the MCP calls of one of the signed-in person's own tokens (names
  of the machine, project and tab read now), shown under **Atividade** in Tokens de API.

## Retention

`SECURITY_EVENT_RETENTION_DAYS` (7–3650, default 365), per instance: whoever runs the server decides.
The screen shows the current value. A setting in the UI was not added: retention is a compliance
choice of the operator, and an admin changing it from the app would be able to shorten the trail
that records them.

## Should "view as" be read-only in terminals?

Evaluated, not changed in this card. Today an admin viewing as someone gets their `terminals:write`
too: they can type into that person's terminals. That is how support works now (the maintainer helps
a user by acting in their session), so making it read-only by default would remove a working flow
from every instance. What the card asked for is visibility, and that is now covered: every terminal
opened through "view as" is recorded with `writable`, and so is every API input under it
(`view_as_id` on the row). The natural follow-up, if an instance wants it, is an opt-in instance
setting "ver como é somente leitura nos terminais" that passes `readonly` in `terminal/ws.ts` when
`opensOthersTerminal` is true and refuses the write routes under a view-as scope.

## Impact on other users

Nothing changes in what anyone can do. Every instance starts recording the trail (default on, 365
days, metadata only); admins get a new Auditoria section, and non-admin roles see nothing unless an
admin grants `security_events:read`. Every token owner gets an Atividade button on their own tokens.
The person whose sign-in fails has the address they typed recorded with the IP, which is what the
trail is for.
