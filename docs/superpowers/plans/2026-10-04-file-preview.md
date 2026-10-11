# File preview (TER-941) — plan

Spec: `docs/superpowers/specs/2026-10-04-file-preview-design.md`. One PR per layer, in order; each merges
with a green CI before the next one starts from the updated `main`.

## PR 1 — Agent 0.16.0

1. Protocol: `file.read`, `FILE_READ_*`, `CAPABILITY_FILE_READ`; tests of params and results.
2. `apps/agent/src/rpc/file-read.ts` + `file-read.test.ts` (every case in spec §6); register the
   handler; advertise the capability; bump 0.16.0 (`package.json`, `version.ts`, lock).
3. Agent README: the allowed folders and `~/.termhub/file-read-roots`.
4. Spec and this plan.
5. After merge: the "Publish @termhub/agent" run, then `npm pack @termhub/agent@0.16.0` and look for
   `file_read` in `dist`.

## PR 2 — Server

1. `requireFileReadCapable` in `agent/errors.ts` + tests.
2. `packages/mobile-api`: `filePreviewQuery` / `filePreviewResponse` + tests.
3. `file-preview/core.ts`: candidates (tab, project machines, account machines), relative paths, RPC,
   decode, `github_url`; tests with a fake `agentRpc`.
4. Routes: `GET /api/file-preview` (web, `guarded('terminals', …)`) and `GET /api/m/v1/file-preview`
   (mobile app); scope tests (404 for another owner).
5. Deploy and check the active color.

## PR 3 — Web

1. `lib/md-paths.ts` + table test; `linkifyPaths` pass after sanitizing in `ChatTurn`; click handler.
2. `editor-tabs`: file ids (`file:<machine>:<path>`) survive pruning; tests.
3. `FileView` (fetch, refusal texts, outdated agent, actions); render via `renderMarkdown(…, { markdownOnly })`
   with images as links and relative `.md` links opening previews; sanitizer tests.
4. `TerminalsView`/`TabBar`: file tabs in the bar (preview, pin, close), `?file=` param from the global chat.
5. Typecheck and build through Docker; deploy.

## PR 4 — App (OTA)

1. `md-paths.ts` (same table) and linkify in `MessageBubble` (concierge and Sessões).
2. API client + mock handler + contract; `file-preview` screen and store; outdated agent and refusal texts.
3. Image and link rules; actions (copy, share, GitHub, send to chat).
4. Tests; merge; the "Publish mobile OTA" run publishes.

## Done

Card to Feito, summary with the PRs and how to use it.
