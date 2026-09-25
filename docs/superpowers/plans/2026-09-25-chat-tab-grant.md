# Chat tab grant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user trust one tab for `send_input` for the rest of a chat conversation (max 24 h), from the confirmation card, with a visible and revocable grant and every run audited in `chat_actions`.

**Architecture:** A new `chat_grants` table (conversation + tab + tool, `expires_at`, `revoked_at`) behind `ChatGrantsRepository`. The gate (`applyGate`) consults an active grant only where it would otherwise ask, inserts an already-approved `chat_actions` row carrying `grant_id`, and runs it through the existing `execute()` so every lock (`TAB_GONE`, `WAITING_PERMISSION`, `PROMPT_CHANGED`) stays in force. The decision route learns `approve_tab`, a `DELETE /chat/grants/:id` revokes, and the web card + a strip above the composer show and revoke grants.

**Tech Stack:** Fastify + zod + Prisma 7 (Postgres) in `@termhub/server`, vitest; React + Testing Library in `@termhub/web`.

**Spec:** `docs/superpowers/specs/2026-09-25-chat-tab-grant-design.md` (read it first).

**Board:** card TER-2 (project `termhub`, id `lxjlcaa8gd35`). Subtasks: TER-3 `9budkbmcxfgj`, TER-4 `wz8ry2yy3nek`, TER-5 `88u5bxqc3m80`, TER-6 `hnr3tu8hzm6f`. The controller (not the implementer) moves each subtask to done after its task passes review.

## Global Constraints

- Code, comments, identifiers, commit messages: English. **UI copy: pt-BR**, verbatim from this plan.
- Commit subject imperative, ≤ 72 chars; every commit ends with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Routes never import Prisma; go through `apps/server/src/db/repositories`. Every request input validated with zod.
- Every user-scoped read/write filters by the owning conversation's `user_id` **in SQL**.
- Migration only adds (a table, a nullable column): the previous release must keep working against it.
- Grant lifetime: `GRANT_TTL_MS = 24 * 60 * 60 * 1000`. Grantable call: `tool === 'send_input'`, `args.answering_permission !== true`, `args.tab_id` a 1–64 char string.
- Terminal content is never logged; never log `args`.
- This host shares production: throwaway containers are named `th-*`; never touch `termhub-*`, `proxy-*`.

## How to run things (worktree `~/termhub-wt-tab-grant`)

All Node commands run in Docker (`node:22`), from the worktree root:

```bash
# one-time: throwaway Postgres for the *.db.test.ts files
docker run -d --name th-tabgrant-db -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=termhub postgres:16-alpine
# NODE: run a shell command in node:22 sharing that container's network (localhost:5432 = the db)
NODE() { docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp --network container:th-tabgrant-db \
  -e DATABASE_URL=postgresql://postgres:postgres@localhost:5432/termhub -v "$PWD:/w" -w /w node:22 sh -c "$1"; }
NODE 'npm ci && npm run prisma:generate -w @termhub/server && npm run build:packages'   # one-time
```

- Server unit tests: `NODE 'npm test -w @termhub/server -- <file-or-pattern>'`
- Server db tests: `NODE 'cd apps/server && npx prisma migrate deploy && cd ../.. && TERMHUB_DB_TESTS=1 npm test -w @termhub/server -- <file>'`
- Web tests: `NODE 'npm test -w @termhub/web -- <file>'`
- Typecheck: `NODE 'npm run typecheck -w @termhub/server'` / web: `NODE 'npm run build -w @termhub/web'`
- After finishing: `rm -rf .npm` (cache the container leaves behind). Leave `th-tabgrant-db` running until the last task; the controller removes it at the end (`docker rm -f th-tabgrant-db`).

## File map

| File | Responsibility |
|---|---|
| `apps/server/prisma/schema.prisma` | `ChatGrant` model; `ChatAction.grantId`; `ChatConversation.grants` |
| `apps/server/prisma/migrations/20260925090000_chat_grants/migration.sql` | table, partial unique index, `chat_actions.grant_id` |
| `apps/server/src/db/repositories/chat-grants.ts` (new) | `ChatGrantsRepository`, `ChatGrant`, `GRANT_TTL_MS` |
| `apps/server/src/db/repositories/chat-grants.db.test.ts` (new) | repository against Postgres |
| `apps/server/src/db/repositories/chat-actions.ts` | `grant_id` on `ChatAction`; `insertApproved` |
| `apps/server/src/db/repositories/index.ts` | register `chatGrants` |
| `apps/server/src/db/repositories/chat-actions-view.ts` | `grant_id` on the card; `describeGrants` |
| `apps/server/src/chat/gate.ts` | `grantable()` |
| `apps/server/src/chat/gate-runtime.ts` | grant branch in `applyGate` |
| `apps/server/src/chat/bus.ts` | events `grant`, `grant_revoked`, `granted_action` |
| `apps/server/src/routes/chat.ts` | `approve_tab`, `DELETE /grants/:id`, `grants` in `GET /` |
| `apps/server/src/chat/service.ts` | reset revokes; injection mentions the grant |
| `apps/web/src/lib/types.ts`, `apps/web/src/lib/api.ts` | `ChatGrant`, events, API calls |
| `apps/web/src/components/chat/grant-time.ts` (new) | "até HH:MM" / "até amanhã, HH:MM" |
| `apps/web/src/components/chat/ChatActionCard.tsx` | third button, granted state, "aba confiada" |
| `apps/web/src/components/chat/ChatGrantStrip.tsx` (new) | strip above the composer |
| `apps/web/src/components/chat/ChatPanel.tsx` | grants state, events, revoke |

---

### Task 1 (TER-3): Grant model, migration and repository

**Files:**
- Modify: `apps/server/prisma/schema.prisma` (models `ChatConversation` ~line 610, `ChatAction` ~line 655)
- Create: `apps/server/prisma/migrations/20260925090000_chat_grants/migration.sql`
- Create: `apps/server/src/db/repositories/chat-grants.ts`
- Create: `apps/server/src/db/repositories/chat-grants.db.test.ts`
- Modify: `apps/server/src/db/repositories/chat-actions.ts`
- Modify: `apps/server/src/db/repositories/chat-actions.db.test.ts`
- Modify: `apps/server/src/db/repositories/index.ts`
- Modify (type fallout only, add `grant_id: null` to every `ChatAction` literal): `apps/server/src/mcp/gate.e2e.test.ts`, `apps/server/src/chat/service.test.ts`, `apps/server/src/db/repositories/chat-actions-view.test.ts`, and any other file `grep -rln "decided_at:" apps/server/src` lists that builds a `ChatAction`.

**Interfaces:**
- Produces:
  ```ts
  // chat-grants.ts
  export const GRANT_TTL_MS: number; // 24 h
  export interface ChatGrant { id: string; conversation_id: string; tab_id: string; tool: string; source_action_id: string | null; granted_by: string; created_at: string; expires_at: string; revoked_at: string | null; revoked_by: string | null }
  export interface GrantInput { conversation_id: string; tab_id: string; tool: string; source_action_id?: string | null; granted_by: string }
  export class ChatGrantsRepository {
    grant(input: GrantInput, now?: Date): Promise<ChatGrant>;
    findActive(conversationId: string, tabId: string, tool: string, now?: Date): Promise<ChatGrant | undefined>;
    listActive(conversationId: string, now?: Date): Promise<ChatGrant[]>;
    findActiveBySourceAction(actionId: string, now?: Date): Promise<ChatGrant | undefined>;
    findByIdForUser(id: string, userId: string): Promise<ChatGrant | undefined>;
    revoke(id: string, userId: string, now?: Date): Promise<ChatGrant | undefined>;
    revokeForConversation(conversationId: string, now?: Date): Promise<number>;
  }
  // chat-actions.ts
  interface ChatAction { /* existing fields */ grant_id: string | null }
  interface InsertApprovedInput extends InsertPendingInput { grant_id: string; decided_by: string }
  ChatActionsRepository.insertApproved(input: InsertApprovedInput): Promise<ChatAction>;
  // index.ts
  Repositories.chatGrants: ChatGrantsRepository
  ```

