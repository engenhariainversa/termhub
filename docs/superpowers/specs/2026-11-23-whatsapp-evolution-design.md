# WhatsApp through the Evolution API (TER-1201)

## Goal

A person connects termhub to their own [Evolution API](https://doc.evolution-api.com) server and gets the
concierge's notices (`notify` levels `needs_you` and `done`) on WhatsApp too, and the chat (or any MCP
client) can check the integration and send a message to the person's own number.

## Decisions

- **Per user, one setup.** A row in `whatsapp_settings` keyed by `user_id` (cascade on account deletion):
  `server_url`, `instance`, `number` (digits only, country code included), `api_key` (AES-256-GCM through
  `lib/crypto.ts`, never returned by any route or tool), `enabled`, `notify_needs_you`, `notify_done`, and the
  last delivery (`last_sent_at`, `last_error` code). It belongs to the signed-in person, not to the "view as"
  scope: an admin viewing as someone else still edits only their own WhatsApp.
- **Not in `integrations`.** That table is the ticket/CI credentials list (GitHub, Linear, Jira) and every
  consumer switches on its provider; a WhatsApp row there would leak into ticket sources and the MCP's
  `list_integrations`. The routes still sit under the `integrations` resource (`guarded('integrations', …)`),
  so the same role grants apply.
- **Only public https servers.** The server URL goes through `checkPublicUrl` (TER-578) on save and before
  every request, and requests use `redirect: 'manual'`: no user can make the server reach its own network.
  On jarvis, the Evolution container is already published as `https://wpp.soupedrogoiano.dev` (Cloudflare
  Tunnel → proxy nginx), so no exception is needed.
- **Only the configured number.** Neither the notices nor the MCP tool take a destination: messages go to
  the number saved on the screen, so a prompt injection cannot message strangers.
- **Notices follow the person's rules.** The WhatsApp copy leaves from the notice dispatcher, after
  `planNotices` decided to send (levels, quiet hours, grouping, hourly cap of Configurações → Avisos), then
  only for the levels the person ticked for WhatsApp. One message per push, never more. A failure is logged
  (codes only) and saved as `last_error`; it never blocks the push.
- **Text.** `*title*\nbody\n<link to the chat message>` in the person's language, built from the same
  `conciergeNoticeText` as the push. The headline is already written without secrets (the `notify` rule).
- **Confirmation.** `send_whatsapp` writes to a third-party system: in the chat it is an irreversible tool
  (always a card, never a grant, a default or the open model), it is in `AUTOMATION_MCP_DENIED_TOOLS`, and
  the card shows the text that will be sent. `whatsapp_status` is a read.
- **Feature flag `whatsapp`** (default off): the screen, the routes (`requireFeature`), the tools (refuse
  with `WHATSAPP_OFF`) and the dispatcher's send all check it.

## Evolution API calls (v2)

- Test: `GET {url}/instance/connectionState/{instance}` with header `apikey` → `{ instance: { state } }`;
  `open` = connected. 401/403 = wrong key, 404 = no such instance, other state = WhatsApp not paired.
- Send: `POST {url}/message/sendText/{instance}` `{ number, text }` → 200/201.
- 10 s timeout. Errors are reported by code (`AUTH`, `INSTANCE_NOT_FOUND`, `NOT_CONNECTED`, `HTTP_<n>`,
  `UNREACHABLE`, `URL_REFUSED`), never with the answer body.

## Surfaces

- **Web:** Configurações → WhatsApp (behind the flag and `integrations:read`): URL, API key (write-only:
  "salva" placeholder, blank keeps it), instance, number, enable switch, the two levels; "Testar conexão"
  (uses the form's values, falling back to the saved key) and "Enviar mensagem de teste" (saved setup);
  "Remover".
- **REST:** `GET/PUT/DELETE /api/whatsapp`, `POST /api/whatsapp/test`, `POST /api/whatsapp/test-message`.
- **MCP:** `whatsapp_status` (configured, enabled, server host, instance, masked number, connection state,
  last delivery) and `send_whatsapp { text }` (≤ 1000 chars).
- **Mobile:** nothing new; setup is on the web (card scope). Notices already reach the phone by push.

## Impact on other users

Nothing changes for anyone who does not set it up: the flag is off by default, and even with it on, no
message leaves until the person saves a server, key, instance and number. Opt-in per user.

## CLIs covered

Claude Code ✅ · Codex ✅ · Cursor ✅ · Gemini ✅ — the feature does not touch a tab's agent; the two MCP
tools are served by the termhub MCP to every client the same way.

## Follow-up (2026-11-24): groups and other destinations

Approved by the maintainer after the first release.

- `list_whatsapp_groups` (read, `integrations:read`): `GET /group/fetchAllGroups/{instance}?getParticipants=false`, returning id (JID), name and size, sorted by name, capped at 200, with an optional `query` (accents and case ignored). It sends nothing.
- `send_whatsapp` takes an optional destination: `group` (exact name, accents and case ignored, or the `…@g.us` id) or `number` (a contact, normalized like the screen's). At most one. Without one it still goes to the saved number. A name that matches no group or more than one is refused (`WHATSAPP_GROUP_NOT_FOUND` / `WHATSAPP_GROUP_AMBIGUOUS`) before anything is sent.
- Confirmation is unchanged: `send_whatsapp` stays in `irreversibleTools`, so every call is the person's card under any permission mode, and the card now names the destination with the text. Automatic tabs still cannot call it.
- Notices still go only to the saved number.

**Impact on other users:** none unless they have the `whatsapp` flag on and ask the chat to message a group or contact; every such message is a card they confirm.
