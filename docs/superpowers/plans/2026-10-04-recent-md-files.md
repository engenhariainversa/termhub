# Recent Markdown files (TER-953) — plan

Spec: `docs/superpowers/specs/2026-10-04-recent-md-files-design.md`. One PR per layer, in order; each merges
with a green CI before the next one starts from the updated `main` (web and app can run side by side).

## PR 1 — Agent 0.17.0

1. Protocol: `file.list` params `{ cwd: machinePath | null, dirs: relDir[] (≤8), paths: machinePath[] (≤100), roots: machinePath[] (≤16) }`,
   result `{ entries: [{ path (resolved), asked (as sent), size, mtime_ms, too_large }] (≤500) }`;
   `FILE_LIST_MAX_ENTRIES`, `CAPABILITY_FILE_LIST`; tests.
2. `apps/agent/src/rpc/file-list.ts`, sharing `file-read.ts`'s folder and place checks (extract helpers,
   no behavior change to `file.read`); tests: each folder, dot folders, links out/in, types, `README.md`
   of lessons is the server's filter (not the agent's), FIFO, directories, over-size, limit and order.
3. Capability, handler, bump 0.17.0 (`package.json`, `version.ts`, lock), agent README.
4. Re-run `file-read.test.ts` in a loop (FIFO stability, D8).
5. After merge: "Publish @termhub/agent", then `npm pack @termhub/agent@0.17.0` and look for `file.list`.

## PR 2 — Server

1. `packages/mobile-api`: `fileRecentQuery` / `fileRecentResponse` + tests.
2. Server-side Markdown path detection (same table as web/app) in `file-preview/md-paths.ts`.
3. `file-preview/recent.ts`: per linked agent machine, cited paths from the project's tabs on it, the RPC,
   merge, groups, limits; tests with a fake RPC; scope tests.
4. Routes `GET /api/file-recent` (web) and `GET /api/m/v1/file-recent` (app).

## PR 3 — Web

`/projects/:id/files` page, nav entry, groups filter, search, open as file tab; tests; Docker build.

## PR 4 — App (OTA)

API client + mock handler, `file-recent` screen and store, entry on the project screen, tests.

## Done

Cards to Feito, summary with the PRs.
