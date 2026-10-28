# Failure lessons: what an agent learned fixing an error, found again by the next one — design

Card: **TER-205** (epic TER-1 · Chat). Origin: spike TER-110 (a post on "swarm knowledge protocols" /
failure-memory). Builds on **TER-95** (`memory_items`, `search_memory`, the docs sweeper, the `memory`
token scope; spec `2026-09-26-concierge-memory-mcp-design.md`) and **TER-57** (the embed service and
the Memória do chat screen). Related cards: TER-212 (the termhub MCP inside agent tabs) and TER-217
(export lessons to the repository), which this design absorbs (§11). Subtasks are listed in the plan
(`docs/superpowers/plans/2026-09-27-failure-lessons.md`).

Project rule: everything the chat does must work in the mobile app too, in the same delivery.

## 1. Problem

An agent in one tab spends 40 minutes on an error that another tab, on another machine of the same
person, fixed yesterday. What an agent learned while debugging is lost when its tab closes: TER-57
remembers only answers to choice questions, and TER-95 indexes cards, messages, specs and plans, not
"this error means that, fix it like this".

## 2. Decisions

D1–D3 were chosen by Pedro in the brainstorm (2026-09-27); the rest are Claude's recommendation, taken
alone as asked.

| # | Topic | Decision | Why |
|---|---|---|---|
| D1 | Where a lesson lives | **In the project repository**, one markdown file per lesson under `docs/lessons/`, committed with the fix. | Works for any agent (Claude, Codex, with or without the termhub MCP: `grep` is enough), travels between machines with the repo, provenance is the git history and the PR, review is the PR review. |
| D2 | Project note too | Lessons can **also** be written into the project's note (the markdown "Notas" of a project), by the person (editing it) and by agents through a new MCP tool `record_lesson`. | Pedro's request: the note is the project's shared notebook; a lesson that does not belong in the repo (infra, a machine quirk) still has a home. |
| D3 | How agents are told | **Both**: a short block in the project's `CLAUDE.md`/`AGENTS.md` (the termhub repo first, by this delivery), and a one-line reminder appended by `start_agent` to the first prompt. | The instructions file reaches every session (opened by termhub or not, Claude or Codex); the reminder covers projects that do not have the block yet. |
| D4 | File format | `docs/lessons/YYYY-MM-DD-<slug>.md` with a YAML front matter (`symptom`, `tags`, `evidence`, `card`, `pr`, `agent`, `date`) and three sections (`## Cause`, `## Fix`, `## How to check`). Language: the repository's docs language (English in termhub). | A fixed shape keeps lessons greppable by `symptom` and lets the indexer build a good title without an LLM. MisakaNet's frontmatter (confidence/evidence + PRs) is the reference. |
| D5 | Indexing files | TER-95's docs sweeper also reads `docs/lessons/*.md` (same RPCs `docs.scan`/`docs.read`, same caps). A file under `docs/lessons/` becomes items of kind **`lesson`**, trust `derived`, title = the `symptom` (fallback: the path), chunked like a doc. | Reuses the whole TER-95 path (agent RPC, sha256 skip, chunking, embedding sweeper). |
| D6 | Indexing the note | The project note becomes a new source: kind **`project_note`** (trust `person`) for the person's text, split by heading like a doc, and kind **`lesson`** (trust `derived`) for each block an agent appended. Re-indexed when the note is saved (and by the memory sweeper when `updated_at` is newer than the items). | Only the person edits the note's free text through the screen, so it is `person`; agent text is fenced in marked blocks so it can never be mistaken for the person's. |
| D7 | Agent blocks in the note | `record_lesson` appends, under a `## Lições` heading it creates at the end if missing, a block `<!-- termhub:lesson id=<id> at=<ISO> tab=<tab id or -> -->` … `<!-- /termhub:lesson -->`. Any `<!--`/`-->` in the agent's text is neutralised before writing. The rendered note hides the markers (DOMPurify drops comments). | A deterministic fence: the indexer's trust split and the save merge (D9) both key on it, and an agent cannot open or close a fence from inside its own text. |
| D8 | Verification before trust | A lesson starts **not verified**. The Memória do chat screen (web and mobile) gets a "Lições" list: Verificar, Abrir origem, Esquecer. "Verificar" stores who and the hash of the lesson text; a changed text drops the mark. `search_memory` returns `verified` and `evidence` for lessons, and its description tells the model to prefer verified lessons and to treat the rest as hypotheses to check. Lessons never back `answer_tab_question` `mode: "auto"` (TER-95 D2/D6 already forbid any `derived` source). | The post's point: "a protocol without verification shares garbage as fast as truth". The mark is the person's act; the hash keeps an edited lesson from inheriting it. |
| D9 | Note saves vs. appends | The note stays one document with autosave. `PUT /projects/:id/note` gains an optional `base_updated_at`: when the note changed since then, the server keeps the lesson blocks whose `at` is newer than `base_updated_at` and that are missing from the submitted content, appending them to the submission (inside `## Lições`). Appends and saves take a row lock on the note. The editor adopts the returned content when it differs and nothing was typed since. | A person with the editor open would otherwise erase a lesson an agent just appended. Server-side merge covers the keep-alive save on page unload, where a 409 would lose the person's edits. A block the person deleted was loaded before, so its `at` is older than the base and it stays deleted. |
| D10 | `record_lesson` | MCP tool, scope `memory` (TER-95 D14), grant `notes:update`. Input: `project_id`, `symptom` (1–300), `cause` (1–2000), `fix` (1–2000), `evidence?` (`observed`\|`fixed`\|`confirmed`, default `fixed`), `card?` (a ref like `TER-12`), `pr?` (URL), `tab_id?`. Checks the project and tab through `ctx.scoped`. Caps: 20 lessons per user per hour (TER-1137: 40 per project per hour, queued instead of refused — see the concierge memory spec §5.2), note ≤ 200 000 chars (the PUT limit). Returns `{ lesson_id, ref }`. | The same cap idea as TER-95's notes: a loop or an injection cannot flood the note. The note limit is the existing one. |
| D11 | Gate | `record_lesson` is **self-mediated** on a gated (concierge) token, like `record_decision`: no confirmation card, because the effect is a visible, forgettable, unverified block. Listed explicitly in `gate.ts`. | Asking to confirm every lesson would stop the concierge from recording one while the person is away, and an unverified lesson changes nothing on its own. |
| D12 | Concierge | The orchestrator prompt's "Memória" block (TER-95 D17) gains one line: when a tab is stuck on an error, search memory for lessons (`kinds: ["lesson"]`) and hand the tab the verified ones; after a tab fixes a non-trivial error, record a lesson if the tab did not write one. No new wake path. | The "tab entered `error`" signal only means a Claude API failure (`StopFailure`), not "stuck on a bug"; a server-side reaction to it would fire on the wrong thing. The concierge already watches tabs when asked. |
| D13 | `start_agent` reminder | `launchLine` receives the prompt with one sentence appended (pt-BR, like the product): "Antes de depurar um erro, procure em docs/lessons/ e nas lições do projeto; ao resolver um erro que não era óbvio, registre uma lição (formato em docs/lessons/README.md)." The prompt limit (4000) counts the reminder; a prompt that no longer fits is refused as today. | Short, fixed, and it points to the format instead of repeating it. |
| D14 | `docs/lessons/README.md` | This delivery adds `docs/lessons/README.md` to the termhub repo (the format, one example) and the CLAUDE.md block. Other projects get the block by their own PR; the product does not write into repositories. | termhub never pushes into a person's repository on its own; the README is what the reminder and the block point to. |