- [ ] **Step 1: Schema.** In `schema.prisma`, add to `model ChatConversation` (next to `actions ChatAction[]`): `grants        ChatGrant[]`. Add to `model ChatAction`, after `tabId`:
  ```prisma
  /// The grant this action ran under (`chat_grants`), when it was not asked but allowed by one.
  grantId        String?          @map("grant_id")
  ```
  and add after `model ChatAction`:
  ```prisma
  /// "Permitir sempre nesta aba": the user let the concierge type into one tab without asking, for
  /// one conversation, until `expires_at` (24 h) or a revocation. Only `send_input` without
  /// `answering_permission` (spec 2026-09-25). One active row per conversation + tab + tool — a partial
  /// unique index that lives only in the migration, like `chat_actions_one_open_per_key`.
  model ChatGrant {
    id             String           @id
    conversationId String           @map("conversation_id")
    conversation   ChatConversation @relation(fields: [conversationId], references: [id], onDelete: Cascade)
    tabId          String           @map("tab_id")
    tool           String
    sourceActionId String?          @map("source_action_id")
    grantedBy      String           @map("granted_by")
    createdAt      DateTime         @default(now()) @map("created_at")
    expiresAt      DateTime         @map("expires_at")
    revokedAt      DateTime?        @map("revoked_at")
    /// Null when the system ended it (a reset), a user id when someone clicked "Revogar".
    revokedBy      String?          @map("revoked_by")

    @@index([conversationId])
    @@map("chat_grants")
  }
  ```

- [ ] **Step 2: Migration** `apps/server/prisma/migrations/20260925090000_chat_grants/migration.sql`:
  ```sql
  -- AlterTable
  ALTER TABLE "chat_actions" ADD COLUMN "grant_id" TEXT;

  -- CreateTable
  CREATE TABLE "chat_grants" (
      "id" TEXT NOT NULL,
      "conversation_id" TEXT NOT NULL,
      "tab_id" TEXT NOT NULL,
      "tool" TEXT NOT NULL,
      "source_action_id" TEXT,
      "granted_by" TEXT NOT NULL,
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "expires_at" TIMESTAMP(3) NOT NULL,
      "revoked_at" TIMESTAMP(3),
      "revoked_by" TEXT,

      CONSTRAINT "chat_grants_pkey" PRIMARY KEY ("id")
  );

  -- CreateIndex
  CREATE INDEX "chat_grants_conversation_id_idx" ON "chat_grants"("conversation_id");

  -- One active grant per conversation + tab + tool. Partial, because a revoked grant must not stop the
  -- same tab from being trusted again. An expired-but-unrevoked row still holds the slot: `grant()`
  -- revokes it in the same transaction before inserting. Prisma cannot express this, so it lives here.
  CREATE UNIQUE INDEX "chat_grants_one_active_per_tab" ON "chat_grants"("conversation_id", "tab_id", "tool")
      WHERE "revoked_at" IS NULL;

  -- AddForeignKey
  ALTER TABLE "chat_grants" ADD CONSTRAINT "chat_grants_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "chat_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  ```
  Regenerate the client: `NODE 'npm run prisma:generate -w @termhub/server'`. Then prove schema and migrations agree, exactly as CI does:
  `NODE 'cd apps/server && npx prisma migrate deploy && npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code'` → expected exit 0 ("No difference detected" or empty). If it reports a difference, fix the SQL (not the check).

- [ ] **Step 3: Write the failing repository test** `apps/server/src/db/repositories/chat-grants.db.test.ts`:
  ```ts
  import { PrismaPg } from '@prisma/adapter-pg';
  import { afterAll, beforeAll, describe, expect, it } from 'vitest';
  import { PrismaClient } from '../../generated/prisma/client.js';
  import { newId } from '../../lib/ids.js';
  import { ChatRepository } from './chat.js';
  import { ChatGrantsRepository, GRANT_TTL_MS } from './chat-grants.js';

  describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('ChatGrantsRepository (Postgres)', () => {
    let db: PrismaClient;
    let repo: ChatGrantsRepository;
    let userId: string;
    let otherUserId: string;
    let conversationId: string;
    let otherConversationId: string;

    beforeAll(async () => {
      db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
      repo = new ChatGrantsRepository(db);
      userId = newId();
      otherUserId = newId();
      await db.user.create({ data: { id: userId, email: `${userId}@test.local`, name: 'test' } });
      await db.user.create({ data: { id: otherUserId, email: `${otherUserId}@test.local`, name: 'other' } });
      const chat = new ChatRepository(db);
      conversationId = (await chat.getOrCreateForUser(userId)).id;
      otherConversationId = (await chat.getOrCreateForUser(otherUserId)).id;
    });

    afterAll(async () => {
      await db.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } }); // cascades conversations and grants
      await db.$disconnect();
    });

    const grant = (tabId: string, now?: Date) => repo.grant({ conversation_id: conversationId, tab_id: tabId, tool: 'send_input', source_action_id: 'act1', granted_by: userId }, now);

    it('grants for 24 h and finds it active for that conversation, tab and tool only', async () => {
      const g = await grant('t1');
      expect(Date.parse(g.expires_at) - Date.parse(g.created_at)).toBe(GRANT_TTL_MS);
      expect((await repo.findActive(conversationId, 't1', 'send_input'))?.id).toBe(g.id);
      expect(await repo.findActive(conversationId, 't2', 'send_input')).toBeUndefined();
      expect(await repo.findActive(conversationId, 't1', 'run_command')).toBeUndefined();
      expect(await repo.findActive(otherConversationId, 't1', 'send_input')).toBeUndefined();
      expect((await repo.findActiveBySourceAction('act1'))?.id).toBe(g.id);
    });

    it('does not see a grant past its expiry', async () => {
      const g = await grant('t3', new Date(Date.now() - GRANT_TTL_MS - 1000));
      expect(await repo.findActive(conversationId, 't3', 'send_input')).toBeUndefined();
      expect((await repo.listActive(conversationId)).some((x) => x.id === g.id)).toBe(false);
    });

    it('granting again replaces the old grant and restarts the clock, even an expired one', async () => {
      const old = await grant('t4', new Date(Date.now() - GRANT_TTL_MS - 1000));
      const fresh = await grant('t4');
      expect(fresh.id).not.toBe(old.id);
      expect((await repo.findActive(conversationId, 't4', 'send_input'))?.id).toBe(fresh.id);
      expect((await repo.findByIdForUser(old.id, userId))?.revoked_at).not.toBeNull();
    });

    it('revokes only for the owner, once', async () => {
      const g = await grant('t5');
      expect(await repo.revoke(g.id, otherUserId)).toBeUndefined();
      expect(await repo.findByIdForUser(g.id, otherUserId)).toBeUndefined();
      const revoked = await repo.revoke(g.id, userId);
      expect(revoked?.revoked_by).toBe(userId);
      expect(await repo.revoke(g.id, userId)).toBeUndefined(); // already revoked
      expect(await repo.findActive(conversationId, 't5', 'send_input')).toBeUndefined();
    });

    it('revokeForConversation ends every active grant of that conversation, by nobody', async () => {
      await grant('t6');
      await grant('t7');
      expect(await repo.revokeForConversation(conversationId)).toBeGreaterThanOrEqual(2);
      expect(await repo.listActive(conversationId)).toEqual([]);
    });
  });
  ```
  And in `chat-actions.db.test.ts`, add:
  ```ts
  it('inserts an action already approved under a grant, and it can be claimed', async () => {
    const row = await repo.insertApproved({ conversation_id: conversationId, tool: 'send_input', args: { tab_id: 't1', text: 'sim' }, class: 'write', idempotency_key: 'kg1', tab_id: 't1', grant_id: 'g1', decided_by: userId });
    expect(row).toMatchObject({ status: 'approved', grant_id: 'g1', decided_by: userId });
    expect(row.decided_at).not.toBeNull();
    expect(await repo.claimApproved(row.id)).toBe(true);
  });
  ```

- [ ] **Step 4: Run to verify it fails.** Run the db tests for both files. Expected: FAIL (module `./chat-grants.js` not found / `insertApproved` is not a function).

