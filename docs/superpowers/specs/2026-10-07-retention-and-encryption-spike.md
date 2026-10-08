# Spike: retention and encryption at rest for chat, attachments and last answers (TER-582)

Origin: TER-543. Output: a recommendation and an estimate. No code changes beyond this document
and one stale README sentence.

Related: `docs/legal/politica-de-privacidade.md` §8 (retention table written "as it should be"),
`docs/legal/duvidas-advogado.md` gaps P-6, P-7, P-11.

## 1. Where we are (code on `main` at c6ed07b2)

### 1.1 Correction to the card

The card says account deletion is admin-only and leaves machines, projects and integrations
orphaned with `owner_id` NULL. **That is no longer true.** TER-720 (PR #285) shipped:

- self-service deletion on web and mobile, with a 30-day window to undo
  (`apps/server/src/account/deletion.ts`, `routes/account.ts`, `routes/m-account.ts`);
- the public page `termhub.dev/excluir-conta` for deleting without the app;
- a full cascade in one transaction under the user row lock
  (`apps/server/src/db/repositories/account-deletion.ts:73`): projects, machines, integrations,
  tickets, uploads, device trail, rows keyed by e-mail (login codes, waitlist, deletion links),
  then everything that cascades from `users` (chat, memory, decisions, attachments rows); the
  attachment bytes on the volume are removed after the commit.
- The admin delete route uses the same purge (`routes/users.ts:206`).

The `onDelete: SetNull` on `machines/projects/integrations.owner_id` is still in the schema, but
no production path deletes a user without the purge first, so orphans are not produced any more.
The README sentence that still described orphaned machines is fixed in this PR.

What is still missing for account deletion: **backups** (there are none, P-7), so the policy's
"[N] days from backups" has nothing to bind to yet.

### 1.2 Inventory of content kept in plain text

| Data | Table / place | Size | Lives until | Read by | Searched in SQL? |
|---|---|---|---|---|---|
| Chat turns | `chat_messages.text` | unbounded prose | conversation, project or user deleted. "Nova conversa" only archives; there is **no route to delete a conversation** | chat UI, concierge | no (memory indexes copies) |
| Proposed commands/texts | `chat_actions.args` (JSON) | small | same as conversation | chat trail, decisions | no |
| Agent last answer | `tab_last_answers.text` | ≤ 100 000 chars, one row per tab, overwritten every turn | tab row deleted | `read_last_answer` | no |
| Tab questions | `tab_questions.payload/answer` | small | conversation/project deleted | chat cards | no |
| Tab state history | `tab_events.text` | small, many rows | tab deleted | timeline | no |
| Memory | `memory_items.text` + embedding; kinds `message`, `action`, `task`, `doc` (repo files read from the machine), `note`, `lesson`, `project_note` | chunks | owner/project deleted; docs replaced on re-index; no FK to the source row | `search_memory`, memory screens | **yes**: `to_tsvector` and `ILIKE` on `text` (`memory-items.ts:324,430`) |
| Attachment text | `chat_attachments.extracted_text` | up to the extractor cap | conversation deleted (unsent rows: 24 h) | concierge on demand | no |
| Attachment bytes | `CHAT_FILES_DIR/<user>/<id>` (volume `chat-files`) | 64 MB/file, 2 GB/user | row deleted (orphan sweep reconciles) | download, extraction | — |
| Waitlist | `waitlist_entries` (name, e-mail, phone, LinkedIn, GitHub) | small | an admin deletes it, or the account purge | admin screen | — |

Already encrypted with AES-256-GCM (`apps/server/src/lib/crypto.ts`): `integrations.secret` and
`devices.pin_secret_enc`. Format `base64(iv).base64(tag).base64(ct)`, one key from
`ENCRYPTION_KEY`, no key id, no rotation path.

Infrastructure: Postgres (`postgres:16` + pgvector) and the `chat-files` volume run on the same
host as the app, on the internal Docker network, with no TLS between app and database. Whether
the host disk is encrypted is not visible from the repo and was not checked here (the probe is
blocked from this agent); it must be confirmed on jarvis. There is no automated backup (README
only documents a manual `pg_dump` before a risky migration).

Existing cleanup machinery to reuse: the hourly `purge` interval in `apps/server/src/app.ts:331`
already runs attachment sweeps, mobile purges, the account deletion job and the 30-day purge of
`automation_events`, each as a `deleteMany({ createdAt: { lt: cutoff } })` in its repository.

## 2. Recommendation

### 2.1 Default retention per type

Principle: content the person **wrote or chose to keep** (notes, lessons, decisions, cards) lives
until they delete it; content that is a **by-product** of running agents expires on its own.
Expiry is per conversation (whole threads), never message by message, so a thread is never left
with holes.

| Data | Default | How it expires |
|---|---|---|
| Archived conversations (with messages, actions, tab questions, attachments) | **180 days after `archived_at`** | delete the conversation row; cascade does the rest; files removed after commit |
| Active conversation | **messages older than 365 days** | delete those messages (their actions, attachments) only; the thread keeps the recent part |
| `chat_actions.args` of decided actions | **90 days**, then redacted to `{}` | keep tool, class, status, dates for the trail; the command/text goes |
| `tab_last_answers` | **30 days after `at`** | delete the row (the tab shows "sem resposta guardada") |
| Closed `tab_questions` (not `open`) | **90 days after `closed_at`** | delete |
| `tab_events` | **30 days** | delete (fills the "[definir]" line in the policy) |
| Attachment bytes + `extracted_text` | follow their conversation/message | — |
| `memory_items` of kind `message` / `action` | follow their source | the job calls `deleteBySource` for every id it deletes (there is no FK) |
| `memory_items` of kind `doc` | no extra expiry | already replaced on re-index and removed when the project–machine link goes (`deleteDocsNotInLinks`); an unchanged file is skipped by hash, so `updated_at` cannot tell "stale" apart from "unchanged" |
| Notes, lessons, decisions, project notes, cards | until the person deletes them | — |
| `waitlist_entries` | **30 days after `invited_at`**, or **12 months** if never invited | delete (matches the policy's 12 months) |

These numbers are deliberately long enough that nobody loses a thread they are still using; the
policy table (§8) gets the same numbers once they ship.

### 2.2 Configurable per account

One nullable JSON column `users.retention` with per-category overrides, validated by a zod schema
with a floor and a ceiling per category (e.g. archived conversations 30–730 days or "keep until I
delete"). Null = defaults. A "Retenção" block in Settings (web) shows the effective value of each
category; mobile can follow later. Per-project overrides are not worth it now: the person owns
both levels.

Also add the missing **"Excluir conversa"** action (web and mobile), since a retention policy
without manual deletion is the wrong way round.

### 2.3 Cleanup job

`apps/server/src/retention/` with one function per category, run from the existing hourly
`purge` interval:

- each step deletes in batches (`DELETE … WHERE id IN (SELECT id … LIMIT 1000)`) until done or a
  time budget (~20 s) runs out, so a first run on a large table does not hold locks;
- both colors may run it; deletes are idempotent, and a `pg_try_advisory_lock` per run avoids
  double work;
- per-user overrides: the default cutoff applies in SQL to users without an override; users with
  one get their own pass (few rows);
- files: collect attachment ids in the transaction, remove the bytes after the commit through the
  attachment store (the same pattern as the account purge);
- memory: `deleteBySource` for deleted messages/actions in the same batch;
- logs only counts per category, never content;
- `RETENTION_DRY_RUN=1` for the first deploy: log what would go, delete nothing.

### 2.4 Encryption: disk and backups first, application-level only for secrets

Recommendation: **do not extend application-level encryption to chat, last answers or memory
now.** Instead:

1. **Encrypted disk on the host** for the Docker volumes (`pgdata`, `chat-files`) — LUKS on the
   data disk, or move the volumes to an encrypted one. Covers a stolen or discarded disk, which is
   the threat at-rest encryption is for.
2. **Automated, encrypted, off-host backups** (closes P-7): nightly `pg_dump` plus the
   `chat-files` volume, encrypted before leaving the host (`age` or `restic`) with a key that does
   not live on the server, retained **30 days**. That makes "[N] days from backups" in the policy
   a real number (N = 30) and bounds how long deleted data survives anywhere.
3. Keep application-level AES-GCM for **secrets** (integration tokens, PIN secret), and use it for
   any new secret.

Why not application-level for content:

- The key would sit in the same container environment as the database credentials. Against the
  realistic threats (host compromise, app compromise) it protects nothing; against a leaked dump or
  backup, the encrypted backup in item 2 already does.
- `memory_items.text` and `chat_decisions` are searched with `to_tsvector`/`ILIKE`; encrypting them
  breaks memory search (or forces an index of plaintext tokens, which defeats the point).
- Cost: every read path of chat, last answers and attachments changes, plus a data migration of
  every row; estimated 5–8 days with real regression risk, for little gain on a single-host setup.

Revisit if the database moves to a managed or shared host, or if termhub ever runs multi-tenant
for third parties on infrastructure they do not control. At that point: application-level
encryption of `tab_last_answers.text`, `chat_attachments.extracted_text` and the attachment bytes
(not searched), with per-user data keys, and `sslmode=require` to Postgres. TLS to Postgres today
adds nothing: the traffic never leaves the host's Docker bridge.

### 2.5 Key rotation with a key id

Small and worth doing now, because today a leaked `ENCRYPTION_KEY` cannot be replaced without
breaking every stored secret.

- Config: `ENCRYPTION_KEYS="k2:<base64>,k1:<base64>"` (keyring) and `ENCRYPTION_KEY_ID=k2`
  (current). `ENCRYPTION_KEY` alone keeps working as key id `k0`.
- Format: `v1.<kid>.<iv>.<tag>.<ct>`; a value with three parts is the legacy format and decrypts
  with `k0`.
- Bind the ciphertext to its place with AES-GCM AAD (`table:column:row id`), so a value copied to
  another row does not decrypt.
- CLI `node apps/server/dist/cli/rotate-secrets.js`: re-encrypts `integrations.secret` and
  `devices.pin_secret_enc` with the current key, in batches; afterwards the old key can be dropped
  from the keyring.
- Runbook in the README (generate key, add to keyring, deploy, rotate, remove old key).

### 2.6 Account deletion by the user

Done (TER-720, §1.1). Remaining items that belong to other cards: data export (P-10) and the
backup window, which item 2.4.2 defines.

## 3. Estimate

| # | Card | Size | Estimate |
|---|---|---|---|
| 1 | Retention job + defaults (§2.1, §2.3), with dry run, DB tests per category, memory follow-up | M | 3–4 days |
| 2 | "Excluir conversa" (server route + web + mobile) | S | 1 day |
| 3 | Per-account overrides: `users.retention`, zod, Settings block, i18n | S–M | 1.5–2 days |
| 4 | Key ring, key id, AAD and `rotate-secrets` CLI + runbook (§2.5) | S | 1–1.5 days |
| 5 | Infra: confirm/enable disk encryption on the data volumes (jarvis, manual, maintainer) | — | half a day, outside the code |
| 6 | Automated encrypted off-host backups, 30-day retention, restore drill (P-7) | M | 2 days |
| 7 | Policy §8 and its security section updated with the real numbers; P-11 and P-7 closed in `duvidas-advogado.md` | XS | 0.5 day |

Total in code: about 7–9 days, plus the infra items. Application-level encryption of content,
if ever needed: 5–8 days more (not recommended now).

Suggested order: 4 (cheap, removes a real risk) → 2 → 1 → 3 → 6 → 7; 5 whenever the maintainer
can do it on the host.

## 4. Decisions for the project owner

1. The default numbers in §2.1 (180 days archived, 365 days active, 30 days last answers).
2. Whether "keep until I delete" is an allowed per-account choice for conversations (proposed:
   yes, opt-in, since it is the person's own content).
3. Where off-host backups go (provider/country, which the policy also has to name, P-5).

## 5. Impact on other users

This spike changes nothing for anyone. The cards it proposes would: retention deletes old
archived conversations, old last answers, tab events and closed tab questions **by default for
every user** — announced before it ships, with the dry run first and long defaults; per-account
overrides are opt-in per user. Key rotation and backups are invisible to users.