## 3. Data

All additive and nullable/defaulted; the previous release never reads them (blue/green safe).

- `memory_items.kind` (TER-95, a text column) gains the values `lesson` and `project_note`. `MemoryKind`
  in the repository and the `kinds` enum of `search_memory` gain both.
- `memory_items.verified_at timestamp(3)` nullable, `verified_by text` nullable (user id, FK → users,
  set null), `verified_hash text` nullable (the item's `content_hash` when it was verified). `verified`
  = `verified_at is not null and verified_hash = content_hash`.
- `memory_items.hidden_hash text` nullable: set by "Esquecer" on a file lesson to the item's
  `content_hash`; search and the lessons list skip rows where `hidden_hash = content_hash`. A changed
  file (new hash) comes back as a new, unverified lesson.
- `memory_items.meta jsonb` nullable: for `lesson`, `{ evidence, card, pr, tags, agent, tab_id,
  machine_id, origin: 'file' | 'note', path? }` (the parsed front matter or the `record_lesson`
  input). Never a place for free text: every value is capped (tags ≤ 10 × 40 chars, strings ≤ 300).
- `source_id` for lessons: a file chunk keeps TER-95's doc form `<project_machine_id>:<path>`; a note
  block is `note:<project_id>:<lesson id>`; a note section is `note:<project_id>` with `chunk_index` =
  section index.
- Verification and hiding survive re-indexing: the upsert by `(kind, source_id, chunk_index)` leaves
  the `verified_*` and `hidden_hash` columns alone, and `verified` is computed against the new `content_hash`.

## 4. Indexing

In `apps/server/src/memory/` (TER-95's module).

- **Files** (`docs.ts`): the scan script's directory list gains `docs/lessons`, and `docPath` in
  `agent-protocol` accepts `docs/lessons/<name>.md`. A path under `docs/lessons/` is indexed as
  `lesson`: `parseLessonFile(md)` reads the front matter (a small line parser for `key: value` and
  `key: [a, b]`; anything else is ignored), title = `symptom` (≤ 300 chars) or the path, text = the body
  chunked by `chunkMarkdown`, `meta` from the front matter plus `origin: 'file'` and `path`.
  `docs/lessons/README.md` is skipped. An agent older than the one that knows `docs/lessons` just
  returns fewer files (the RPC validates paths, so the server version-gates nothing).
- **Note** (`note.ts`): `splitNote(content)` → `{ sections: {heading, text}[], lessons: {id, at, tab,
  text}[] }` (fences parsed strictly: an unclosed fence is text of the person's section and is indexed
  as `project_note`, never as a lesson). `indexProjectNote(repos, projectId)` upserts both kinds and
  deletes items of blocks/sections no longer present. Called after every note save and every
  `record_lesson` (best effort, `void`), and by the memory sweeper for notes whose `updated_at` is newer
  than their newest item (covers a crash between save and index).
- A lesson block's text as indexed: `"Sintoma: …\nCausa: …\nCorreção: …"`, title = symptom.
- Embedding: unchanged (TER-95's sweeper and immediate embed).

## 5. MCP

- `record_lesson` (D10). The block written:

  ```markdown
  <!-- termhub:lesson id=l_ab12 at=2026-09-27T03:10:00.000Z tab=u439n1764mpw -->
  ### P3009: migrate found failed migrations
  - **Causa:** …
  - **Correção:** …
  - **Evidência:** corrigida · TER-57 · https://github.com/…/pull/169
  <!-- /termhub:lesson -->
  ```

- `search_memory` (TER-95): `kinds` accepts `lesson` and `project_note`; each lesson result carries
  `verified`, `evidence`, `origin`, `path` or `tab`, `card`, `pr`. The description gains: "Lições
  (`kind: lesson`) são o que um agente aprendeu corrigindo um erro: prefira as verificadas; as não
  verificadas são hipóteses a conferir."
- `gate.ts`: `record_lesson` in the self-mediated set (D11). `list_tabs`/`read_screen` unchanged.

## 6. HTTP API (web and mobile)

Under the chat memory routes (`guarded('chat', …)`, mounted at `/api/chat` and `/api/m/v1/chat`):

- `GET /lessons?q=&project_id=&cursor=` → `{ lessons: [{ id, project: {id, name}, title, excerpt,
  origin, path?, tab?, card?, pr?, evidence, verified, verified_at?, created_at }], next_cursor }` — the
  owner's `lesson` items, one row per source (chunk 0), newest first, ILIKE on title/text.
- `POST /lessons/:id/verify` and `DELETE /lessons/:id/verify` (unverify).
- `DELETE /lessons/:id` ("Esquecer"): for a note block, removes the block from the note (under the
  note lock) and its items; for a file lesson, sets `hidden_hash` (§3) on its items so the sweeper does
  not bring the same content back. The response says that the file itself stays in the
  repository ("O arquivo continua no repositório; apague-o por um PR para sumir de vez").
- Contracts in `packages/mobile-api` (`chat.ts`), non-strict zod objects.
- `PUT /projects/:id/note` accepts `base_updated_at` (D9).

## 7. Clients

- Web `ChatMemoryPage.tsx` and mobile `chat-memory-screen.tsx`: a third section "Lições" (after
  "Decisões" and TER-95's "Anotações do concierge"): search box, list rows with the symptom, project,
  origin ("arquivo docs/lessons/…" or "anotação do projeto"), evidence, a "verificada" badge, and the
  actions Verificar/Desfazer verificação, Abrir origem (web: the PR/card link or the project's Notas;
  mobile: the PR/card link), Esquecer (with the confirm text from §6).
- Web `NotesEditor.tsx`: sends `base_updated_at` (the note's `updated_at` it last loaded or saved),
  adopts the returned content when it differs from what it sent and nothing was typed since, and shows
  "lição adicionada por um agente" in the status line when that happens.

## 8. Instructions for agents

`CLAUDE.md` of termhub gains (English, like the file):

```markdown
## Failure lessons

- Before debugging an error, search `docs/lessons/` (`grep -ril "<error text>" docs/lessons`) and, when the termhub MCP is available, `search_memory` with `kinds: ["lesson"]`.
- After fixing an error that was not obvious, add `docs/lessons/YYYY-MM-DD-<slug>.md` in the same PR (format in `docs/lessons/README.md`). Never paste secrets, tokens or customer data into a lesson.
```

`docs/lessons/README.md` holds the format of D4 and one real example from this repo's history
(TER-57's P3009 migration lesson).

## 9. Security

- **Prompt injection.** A lesson is text an agent wrote after reading terminal output: it is `derived`,
  labelled as data in `search_memory`, never an automatic-answer source, and unverified until the
  person marks it. Screens and command output are still never indexed (TER-95 D4); `record_lesson`
  stores what the agent wrote, not what the screen showed.
- **Fence forgery.** `<!--`/`-->` inside `record_lesson` fields are replaced before writing (D7); the
  indexer only recognises fences at the start of a line with the exact shape; an unclosed fence is the
  person's text.
- **Secrets.** Lessons end up in repositories and notes: the tool description and the CLAUDE.md block
  say never to include secrets; the server refuses a `record_lesson` whose fields match a small list of token
  patterns (`thb_pat_`, `sk-`, `ghp_`, `github_pat_`, `AKIA` + 16 characters, `-----BEGIN … PRIVATE KEY`)
  with a pt-BR error. The list is a floor, not a scanner.
- **Scope.** Everything filters by owner; `project_id` and `tab_id` go through `ctx.scoped`; the
  lessons routes check the item's `owner_id`.
- **Logs.** ids, counts and codes only; never symptoms, text or paths.

## 10. Testing

- Unit: `parseLessonFile` (front matter variants, missing fields, README skipped); `splitNote` (fences,
  unclosed fence, marker inside text, headings); fence neutralising; the D9 merge (new block kept,
  deleted old block not restored, no base → plain overwrite); secret patterns; `record_lesson` checks,
  cap and note-size limit; the reminder appended by `launchLine`'s caller and the 4000 limit.
- DB: `memory_items` lesson upsert keeps `verified_*`, `verified` drops on hash change; note lock
  (concurrent append + save keeps both); hidden lesson stays hidden after re-index, comes back on a new hash.
- MCP route: `record_lesson` listed only with scope `memory` + `notes:update`; self-mediated on a gated
  token; `search_memory` `kinds: ["lesson"]` returns `verified`/`evidence`.
- Docs sweeper: `docs/lessons/*.md` listed and indexed as `lesson`, README skipped; agent script
  parity (ssh/local) for the new directory.
- Web and mobile: Lições list (verify, unverify, forget with confirmation), NotesEditor adopting merged
  content.

## 11. Out of scope and related cards

- **TER-212** (MCP inside agent tabs, scoped per-tab token): still needed for tabs to call
  `record_lesson`/`search_memory`; until then tabs use `docs/lessons/` and `grep`, and the concierge
  writes to the note. This design does not change TER-212's scope.
- **TER-217** (export lessons to the repository): absorbed — lessons are born in the repository (D1).
  The card is closed pointing here.
- Sharing lessons between people, public lesson networks, consensus between agents: out (TER-110).
- Writing into a person's repository from the server (e.g. moving a note lesson to `docs/lessons/` by a
  PR): out; the person or an agent in a tab does it.

## 12. Adjustments found while implementing

- **§4 revised: the docs sweeper does version-gate `docs/lessons`.** §4 said an agent older than the
  one that knows `docs/lessons` "just returns fewer files (the RPC validates paths, so the server
  version-gates nothing)". In the real agent protocol a param the agent's RPC schema does not know
  fails the params parse before dispatch, the same failure mode `DOCS_MIN_AGENT_VERSION` already
  existed to avoid for specs/plans — so lessons get their own floor, `DOCS_LESSONS_MIN_AGENT_VERSION =
  '0.9.1'` (`memory/docs.ts`), next to `DOCS_MIN_AGENT_VERSION = '0.8.0'`. The agent itself was bumped
  to 0.9.1. `docs.read` for `docs/lessons/*.md` is a separate call (`DocsExec.readLessons`) from the
  specs/plans one, gated independently, so a machine on an agent between 0.8.0 and 0.9.1 keeps reading
  specs/plans while its lessons are skipped until it updates (auto-update within the hour). (0.9.1, not
  0.8.1: after rebasing onto `main`, it turned out `main` had already released agent 0.9.0 for the
  `secret.read` RPC, another card, ahead of this one, so lessons needed the next version to land after
  it.)
- **This branch's migration is `20260928200000_failure_lessons`**, renamed (from an earlier timestamp)
  to sort after `main`'s own `20260928090000_chat_project_grant_scope`, picked up by the same rebase.
- **The project note's free text is split by a note-local splitter (`splitPersonText`,
  `lessons/note.ts`), not TER-95's `chunkMarkdown`.** `chunkMarkdown` drops a heading-only section and
  failed the plan's unclosed-fence test; `splitPersonText` keeps the same heading-split shape but
  handles both. A `project_note` section over `ITEM_TEXT_MAX` (1200 chars) is split into consecutive
  chunks (`memory/note.ts`), never truncated — the plan's data model (§3) did not say what happens to
  an oversized section.
- **Card vs. PR in a note lesson's `- **Evidência:**` line are told apart by shape, not position**
  (`parseEvidenceLine`, `memory/note.ts`): a PR always looks like a URL, a card never does, so a block
  with a PR but no card (an omitted-field render) still parses correctly. A note lesson's `meta` is
  otherwise thinner than a file lesson's: `tags: []` and `agent: null` always (`record_lesson` takes
  neither), `evidence` falling back to `fixed` when the line is missing or unrecognised.
- **`deleteDocsNotInLinks` also removes file lessons of an unlinked/deleted project link**, not only
  `kind = 'doc'` rows (fix round 1, Task 4): a project link's `docs/lessons/*.md` items were otherwise
  never revisited once its link was gone, staying indexed forever.
- **`indexProjectNote` loads the note's owner through the projects repository and skips a deleted
  project**. The note route fires it `void` (best effort) after the save; `record_lesson` **awaits**
  it (not `void`, unlike §4 says), since it must look the fresh item up for the `ref` it returns —
  `indexProjectNote` never throws (it logs `{ projectId, code }` and resolves with zero counts), so
  awaiting it can delay the call but never fail it. Either way, a crash between saving and indexing
  leaves the note stale until the memory sweeper's own pass, never blocks or fails the save/record.
- **`record_lesson` returns `ref: null`, not a failure, when the just-written block is not yet
  indexed** (`control/lessons.ts`): the write to the note always succeeds and is reported as such; only
  the ref the caller could cite in the same turn is missing until the index catches up.
- **`NotesEditor.tsx` only advances its `base.current` when it adopts the merged content, or when
  nothing was typed since sending** (fix round 1, Task 7, was Critical): advancing it unconditionally
  on every response — including when the person had typed since and the merge was *not* shown — let a
  base newer than a just-appended block's `at` reach the next save, so the server's merge (D9) no
  longer re-appended it and the lesson was silently lost.
- **The concierge prompt's line about lessons (D12) is in English**, next to TER-95's own '- Memory:'
  line in `chat/concierge-prompt.ts`, which is already English — not pt-BR as the plan assumed. The
  `start_agent` reminder (D13) stays pt-BR, like the rest of `RESUME_PROMPT`.
- **`docs/lessons/README.md`'s example (D14) is a lesson actually hit during this delivery**, not the
  plan's P3009 migration story: after rebasing on `main`, `npm run typecheck -w @termhub/server` failed
  with a `TS2305` on `@termhub/mobile-api` because the internal packages' `dist/` was stale;
  `npm run build:packages` (the same step CI runs before the server typecheck) fixed it. The original
  P3009 example was a preventive runbook in the TER-57 spec, never an incident, so writing it up with
  `evidence: fixed` and a past-tense narrative would have fabricated a history that never happened.
- **Verification (Task 10) ran on `node:22`**, matching CI and the rest of this delivery's tasks, not
  the `node:20` CLAUDE.md's "Verifying before pushing" section names — only the image tag would change
  if that were wrong (that command is stale against `deploy.yml`'s `node-version: 22`; out of scope
  for this PR to fix, and already the ruling Task 9's lesson example landed on).
- **`th-ter205-db`'s migration bookkeeping needed a manual `prisma migrate resolve --applied`
  before Task 10's checks could run**: `20260927170000_concierge_memory`'s DDL (the `memory_items`
  table, `users.chat_autodecide`, …) had already been applied under an earlier name
  (`20260927100000_concierge_memory`, TER-95's original timestamp) by an earlier task's full
  `migrate deploy`; once TER-95's migration was renumbered to sort after this branch's other
  post-merge migrations, Prisma no longer recognised the folder as already applied and a later
  `migrate deploy` failed on `column "chat_autodecide" already exists`. Resolving the renamed migration
  as applied (no DDL re-run) is a one-time fix of `th-ter205-db`'s own history, not a code change.
- **End-to-end smoke (Task 10), real embedder against `th-ter205-db` + a throwaway `docker/embed`
  container built as `th-ter205-embed`** (model weights copied from the existing `termhub_embed-models`
  volume into a throwaway one, so no download and no touching that volume): seeded a user, a project
  and a personal token (`read`, `memory`). Over `/mcp`: `record_lesson` (`symptom: "P9999 smoke"`,
  `evidence: "fixed"`) wrote the fenced block under a new `## Lições` heading and returned a ref;
  `search_memory({query: "P9999", kinds: ["lesson"]})` found it with `verified: false`. Logging in as
  that user (password login, session cookie) and calling `POST /api/chat/lessons/:id/verify` (the
  route's own session + CSRF auth, not the MCP token) returned `verified: true`, and the next
  `search_memory` call agreed. `PUT /projects/:id/note` with content that dropped the block and a
  `base_updated_at` older than the block's `at` came back with the block re-appended under `## Lições`,
  exactly as D9 specifies.
- **Verification and hiding key on the whole lesson source, not one chunk** (final review fix; revises
  §3, which pinned `content_hash`): a README-format file lesson becomes several chunks, and a per-chunk
  mark said `verified: false` for a hit on chunk 1 and kept "verificada" when only the Fix section
  changed. For `kind = 'lesson'`, `setVerified`/`clearVerified`/`hideSource` update every row of the
  `(kind, source_id)`, storing the source's `source_hash` (the file's sha256; `sha256(body)` for a note
  block) into `verified_hash`/`hidden_hash`, and `verified`/"not hidden" compare against `source_hash`
  (`markHash`, `db/repositories/memory-items.ts`). Every other kind keeps TER-95's `content_hash`.
- **A fence whose `at` is not a real instant is the person's text** (final review fix): `OPEN`'s regex
  accepted `at=2026-99-99T99:…`, which became an `Invalid Date` `source_at` and failed the whole note's
  index on every pass. `splitNote` (and so `mergeNoteSave`) now requires `at` to round-trip through
  `Date`, the same rule as a shape-invalid marker.
- **`docs/lessons` has its own scan budget, and an old agent's scan never deletes lessons** (final
  review fix): specs, plans and lessons shared `DOCS_MAX_FILES = 200`, so a repo with 200+ specs/plans
  never listed a lesson and every indexed file lesson was then deleted as gone. The scan now counts
  lessons against `LESSONS_MAX_FILES = 200` on their own (specs/plans unchanged), and `indexDocsForLink`
  skips the "gone lessons" deletion for an agent below `DOCS_LESSONS_MIN_AGENT_VERSION`, whose scan
  never walks `docs/lessons`.
- **`NotesEditor` always sends a base** (final review fix): for a project with no note yet it sent no
  `base_updated_at`, so its first save was a plain upsert that erased a lesson appended meanwhile. It now
  sends the note's `updated_at` as returned — the epoch for a missing note — and only hides that date.
- **A lesson's `at` is taken under the note row lock** (final review fix): `notes.appendBlock(projectId,
  render)` renders the block after `lockOrCreate`, with `at` later than the locked row's `updated_at`,
  and stamps the row with that `at`. Rendered before the lock, a person's save committing in between
  left the row newer than the block, and a client basing its next save on it dropped the block.
- **A file lesson's `pr` is kept only when it is an http(s) URL** (final review fix): the web list links
  it and mobile hands it to `Linking.openURL`; anything else in the front matter becomes `null`.
- **`record_lesson` logs through the MCP request's logger** (final review fix): `ControlContext` gained
  an optional `log`, set by the MCP route, which `record_lesson` passes to `indexProjectNote`.
- **Known limits** (not fixed in this delivery):
  - A repository linked to the same project on two machines indexes each file lesson twice (one
    `source_id` per link), so it can show twice in the list and in search.
  - "Esquecer" on a note lesson while the notes editor is open elsewhere can bring the block back with
    that editor's next save (its content still has the block and its base predates the removal).
  - A copy-pasted block (duplicate id) is indexed once, and `removeLessonBlock` removes only the first
    copy.