- [ ] **Step 5: Implement** `apps/server/src/db/repositories/chat-grants.ts`:
  ```ts
  import type { PrismaClient } from '../prisma.js';
  import type { ChatGrant as PrismaChatGrant } from '../../generated/prisma/client.js';
  import { newId } from '../../lib/ids.js';

  /** How long "Permitir sempre nesta aba" lasts at most (spec 2026-09-25 §2): the conversation, capped
   * at the same 24 h an approval lives (`ACTION_TTL_MS`). A reset ends it earlier (`revokeForConversation`). */
  export const GRANT_TTL_MS = 24 * 60 * 60 * 1000;

  /** A standing "yes" for one tool on one tab, in one conversation. */
  export interface ChatGrant {
    id: string;
    conversation_id: string;
    tab_id: string;
    tool: string;
    source_action_id: string | null;
    granted_by: string;
    created_at: string;
    expires_at: string;
    revoked_at: string | null;
    revoked_by: string | null;
  }

  export interface GrantInput {
    conversation_id: string;
    tab_id: string;
    tool: string;
    source_action_id?: string | null;
    granted_by: string;
  }

  const mapGrant = (g: PrismaChatGrant): ChatGrant => ({
    id: g.id,
    conversation_id: g.conversationId,
    tab_id: g.tabId,
    tool: g.tool,
    source_action_id: g.sourceActionId,
    granted_by: g.grantedBy,
    created_at: g.createdAt.toISOString(),
    expires_at: g.expiresAt.toISOString(),
    revoked_at: g.revokedAt?.toISOString() ?? null,
    revoked_by: g.revokedBy,
  });

  export class ChatGrantsRepository {
    constructor(private db: PrismaClient) {}

    /**
     * Trusts a tab for a tool in a conversation. The previous grant for the same triple — active or
     * merely expired, both hold the partial unique slot — is revoked in the same transaction, so granting
     * again is how the 24 h restart.
     */
    async grant(input: GrantInput, now = new Date()): Promise<ChatGrant> {
      const row = await this.db.$transaction(async (tx) => {
        await tx.chatGrant.updateMany({
          where: { conversationId: input.conversation_id, tabId: input.tab_id, tool: input.tool, revokedAt: null },
          data: { revokedAt: now, revokedBy: input.granted_by },
        });
        return tx.chatGrant.create({
          data: {
            id: newId(),
            conversationId: input.conversation_id,
            tabId: input.tab_id,
            tool: input.tool,
            sourceActionId: input.source_action_id ?? null,
            grantedBy: input.granted_by,
            createdAt: now,
            expiresAt: new Date(now.getTime() + GRANT_TTL_MS),
          },
        });
      });
      return mapGrant(row);
    }

    async findActive(conversationId: string, tabId: string, tool: string, now = new Date()): Promise<ChatGrant | undefined> {
      const row = await this.db.chatGrant.findFirst({ where: { conversationId, tabId, tool, revokedAt: null, expiresAt: { gt: now } } });
      return row ? mapGrant(row) : undefined;
    }

    async listActive(conversationId: string, now = new Date()): Promise<ChatGrant[]> {
      const rows = await this.db.chatGrant.findMany({ where: { conversationId, revokedAt: null, expiresAt: { gt: now } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
      return rows.map(mapGrant);
    }

    /** The active grant a confirmation card created, if any — for the injected sentence. */
    async findActiveBySourceAction(actionId: string, now = new Date()): Promise<ChatGrant | undefined> {
      const row = await this.db.chatGrant.findFirst({ where: { sourceActionId: actionId, revokedAt: null, expiresAt: { gt: now } } });
      return row ? mapGrant(row) : undefined;
    }

    /** Scoped through the owning conversation's `user_id`, like `ChatActionsRepository.findByIdForUser`:
     * another user's grant and no grant at all are the same `undefined`. */
    async findByIdForUser(id: string, userId: string): Promise<ChatGrant | undefined> {
      const row = await this.db.chatGrant.findFirst({ where: { id, conversation: { userId } } });
      return row ? mapGrant(row) : undefined;
    }

    /** "Revogar". Undefined when it matched nothing: wrong id, another user's, or already revoked. */
    async revoke(id: string, userId: string, now = new Date()): Promise<ChatGrant | undefined> {
      const { count } = await this.db.chatGrant.updateMany({ where: { id, revokedAt: null, conversation: { userId } }, data: { revokedAt: now, revokedBy: userId } });
      if (count === 0) return undefined;
      const row = await this.db.chatGrant.findUnique({ where: { id } });
      return row ? mapGrant(row) : undefined;
    }

    /** "Nova conversa" ends the conversation, and with it every grant it held. */
    async revokeForConversation(conversationId: string, now = new Date()): Promise<number> {
      const { count } = await this.db.chatGrant.updateMany({ where: { conversationId, revokedAt: null }, data: { revokedAt: now, revokedBy: null } });
      return count;
    }
  }
  ```
  In `chat-actions.ts`: add `grant_id: string | null;` to `ChatAction` (after `tab_id`), `grant_id: a.grantId,` to `mapAction`, and:
  ```ts
  export interface InsertApprovedInput extends InsertPendingInput {
    grant_id: string;
    decided_by: string;
  }
  ```
  ```ts
    /**
     * An action the user never saw as a card because a grant ("Permitir sempre nesta aba") already
     * answered it: inserted `approved`, decided now by the user who granted, so the gate's `execute()`
     * claims and audits it exactly like a clicked approval. Subject to the same partial unique index
     * as `insertPending` — a parallel identical call loses here.
     */
    async insertApproved(input: InsertApprovedInput): Promise<ChatAction> {
      const row = await this.db.chatAction.create({
        data: {
          id: newId(),
          conversationId: input.conversation_id,
          messageId: input.message_id ?? null,
          tool: input.tool,
          args: input.args as never,
          class: input.class,
          status: 'approved',
          idempotencyKey: input.idempotency_key ?? null,
          machineId: input.machine_id ?? null,
          projectId: input.project_id ?? null,
          tabId: input.tab_id ?? null,
          grantId: input.grant_id,
          decidedBy: input.decided_by,
          decidedAt: new Date(),
        },
      });
      return mapAction(row);
    }
  ```
  In `index.ts`: import `ChatGrantsRepository` from `./chat-grants.js`, add `chatGrants: ChatGrantsRepository;` to the `Repositories` interface and `chatGrants: new ChatGrantsRepository(db),` to the factory, next to `chatActions`.
  Add `grant_id: null` to every `ChatAction` object literal in test files (see Files).

- [ ] **Step 6: Run to verify it passes.** Both db test files PASS; `NODE 'npm run typecheck -w @termhub/server'` passes; `NODE 'npm test -w @termhub/server'` (unit suite) passes.

- [ ] **Step 7: Commit**
  ```bash
  git add apps/server/prisma apps/server/src/db/repositories apps/server/src/mcp/gate.e2e.test.ts apps/server/src/chat/service.test.ts
  git commit -m "Chat: store tab grants for send_input (TER-3)"
  ```

---

### Task 2 (TER-4): The gate honours an active grant

**Files:**
- Modify: `apps/server/src/chat/gate.ts`, `apps/server/src/chat/gate.test.ts`
- Modify: `apps/server/src/chat/bus.ts`
- Modify: `apps/server/src/db/repositories/chat-actions-view.ts` (+ its test)
- Modify: `apps/server/src/chat/gate-runtime.ts`
- Modify: `apps/server/src/mcp/gate.e2e.test.ts`

**Interfaces:**
- Consumes: `ChatGrantsRepository.findActive`, `ChatActionsRepository.insertApproved`, `ChatAction.grant_id` (Task 1).
- Produces:
  ```ts
  // gate.ts
  export function grantable(tool: string, args: Record<string, unknown>): args is Record<string, unknown> & { tab_id: string };
  export const GRANTABLE_TOOL = 'send_input';
  // chat-actions-view.ts
  interface ChatActionCard { /* existing */ grant_id: string | null }
  // bus.ts — new ChatEvent member
  { type: 'granted_action'; user_id: string; conversation_id: string; action: ChatActionCard }
  ```

- [ ] **Step 1: Failing unit test for `grantable`** in `gate.test.ts`:
  ```ts
  describe('grantable', () => {
    it('is only send_input to a named tab that is not answering a permission', () => {
      expect(grantable('send_input', { tab_id: 't1', text: 'oi' })).toBe(true);
      expect(grantable('send_input', { tab_id: 't1', text: 'oi', answering_permission: false })).toBe(true);
      expect(grantable('send_input', { tab_id: 't1', text: '1', answering_permission: true })).toBe(false);
      expect(grantable('send_input', { text: 'oi' })).toBe(false);
      expect(grantable('send_input', { tab_id: '', text: 'oi' })).toBe(false);
      expect(grantable('send_input', { tab_id: 'x'.repeat(65), text: 'oi' })).toBe(false);
      expect(grantable('run_command', { tab_id: 't1', command: 'ls' })).toBe(false);
      expect(grantable('send_key', { tab_id: 't1', key: 'Enter' })).toBe(false);
    });
  });
  ```
  (import `grantable` next to the existing imports from `./gate.js`; add `describe` to the vitest import if missing.)

- [ ] **Step 2: Run** `NODE 'npm test -w @termhub/server -- src/chat/gate.test.ts'` → FAIL (`grantable` is not exported).

