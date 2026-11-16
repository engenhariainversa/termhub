# Multi-repo — repository discovery (TER-1071) — implementation plan

> Task 6 of `docs/superpowers/plans/2026-10-07-multi-repo-automation.md`. Spec:
> `docs/superpowers/specs/2026-10-07-multi-repo-automation-design.md` (R2–R6, R10, §5, §10).

**Goal:** the server finds by itself the git repositories in a project's folder, on every machine linked to
the project, and keeps `project_repositories` / `project_repository_checkouts` current. Nothing automatic
acts on what it finds: discovery only adds rows (and marks gone checkouts).

**CLIs covered:** not an agent CLI feature (it reads the machine's folder through the termhub agent, whatever
CLI the tabs run). Claude Code ✅ · Codex ✅ · Cursor ✅ · Gemini ✅.

## Pieces

1. **No migration.** The "last scan" per project and machine is the latest `seen_at` of the project's
   checkouts on that machine (every scan that finds something writes it, from either colour), or this
   instance's own finished scan when later (`scanTimes`). This is also the cross-colour half of the throttle
   (spec §5 step 1). A column on `project_machines` was the first idea, but the Prisma client is committed
   and checked for staleness by CI, and the spec's `seen_at` is enough.
2. **`apps/server/src/repos/origin.ts`** — `repoOfOrigin(url)`: GitHub https / ssh / scp forms (and ssh
   host aliases such as `github.com-work`) → `{ full_name: 'owner/repo', github: true }`; any other URL →
   `{ full_name: '<host>/<path>', github: false }`; no origin → null (the caller names it
   `local/<folder>`). Unit tests for each form.
3. **`ProjectRepositoriesRepository.setStatus(id, status)`** for the access check.
4. **`apps/server/src/repos/discovery.ts`**:
   - `scanLink(repos, link, opts, deps)`: skips a machine that is not an agent, is offline or lacks the
     `repo_scan` capability (reason in the result); calls `git.repos.scan { dir: cwd, depth:
     repo_defaults.scan_depth }`; maps each checkout to `DiscoveredCheckoutInput` (`unsupported` for a
     non-GitHub origin); `upsertDiscovered`; `markMissing` only when the answer is not `truncated`; checks
     access (`GET /repos/{full_name}`) for new GitHub repos and for those already `no_access` (so they can
     recover), with the repo's effective integration, else the project's `setup.repo` integration.
   - Events and chat: a project with no rows before this scan records **one** `repo_discovered` summary
     event (`first_scan: true`, `count`, `names`) and one chat line, leaving out the repo already in
     `setup.repo`; when nothing but that repo was found, nothing at all (single-repo project, no noise).
     Later scans record `repo_discovered` + one chat line per new repo ("Novo repositório na pasta do
     projeto: owner/repo (nível pr).") and `repo_missing` per checkout newly marked missing.
   - Throttle: an in-memory map per instance keyed `project:machine` plus the checkouts' `seen_at`, one scan per
     minute for the automatic triggers; `force` (on demand) skips the throttle but shares a scan already in
     flight for the same link. The upsert is idempotent and creates under `lockProject`, so both colours
     scanning at once never duplicate rows or events.
   - Triggers: `startRepoDiscovery(repos, log, active)`: agent `online` (after a short delay), a 10-minute
     loop over projects with automation on or more than one repository, the Setup GET (fire and forget,
     throttled), and on demand (route + MCP).
5. **Feed**: kinds `repo_discovered`, `repo_missing` in `AutomationEventKind`, `FEED_KINDS`, a server
   `reason_text`, and the web feed line. The app's feed skips them until it has a line (no app change).
6. **Routes** (`routes/setup.ts`): `GET /projects/:id/repos` (discovered repos with checkouts, effective
   level, and per machine: name, folder, last scan, whether it can scan) and `POST /projects/:id/repos/scan`
   (on demand; same answer plus the per-machine outcome).
7. **MCP** (`mcp/tools.ts`, `control/repos.ts`): `list_project_repos` (key, owner/repo, description, level,
   status, machines) and `scan_project_repos`; both `read` in the gate (they only look at the folder and add
   rows nobody acts on). The "when to call" guidance lives in the descriptions; the concierge prompt is not
   touched.
8. **Web** (`components/RepoDiscovery.tsx` in `SetupForm`): "Repositórios na pasta" card with "Procurar
   agora", the last scan per machine, and each repo with its key, status, level and presence per machine
   (folder or "ausente"). pt-BR, en and es.

## Tests

- `repos/origin.test.ts`: https, ssh, scp, alias, `.git` suffix, credentials, GitLab, garbage.
- `repos/discovery.test.ts` with a fake agent and in-memory repositories:
  - one repo at the folder (single-repo project): key `main`, no event, no chat line;
  - ten repos on a first scan: one summary event and one chat line;
  - a later scan with a new repo: `repo_discovered` and the chat line with its level;
  - a repo that disappears: `missing_at`, `repo_missing`, nothing deleted; a truncated answer marks nothing;
  - a folder renamed: same key, checkout's `dir` updated, no event;
  - a non-GitHub origin: `unsupported`, no GitHub call;
  - a repo the token cannot read: `no_access`;
  - machines without `repo_scan`, offline or not agents are skipped; the throttle and `force`.
- Route test for `GET/POST /projects/:id/repos`, MCP tool test, gate classification.

## Impact on other users

Discovery runs on every agent machine linked to a project whose agent has `repo_scan` (0.29.0+). It reads
folder names, the `git remote`, the default branch and one description line, never terminal content. It adds
rows and feed events; nothing automatic changes, and no discovered repo gets merge or deploy by itself
(level `pr`, R6). A single-repo project sees no event and no chat line. Default for everyone, no setting: it
only records what is in the folder.
