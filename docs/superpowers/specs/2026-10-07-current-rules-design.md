# Current rules per user and per project (TER-1010)

Phase 3 of the memory and decisions epic (TER-1007). Decisions and concierge notes that say the same
thing become a short list of **current rules** (regras vigentes), per project and per user, and only
ever with the person's approval.

## Sources

- Concierge notes: `memory_items` kind `note`, chunk 0 (`record_decision`, `indexNote`). Their
  statement is the `Decisão:` line.
- Card decisions: `chat_decisions`. Their statement is `question → answer`.
- Sources an approved rule supersedes (and the rule's own note) are left out. When TER-1013/1014 land
  their status columns (`wrong_at`, `superseded_at`, `expires_at`), `listSources` should add their
  "current" condition (`currentSql`) too; this card does not add competing columns.

## Data

New table `memory_rules` (migration `20261014090000_memory_rules`, additive):
`id`, `owner_id`, `project_id` (null = user level), `kind` (`rule` | `policy`), `status`
(`proposed` | `awaiting_confirmation` | `approved` | `rejected`), `text`, `policy`
(`{ autonomy?, max_parallel?, project_ids[], applied[] }`), `source_refs` (`note:<id>` /
`decision:<id>`), `fingerprint` (unique per owner), `note_id`, `decided_at`, `decided_by`.

## Consolidation (`apps/server/src/memory/rules.ts`, pure)

1. Grouping: union-find over pairs from pgvector (`similarPairs`: notes with notes, decisions with
   decisions that got the same answer, same `embed_model`, cosine ≥ `RULES_SIMILARITY_THRESHOLD`,
   default 0.9) plus word overlap (Jaccard ≥ 0.6 on the statement and title, card refs and stopwords
   removed), so it also works on a server without embeddings.
2. Permission: a clause with a grant word (pode, liberado, permitido, autorizado, sem perguntar, não
   precisa pedir…) and no negation in that same clause.
3. Autonomy: the granting clauses' highest level (merge/mesclar → `merge`, deploy → `deploy`,
   release/publicar/npm/OTA → `release`) and the number next to "paralelo". When that is wider than the
   Setup of one or more of the group's projects, the group becomes **one `policy` proposal** for those
   projects.
4. Otherwise a permission in 2 or more projects becomes **one rule at the user level** (the 4-project
   acceptance case gives one proposal), and 2 or more sources of one scope become one rule of that scope.
5. Rejection: a rejected row of the same kind and scope, decided less than 180 days ago, that held more
   than half of a candidate's sources suppresses it. One more project saying the same thing does not bring
   it back; after 180 days it is proposed again.

Consolidation runs on `GET /chat/rules` (the Memória screen); `syncProposals` keeps a proposal's id
across refreshes (same fingerprint) and drops proposals whose sources went away.

## Approving and rejecting

Routes in `chat-memory.ts`, mounted for the web (`/api/chat`) and the app (`/api/m/v1/chat`):
`GET /rules`, `POST /rules/:id/approve` (`{ text? }`), `POST /rules/:id/reject`, `DELETE /rules/:id`.

- Approving a `rule`: `approved`, and indexed as a note of the person's (trust `person`,
  title "Regra vigente"), so `search_memory` finds the rule; `search_memory` drops the refs approved rules
  supersede.
- Approving a `policy` never touches the Setup. It asks one `set_automation_policy` card per project
  (`askForAutomation`, key `memory_rule:<rule>:<project>`) and waits as `awaiting_confirmation`. The
  `onApproved('set_automation_policy')` hook (ignores the concierge's own cards, which have no such key)
  claims the approved card and applies it through `setAutomationPolicy` with the card as the approval.
  When every card is decided the rule is `approved` if any project took it, else `rejected` (the
  180 days start).
- Rejecting stores `rejected` and `decided_at`.
- "Remover" deletes an approved rule and its note; its sources apply again.

## UI

A "Regras vigentes" section, its own component, mounted with one line on the web
(`components/MemoryRulesSection.tsx`) and in the app's Memória screen: proposals with Aprovar/Recusar,
what a policy changes and on which projects, "Aguardando a confirmação no chat" while its cards are
open, approved rules with their sources and "Remover". pt-BR through `t()`, English in the catalogs.

## Impact on other users

Opt-in: proposals only appear on the Memória screen, and nothing changes until the person approves one.
A policy change still needs the `set_automation_policy` confirmation card for each project. Someone who
never approves a proposal sees no difference besides the new section.