- [ ] **Step 3: Implement** in `gate.ts`:
  ```ts
  /** The one tool a tab grant can cover (spec 2026-09-25): free text typed at a prompt. */
  export const GRANTABLE_TOOL = 'send_input';

  /**
   * Whether "Permitir sempre nesta aba" may cover this call. Only `send_input` to a named tab, and
   * never with `answering_permission`: answering a permission dialog, like `send_key` and
   * `run_command`, always asks. Shared by the gate and the decision route, so the button is offered and
   * accepted for exactly the calls the gate will honour.
   */
  export function grantable(tool: string, args: Record<string, unknown>): args is Record<string, unknown> & { tab_id: string } {
    const tab = args.tab_id;
    return tool === GRANTABLE_TOOL && args.answering_permission !== true && typeof tab === 'string' && tab.length >= 1 && tab.length <= 64;
  }
  ```
  Run the test → PASS.

- [ ] **Step 4: Card and event.** In `chat-actions-view.ts` add `grant_id: string | null;` to `ChatActionCard` and `grant_id: action.grant_id,` to `toCard`. Update `chat-actions-view.test.ts` expectations that compare whole cards with `toEqual` (add `grant_id: null`). In `bus.ts`, import `type { ChatActionCard } from '../db/repositories/chat-actions-view.js'` and add to `ChatEvent`:
  ```ts
    /** A call the concierge made under a tab grant, already executed or failed: the trail's row for
     * it (spec 2026-09-25 §5). Nobody was asked, so without this the trail would only show it on reload. */
    | { type: 'granted_action'; user_id: string; conversation_id: string; action: ChatActionCard }
  ```

- [ ] **Step 5: Failing e2e tests** in `apps/server/src/mcp/gate.e2e.test.ts`. Extend the fakes first:
  - In `fakeChatActions()`, add `insertApproved` next to `insertPending` (same duplicate check, same row shape, but `status: 'approved'`, `grant_id: input.grant_id`, `decided_by: input.decided_by`, `decided_at: new Date().toISOString()`), and give `insertPending`'s and `seed`'s rows `grant_id: null`.
  - Add a fake grants store and wire it into `build()`'s `repos` as `chatGrants`:
    ```ts
    function fakeChatGrants() {
      const grants: { id: string; conversation_id: string; tab_id: string; tool: string; expires_at: string; revoked_at: string | null }[] = [];
      return {
        grants,
        /** A grant as the decision route leaves it; `expiresInMinutes` < 0 stages an expired one. */
        seed: (tabId: string, opts: { conversationId?: string; expiresInMinutes?: number; revoked?: boolean } = {}) => {
          const g = { id: `g${grants.length + 1}`, conversation_id: opts.conversationId ?? CONVERSATION, tab_id: tabId, tool: 'send_input', expires_at: new Date(Date.now() + (opts.expiresInMinutes ?? 60) * 60_000).toISOString(), revoked_at: opts.revoked ? new Date().toISOString() : null };
          grants.push(g);
          return g;
        },
        findActive: vi.fn(async (conversationId: string, tabId: string, tool: string) =>
          grants.find((g) => g.conversation_id === conversationId && g.tab_id === tabId && g.tool === tool && g.revoked_at === null && Date.parse(g.expires_at) > Date.now()),
        ),
      };
    }
    ```
    `build()` creates `const grants = fakeChatGrants();`, puts `chatGrants: grants` in `repos`, and returns `grants`.
  - Tests (each attaches `attachFakeTmux(typed)` and builds `{ gated: true }`):
    ```ts
    it('types at once into a trusted tab, and leaves an executed audit row tied to the grant', async () => {
      const typed: string[] = [];
      attachFakeTmux(typed);
      const { app, actions, grants } = build({ gated: true });
      const g = grants.seed('t1');

      const res = await callTool(app, 'send_input', { tab_id: 't1', text: 'sim, pode seguir' });
      expect(resultOf(res).isError).toBeFalsy();
      expect(typed).toContain('sim, pode seguir');
      expect(actions.insertPending).not.toHaveBeenCalled();
      expect(actions.rows).toHaveLength(1);
      expect(actions.rows[0]).toMatchObject({ status: 'executed', grant_id: g.id, decided_by: 'u1', tab_id: 't1' });
      const live = collected.find((e) => e.type === 'granted_action') as { action: { status: string; grant_id: string; summary: string } } | undefined;
      expect(live?.action).toMatchObject({ status: 'executed', grant_id: g.id });
      expect(collected.some((e) => e.type === 'confirmation')).toBe(false);
    });

    it.each([
      ['answering a permission', 'send_input', { tab_id: 't1', text: '1', answering_permission: true }],
      ['run_command', 'run_command', { tab_id: 't1', command: 'ls' }],
      ['send_key', 'send_key', { tab_id: 't1', key: 'Enter' }],
    ])('still asks for %s on a trusted tab', async (_label, tool, args) => {
      const typed: string[] = [];
      attachFakeTmux(typed);
      const { app, actions, grants } = build({ gated: true });
      grants.seed('t1');
      const res = await callTool(app, tool, args);
      expect(textOf(res)).toMatch(/pendente de confirmação/i);
      expect(actions.insertPending).toHaveBeenCalledTimes(1);
      expect(typed).toEqual([]);
    });

    it.each([
      ['another tab', () => ({ tabId: 't2' })],
      ['another conversation', () => ({ tabId: 't1', conversationId: 'c_other' })],
      ['an expired grant', () => ({ tabId: 't1', expiresInMinutes: -1 })],
      ['a revoked grant', () => ({ tabId: 't1', revoked: true })],
    ])('asks when the only grant is for %s', async (_label, grantOf) => {
      const typed: string[] = [];
      attachFakeTmux(typed);
      const { app, actions, grants } = build({ gated: true });
      const { tabId, ...opts } = grantOf();
      grants.seed(tabId, opts);
      const res = await callTool(app, 'send_input', { tab_id: 't1', text: 'oi' });
      expect(textOf(res)).toMatch(/pendente de confirmação/i);
      expect(actions.insertPending).toHaveBeenCalledTimes(1);
      expect(typed).toEqual([]);
    });

    it('a recent "no" to the same text beats the grant', async () => {
      const typed: string[] = [];
      attachFakeTmux(typed);
      const { app, actions, grants } = build({ gated: true });
      grants.seed('t1');
      actions.seed('denied', 'send_input', { tab_id: 't1', text: 'rm -rf' }, 1);
      const res = await callTool(app, 'send_input', { tab_id: 't1', text: 'rm -rf' });
      expect(resultOf(res).isError).toBe(true);
      expect(typed).toEqual([]);
      expect(actions.insertApproved).not.toHaveBeenCalled();
    });

    it('a trusted tab that is waiting on a permission types nothing and records WAITING_PERMISSION', async () => {
      const typed: string[] = [];
      attachFakeTmux(typed);
      const { app, actions, grants, tabs } = build({ gated: true });
      grants.seed('t1');
      Object.assign(tabs.get('t1')!, { state: 'waiting_permission', state_at: new Date().toISOString() });
      const res = await callTool(app, 'send_input', { tab_id: 't1', text: 'oi' });
      expect(resultOf(res).isError).toBe(true);
      expect(typed).toEqual([]);
      expect(actions.rows[0]).toMatchObject({ status: 'failed', error_code: 'WAITING_PERMISSION' });
      expect(collected.some((e) => e.type === 'confirmation')).toBe(false);
    });

    it('a trusted tab that no longer exists records TAB_GONE', async () => {
      const typed: string[] = [];
      attachFakeTmux(typed);
      const { app, actions, grants, tabs } = build({ gated: true });
      grants.seed('t1');
      tabs.delete('t1');
      const res = await callTool(app, 'send_input', { tab_id: 't1', text: 'oi' });
      expect(resultOf(res).isError).toBe(true);
      expect(typed).toEqual([]);
      expect(actions.rows[0]).toMatchObject({ status: 'failed', error_code: 'TAB_GONE' });
    });

    it('a person\'s own token never looks at grants', async () => {
      const typed: string[] = [];
      attachFakeTmux(typed);
      const { app, grants } = build({ gated: false });
      await callTool(app, 'send_input', { tab_id: 't1', text: 'oi' });
      expect(grants.findActive).not.toHaveBeenCalled();
    });
    ```
    Note for the tab-gone case: `tabs.delete('t1')` makes both `findById` and the owner-scoped read miss. If the tool itself 404s before the gate for a missing tab (check the route: scope checks run inside `run()`), the expectation on `TAB_GONE` still holds because `staleApproval` runs before `run()`. If the test harness shows otherwise, keep the assertion that nothing was typed and the row is `failed`, and assert the actual code the gate recorded.

- [ ] **Step 6: Run** `NODE 'npm test -w @termhub/server -- src/mcp/gate.e2e.test.ts'` → the new tests FAIL (the gate asks instead of executing).

