# Current rules per user and per project (TER-1010) — DRAFT, work in progress

**Status:** draft. Work stopped before any code was written (the machine was being shut down).
This file records the code map and the design so far, so the next run can pick it up.

## Code map (verified 2026-10-07)

- Concierge notes: `record_decision` (`apps/server/src/mcp/tools.ts:413`) → `recordDecision`
  (`apps/server/src/control/memory.ts:284`) → `indexNote` (`apps/server/src/memory/index-items.ts:208`):
  `memory_items` kind `note`, trust `derived`, text `Decisão: …\nMotivo: …\nFontes: …`.
- Card decisions: `chat_decisions` (`apps/server/src/db/repositories/chat-decisions.ts`), trust `person`.
- Project note sections: `memory_items` kind `project_note`, trust `person` (`apps/server/src/memory/note.ts:82`).
- No `supersedes` or `expires_at` column exists yet. Sibling cards TER-1013 (supersedes) and TER-1014
  (scope and expires_at) add them in parallel, so this card must not add competing columns to
  `memory_items` or `chat_decisions`.
- Automation policy: `set_automation_policy` (`apps/server/src/mcp/tools.ts:288`) →
  `setAutomationPolicy` (`apps/server/src/automation/setup-tools.ts:85`). It is stored in
  `project_setups.data.automation`. A widening change on a gated token needs an approved `chat_actions`
  card (`apps/server/src/chat/gate-runtime.ts`). `askForAutomation` (gate-runtime.ts ~410) creates a
  server-owned card that the server acts on through `ChatService.onApproved(tool, fn)` (`apps/server/src/chat/service.ts:732`).
- Memory screen routes: `apps/server/src/routes/chat-memory.ts`, mounted for both web (`/api/chat`) and
  mobile (`/api/m/v1/chat`). Web: `apps/web/src/pages/ChatMemoryPage.tsx`. Mobile:
  `apps/mobile/src/features/chat/view/chat-memory-screen.tsx` and `createChatMemoryStore.ts`.
  Contracts: `packages/mobile-api/src/chat.ts`.
- DB tests need `TERMHUB_DB_TESTS=1` and Postgres with pgvector. In this environment `docker` is blocked
  by the hard-lock hook, so they only run in CI.

## Design (proposed)

1. New table `memory_rules`, created by a new migration:
   - `id`, `owner_id`, `project_id` (null means a user-level rule), `kind` (`rule` | `policy`), `status`
     (`proposed` | `awaiting_confirmation` | `approved` | `rejected`), `text`, `policy` (Json:
     `{ autonomy?, max_parallel?, project_ids[] }`), `source_refs` (Json: `note:<id>` / `decision:<id>`),
     `fingerprint`, `decided_at`, `decided_by`, `created_at`.
   - An approved rule **supersedes its `source_refs`**. Consolidation and the rules list skip those
     sources. When TER-1013's `supersedes` field lands, it can be written too.
2. Pure consolidation (`apps/server/src/memory/rules.ts`, unit-tested):
   - Inputs: the current notes and decisions (not forgotten, not covered by an approved rule, not
     expired once TER-1014 lands), plus similar pairs from a pgvector self-join (same `embed_model`,
     cosine ≥ threshold).
   - Union-find groups the items into clusters.
   - A permission-like cluster (detected by regex: pode / liberar / permitir / sem perguntar / sem
     confirmação / autoriz…) that spans ≥ 2 projects becomes **one** user-level proposal. Acceptance
     case: the same permission in 4 projects gives 1 proposal.
   - A cluster of ≥ 2 items inside one project becomes a project-level proposal, worded as the newest item.
   - Autonomy terms (merge/mesclar, deploy, release/publicar, paralel…) produce a `policy` proposal:
     autonomy = the highest level mentioned, `max_parallel` = the number next to "paralel".
   - `fingerprint` = sorted `source_refs` hash plus kind and scope. A `rejected` row with the same
     fingerprint and `decided_at` < 180 days ago suppresses the proposal.
3. Approving and rejecting (routes in `chat-memory.ts`, so web and mobile share them):
   - `GET /chat/rules` returns the current rules per scope, plus the pending proposals.
   - `POST /chat/rules/:id/decision` with `{ decision: approve | reject }`.
   - Approving a `rule` sets it to `approved`.
   - Approving a `policy` never touches the policy directly. It creates one `set_automation_policy` card
     per project through `askForAutomation`, sets the rule to `awaiting_confirmation`, and an
     `onApproved('set_automation_policy')` handler applies it. A denied card marks the rule `rejected`.
   - Reject stores `rejected` with `decided_at` (the 180-day block).
4. UI: a "Regras vigentes" section as its own component, mounted with one line in `ChatMemoryPage`
   (web) and `chat-memory-screen` (mobile) to avoid conflicts with TER-1013. pt-BR keys through `t()`,
   with English in `locales/en/chat.json` for both apps.
5. Tests: unit tests of the consolidation (4 projects give 1 proposal; autonomy gives a policy proposal;
   a rejection inside 180 days suppresses, after 180 days it returns), and a DB test of the repository.

## Impact on other users

Opt-in: proposals only appear on the Memória screen. Nothing changes until the person approves.
Policy changes still require the `set_automation_policy` confirmation card.

## Next step

Open questions to settle first:
- The similarity threshold: check what `decision-memory.ts` uses.
- How `onApproved` hands the approval to `setAutomationPolicy`.

Then: write the migration and repository, then the pure `rules.ts` with tests, then the routes, then
web, mobile and the mobile-api contracts, then i18n check, typecheck and the PR against
`epic/TER-1007-memoria-e-decisoes-hierarquia-regras-vig`.
