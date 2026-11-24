# Plan: WhatsApp through the Evolution API (TER-1201)

Spec: `docs/superpowers/specs/2026-11-23-whatsapp-evolution-design.md`. One PR.

1. **Flag** `whatsapp` in `features/flags.ts` (+ en/es copy), web `FeatureFlagKey`, mobile `meResponse.features`.
2. **Schema + migration** `whatsapp_settings` (new table only: backward compatible) and
   `db/repositories/whatsapp-settings.ts` (get, upsert with optional key, delete, `apiKey()`, `noteDelivery`).
3. **Client** `integrations/evolution.ts`: `connectionState`, `sendText`, `checkPublicUrl` each time,
   timeout, `redirect: 'manual'`, error codes; tests with a fake `fetch`.
4. **Service** `whatsapp/service.ts`: `status`, `test`, `sendToOwner(userId, text)`, `noticeText(n)`,
   `onNotice(n)` (flag + enabled + level, records the outcome); tests.
5. **Routes** `routes/whatsapp.ts` under `guarded('integrations', …, '/whatsapp')`, zod bodies, `requireFeature`,
   audit `whatsapp.update` / `whatsapp.delete`; tests.
6. **Dispatcher wiring** in `app.ts`: after the push, `whatsapp.onNotice(n)` (fire-and-forget, logged).
7. **MCP** `whatsapp_status` / `send_whatsapp` in `mcp/tools.ts` + `control/whatsapp.ts`; gate:
   read / irreversible, automation deny list, action card text, prompt text, open-model core text; tests.
8. **Web** `components/WhatsAppView.tsx`, section `whatsapp` in `settings-sections.ts` (hidden without the
   flag), `api.whatsapp`, locales en/es, `GUARDED`; test.
9. Docs: `docs/feature-flags.md` row; verify in `node:22` (typecheck, server tests touched, web build/tests,
   i18n check); PR; merge on green; turn the flag on for Pedro is his click (Recursos em teste).