- [ ] **Step 7: Implement the grant branch** in `gate-runtime.ts`. Imports: add `grantable, GRANTABLE_TOOL` to the `./gate.js` import. Add, above `applyGate`:
  ```ts
  /**
   * Runs a call a tab grant already answered ("Permitir sempre nesta aba", spec 2026-09-25). The row is
   * born `approved` and goes through `execute()` like a clicked approval — the claim, `staleApproval`
   * (so a dead tab or a tab waiting on a permission still blocks) and the audit — and the trail is told
   * live, since no card was ever shown for it.
   */
  async function executeGranted(ctx: ControlContext, call: GatedCall, conversationId: string, key: string, cls: ChatActionClass, grantId: string): Promise<GateOutcome> {
    let row: ChatAction;
    try {
      row = await ctx.repos.chatActions.insertApproved({ conversation_id: conversationId, tool: call.tool, args: call.args, class: cls, idempotency_key: key, ...targetOf(call.args), grant_id: grantId, decided_by: ctx.scope.user.id });
    } catch {
      // The partial unique index refused it: an identical call arrived in the same instant and owns
      // this execution. Same reading as a lost claim; the error itself is not rethrown (it carries args).
      return ALREADY_CLAIMED;
    }
    try {
      return await execute(ctx, call, row);
    } finally {
      const done = await ctx.repos.chatActions.findByIdForUser(row.id, ctx.scope.user.id).catch(() => undefined);
      if (done) {
        const [card] = await describeActions(ctx.repos, [done], ctx.scope.user.id);
        chatBus.publish({ type: 'granted_action', user_id: ctx.scope.user.id, conversation_id: conversationId, action: card });
      }
    }
  }
  ```
  In `applyGate`, replace
  ```ts
    if (!row || decision === 'ask') return ask(ctx, call, conversationId, key, cls);
  ```
  with
  ```ts
    if (!row || decision === 'ask') {
      // Only where the gate would otherwise ask: an open row or a "no" still in force decided above.
      if (!row && grantable(call.tool, call.args)) {
        const grant = await ctx.repos.chatGrants.findActive(conversationId, call.args.tab_id, GRANTABLE_TOOL);
        if (grant) return executeGranted(ctx, call, conversationId, key, cls, grant.id);
      }
      return ask(ctx, call, conversationId, key, cls);
    }
  ```
  Note: `gateDecision` returns `ask` only when `row` is undefined for a write class, so the `!row` guard is the same condition made explicit.

- [ ] **Step 8: Run** the e2e file and `gate.test.ts` → PASS. Then the whole server unit suite and typecheck → PASS.

- [ ] **Step 9: Commit**
  ```bash
  git add apps/server/src/chat apps/server/src/db/repositories/chat-actions-view.ts apps/server/src/db/repositories/chat-actions-view.test.ts apps/server/src/mcp/gate.e2e.test.ts
  git commit -m "Chat gate: run send_input on a trusted tab without asking (TER-4)"
  ```

---

### Task 3 (TER-4/TER-5 server side): Grant, list and revoke through the chat API

**Files:**
- Modify: `apps/server/src/db/repositories/chat-actions-view.ts` (+ test): `describeGrants`
- Modify: `apps/server/src/chat/bus.ts`: `grant`, `grant_revoked`
- Modify: `apps/server/src/routes/chat.ts`, `apps/server/src/routes/chat.test.ts`
- Modify: `apps/server/src/chat/service.ts`, `apps/server/src/chat/service.test.ts`

**Interfaces:**
- Consumes: `grantable`, `GRANTABLE_TOOL` (Task 2); `ChatGrantsRepository` (Task 1).
- Produces (wire shapes the web relies on in Task 4):
  ```ts
  // chat-actions-view.ts
  export interface ChatGrantView { id: string; tab_id: string; tool: string; source_action_id: string | null; created_at: string; expires_at: string; tab_name: string | null }
  export function describeGrants(repos: Repositories, grants: ChatGrant[], ownerId: string): Promise<ChatGrantView[]>;
  // bus.ts
  | { type: 'grant'; user_id: string; conversation_id: string; grant: ChatGrantView }
  | { type: 'grant_revoked'; user_id: string; conversation_id: string; grant_id: string }
  // HTTP
  GET  /chat                         → { conversation, messages, actions, host, grants: ChatGrantView[] }
  POST /chat/actions/:id/decision    body { decision: 'approve' | 'deny' | 'approve_tab' }
       approve_tab → same answer as approve plus `grant: ChatGrantView`; 400 GRANT_NOT_ALLOWED; 404; 409
  DELETE /chat/grants/:id            → { grant: ChatGrantView }; 404 not found; 409 already revoked
  ```

- [ ] **Step 1: Failing tests.** In `routes/chat.test.ts`, extend `build()`: accept `grants?: ChatGrant-like[]` and add to `repos`:
  ```ts
  chatGrants: {
    grant: vi.fn(async (input: { conversation_id: string; tab_id: string; tool: string; source_action_id: string; granted_by: string }) => ({ id: 'g1', ...input, created_at: '2026-09-25T10:00:00.000Z', expires_at: '2026-09-26T10:00:00.000Z', revoked_at: null, revoked_by: null })),
    listActive: vi.fn(async () => opts.grants ?? []),
    revoke: opts.revoke ?? vi.fn(async (id: string) => ({ id, conversation_id: 'c1', tab_id: 't1', tool: 'send_input', source_action_id: 'act1', granted_by: 'u1', created_at: '', expires_at: '', revoked_at: 'now', revoked_by: 'u1' })),
    findByIdForUser: opts.findGrantByIdForUser ?? vi.fn(async () => undefined),
  },
  ```
  (add `revoke?` and `findGrantByIdForUser?` to the options type; return `repos` already returned.) Tests:
  ```ts
  it('approve_tab on an eligible send_input approves it, trusts the tab and says so live', async () => {
    const events: ChatEvent[] = [];
    const off = chatBus.subscribe((e) => events.push(e));
    const eligible = { ...pendingAction, status: 'pending', args: { tab_id: 't1', text: 'oi' } };
    const { app, decide, repos, resumeAfterDecision } = build({ findByIdForUser: vi.fn(async () => eligible), tabs: [{ id: 't1', project_id: 'p1', name: 'Terminal 1' }] });
    const res = await app.inject({ method: 'POST', url: '/chat/actions/act1/decision', payload: { decision: 'approve_tab' } });
    off();
    expect(res.statusCode).toBe(200);
    expect(decide).toHaveBeenCalledWith('act1', 'u1', 'approved');
    expect(repos.chatGrants.grant).toHaveBeenCalledWith({ conversation_id: 'c1', tab_id: 't1', tool: 'send_input', source_action_id: 'act1', granted_by: 'u1' });
    expect(res.json().grant).toMatchObject({ id: 'g1', tab_id: 't1', tab_name: 'Terminal 1', source_action_id: 'act1' });
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['decision', 'grant']));
    expect(resumeAfterDecision).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['answering a permission', { tab_id: 't1', text: '1', answering_permission: true }, 'send_input'],
    ['run_command', { tab_id: 't1', command: 'ls' }, 'run_command'],
  ])('approve_tab refuses %s with 400 and decides nothing', async (_l, args, tool) => {
    const row = { ...pendingAction, status: 'pending', tool, args };
    const { app, decide, repos } = build({ findByIdForUser: vi.fn(async () => row) });
    const res = await app.inject({ method: 'POST', url: '/chat/actions/act1/decision', payload: { decision: 'approve_tab' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('GRANT_NOT_ALLOWED');
    expect(decide).not.toHaveBeenCalled();
    expect(repos.chatGrants.grant).not.toHaveBeenCalled();
  });

  it('approve_tab on a row that is not this user\'s is a 404', async () => {
    const { app, decide } = build({ findByIdForUser: vi.fn(async () => undefined) });
    const res = await app.inject({ method: 'POST', url: '/chat/actions/act1/decision', payload: { decision: 'approve_tab' } });
    expect(res.statusCode).toBe(404);
    expect(decide).not.toHaveBeenCalled();
  });

  it('DELETE /chat/grants/:id revokes and says so live', async () => {
    const events: ChatEvent[] = [];
    const off = chatBus.subscribe((e) => events.push(e));
    const { app, repos } = build();
    const res = await app.inject({ method: 'DELETE', url: '/chat/grants/g1' });
    off();
    expect(res.statusCode).toBe(200);
    expect(repos.chatGrants.revoke).toHaveBeenCalledWith('g1', 'u1');
    expect(events).toContainEqual(expect.objectContaining({ type: 'grant_revoked', grant_id: 'g1', conversation_id: 'c1' }));
  });

  it('DELETE /chat/grants/:id: 404 when unknown, 409 when already revoked', async () => {
    const gone = build({ revoke: vi.fn(async () => undefined) });
    expect((await gone.app.inject({ method: 'DELETE', url: '/chat/grants/nope' })).statusCode).toBe(404);
    const done = build({ revoke: vi.fn(async () => undefined), findGrantByIdForUser: vi.fn(async () => ({ id: 'g1', revoked_at: 'x' })) });
    expect((await done.app.inject({ method: 'DELETE', url: '/chat/grants/g1' })).statusCode).toBe(409);
  });

  it('GET /chat returns the conversation\'s active grants with the tab name', async () => {
    const { app } = build({ grants: [{ id: 'g1', conversation_id: 'c1', tab_id: 't1', tool: 'send_input', source_action_id: 'act1', granted_by: 'u1', created_at: 'a', expires_at: 'b', revoked_at: null, revoked_by: null }], tabs: [{ id: 't1', project_id: 'p1', name: 'Terminal 1' }] });
    const res = await app.inject({ method: 'GET', url: '/chat' });
    expect(res.json().grants).toEqual([{ id: 'g1', tab_id: 't1', tool: 'send_input', source_action_id: 'act1', created_at: 'a', expires_at: 'b', tab_name: 'Terminal 1' }]);
  });
  ```
  In `service.test.ts`, add (following that file's existing reset and injection tests — read them first and reuse their fixture builders):
  - reset calls `repos.chatGrants.revokeForConversation(<archived conversation id>)`;
  - the injected sentence for an approved action that has an active grant (`chatGrants.findActiveBySourceAction` resolves one) contains `Os próximos send_input nesta aba, nesta conversa, rodam sem pedir confirmação`; without a grant it does not. Every existing fake `repos` in that file needs `chatGrants: { revokeForConversation: vi.fn(async () => 0), findActiveBySourceAction: vi.fn(async () => undefined) }`.

- [ ] **Step 2: Run** `NODE 'npm test -w @termhub/server -- src/routes/chat.test.ts src/chat/service.test.ts'` → new tests FAIL.

- [ ] **Step 3: Implement.**
  `chat-actions-view.ts`:
  ```ts
  import type { ChatGrant } from './chat-grants.js';

  /** A grant as the chat shows it: the tab by name (owner-scoped, like the cards), no user ids. */
  export interface ChatGrantView {
    id: string;
    tab_id: string;
    tool: string;
    source_action_id: string | null;
    created_at: string;
    expires_at: string;
    /** Null when the tab is gone (or not this user's): the strip then says "uma aba que não existe mais". */
    tab_name: string | null;
  }

  export async function describeGrants(repos: Repositories, grants: ChatGrant[], ownerId: string): Promise<ChatGrantView[]> {
    const tabIds = [...new Set(grants.map((g) => g.tab_id))];
    const tabs = tabIds.length ? await repos.tabs.findByIdsForOwner(tabIds, ownerId) : [];
    const nameById = new Map(tabs.map((t) => [t.id, t.name]));
    return grants.map((g) => ({ id: g.id, tab_id: g.tab_id, tool: g.tool, source_action_id: g.source_action_id, created_at: g.created_at, expires_at: g.expires_at, tab_name: nameById.get(g.tab_id) ?? null }));
  }
  ```
  `bus.ts`: import `ChatGrantView` alongside `ChatActionCard` and add
  ```ts
    /** "Permitir sempre nesta aba" was clicked: every open screen shows the strip. */
    | { type: 'grant'; user_id: string; conversation_id: string; grant: ChatGrantView }
    /** "Revogar": every open screen drops it. */
    | { type: 'grant_revoked'; user_id: string; conversation_id: string; grant_id: string }
  ```
  `routes/chat.ts`:
  - `const decisionBody = z.object({ decision: z.enum(['approve', 'deny', 'approve_tab']) });`, `const grantIdParam = z.object({ id: z.string().min(1).max(64) });`, import `grantable, GRANTABLE_TOOL` from `../chat/gate.js` and `describeGrants` from the view.
  - In `GET /`: add `repos.chatGrants.listActive(conversation.id)` to the `Promise.all`, then `const grants = await describeGrants(repos, activeGrants, request.scope.user.id);` and return `{ conversation, messages, actions, host, grants }`.
  - In the decision handler, before `decide`:
    ```ts
    const status = decision === 'deny' ? 'denied' : 'approved';
    // "Permitir sempre nesta aba" is only for what the gate will honour (`grantable`): checked on the
    // row as the user sees it, before anything is decided, so a refused request changes nothing.
    if (decision === 'approve_tab') {
      const row = await repos.chatActions.findByIdForUser(id, user.id);
      if (!row) throw notFound('Ação não encontrada');
      if (row.status !== 'pending') throw conflict('Esta ação já foi decidida');
      if (!grantable(row.tool, (row.args ?? {}) as Record<string, unknown>)) throw new HttpError(400, 'Só dá para permitir sempre o envio de texto para uma aba', 'GRANT_NOT_ALLOWED');
    }
    ```
    After the existing `decision` publish:
    ```ts
    let grant: ChatGrantView | undefined;
    if (decision === 'approve_tab' && action.tab_id) {
      const created = await repos.chatGrants.grant({ conversation_id: action.conversation_id, tab_id: action.tab_id, tool: GRANTABLE_TOOL, source_action_id: action.id, granted_by: user.id });
      [grant] = await describeGrants(repos, [created], user.id);
      chatBus.publish({ type: 'grant', user_id: user.id, conversation_id: action.conversation_id, grant });
    }
    ```
    and include `grant` in both return shapes (`{ action, message, grant }` / `{ action, queued: true, note: QUEUED_NOTE, grant }`). The grant is created before `resumeAfterDecision` so the injected sentence can mention it.
  - New route:
    ```ts
    /** "Revogar" on the strip or on the card that granted it. */
    app.delete('/grants/:id', async (request) => {
      const { id } = grantIdParam.parse(request.params);
      const user = request.scope.user;
      const revoked = await repos.chatGrants.revoke(id, user.id);
      if (!revoked) {
        const existing = await repos.chatGrants.findByIdForUser(id, user.id);
        throw existing ? conflict('Esta permissão já foi revogada') : notFound('Permissão não encontrada');
      }
      chatBus.publish({ type: 'grant_revoked', user_id: user.id, conversation_id: revoked.conversation_id, grant_id: revoked.id });
      const [grant] = await describeGrants(repos, [revoked], user.id);
      return { grant };
    });
    ```
    Permissions: the chat plugin is registered with `guarded('chat', …)` and a route without
    `config.action` gets `actionForMethod(method)` (`apps/server/src/auth/permissions.ts`), which for
    `DELETE` is `chat:delete` — a grant the chat roles may not hold, while the decision route (a bare
    `POST`) needs `chat:create`. Revoking must be possible for anyone who can grant, so declare the
    route as `app.delete('/grants/:id', { config: { action: 'create' } }, async (request) => { … })`,
    with a one-line comment saying why.
  `service.ts`:
  - In `reset`, after `expireOpenForConversation(current.id)`: `await this.deps.repos.chatGrants.revokeForConversation(current.id);`
  - `injectionFor`: compute the grant note for approved actions and pass it through:
    ```ts
    private async injectionFor(user: User, action: ChatAction, freshSession: boolean): Promise<string> {
      if (action.status === 'denied') return injectionText(action, freshSession);
      const grant = await this.deps.repos.chatGrants.findActiveBySourceAction(action.id);
      const grantNote = grant ? GRANT_NOTE : '';
      if (!freshSession) return injectionText(action, freshSession) + grantNote;
      const [card] = await describeActions(this.deps.repos, [action], user.id);
      return injectionText(action, freshSession, card.summary) + grantNote;
    }
    ```
    with, next to `injectionText`:
    ```ts
    /** Appended when the approval came with "Permitir sempre nesta aba": the model should stop expecting
     * a question per message to that tab, and know it can still be revoked. */
    const GRANT_NOTE = ' O usuário também permitiu digitar nesta aba sem confirmar: os próximos send_input nesta aba, nesta conversa, rodam sem pedir confirmação, até ele revogar ou por 24 horas. Isso não vale para run_command, send_key nem para responder permissões.';
    ```
    Make the service test's expected substring match this sentence (`Os próximos` → use `os próximos send_input nesta aba, nesta conversa, rodam sem pedir confirmação`).

- [ ] **Step 4: Run** the two test files → PASS; full server unit suite + typecheck → PASS.

- [ ] **Step 5: Commit**
  ```bash
  git add apps/server/src
  git commit -m "Chat API: approve_tab, grant list and revoke (TER-4)"
  ```

---

### Task 4 (TER-5): Card button, granted state and the strip

**Files:**
- Modify: `apps/web/src/lib/types.ts` (near line 771), `apps/web/src/lib/api.ts` (near lines 170 and 204)
- Create: `apps/web/src/components/chat/grant-time.ts`, `apps/web/src/components/chat/grant-time.test.ts`
- Modify: `apps/web/src/components/chat/ChatActionCard.tsx`; Create: `apps/web/src/components/chat/ChatActionCard.test.tsx` if absent (else extend)
- Create: `apps/web/src/components/chat/ChatGrantStrip.tsx`, `apps/web/src/components/chat/ChatGrantStrip.test.tsx`
- Modify: `apps/web/src/components/chat/ChatPanel.tsx`, `apps/web/src/components/chat/ChatPanel.test.tsx`

**Interfaces:**
- Consumes: the HTTP/event shapes of Task 3.
- Produces:
  ```ts
  // types.ts
  export interface ChatGrant { id: string; tab_id: string; tool: string; source_action_id: string | null; created_at: string; expires_at: string; tab_name: string | null }
  ChatAction.grant_id?: string | null
  ChatEvent += | { type: 'grant'; grant: ChatGrant; conversation_id?: string } | { type: 'grant_revoked'; grant_id: string; conversation_id?: string } | { type: 'granted_action'; action: ChatAction; conversation_id?: string }
  // api.ts
  chat(...) → { …, grants?: ChatGrant[] }
  decideChatAction(id, decision: 'approve' | 'deny' | 'approve_tab') → { …, grant?: ChatGrant }
  revokeChatGrant(id: string) → { grant: ChatGrant }
  // grant-time.ts
  export function untilLabel(expiresAt: string, now?: Date): string   // "até 14:32" | "até amanhã, 14:32"
  export function isGrantActive(g: { expires_at: string }, now?: Date): boolean
  // ChatActionCard.tsx
  export function isTabGrantable(action: ChatAction): boolean
  props += { grant?: ChatGrant; revoking?: boolean; onRevoke?: () => void; onDecide: (d: 'approve' | 'deny' | 'approve_tab') => void }
  // ChatGrantStrip.tsx
  export function ChatGrantStrip(props: { grants: ChatGrant[]; revokingId: string | null; onRevoke: (id: string) => void }): JSX.Element | null
  ```

- [ ] **Step 1: Types and API** (no behaviour yet). In `types.ts` add `ChatGrant`, `grant_id?: string | null;` on `ChatAction`, and the three `ChatEvent` members with one-line doc comments. In `api.ts` widen `chat`'s response with `grants?: ChatGrant[]` (optional: an older server has none), widen `decideChatAction`'s `decision` union and response (`grant?: ChatGrant`), and add:
  ```ts
  /** "Revogar": 404 unknown/not yours, 409 already revoked. */
  revokeChatGrant: (id: string) => request<{ grant: ChatGrant }>('DELETE', `/chat/grants/${encodeURIComponent(id)}`),
  ```
  (add `ChatGrant` to the type import at the top of `api.ts`.)

- [ ] **Step 2: Failing tests for `grant-time.ts`:**
  ```ts
  import { expect, it } from 'vitest';
  import { isGrantActive, untilLabel } from './grant-time';

  const now = new Date(2026, 8, 25, 10, 0); // local time, 25 Sep 2026 10:00
  it('says the hour when it ends today', () => {
    expect(untilLabel(new Date(2026, 8, 25, 14, 32).toISOString(), now)).toBe('até 14:32');
  });
  it('says tomorrow when it ends tomorrow', () => {
    expect(untilLabel(new Date(2026, 8, 26, 9, 5).toISOString(), now)).toBe('até amanhã, 09:05');
  });
  it('is active only before its expiry', () => {
    expect(isGrantActive({ expires_at: new Date(2026, 8, 25, 10, 1).toISOString() }, now)).toBe(true);
    expect(isGrantActive({ expires_at: new Date(2026, 8, 25, 9, 59).toISOString() }, now)).toBe(false);
  });
  ```
  Run `NODE 'npm test -w @termhub/web -- src/components/chat/grant-time.test.ts'` → FAIL.

- [ ] **Step 3: Implement** `grant-time.ts`:
  ```ts
  const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

  /** "até 14:32", or "até amanhã, 09:05" — a grant lasts at most 24 h, so those are the only two days. */
  export function untilLabel(expiresAt: string, now = new Date()): string {
    const end = new Date(expiresAt);
    return end.toDateString() === now.toDateString() ? `até ${hhmm(end)}` : `até amanhã, ${hhmm(end)}`;
  }

  /** The server is the judge (it re-checks on every call); this only hides a strip that has run out. */
  export const isGrantActive = (g: { expires_at: string }, now = new Date()) => Date.parse(g.expires_at) > now.getTime();
  ```
  Run → PASS.

- [ ] **Step 4: Failing tests for the card** (`ChatActionCard.test.tsx`, jsdom, same header as `ChatPanel.test.tsx`):
  ```tsx
  const base: ChatAction = { id: 'a1', tool: 'send_input', args: { tab_id: 't1', text: 'oi' }, class: 'write', status: 'pending', machine_id: null, project_id: null, tab_id: 't1', summary: 'digitar `oi` na aba Terminal 1', created_at: '' };
  const grant: ChatGrant = { id: 'g1', tab_id: 't1', tool: 'send_input', source_action_id: 'a1', created_at: '', expires_at: new Date(Date.now() + 3_600_000).toISOString(), tab_name: 'Terminal 1' };

  it('offers "Permitir sempre nesta aba" on a pending send_input to a tab', () => {
    const onDecide = vi.fn();
    render(<ChatActionCard action={base} deciding={false} onDecide={onDecide} />);
    fireEvent.click(screen.getByRole('button', { name: 'Permitir sempre nesta aba' }));
    expect(onDecide).toHaveBeenCalledWith('approve_tab');
  });
  it.each([
    ['answering a permission', { ...base, args: { tab_id: 't1', text: '1', answering_permission: true } }],
    ['run_command', { ...base, tool: 'run_command', args: { tab_id: 't1', command: 'ls' } }],
    ['no tab', { ...base, tab_id: null, args: { text: 'oi' } }],
  ])('does not offer it for %s', (_l, action) => {
    render(<ChatActionCard action={action as ChatAction} deciding={false} onDecide={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Permitir sempre nesta aba' })).toBeNull();
  });
  it('the card that granted shows until when and revokes', () => {
    const onRevoke = vi.fn();
    render(<ChatActionCard action={{ ...base, status: 'executed' }} deciding={false} onDecide={vi.fn()} grant={grant} onRevoke={onRevoke} />);
    expect(screen.getByText(/^Permitido nesta aba até/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Revogar' }));
    expect(onRevoke).toHaveBeenCalled();
  });
  it('an action run under a grant reads "aba confiada"', () => {
    render(<ChatActionCard action={{ ...base, status: 'executed', grant_id: 'g1' }} deciding={false} onDecide={vi.fn()} />);
    expect(screen.getByText('Executado · aba confiada')).toBeInTheDocument();
  });
  ```
  Run → FAIL.

- [ ] **Step 5: Implement the card.**
  ```tsx
  import type { ChatAction, ChatGrant } from '../../lib/types';
  import { untilLabel } from './grant-time';

  /** Mirrors the server's `grantable` (apps/server/src/chat/gate.ts): the server refuses anything else. */
  export function isTabGrantable(action: ChatAction): boolean {
    const args = (action.args ?? {}) as Record<string, unknown>;
    return action.tool === 'send_input' && args.answering_permission !== true && Boolean(action.tab_id);
  }
  ```
  Props: `onDecide: (decision: 'approve' | 'deny' | 'approve_tab') => void;` plus
  ```ts
  /** The active grant this card created ("Permitir sempre nesta aba"), if it is still in force. */
  grant?: ChatGrant;
  revoking?: boolean;
  onRevoke?: () => void;
  ```
  Pending buttons become: "Autorizar" (`approve`), then — only when `isTabGrantable(action)` — `<button type="button" className="btn-secondary" disabled={deciding} onClick={() => onDecide('approve_tab')}>Permitir sempre nesta aba</button>`, then "Recusar". (Use whatever secondary button class the codebase already has: `grep -rn "btn-" apps/web/src/index.css`; pick the neutral one.) Decided state:
  ```tsx
  <p className="mt-1 text-xs text-fg-dim">
    {ACTION_STATUS_LABEL[action.status]}
    {action.grant_id ? ' · aba confiada' : ''}
  </p>
  {grant && (
    <p className="mt-1 flex items-center gap-2 text-xs text-fg-dim">
      <span>Permitido nesta aba {untilLabel(grant.expires_at)}</span>
      <button type="button" className="underline hover:text-fg" disabled={revoking} onClick={onRevoke}>
        Revogar
      </button>
    </p>
  )}
  ```
  Run → PASS.

- [ ] **Step 6: Failing tests for the strip** (`ChatGrantStrip.test.tsx`):
  ```tsx
  it('shows one line per active grant, naming the tab, and revokes it', () => {
    const onRevoke = vi.fn();
    render(<ChatGrantStrip grants={[grant]} revokingId={null} onRevoke={onRevoke} />);
    expect(screen.getByText(/Enviando direto para a aba Terminal 1 até/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Revogar' }));
    expect(onRevoke).toHaveBeenCalledWith('g1');
  });
  it('hides expired grants, and renders nothing without any', () => {
    const { container } = render(<ChatGrantStrip grants={[{ ...grant, expires_at: new Date(Date.now() - 1000).toISOString() }]} revokingId={null} onRevoke={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });
  it('names a tab that no longer exists plainly', () => {
    render(<ChatGrantStrip grants={[{ ...grant, tab_name: null }]} revokingId={null} onRevoke={vi.fn()} />);
    expect(screen.getByText(/uma aba que não existe mais/)).toBeInTheDocument();
  });
  ```
  Run → FAIL.

- [ ] **Step 7: Implement** `ChatGrantStrip.tsx`:
  ```tsx
  import type { ChatGrant } from '../../lib/types';
  import { isGrantActive, untilLabel } from './grant-time';

  /**
   * The trusted tabs of this conversation, right above the message box: while one is here the concierge
   * types into that tab without asking (spec 2026-09-25 §6). Presentational: `ChatPanel` owns the list
   * and the revoke call.
   */
  export function ChatGrantStrip({ grants, revokingId, onRevoke }: { grants: ChatGrant[]; revokingId: string | null; onRevoke: (id: string) => void }) {
    const active = grants.filter((g) => isGrantActive(g));
    if (active.length === 0) return null;
    return (
      <ul aria-label="Abas confiadas" className="mb-2 space-y-1">
        {active.map((g) => (
          <li key={g.id} className="flex items-center justify-between gap-2 rounded-lg border border-attention/40 bg-bg-2 px-3 py-1.5 text-xs text-fg-dim">
            <span>
              Enviando direto para {g.tab_name ? `a aba ${g.tab_name}` : 'uma aba que não existe mais'} {untilLabel(g.expires_at)}
            </span>
            <button type="button" className="underline hover:text-fg" disabled={revokingId === g.id} onClick={() => onRevoke(g.id)}>
              Revogar
            </button>
          </li>
        ))}
      </ul>
    );
  }
  ```
  Run → PASS.

- [ ] **Step 8: Failing panel tests** in `ChatPanel.test.tsx` (add `revokeChatGrant: (...a: unknown[]) => revokeMock(...a)` to the mocked `api`, a `const revokeMock = vi.fn();`, and reuse the file's existing way of making `chatMock` resolve and of emitting stream events through `streamMock` — read the top of the file and one existing `confirmation` event test first):
  - `GET /chat` answering `grants: [grant]` renders the strip line; clicking its "Revogar" calls `revokeMock('g1')` and the line disappears.
  - Clicking "Permitir sempre nesta aba" on a pending eligible card calls `decideMock('a1', 'approve_tab')`; with `decideMock` resolving `{ action: { id: 'a1', status: 'approved' }, grant }` the strip line appears and the card shows "Permitido nesta aba".
  - A `grant` event adds the strip line; a `grant_revoked` event removes it; a `granted_action` event appends a card reading "Executado · aba confiada"; events of another `conversation_id` are ignored.
  Run → FAIL.

- [ ] **Step 9: Implement in `ChatPanel.tsx`:**
  - State: `const [grants, setGrants] = useState<ChatGrant[]>([]);` and `const [revokingId, setRevokingId] = useState<string | null>(null);`
  - `load`: destructure `grants` too and `setGrants(grants ?? [])`.
  - `onEvent`: add
    ```ts
    else if (e.type === 'grant') setGrants((prev) => [...prev.filter((g) => g.id !== e.grant.id && g.tab_id !== e.grant.tab_id), e.grant]);
    else if (e.type === 'grant_revoked') setGrants((prev) => prev.filter((g) => g.id !== e.grant_id));
    else if (e.type === 'granted_action') setActions((prev) => (prev.some((a) => a.id === e.action.id) ? prev.map((a) => (a.id === e.action.id ? e.action : a)) : [...prev, e.action]));
    ```
    (a re-grant for the same tab replaces the older one, as on the server.)
  - `decide(id, decision: 'approve' | 'deny' | 'approve_tab')`: after applying the status, `if (res.grant) setGrants((prev) => [...prev.filter((g) => g.id !== res.grant!.id && g.tab_id !== res.grant!.tab_id), res.grant!]);`. In the `HOST_CODES` branch, `const status = decision === 'deny' ? 'denied' : 'approved';` (the grant itself was created before the busy/offline answer only when the server got that far; the next `load()` there brings it in).
  - `revoke`:
    ```ts
    const revoke = async (grantId: string) => {
      setRevokingId(grantId);
      setActionError(null);
      try {
        await api.revokeChatGrant(grantId);
        setGrants((prev) => prev.filter((g) => g.id !== grantId));
      } catch (e) {
        // 409: it was already revoked (another tab, or it expired and a reset ended it) — the strip is stale, not wrong.
        if (e instanceof ApiError && e.status === 409) setGrants((prev) => prev.filter((g) => g.id !== grantId));
        else setActionError(e instanceof ApiError ? e.message : 'Não foi possível revogar a permissão');
      } finally {
        setRevokingId(null);
      }
    };
    ```
  - Card render: pass `grant={grants.find((g) => g.source_action_id === entry.action.id && isGrantActive(g))}`, `revoking={...}` and `onRevoke={() => { const g = …; if (g) void revoke(g.id); }}` (compute `g` once per card in a small local const before `return`).
  - Reset (`setActions([])` in the reset handler): also `setGrants([])`.
  - Right before `<ChatComposer …/>`: `<ChatGrantStrip grants={grants} revokingId={revokingId} onRevoke={(id) => void revoke(id)} />`.
  Run the panel tests → PASS; then the whole web suite and `NODE 'npm run build -w @termhub/web'` → PASS.

- [ ] **Step 10: Commit**
  ```bash
  git add apps/web/src
  git commit -m "Chat: trust a tab from the card, show and revoke it (TER-5)"
  ```

---

### Task 5 (TER-6): Coverage check and full verification

**Files:** only tests, if a gap is found.

- [ ] **Step 1: Coverage review against spec §7.** For each bullet in the spec's Tests section, point at the test that covers it (Tasks 1–4). Any bullet without a test: write it now in the matching file, run it, and see it pass. In particular confirm there is a test for the full loop in `gate.e2e.test.ts` — add it if Tasks 2–3 did not:
  ```ts
  it('grant → direct send → revoke → asks again', async () => {
    const typed: string[] = [];
    attachFakeTmux(typed);
    const { app, actions, grants } = build({ gated: true });
    const g = grants.seed('t1');
    await callTool(app, 'send_input', { tab_id: 't1', text: 'primeira' });
    expect(typed).toContain('primeira');
    g.revoked_at = new Date().toISOString();
    const res = await callTool(app, 'send_input', { tab_id: 't1', text: 'segunda' });
    expect(textOf(res)).toMatch(/pendente de confirmação/i);
    expect(typed).not.toContain('segunda');
    expect(actions.rows.map((r) => r.status)).toEqual(['executed', 'pending']);
  });
  ```
- [ ] **Step 2: Full verification** (all must pass; paste the summary lines into the report):
  ```bash
  NODE 'cd apps/server && npx prisma migrate deploy && npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code'
  NODE 'TERMHUB_DB_TESTS=1 npm test -w @termhub/server'
  NODE 'npm test -w @termhub/web'
  NODE 'npm run typecheck -w @termhub/server && npm run build -w @termhub/web && npm run build -w @termhub/landing && npm run typecheck -w @termhub/mobile'
  rm -rf .npm
  ```
- [ ] **Step 3: Commit** any added tests: `git commit -m "Chat tab grant: cover the full grant loop (TER-6)"` (skip if nothing changed).
