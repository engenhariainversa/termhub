# Chat grants list + batched confirmations — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take the trusted-tab strips out of the chat (web + app), list every chat grant (active + paged history) in its own screen with Revogar, and turn a burst of confirmation cards into one grouped confirmation decided and re-injected at once (TER-67, TER-94).

**Architecture:** Server: a user-scoped, cursor-paged query on `chat_grants` enriched by a batched view, exposed on `/api/chat/grants` and `/api/m/v1/chat/grants`; a `decideMany` core behind two batch routes; re-injection that drains every decided-but-uninjected action in one run. Web: a settings section + a header link replacing the strip; a grouped card in the timeline. App: a stack screen + store, a header button replacing the strip, a grouped card and a one-PIN multi-proof prompt.

**Tech Stack:** Fastify + zod + Prisma (Postgres), React + Vite + vitest/RTL (web), Expo/React Native + zustand + jest/RNTL (app), `@termhub/mobile-api` (shared zod contract, consumed from `dist/`).

**Spec:** `docs/superpowers/specs/2026-09-26-chat-grants-list-design.md`

## Global Constraints

- Work only in the worktree `/home/pedrogoiania/termhub/.claude/worktrees/ter-67-chat-grants` (branch `feat/ter-67-chat-grants`). No push, no merge, no deploy.
- The host has no Node: every npm/npx command runs in Docker. Use exactly this prefix (throwaway Postgres `th-ter67-db` on network `th-ter67-net` is already migrated; never touch any container not named `th-*`):
  `docker run --rm --name th-ter67-run -u 1000:1000 -e HOME=/tmp --network th-ter67-net -e DATABASE_URL=postgresql://postgres:postgres@th-ter67-db:5432/termhub -e TERMHUB_DB_TESTS=1 -v /home/pedrogoiania/termhub/.claude/worktrees/ter-67-chat-grants:/w -w /w node:22 sh -c '<command>'`
  (referred to below as `DOCKER '<command>'`).
- After changing `packages/mobile-api/src`, rebuild it before server or app tests: `DOCKER 'npm run build -w @termhub/mobile-api'` (both consume `dist/`).
- Commit messages in English, imperative subject ≤ 72 chars, ending with the line `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- UI copy stays pt-BR exactly as written in the tasks; code, comments and identifiers in English. Match the surrounding comment density.
- Routes never import Prisma; go through repositories. Every request input is validated with zod. Grants and actions are owner-scoped through the conversation's `user_id` (`request.scope.user.id`), never trusting a client-sent owner.
- No migration in this plan (the previous release must keep working unchanged).
- Revoking a grant on the phone never asks for the PIN.
- Web tests: `DOCKER 'npx -w @termhub/web vitest run <paths>'`. Server tests: `DOCKER 'npx -w @termhub/server vitest run <paths>'`. App tests: `DOCKER 'npm test -w @termhub/mobile -- <paths>'`. mobile-api tests: `DOCKER 'npx -w @termhub/mobile-api vitest run'`.

## Review Focus

- A grant that expired and was later revoked by "Nova conversa" or by a re-grant (both revoke every unrevoked row, expired ones too) must read **Expirou** with `ended_at = expires_at`, not "Encerrada com a conversa"/"Revogada" at reset time — pinned in Task 2.
- History paging across rows with the **same `created_at`** must neither skip nor repeat a row — pinned in Task 1.
- A cursor that is garbage, truncated base64, or a valid base64 of a non-ISO date must be a 400, never a 500 or an unfiltered page — pinned in Task 3.
- A batch whose PIN is wrong on the phone must decide **nothing** (no row left half-approved) — pinned in Task 11.
- A batch that mixes ids of two conversations must be refused before any decision (the injected sentence goes to one conversation only) — pinned in Task 10.

---

### Task 1: Repository — `ChatGrantsRepository.listForUser` (TER-70)

**Files:**
- Modify: `apps/server/src/db/repositories/chat-grants.ts`
- Test: `apps/server/src/db/repositories/chat-grants.db.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface GrantCursor { created_at: string; id: string }
  export interface ChatGrantWithConversation extends ChatGrant { conversation_project_id: string | null; conversation_archived: boolean }
  export const GRANT_LIST_MAX = 100;
  listForUser(userId: string, opts: { state: 'active' | 'ended'; cursor?: GrantCursor | null; limit: number }, now?: Date): Promise<{ grants: ChatGrantWithConversation[]; next: GrantCursor | null }>
  ```

- [ ] **Step 1: Write the failing test** — append a new `describe` block at the end of `chat-grants.db.test.ts` (own users, so the other tests' rows never interfere):

```ts
describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('ChatGrantsRepository.listForUser (Postgres)', () => {
  let db: PrismaClient;
  let repo: ChatGrantsRepository;
  let userId: string;
  let otherUserId: string;
  let generalId: string;
  let archivedId: string;
  let otherConversationId: string;
  const DAY = GRANT_TTL_MS;

  beforeAll(async () => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    repo = new ChatGrantsRepository(db);
    userId = newId();
    otherUserId = newId();
    await db.user.create({ data: { id: userId, email: `${userId}@test.local`, name: 'list' } });
    await db.user.create({ data: { id: otherUserId, email: `${otherUserId}@test.local`, name: 'other' } });
    const chat = new ChatRepository(db);
    generalId = (await chat.getOrCreateForUser(userId)).id;
    otherConversationId = (await chat.getOrCreateForUser(otherUserId)).id;
    archivedId = newId();
    await db.chatConversation.create({ data: { id: archivedId, userId, archivedAt: new Date() } });
  });

  afterAll(async () => {
    await db.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
    await db.$disconnect();
  });

  const grantIn = (conversationId: string, tabId: string, at: Date, by = userId) =>
    repo.grant({ conversation_id: conversationId, tab_id: tabId, tool: 'send_input', source_action_id: null, granted_by: by }, at);

  it('splits active from ended, only for this user, with the conversation it came from', async () => {
    const now = new Date();
    const active = await grantIn(generalId, 'la1', new Date(now.getTime() - 60_000));
    const expired = await grantIn(generalId, 'la2', new Date(now.getTime() - DAY - 60_000));
    const revoked = await grantIn(archivedId, 'la3', new Date(now.getTime() - 120_000));
    await repo.revoke(revoked.id, userId);
    await grantIn(otherConversationId, 'la4', new Date(now.getTime() - 60_000), otherUserId);

    const a = await repo.listForUser(userId, { state: 'active', limit: 50 }, now);
    expect(a.grants.map((g) => g.id)).toEqual([active.id]);
    expect(a.next).toBeNull();
    expect(a.grants[0]).toMatchObject({ conversation_id: generalId, conversation_project_id: null, conversation_archived: false });

    const e = await repo.listForUser(userId, { state: 'ended', limit: 50 }, now);
    expect(e.grants.map((g) => g.id).sort()).toEqual([expired.id, revoked.id].sort());
    expect(e.grants.find((g) => g.id === revoked.id)).toMatchObject({ conversation_archived: true, revoked_by: userId });
  });

  it('pages the history newest first without skipping or repeating rows that share created_at', async () => {
    const same = new Date(Date.now() - 3 * DAY);
    const ids = [(await grantIn(generalId, 'lp1', same)).id, (await grantIn(generalId, 'lp2', same)).id, (await grantIn(generalId, 'lp3', same)).id];
    const seen: string[] = [];
    let cursor: { created_at: string; id: string } | null = null;
    for (let i = 0; i < 10; i++) {
      const page = await repo.listForUser(userId, { state: 'ended', cursor, limit: 2 });
      seen.push(...page.grants.map((g) => g.id));
      if (!page.next) break;
      cursor = page.next;
    }
    const mine = seen.filter((id) => ids.includes(id));
    expect(new Set(seen).size).toBe(seen.length);
    expect(mine).toEqual([...ids].sort().reverse());
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `DOCKER 'npx -w @termhub/server vitest run src/db/repositories/chat-grants.db.test.ts'`
Expected: FAIL — `repo.listForUser is not a function`.

- [ ] **Step 3: Implement** — in `chat-grants.ts`, add the exports below after `GrantInput`, and the method at the end of the class. Also update the class doc comment's second sentence to list `listForUser` among the methods that filter by the conversation's `user_id` in SQL.

```ts
/** Where a page of the grant history ended: the last row's `(created_at, id)`. */
export interface GrantCursor {
  created_at: string;
  id: string;
}

/** A grant with what the list needs from the conversation that granted it. */
export interface ChatGrantWithConversation extends ChatGrant {
  conversation_project_id: string | null;
  conversation_archived: boolean;
}

/** The most rows one page (or the active list) ever returns. */
export const GRANT_LIST_MAX = 100;
```

```ts
  /**
   * Every grant of one user, across all their conversations ("Abas confiáveis", spec 2026-09-26 §3.1),
   * scoped by the owning conversation's `user_id` in SQL. `active` returns what is in force (capped at
   * `GRANT_LIST_MAX`, no paging: at most one per conversation + tab, each ≤ 24 h). `ended` is the history,
   * newest first, paged by `(created_at, id)` so rows sharing a timestamp are neither skipped nor repeated.
   */
  async listForUser(userId: string, opts: { state: 'active' | 'ended'; cursor?: GrantCursor | null; limit: number }, now = new Date()): Promise<{ grants: ChatGrantWithConversation[]; next: GrantCursor | null }> {
    const limit = Math.min(Math.max(Math.trunc(opts.limit), 1), GRANT_LIST_MAX);
    const state = opts.state === 'active' ? { revokedAt: null, expiresAt: { gt: now } } : { OR: [{ revokedAt: { not: null } }, { expiresAt: { lte: now } }] };
    const cursor = opts.state === 'ended' ? opts.cursor : null;
    const after = cursor ? { OR: [{ createdAt: { lt: new Date(cursor.created_at) } }, { createdAt: new Date(cursor.created_at), id: { lt: cursor.id } }] } : {};
    const rows = await this.db.chatGrant.findMany({
      where: { AND: [{ conversation: { userId } }, state, after] },
      include: { conversation: { select: { projectId: true, archivedAt: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      grants: page.map((r) => ({ ...mapGrant(r), conversation_project_id: r.conversation.projectId, conversation_archived: r.conversation.archivedAt !== null })),
      next: opts.state === 'ended' && rows.length > limit && last ? { created_at: last.createdAt.toISOString(), id: last.id } : null,
    };
  }
```

- [ ] **Step 4: Run it to verify it passes** — same command. Expected: PASS (all tests in the file).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/db/repositories/chat-grants.ts apps/server/src/db/repositories/chat-grants.db.test.ts
git commit -m "Chat grants: list a user's grants, active or paged history"
```

---

### Task 2: View — `describeGrantList` (TER-70)

**Files:**
- Modify: `apps/server/src/db/repositories/chat-actions-view.ts`
- Test: `apps/server/src/db/repositories/chat-actions-view.test.ts`

**Interfaces:**
- Consumes: `ChatGrantWithConversation` (Task 1), `repos.tabs.findByIdsForOwner`, `repos.projects.findByIdsForOwner`.
- Produces:
  ```ts
  export type ChatGrantState = 'active' | 'expired' | 'revoked' | 'ended';
  export interface ChatGrantListItem extends ChatGrantView { project_id: string | null; project_name: string | null; conversation_id: string; conversation_project_name: string | null; conversation_archived: boolean; state: ChatGrantState; ended_at: string | null }
  export function grantState(g: Pick<ChatGrant, 'expires_at' | 'revoked_at' | 'revoked_by'>, now?: Date): ChatGrantState
  export async function describeGrantList(repos: Repositories, grants: ChatGrantWithConversation[], ownerId: string, now?: Date): Promise<ChatGrantListItem[]>
  ```

- [ ] **Step 1: Write the failing tests** — in `chat-actions-view.test.ts`, change the import to `import { describeActions, describeGrantList, describeGrants, grantState } from './chat-actions-view.js';` and `import type { ChatGrant, ChatGrantWithConversation } from './chat-grants.js';`, then append:

```ts
const NOW = new Date('2026-09-25T12:00:00.000Z');
const listed = (over: Partial<ChatGrantWithConversation>): ChatGrantWithConversation => ({ ...grant({}), conversation_project_id: null, conversation_archived: false, ...over });

it('grantState: active, expired, revoked by a person, ended by "Nova conversa"', () => {
  expect(grantState(grant({}), NOW)).toBe('active');
  expect(grantState(grant({ expires_at: '2026-09-25T11:00:00.000Z' }), NOW)).toBe('expired');
  expect(grantState(grant({ revoked_at: '2026-09-25T11:00:00.000Z', revoked_by: OWNER }), NOW)).toBe('revoked');
  expect(grantState(grant({ revoked_at: '2026-09-25T11:00:00.000Z', revoked_by: null }), NOW)).toBe('ended');
});

it('grantState: a grant that expired before a reset or a re-grant revoked it reads expired', () => {
  expect(grantState(grant({ expires_at: '2026-09-25T09:00:00.000Z', revoked_at: '2026-09-25T11:00:00.000Z', revoked_by: null }), NOW)).toBe('expired');
  expect(grantState(grant({ expires_at: '2026-09-25T09:00:00.000Z', revoked_at: '2026-09-25T11:00:00.000Z', revoked_by: OWNER }), NOW)).toBe('expired');
});

it('describeGrantList names the tab, its project and the origin conversation, with state and ended_at', async () => {
  const repos = fakeRepos();
  const [active, revoked, expiredThenReset] = await describeGrantList(
    repos,
    [
      listed({ id: 'g1', tab_id: tab.id, conversation_project_id: project.id }),
      listed({ id: 'g2', tab_id: tab.id, revoked_at: '2026-09-25T11:00:00.000Z', revoked_by: OWNER, conversation_archived: true }),
      listed({ id: 'g3', tab_id: foreignTab.id, expires_at: '2026-09-25T09:00:00.000Z', revoked_at: '2026-09-25T11:00:00.000Z', revoked_by: null }),
    ],
    OWNER,
    NOW,
  );
  expect(active).toEqual({
    id: 'g1', tab_id: tab.id, tool: 'send_input', source_action_id: 'a1', created_at: '2026-09-25T10:00:00.000Z', expires_at: '2026-09-26T10:00:00.000Z',
    tab_name: tab.name, project_id: project.id, project_name: project.name, conversation_id: 'c1', conversation_project_name: project.name,
    conversation_archived: false, state: 'active', ended_at: null,
  });
  expect(revoked).toMatchObject({ state: 'revoked', ended_at: '2026-09-25T11:00:00.000Z', conversation_project_name: null, conversation_archived: true });
  expect(expiredThenReset).toMatchObject({ state: 'expired', ended_at: '2026-09-25T09:00:00.000Z', tab_name: null, project_id: null, project_name: null });
});

it('describeGrantList batches one lookup per kind, owner-scoped, and none for an empty list', async () => {
  const repos = fakeRepos();
  await describeGrantList(repos, [listed({ id: 'g1', tab_id: tab.id, conversation_project_id: project.id }), listed({ id: 'g2', tab_id: tab.id })], OWNER, NOW);
  expect(repos.tabs.findByIdsForOwner).toHaveBeenCalledTimes(1);
  expect(repos.tabs.findByIdsForOwner).toHaveBeenCalledWith([tab.id], OWNER);
  expect(repos.projects.findByIdsForOwner).toHaveBeenCalledTimes(1);
  expect(repos.projects.findByIdsForOwner).toHaveBeenCalledWith([project.id], OWNER);
  const empty = fakeRepos();
  expect(await describeGrantList(empty, [], OWNER, NOW)).toEqual([]);
  expect(empty.tabs.findByIdsForOwner).not.toHaveBeenCalled();
  expect(empty.projects.findByIdsForOwner).not.toHaveBeenCalled();
});
```

(`fakeRepos()` returns `never`; if TypeScript complains about `.tabs` on it in the last test, assign `const repos = fakeRepos() as unknown as { tabs: { findByIdsForOwner: ReturnType<typeof vi.fn> }; projects: { findByIdsForOwner: ReturnType<typeof vi.fn> } }` for the assertions and pass `repos as never`, the way the existing `describeGrants batches` test does.)

- [ ] **Step 2: Run to verify failure** — `DOCKER 'npx -w @termhub/server vitest run src/db/repositories/chat-actions-view.test.ts'`. Expected: FAIL (`describeGrantList`/`grantState` not exported).

- [ ] **Step 3: Implement** — in `chat-actions-view.ts`, change the grant import to `import type { ChatGrant, ChatGrantWithConversation } from './chat-grants.js';` and append after `describeGrants`:

```ts
/** How a grant stands (spec 2026-09-26 §3.2). A reset or a re-grant revokes every unrevoked row, expired
 * ones included, so a revocation that came after the expiry is not what ended it: that grant expired. */
export type ChatGrantState = 'active' | 'expired' | 'revoked' | 'ended';

export function grantState(g: Pick<ChatGrant, 'expires_at' | 'revoked_at' | 'revoked_by'>, now = new Date()): ChatGrantState {
  const expiresAt = Date.parse(g.expires_at);
  if (g.revoked_at !== null && Date.parse(g.revoked_at) < expiresAt) return g.revoked_by ? 'revoked' : 'ended';
  return expiresAt > now.getTime() && g.revoked_at === null ? 'active' : 'expired';
}

/** A grant as "Abas confiáveis" lists it: the chat's view plus the tab's project, the conversation that
 * granted it and how it stands. No user ids. */
export interface ChatGrantListItem extends ChatGrantView {
  project_id: string | null;
  project_name: string | null;
  conversation_id: string;
  /** Null = the account-wide chat ("Chat geral"). */
  conversation_project_name: string | null;
  conversation_archived: boolean;
  state: ChatGrantState;
  /** When it stopped counting: the revocation, or the expiry; null while active. */
  ended_at: string | null;
}

/** Enriches a page of grants like `describeGrants`: one owner-scoped lookup for the tabs and one for the
 * projects (the tabs' and the conversations'), never one per grant. */
export async function describeGrantList(repos: Repositories, grants: ChatGrantWithConversation[], ownerId: string, now = new Date()): Promise<ChatGrantListItem[]> {
  const tabIds = [...new Set(grants.map((g) => g.tab_id))];
  const tabs = tabIds.length ? await repos.tabs.findByIdsForOwner(tabIds, ownerId) : [];
  const tabById = new Map(tabs.map((t) => [t.id, t]));
  const projectIds = [...new Set([...tabs.map((t) => t.project_id), ...grants.flatMap((g) => (g.conversation_project_id ? [g.conversation_project_id] : []))])];
  const projects = projectIds.length ? await repos.projects.findByIdsForOwner(projectIds, ownerId) : [];
  const projectName = new Map(projects.map((p) => [p.id, p.name]));
  return grants.map((g) => {
    const tab = tabById.get(g.tab_id);
    const state = grantState(g, now);
    const projectId = tab?.project_id ?? null;
    return {
      id: g.id,
      tab_id: g.tab_id,
      tool: g.tool,
      source_action_id: g.source_action_id,
      created_at: g.created_at,
      expires_at: g.expires_at,
      tab_name: tab?.name ?? null,
      project_id: projectId,
      project_name: projectId ? (projectName.get(projectId) ?? null) : null,
      conversation_id: g.conversation_id,
      conversation_project_name: g.conversation_project_id ? (projectName.get(g.conversation_project_id) ?? null) : null,
      conversation_archived: g.conversation_archived,
      state,
      ended_at: state === 'active' ? null : state === 'expired' ? g.expires_at : g.revoked_at,
    };
  });
}
```

- [ ] **Step 4: Run to verify it passes** — same command. Expected: PASS.

- [ ] **Step 5: Commit** — `git add` both files; `git commit -m "Chat grants: describe a grant list with state, project and origin"`.

---

### Task 3: Contract, `listGrants` helper and routes (TER-70)

**Files:**
- Modify: `packages/mobile-api/src/events.ts` (schemas), `packages/mobile-api/src/events.test.ts`
- Modify: `apps/server/src/chat/grants.ts`, `apps/server/src/routes/chat.ts`, `apps/server/src/routes/m-chat.ts`
- Test: `apps/server/src/chat/grants.test.ts` (create), `apps/server/src/routes/chat.test.ts`, `apps/server/src/routes/m-chat.test.ts`

**Interfaces:**
- Consumes: `listForUser` (Task 1), `describeGrantList` (Task 2).
- Produces (mobile-api): `chatGrantState`, `chatGrantListItemSchema`, `chatGrantListResponse`, `chatGrantListQuery` (`{ state: 'active'|'ended'; cursor?: string; limit: number }`, `limit` coerced, default 50, 1..100).
- Produces (server `chat/grants.ts`): `encodeGrantCursor(c: GrantCursor): string`, `decodeGrantCursor(s: string): GrantCursor` (throws `HttpError(400, 'Cursor inválido', 'INVALID_CURSOR')`), `listGrants(repos, userId, query, now?) => Promise<{ grants: ChatGrantListItem[]; next_cursor: string | null }>`.
- Produces (HTTP): `GET /api/chat/grants?state=&cursor=&limit=` and `GET /api/m/v1/chat/grants?…` → `{ grants, next_cursor }`.

- [ ] **Step 1: Contract test** — append to `packages/mobile-api/src/events.test.ts` (keep its existing imports style; add the three names to the import from `./events.js`):

```ts
describe('chat grant list', () => {
  const item = {
    id: 'g1', tab_id: 't1', tool: 'send_input', source_action_id: null, created_at: '2026-09-25T10:00:00.000Z', expires_at: '2026-09-26T10:00:00.000Z',
    tab_name: null, project_id: null, project_name: null, conversation_id: 'c1', conversation_project_name: null, conversation_archived: false,
    state: 'expired', ended_at: '2026-09-26T10:00:00.000Z',
  };
  it('parses the server list shape', () => {
    expect(chatGrantListResponse.parse({ grants: [item], next_cursor: null }).grants[0]!.state).toBe('expired');
    expect(chatGrantListResponse.safeParse({ grants: [{ ...item, state: 'gone' }], next_cursor: null }).success).toBe(false);
  });
  it('validates the query: state required, limit 1..100 defaulting to 50', () => {
    expect(chatGrantListQuery.parse({ state: 'ended' })).toEqual({ state: 'ended', limit: 50 });
    expect(chatGrantListQuery.parse({ state: 'active', limit: '10', cursor: 'abc' })).toEqual({ state: 'active', limit: 10, cursor: 'abc' });
    for (const bad of [{}, { state: 'all' }, { state: 'ended', limit: '0' }, { state: 'ended', limit: '101' }, { state: 'ended', cursor: '' }]) expect(chatGrantListQuery.safeParse(bad).success).toBe(false);
  });
});
```

- [ ] **Step 2: Implement the contract** — in `packages/mobile-api/src/events.ts`, right after `chatGrantSchema`:

```ts
/** How a listed grant stands (server `ChatGrantState`). */
export const chatGrantState = z.enum(['active', 'expired', 'revoked', 'ended']);

/** One row of "Abas confiáveis" (server `ChatGrantListItem`). */
export const chatGrantListItemSchema = chatGrantSchema.extend({
  project_id: z.string().nullable(),
  project_name: z.string().nullable(),
  conversation_id: z.string(),
  conversation_project_name: z.string().nullable(),
  conversation_archived: z.boolean(),
  state: chatGrantState,
  ended_at: z.string().nullable(),
});

export const chatGrantListResponse = z.object({ grants: z.array(chatGrantListItemSchema), next_cursor: z.string().nullable() });

/** `GET chat/grants`, web and phone alike. */
export const chatGrantListQuery = z.object({
  state: z.enum(['active', 'ended']),
  cursor: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
```

Run: `DOCKER 'npx -w @termhub/mobile-api vitest run && npm run build -w @termhub/mobile-api'`. Expected: PASS, build ok.

- [ ] **Step 3: Helper tests** — create `apps/server/src/chat/grants.test.ts`:

```ts
import { expect, it, vi } from 'vitest';
import { HttpError } from '../lib/errors.js';
import { decodeGrantCursor, encodeGrantCursor, listGrants } from './grants.js';

it('round-trips a cursor', () => {
  const c = { created_at: '2026-09-25T10:00:00.000Z', id: 'abc123' };
  expect(decodeGrantCursor(encodeGrantCursor(c))).toEqual(c);
});

it('refuses a cursor that is not one of ours with a 400', () => {
  const bad = ['nope', Buffer.from('no-separator').toString('base64url'), Buffer.from('yesterday|g1').toString('base64url'), Buffer.from('2026-09-25T10:00:00.000Z|').toString('base64url'), Buffer.from('2026-09-25|g1').toString('base64url')];
  for (const s of bad) {
    expect(() => decodeGrantCursor(s)).toThrow(HttpError);
    try {
      decodeGrantCursor(s);
    } catch (e) {
      expect((e as HttpError).code).toBe('INVALID_CURSOR');
    }
  }
});

it('listGrants passes the decoded cursor and encodes the next one', async () => {
  const listForUser = vi.fn(async () => ({ grants: [], next: { created_at: '2026-09-25T10:00:00.000Z', id: 'g9' } }));
  const repos = { chatGrants: { listForUser }, tabs: { findByIdsForOwner: vi.fn(async () => []) }, projects: { findByIdsForOwner: vi.fn(async () => []) } } as never;
  const cursor = encodeGrantCursor({ created_at: '2026-09-24T10:00:00.000Z', id: 'g1' });
  const now = new Date('2026-09-25T12:00:00.000Z');
  const res = await listGrants(repos, 'u1', { state: 'ended', cursor, limit: 20 }, now);
  expect(listForUser).toHaveBeenCalledWith('u1', { state: 'ended', cursor: { created_at: '2026-09-24T10:00:00.000Z', id: 'g1' }, limit: 20 }, now);
  expect(decodeGrantCursor(res.next_cursor!)).toEqual({ created_at: '2026-09-25T10:00:00.000Z', id: 'g9' });
});
```

Run `DOCKER 'npx -w @termhub/server vitest run src/chat/grants.test.ts'` → FAIL (not exported).

- [ ] **Step 4: Implement the helper** — in `apps/server/src/chat/grants.ts` add imports `import type { z } from 'zod';`, `import type { chatGrantListQuery } from '@termhub/mobile-api';`, `import type { GrantCursor } from '../db/repositories/chat-grants.js';`, extend the view import with `describeGrantList, type ChatGrantListItem`, and append:

```ts
const INVALID_CURSOR = () => new HttpError(400, 'Cursor inválido', 'INVALID_CURSOR');

/** Opaque to clients: base64url of `<created_at ISO>|<id>`. */
export const encodeGrantCursor = (c: GrantCursor): string => Buffer.from(`${c.created_at}|${c.id}`, 'utf8').toString('base64url');

/** The inverse, strictly: anything that is not exactly what `encodeGrantCursor` makes is a 400, never an
 * unfiltered page. */
export function decodeGrantCursor(s: string): GrantCursor {
  const raw = Buffer.from(s, 'base64url').toString('utf8');
  const sep = raw.indexOf('|');
  if (sep <= 0) throw INVALID_CURSOR();
  const created_at = raw.slice(0, sep);
  const id = raw.slice(sep + 1);
  const t = Date.parse(created_at);
  if (!id || id.length > 64 || !Number.isFinite(t) || new Date(t).toISOString() !== created_at) throw INVALID_CURSOR();
  return { created_at, id };
}

/** "Abas confiáveis" (spec 2026-09-26 §3.3): one page of this user's grants, web and phone alike. */
export async function listGrants(repos: Repositories, userId: string, query: z.infer<typeof chatGrantListQuery>, now = new Date()): Promise<{ grants: ChatGrantListItem[]; next_cursor: string | null }> {
  const cursor = query.cursor ? decodeGrantCursor(query.cursor) : null;
  const { grants, next } = await repos.chatGrants.listForUser(userId, { state: query.state, cursor, limit: query.limit }, now);
  return { grants: await describeGrantList(repos, grants, userId, now), next_cursor: next ? encodeGrantCursor(next) : null };
}
```

Run the helper test → PASS.

- [ ] **Step 5: Route tests** — in `apps/server/src/routes/chat.test.ts`: add `listForUser?: ReturnType<typeof vi.fn>;` to `build`'s options and `listForUser: opts.listForUser ?? vi.fn(async () => ({ grants: [], next: null })),` inside `repos.chatGrants`. Append:

```ts
const listedRow = { id: 'g1', conversation_id: 'c1', tab_id: 't1', tool: 'send_input', source_action_id: 'act1', granted_by: 'u1', created_at: '2026-09-25T10:00:00.000Z', expires_at: '2026-09-26T10:00:00.000Z', revoked_at: '2026-09-25T12:00:00.000Z', revoked_by: 'u1', conversation_project_id: null, conversation_archived: false };

it('GET /chat/grants lists this user\'s grants, named, with a cursor for the next page', async () => {
  const listForUser = vi.fn(async () => ({ grants: [listedRow], next: { created_at: listedRow.created_at, id: 'g1' } }));
  const { app } = build({ listForUser, tabs: [{ id: 't1', project_id: 'p1', name: 'api' }], projects: [{ id: 'p1', owner_id: 'u1', name: 'termhub' }] });
  const res = await app.inject({ method: 'GET', url: '/chat/grants?state=ended' });
  expect(res.statusCode).toBe(200);
  expect(listForUser).toHaveBeenCalledWith('u1', { state: 'ended', cursor: null, limit: 50 }, expect.any(Date));
  const body = res.json();
  expect(body.grants[0]).toMatchObject({ id: 'g1', tab_name: 'api', project_name: 'termhub', conversation_project_name: null, state: 'revoked', ended_at: listedRow.revoked_at });
  expect(typeof body.next_cursor).toBe('string');
  await app.inject({ method: 'GET', url: `/chat/grants?state=ended&cursor=${body.next_cursor}` });
  expect(listForUser).toHaveBeenLastCalledWith('u1', { state: 'ended', cursor: { created_at: listedRow.created_at, id: 'g1' }, limit: 50 }, expect.any(Date));
});

it('GET /chat/grants: 400 without a valid state, with a bad cursor or a limit out of range', async () => {
  const listForUser = vi.fn(async () => ({ grants: [], next: null }));
  const { app } = build({ listForUser });
  for (const url of ['/chat/grants', '/chat/grants?state=all', '/chat/grants?state=ended&cursor=nope', '/chat/grants?state=ended&limit=0', '/chat/grants?state=ended&limit=101']) {
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(400);
  }
  expect(listForUser).not.toHaveBeenCalled();
});
```

In `apps/server/src/routes/m-chat.test.ts`: same `listForUser` option + fake in its `repos.chatGrants`; add `import { chatGrantListResponse } from '@termhub/mobile-api';` and, inside `describe('grants', …)`:

```ts
  it('GET /chat/grants answers the shared contract shape for this user', async () => {
    const row = { id: 'g1', conversation_id: 'c1', tab_id: 't1', tool: 'send_input', source_action_id: 'act1', granted_by: 'u1', created_at: '2026-09-25T10:00:00.000Z', expires_at: '2099-09-26T10:00:00.000Z', revoked_at: null, revoked_by: null, conversation_project_id: null, conversation_archived: false };
    const listForUser = vi.fn(async () => ({ grants: [row], next: null }));
    const { app } = build({ listForUser, tabs: [{ id: 't1', project_id: 'p1', name: 'Terminal 1' }] });
    const res = await app.inject({ method: 'GET', url: '/chat/grants?state=active' });
    expect(res.statusCode).toBe(200);
    expect(chatGrantListResponse.safeParse(res.json()).success).toBe(true);
    expect(res.json()).toMatchObject({ grants: [{ id: 'g1', tab_name: 'Terminal 1', state: 'active', ended_at: null }], next_cursor: null });
    expect(listForUser).toHaveBeenCalledWith('u1', { state: 'active', cursor: null, limit: 50 }, expect.any(Date));
    expect((await app.inject({ method: 'GET', url: '/chat/grants?state=ended&cursor=nope' })).statusCode).toBe(400);
  });
```

(Check how the m-chat `build` injects the tabs option — it already takes `tabs`; add `listForUser` the same way the web one does.)

Run `DOCKER 'npx -w @termhub/server vitest run src/routes/chat.test.ts src/routes/m-chat.test.ts'` → FAIL (404 on the new route).

- [ ] **Step 6: Routes** — `routes/chat.ts`: add `import { chatGrantListQuery } from '@termhub/mobile-api';`, add `listGrants` to the `../chat/grants.js` import, and before the `DELETE /grants/:id` handler:

```ts
  /** "Abas confiáveis" (Configurações): every grant of this user, active or a page of the history. */
  app.get('/grants', async (request) => listGrants(repos, request.scope.user.id, chatGrantListQuery.parse(request.query)));
```

`routes/m-chat.ts`: add `chatGrantListQuery, chatGrantListResponse` to the `@termhub/mobile-api` import, `listGrants` to the grants import, and before its `DELETE /grants/:id`:

```ts
  /** The phone's "Abas confiáveis": the same list as the web, validated against the shared contract. */
  app.get('/grants', async (request) => chatGrantListResponse.parse(await listGrants(repos, request.scope.user.id, chatGrantListQuery.parse(request.query))));
```

- [ ] **Step 7: Run** — `DOCKER 'npx -w @termhub/server vitest run src/routes/chat.test.ts src/routes/m-chat.test.ts src/chat/grants.test.ts && npm run typecheck -w @termhub/server'`. Expected: PASS, no type errors.

- [ ] **Step 8: Commit** — `git add packages/mobile-api/src apps/server/src/chat/grants.ts apps/server/src/chat/grants.test.ts apps/server/src/routes/chat.ts apps/server/src/routes/m-chat.ts apps/server/src/routes/chat.test.ts apps/server/src/routes/m-chat.test.ts`; `git commit -m "Chat grants: list them on the web and phone APIs"`.

---

### Task 4: Web — "Abas confiáveis" settings section (TER-69)

**Files:**
- Modify: `apps/web/src/lib/types.ts`, `apps/web/src/lib/api.ts`, `apps/web/src/lib/settings-sections.ts`, `apps/web/src/lib/settings-sections.test.ts`, `apps/web/src/pages/SettingsPage.tsx`, `apps/web/src/pages/SettingsPage.test.tsx`
- Create: `apps/web/src/components/chat/grant-list-text.ts`, `apps/web/src/components/chat/grant-list-text.test.ts`, `apps/web/src/components/ChatGrantsView.tsx`, `apps/web/src/components/ChatGrantsView.test.tsx`

**Interfaces:**
- Consumes: `GET /api/chat/grants` (Task 3), existing `api.revokeChatGrant(id)`, `untilLabel` from `components/chat/grant-time`.
- Produces: `ChatGrantListItem`, `ChatGrantState` types; `api.listChatGrants(q: { state: 'active' | 'ended'; cursor?: string | null })`; `trustedTabsLabel(n: number): string` (used by Task 5); `ChatGrantsView`.

- [ ] **Step 1: Types and api** — in `lib/types.ts`, after `ChatGrant`:

```ts
/** How a listed grant stands: in force, run out, revoked by someone, or ended by "Nova conversa". */
export type ChatGrantState = 'active' | 'expired' | 'revoked' | 'ended';

/** A row of "Abas confiáveis" (`GET /api/chat/grants`). */
export interface ChatGrantListItem extends ChatGrant {
  project_id: string | null;
  project_name: string | null;
  conversation_id: string;
  /** Null = the account-wide chat. */
  conversation_project_name: string | null;
  conversation_archived: boolean;
  state: ChatGrantState;
  ended_at: string | null;
}
```

In `lib/api.ts` add `ChatGrantListItem` to the type import and, next to `revokeChatGrant`:

```ts
  listChatGrants: (q: { state: 'active' | 'ended'; cursor?: string | null }) =>
    request<{ grants: ChatGrantListItem[]; next_cursor: string | null }>('GET', `/chat/grants?state=${q.state}${q.cursor ? `&cursor=${encodeURIComponent(q.cursor)}` : ''}`),
```

- [ ] **Step 2: Copy helpers, test first** — `components/chat/grant-list-text.test.ts`:

```ts
import { expect, it } from 'vitest';
import { endedAtLabel, GRANT_STATE_LABEL, grantOriginLabel, grantTabLabel, trustedTabsLabel } from './grant-list-text';

it('counts trusted tabs in pt-BR', () => {
  expect(trustedTabsLabel(1)).toBe('1 aba confiável');
  expect(trustedTabsLabel(3)).toBe('3 abas confiáveis');
});
it('names the tab, the origin and the state', () => {
  expect(grantTabLabel({ tab_name: 'api' })).toBe('Aba api');
  expect(grantTabLabel({ tab_name: null })).toBe('Aba que não existe mais');
  expect(grantOriginLabel({ conversation_project_name: null, conversation_archived: false })).toBe('Chat geral');
  expect(grantOriginLabel({ conversation_project_name: 'termhub', conversation_archived: true })).toBe('Chat do projeto termhub · conversa encerrada');
  expect(GRANT_STATE_LABEL).toEqual({ active: 'Ativa', expired: 'Expirou', revoked: 'Revogada', ended: 'Encerrada com a conversa' });
});
it('formats when it ended as dd/mm/aaaa hh:mm in local time', () => {
  const d = new Date(2026, 8, 5, 7, 3);
  expect(endedAtLabel(d.toISOString())).toBe('05/09/2026 07:03');
});
```

Implementation `components/chat/grant-list-text.ts`:

```ts
import type { ChatGrantListItem, ChatGrantState } from '../../lib/types';

const pad = (n: number) => String(n).padStart(2, '0');

/** The chat header's link to "Abas confiáveis". */
export const trustedTabsLabel = (n: number): string => (n === 1 ? '1 aba confiável' : `${n} abas confiáveis`);

export const grantTabLabel = (g: Pick<ChatGrantListItem, 'tab_name'>): string => (g.tab_name ? `Aba ${g.tab_name}` : 'Aba que não existe mais');

/** Which conversation granted it; a reset conversation says so. */
export function grantOriginLabel(g: Pick<ChatGrantListItem, 'conversation_project_name' | 'conversation_archived'>): string {
  const base = g.conversation_project_name ? `Chat do projeto ${g.conversation_project_name}` : 'Chat geral';
  return g.conversation_archived ? `${base} · conversa encerrada` : base;
}

export const GRANT_STATE_LABEL: Record<ChatGrantState, string> = { active: 'Ativa', expired: 'Expirou', revoked: 'Revogada', ended: 'Encerrada com a conversa' };

export function endedAtLabel(iso: string): string {
  const d = new Date(iso);
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
```

Run `DOCKER 'npx -w @termhub/web vitest run src/components/chat/grant-list-text.test.ts'` → PASS after creating both.

- [ ] **Step 3: View test** — `components/ChatGrantsView.test.tsx`:

```tsx
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ChatGrantListItem } from '../lib/types';

const listMock = vi.fn();
const revokeMock = vi.fn();
vi.mock('../lib/api', () => {
  class ApiError extends Error {
    constructor(public status: number, message: string) {
      super(message);
    }
  }
  return { ApiError, api: { listChatGrants: (...a: unknown[]) => listMock(...a), revokeChatGrant: (...a: unknown[]) => revokeMock(...a) } };
});

import { ApiError } from '../lib/api';
import { ChatGrantsView } from './ChatGrantsView';

const item = (over: Partial<ChatGrantListItem> & { id: string }): ChatGrantListItem => ({
  tab_id: 't1', tool: 'send_input', source_action_id: null, created_at: '2026-09-25T10:00:00.000Z', expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  tab_name: 'api', project_id: 'p1', project_name: 'termhub', conversation_id: 'c1', conversation_project_name: null, conversation_archived: false,
  state: 'active', ended_at: null, ...over,
});

beforeEach(() => {
  listMock.mockReset();
  revokeMock.mockReset();
});
afterEach(() => cleanup());

function serve(active: ChatGrantListItem[], pages: { grants: ChatGrantListItem[]; next_cursor: string | null }[]) {
  let page = 0;
  listMock.mockImplementation(async (q: { state: string }) => (q.state === 'active' ? { grants: active, next_cursor: null } : pages[Math.min(page++, pages.length - 1)]));
}

it('lists active grants with tab, project, origin and validity, and the history with its state', async () => {
  serve([item({ id: 'g1' })], [{ grants: [item({ id: 'g2', tab_name: null, state: 'ended', ended_at: '2026-09-24T10:00:00.000Z', conversation_project_name: 'termhub', conversation_archived: true })], next_cursor: null }]);
  render(<ChatGrantsView />);
  const active = await screen.findByRole('region', { name: 'Ativas' });
  expect(within(active).getByText('Aba api · termhub')).toBeInTheDocument();
  expect(within(active).getByText(/^Chat geral · até/)).toBeInTheDocument();
  const history = screen.getByRole('region', { name: 'Histórico' });
  expect(within(history).getByText('Aba que não existe mais · termhub')).toBeInTheDocument();
  expect(within(history).getByText(/^Chat do projeto termhub · conversa encerrada · Encerrada com a conversa em /)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Carregar mais' })).toBeNull();
});

it('shows the empty states', async () => {
  serve([], [{ grants: [], next_cursor: null }]);
  render(<ChatGrantsView />);
  expect(await screen.findByText('Nenhuma aba confiável agora.')).toBeInTheDocument();
  expect(screen.getByText('Nada no histórico ainda.')).toBeInTheDocument();
});

it('Carregar mais appends the next page with the cursor', async () => {
  serve([], [{ grants: [item({ id: 'g2', state: 'expired', ended_at: '2026-09-24T10:00:00.000Z' })], next_cursor: 'CUR' }, { grants: [item({ id: 'g3', tab_name: 'web', state: 'expired', ended_at: '2026-09-23T10:00:00.000Z' })], next_cursor: null }]);
  render(<ChatGrantsView />);
  fireEvent.click(await screen.findByRole('button', { name: 'Carregar mais' }));
  expect(await screen.findByText('Aba web · termhub')).toBeInTheDocument();
  expect(listMock).toHaveBeenLastCalledWith({ state: 'ended', cursor: 'CUR' });
  expect(screen.getByText('Aba api · termhub')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Carregar mais' })).toBeNull();
});

it('Revogar revokes and reloads; a 409 counts as done', async () => {
  serve([item({ id: 'g1' })], [{ grants: [], next_cursor: null }]);
  revokeMock.mockRejectedValueOnce(new ApiError(409, 'Esta permissão já foi revogada'));
  render(<ChatGrantsView />);
  fireEvent.click(await screen.findByRole('button', { name: 'Revogar' }));
  await waitFor(() => expect(revokeMock).toHaveBeenCalledWith('g1'));
  await waitFor(() => expect(listMock).toHaveBeenCalledTimes(4));
  expect(screen.queryByText(/Não foi possível/)).toBeNull();
});

it('a failed load says so and retries', async () => {
  listMock.mockRejectedValueOnce(new Error('offline'));
  render(<ChatGrantsView />);
  expect(await screen.findByText('Não foi possível carregar as permissões.')).toBeInTheDocument();
  serve([], [{ grants: [], next_cursor: null }]);
  fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
  expect(await screen.findByText('Nenhuma aba confiável agora.')).toBeInTheDocument();
});
```

Run `DOCKER 'npx -w @termhub/web vitest run src/components/ChatGrantsView.test.tsx'` → FAIL (module missing).

- [ ] **Step 4: View** — `components/ChatGrantsView.tsx`:

```tsx
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import type { ChatGrantListItem } from '../lib/types';
import { untilLabel } from './chat/grant-time';
import { endedAtLabel, GRANT_STATE_LABEL, grantOriginLabel, grantTabLabel } from './chat/grant-list-text';

const LOAD_FAILED = 'Não foi possível carregar as permissões.';

const title = (g: ChatGrantListItem) => `${grantTabLabel(g)}${g.project_name ? ` · ${g.project_name}` : ''}`;

/**
 * "Abas confiáveis" (spec 2026-09-26 §4.2): what the chat was allowed to type into without asking, in
 * every conversation — the grants in force, with Revogar, and the paged history. Reads on open, after a
 * revoke and on "Carregar mais"; no live updates.
 */
export function ChatGrantsView() {
  const [active, setActive] = useState<ChatGrantListItem[] | null>(null);
  const [history, setHistory] = useState<ChatGrantListItem[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    setLoadFailed(false);
    try {
      const [a, h] = await Promise.all([api.listChatGrants({ state: 'active' }), api.listChatGrants({ state: 'ended' })]);
      setActive(a.grants);
      setHistory(h.grants);
      setNext(h.next_cursor);
    } catch {
      setLoadFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const loadMore = async () => {
    if (!next) return;
    setLoadingMore(true);
    setError(null);
    try {
      const h = await api.listChatGrants({ state: 'ended', cursor: next });
      setHistory((prev) => [...(prev ?? []), ...h.grants]);
      setNext(h.next_cursor);
    } catch {
      setError(LOAD_FAILED);
    } finally {
      setLoadingMore(false);
    }
  };

  const revoke = async (id: string) => {
    setRevokingId(id);
    setError(null);
    try {
      await api.revokeChatGrant(id);
    } catch (e) {
      // 409: already revoked (another screen, or a reset) — the list is stale, not wrong.
      if (!(e instanceof ApiError && e.status === 409)) {
        setError(e instanceof ApiError ? e.message : 'Não foi possível revogar a permissão.');
        setRevokingId(null);
        return;
      }
    }
    setRevokingId(null);
    await load();
  };

  if (loadFailed)
    return (
      <div className="space-y-2 text-sm">
        <p className="text-danger">{LOAD_FAILED}</p>
        <button type="button" className="btn-ghost" onClick={() => void load()}>
          Tentar de novo
        </button>
      </div>
    );
  if (active === null || history === null) return <p className="text-sm text-fg-dim">Carregando…</p>;

  return (
    <div className="max-w-3xl space-y-6">
      <p className="text-sm text-fg-muted">Abas em que o chat pode digitar sem pedir confirmação. Cada permissão vale para uma conversa, por até 24 horas.</p>
      {error && <p className="text-sm text-danger">{error}</p>}
      <section aria-labelledby="chat-grants-active" className="space-y-2">
        <h2 id="chat-grants-active" className="text-sm font-semibold text-fg">
          Ativas
        </h2>
        {active.length === 0 ? (
          <p className="text-sm text-fg-dim">Nenhuma aba confiável agora.</p>
        ) : (
          <ul className="space-y-2">
            {active.map((g) => (
              <li key={g.id} className="flex items-center justify-between gap-3 rounded-lg border border-line bg-bg-2 px-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-sm text-fg">{title(g)}</p>
                  <p className="text-xs text-fg-dim">{`${grantOriginLabel(g)} · ${untilLabel(g.expires_at)}`}</p>
                </div>
                <button type="button" className="btn-ghost shrink-0" disabled={revokingId === g.id} onClick={() => void revoke(g.id)}>
                  Revogar
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="chat-grants-history" className="space-y-2">
        <h2 id="chat-grants-history" className="text-sm font-semibold text-fg">
          Histórico
        </h2>
        {history.length === 0 ? (
          <p className="text-sm text-fg-dim">Nada no histórico ainda.</p>
        ) : (
          <ul className="space-y-2">
            {history.map((g) => (
              <li key={g.id} className="rounded-lg border border-line px-3 py-2">
                <p className="truncate text-sm text-fg">{title(g)}</p>
                <p className="text-xs text-fg-dim">{`${grantOriginLabel(g)} · ${GRANT_STATE_LABEL[g.state]}${g.ended_at ? ` em ${endedAtLabel(g.ended_at)}` : ''}`}</p>
              </li>
            ))}
          </ul>
        )}
        {next && (
          <button type="button" className="btn-ghost" disabled={loadingMore} onClick={() => void loadMore()}>
            Carregar mais
          </button>
        )}
      </section>
    </div>
  );
}
```

Run the view test → PASS. (If the "Revogar reloads" test counts calls differently because `load` runs twice under StrictMode — it does not in RTL `render` — adjust only the expected count, not the behaviour.)

- [ ] **Step 5: Settings section** — `lib/settings-sections.ts`: add `'chat-grants'` to the `SettingsSection` union and insert `{ key: 'chat-grants', label: 'Abas confiáveis', resource: 'chat', group: 'account' },` right after the `devices` entry. In `settings-sections.test.ts` insert `'account:chat-grants',` after `'account:devices',` in the order test and add:

```ts
  it('puts Abas confiáveis under Conta, gated by the chat resource', () => {
    expect(SETTINGS_SECTIONS.find((s) => s.key === 'chat-grants')).toEqual({ key: 'chat-grants', label: 'Abas confiáveis', resource: 'chat', group: 'account' });
    expect(visibleSettingsSections((r) => r === 'chat').map((s) => s.key)).toEqual(['profile', 'city', 'chat-grants']);
  });
```

`pages/SettingsPage.tsx`: `import { ChatGrantsView } from '../components/ChatGrantsView';` and a case before `'permissions'`:

```tsx
    case 'chat-grants':
      return (
        <PageFrame title={current.label}>
          <ChatGrantsView />
        </PageFrame>
      );
```

`pages/SettingsPage.test.tsx`: add `vi.mock('../components/ChatGrantsView', () => ({ ChatGrantsView: () => <p>chat-grants-view</p> }));` next to the other view mocks and a test mirroring "opens Integrações as a section" for `/settings/chat-grants` with a user who `can('chat')`, expecting the `chat-grants-view` text and a heading "Abas confiáveis" (read how that file builds `authState.current` and copy it).

- [ ] **Step 6: Run** — `DOCKER 'npx -w @termhub/web vitest run src/lib/settings-sections.test.ts src/pages/SettingsPage.test.tsx src/components/ChatGrantsView.test.tsx src/components/chat/grant-list-text.test.ts && npx -w @termhub/web tsc --noEmit -p tsconfig.json'`. Expected: PASS. (If the web package has a `typecheck` script, use `npm run typecheck -w @termhub/web` instead.)

- [ ] **Step 7: Commit** — `git add apps/web/src`; `git commit -m "Settings: list the chat's trusted tabs with revoke and history"`.

---

### Task 5: Web — strip out of the conversation, header link (TER-68, TER-97)

**Files:**
- Modify: `apps/web/src/components/chat/ChatPanel.tsx`, `apps/web/src/components/chat/ChatPanel.test.tsx`
- Delete: `apps/web/src/components/chat/ChatGrantStrip.tsx`, `apps/web/src/components/chat/ChatGrantStrip.test.tsx`

**Interfaces:**
- Consumes: `trustedTabsLabel` (Task 4), `isGrantActive`.

- [ ] **Step 1: Rewrite the three strip tests in `ChatPanel.test.tsx`**:
  - `'the strip from GET /chat revokes a grant'` → rename to `'shows how many tabs are trusted as a link to Configurações, and no strip'`:

```tsx
it('shows how many tabs are trusted as a link to Configurações, and no strip', async () => {
  chatMock.mockResolvedValue({ conversation: { id: 'c_p1', project_id: 'p1', ai_account_id: null }, messages: [], actions: [], host: READY, grants: [grant({ id: 'g1' }), grant({ id: 'g2', tab_id: 't2' }), grant({ id: 'g3', tab_id: 't3', expires_at: new Date(Date.now() - 1000).toISOString() })] });
  render(
    <MemoryRouter>
      <ChatPanel projectId="p1" />
    </MemoryRouter>,
  );
  expect(await screen.findByRole('link', { name: '2 abas confiáveis' })).toHaveAttribute('href', '/settings/chat-grants');
  expect(screen.queryByText(/Enviando direto para/)).toBeNull();
});

it('no link without an active grant', async () => {
  chatMock.mockResolvedValue({ conversation: { id: 'c_p1', project_id: 'p1', ai_account_id: null }, messages: [], actions: [], host: READY, grants: [] });
  render(
    <MemoryRouter>
      <ChatPanel projectId="p1" />
    </MemoryRouter>,
  );
  await waitFor(() => expect(chatMock).toHaveBeenCalled());
  expect(screen.queryByRole('link', { name: /aba(s)? confiáve/ })).toBeNull();
});
```

  - In `'"Permitir sempre nesta aba" on a pending card …'`: rename to `'… records the grant, shows it on the card and counts it in the header'` and replace `expect(await screen.findByText(/Enviando direto para a aba Terminal 1 até/)).toBeInTheDocument();` with `expect(await screen.findByRole('link', { name: '1 aba confiável' })).toBeInTheDocument();`.
  - In the events test: rename to `'a grant event adds to the header count, a grant_revoked removes it, …'`; replace every `screen.queryByText(/Enviando direto para/)` with `screen.queryByRole('link', { name: '1 aba confiável' })` and the `findByText(/Enviando direto para a aba Terminal 1 até/)` with `findByRole('link', { name: '1 aba confiável' })`.

Run `DOCKER 'npx -w @termhub/web vitest run src/components/chat/ChatPanel.test.tsx'` → FAIL (no link).

- [ ] **Step 2: Implement** in `ChatPanel.tsx`:
  - Remove `import { ChatGrantStrip } from './ChatGrantStrip';` and the `<ChatGrantStrip … />` line; add `import { trustedTabsLabel } from './grant-list-text';`.
  - Before the `return (`, add `const activeGrantCount = grants.filter((g) => isGrantActive(g)).length;`.
  - Replace the header row (`<div className="flex items-center justify-end pt-2">` … `Nova conversa` button) with:

```tsx
      {/* The conversation's trusted tabs used to be a strip above the box; now one link, only while any is
       *  in force, to the list in Configurações (spec 2026-09-26 §4.1). */}
      <div className="flex items-center justify-end gap-1 pt-2">
        {activeGrantCount > 0 && (
          <Link to="/settings/chat-grants" className="rounded px-2 py-1 text-xs text-fg-dim hover:bg-bg-3 hover:text-fg">
            {trustedTabsLabel(activeGrantCount)}
          </Link>
        )}
        <button type="button" className="rounded px-2 py-1 text-xs text-fg-dim hover:bg-bg-3 hover:text-fg disabled:opacity-50" disabled={answering || resetting || messages.length === 0} onClick={() => setConfirmReset(true)}>
          Nova conversa
        </button>
      </div>
```

  (keep the existing comment above the old row; `Link` is already imported.)
  - Update the `revoke` doc comment to `/** "Revogar", from the card that granted it. */` and its 409 comment to say "the list is stale, not wrong".
- `git rm apps/web/src/components/chat/ChatGrantStrip.tsx apps/web/src/components/chat/ChatGrantStrip.test.tsx`.
- `grep -rn ChatGrantStrip apps/web/src` must print nothing.

- [ ] **Step 3: Run** — `DOCKER 'npx -w @termhub/web vitest run src/components/chat src/pages/ChatPage.test.tsx'`. Expected: PASS.

- [ ] **Step 4: Commit** — `git add -A apps/web/src/components/chat`; `git commit -m "Chat: replace the trusted-tab strip with a header link"`.

---

### Task 6: App — API client and mock for the grant list (TER-71)

**Files:**
- Modify: `apps/mobile/src/services/api/types.ts`, `apps/mobile/src/services/api/client.ts`, `apps/mobile/src/services/api/contract/local.ts`, `apps/mobile/src/services/api/mock/state.ts`, `apps/mobile/src/services/api/mock/handlers/chat.ts`
- Test: `apps/mobile/src/services/api/mock/chat.e2e.test.ts`

**Interfaces:**
- Consumes: `chatGrantListResponse`, `chatGrantListQuery` (Task 3).
- Produces: `TChatGrantListItem`, `TChatGrantListResponse` (contract `local.ts`); `MobileApi.listGrants(auth: Auth, q: { state: 'active' | 'ended'; cursor?: string | null }): Promise<TChatGrantListResponse>`.

- [ ] **Step 1: Test** — append to `mock/chat.e2e.test.ts` (reuse its `enrol`, `START`, `decisionProof` helpers exactly as the approve_tab test does):

```ts
it('listGrants lists active and ended grants, newest first, paging the history', async () => {
  const clock = { value: START };
  const { api, auth, deviceId, secret } = await enrol(clock);
  expect(await api.listGrants(auth, { state: 'active' })).toEqual({ grants: [], next_cursor: null });

  const chal = await api.challenge({ device_id: deviceId, purpose: 'decision', action_id: 'a-termhub-1' });
  await api.decide(auth, 'a-termhub-1', { decision: 'approve_tab', challenge: chal.challenge, pin_proof: decisionProof(secret, chal.challenge, 'a-termhub-1', 'approve_tab') });
  const [active] = (await api.listGrants(auth, { state: 'active' })).grants;
  expect(active).toMatchObject({ tab_name: 'api', state: 'active', ended_at: null, conversation_project_name: 'termhub', conversation_archived: false });

  await api.revokeGrant(auth, active!.id);
  expect((await api.listGrants(auth, { state: 'active' })).grants).toEqual([]);
  const ended = await api.listGrants(auth, { state: 'ended' });
  expect(ended.grants).toEqual([expect.objectContaining({ id: active!.id, state: 'revoked' })]);
  expect(ended.next_cursor).toBeNull();
});
```

(If the mock project `p-termhub` is not named `termhub`, use its fixture name.) Run `DOCKER 'npm test -w @termhub/mobile -- src/services/api/mock/chat.e2e.test.ts'` → FAIL.

- [ ] **Step 2: Contract types** — `contract/local.ts`: add `chatGrantListItemSchema, chatGrantListResponse` to the import from `@termhub/mobile-api` and next to `TChatGrant`:

```ts
export type TChatGrantListItem = z.infer<typeof chatGrantListItemSchema>;
export type TChatGrantListResponse = z.infer<typeof chatGrantListResponse>;
```

- [ ] **Step 3: API** — `types.ts` next to `revokeGrant`: `listGrants(auth: Auth, q: { state: 'active' | 'ended'; cursor?: string | null }): Promise<TChatGrantListResponse>;` (import the type as the file imports the others). `client.ts` next to `revokeGrant`:

```ts
    listGrants: (a: Auth, q: { state: 'active' | 'ended'; cursor?: string | null }) =>
      call('GET', `/api/m/v1/chat/grants?state=${q.state}${q.cursor ? `&cursor=${encodeURIComponent(q.cursor)}` : ''}`, chatGrantListResponse, { token: a.accessToken }),
```

(import `chatGrantListResponse` with the other contract schemas.)

- [ ] **Step 4: Mock** — `mock/state.ts`: extend `MockGrant` with `revoked_at: string | null; revoked_by_user: boolean;` (doc: "when and whether a person revoked it — a reset revokes with `revoked_by_user: false`"). In `mock/handlers/chat.ts`:
  - `grantTab`: the loop that revokes older grants sets `g.revoked = true; g.revoked_at = new Date(now).toISOString(); g.revoked_by_user = true;`; the new grant gets `revoked_at: null, revoked_by_user: false`.
  - The reset handler (`for (const g of state.grants) if (g.conversation_id === previous.id) g.revoked = true;`) also sets `revoked_at` (to `new Date(ctx.now()).toISOString()`) and `revoked_by_user = false` for rows not already revoked.
  - The DELETE handler sets `revoked_at` and `revoked_by_user = true`.
  - Add, before the DELETE route:

```ts
/** The mock's `ChatGrantListItem`: same state rule as the server's `grantState`. */
function grantListItem(state: MockState, g: MockGrant, now: number): TChatGrantListItem {
  const expiresAt = Date.parse(g.expires_at);
  const revokedFirst = g.revoked && g.revoked_at !== null && Date.parse(g.revoked_at) < expiresAt;
  const s = revokedFirst ? (g.revoked_by_user ? 'revoked' : 'ended') : !g.revoked && expiresAt > now ? 'active' : 'expired';
  const conversation = state.conversations.get(g.conversation_id);
  const project = conversation?.project_id ? state.projects.get(conversation.project_id) : undefined;
  return {
    ...grantView(g),
    project_id: project?.id ?? null,
    project_name: project?.name ?? null,
    conversation_id: g.conversation_id,
    conversation_project_name: project?.name ?? null,
    conversation_archived: conversation?.archived_at != null,
    state: s,
    ended_at: s === 'active' ? null : s === 'expired' ? g.expires_at : g.revoked_at,
  };
}

  /** "Abas confiáveis": the server's paging (newest first, cursor = the last id of the page). */
  router.route('GET', '/api/m/v1/chat/grants', (ctx) => {
    verifyAuth(state, { headers: ctx.headers, htm: 'GET', htu: ctx.htu, now: ctx.now() });
    const q = chatGrantListQuery.parse(ctx.query);
    const now = ctx.now();
    const rows = [...state.grants].reverse().map((g) => grantListItem(state, g, now)).filter((g) => (q.state === 'active' ? g.state === 'active' : g.state !== 'active'));
    const start = q.state === 'ended' && q.cursor ? rows.findIndex((g) => g.id === q.cursor) + 1 : 0;
    const page = rows.slice(start, start + q.limit);
    const more = q.state === 'ended' && start + q.limit < rows.length;
    return { status: 200, body: { grants: page, next_cursor: more ? page[page.length - 1]!.id : null } };
  });
```

  (The mock's project for a grant is the conversation's project — enough for the app; import `chatGrantListQuery` and `TChatGrantListItem`. Check `ctx.query`'s type — `notifications.ts` reads `ctx.query.before` — and pass it to `parse` as is.)

- [ ] **Step 5: Run** — `DOCKER 'npm test -w @termhub/mobile -- src/services/api && npm run typecheck -w @termhub/mobile'`. Expected: PASS.

- [ ] **Step 6: Commit** — `git add apps/mobile/src/services`; `git commit -m "App: grant list in the API client and the mock"`.

---

### Task 7: App — "Abas confiáveis" screen and Ajustes entry (TER-71)

**Files:**
- Create: `apps/mobile/src/features/chat-grants/model/labels.ts`, `…/model/labels.test.ts`, `…/viewmodel/createChatGrantsStore.ts`, `…/viewmodel/createChatGrantsStore.test.ts`, `…/viewmodel/useChatGrantsStore.ts`, `…/view/chat-grants-screen.tsx`, `…/view/chat-grants-screen.test.tsx`, `apps/mobile/app/chat-grants.tsx`
- Modify: `apps/mobile/test/helpers/ui-stores.ts`, `apps/mobile/src/features/settings/view/settings-screen.tsx`, `apps/mobile/src/features/settings/view/settings-screen.test.tsx`

**Interfaces:**
- Consumes: `api.listGrants`, `api.revokeGrant` (Task 6); `untilLabel` from `@/features/chat/model/grant-time`.
- Produces: `createChatGrantsStore({ api, session })` → state `{ active: TChatGrantListItem[] | null; history: TChatGrantListItem[] | null; next: string | null; loading: boolean; loadingMore: boolean; revokingId: string | null; error: string | null; load(): Promise<void>; loadMore(): Promise<void>; revoke(id: string): Promise<void> }`; `trustedTabsLabel(n)` (used by Task 8).

- [ ] **Step 1: Labels** — `model/labels.ts` is a verbatim copy of the web's `grant-list-text.ts` (Task 4) with the first line `// Verbatim from apps/web/src/components/chat/grant-list-text.ts` and the type import changed to `import type { TChatGrantListItem as ChatGrantListItem } from '@/services/api/contract';` and `type ChatGrantState = ChatGrantListItem['state'];`. `labels.test.ts` is the web test translated to jest (`import { describe, expect, it } from '@jest/globals'` only if the other model tests do; otherwise globals).

- [ ] **Step 2: Store test first** — `viewmodel/createChatGrantsStore.test.ts`, modelled on `createSettingsStore.test.ts` (read it for how `api`/`session` fakes are built):

```ts
import { createChatGrantsStore } from './createChatGrantsStore';
import { ApiError } from '@/services/api/errors';

const item = (id: string, state: 'active' | 'expired' = 'active') => ({ id, tab_id: 't1', tool: 'send_input', source_action_id: null, created_at: '2026-09-25T10:00:00.000Z', expires_at: '2099-01-01T00:00:00.000Z', tab_name: 'api', project_id: null, project_name: null, conversation_id: 'c1', conversation_project_name: null, conversation_archived: false, state, ended_at: state === 'active' ? null : '2026-09-25T11:00:00.000Z' });

function setup(listGrants: jest.Mock, revokeGrant = jest.fn(async () => undefined)) {
  const api = { listGrants, revokeGrant } as never;
  const session = () => ({ auth: () => ({ accessToken: 'tok' }) as never, handleApiError: () => false });
  return { store: createChatGrantsStore({ api, session }), listGrants, revokeGrant };
}

it('load reads active and the first history page', async () => {
  const { store } = setup(jest.fn(async (_a, q: { state: string }) => (q.state === 'active' ? { grants: [item('g1')], next_cursor: null } : { grants: [item('g2', 'expired')], next_cursor: 'g2' })));
  await store.getState().load();
  expect(store.getState()).toMatchObject({ active: [{ id: 'g1' }], history: [{ id: 'g2' }], next: 'g2', loading: false, error: null });
});

it('loadMore appends with the cursor and stops at the end', async () => {
  const listGrants = jest.fn(async (_a, q: { state: string; cursor?: string }) => (q.state === 'active' ? { grants: [], next_cursor: null } : q.cursor ? { grants: [item('g3', 'expired')], next_cursor: null } : { grants: [item('g2', 'expired')], next_cursor: 'g2' }));
  const { store } = setup(listGrants);
  await store.getState().load();
  await store.getState().loadMore();
  expect(listGrants).toHaveBeenLastCalledWith(expect.anything(), { state: 'ended', cursor: 'g2' });
  expect(store.getState().history!.map((g) => g.id)).toEqual(['g2', 'g3']);
  expect(store.getState().next).toBeNull();
});

it('revoke needs no PIN, treats 409 as done, reloads, and ignores a second tap while busy', async () => {
  let release!: () => void;
  const revokeGrant = jest.fn(() => new Promise<void>((_res, rej) => { release = () => rej(new ApiError(409, 'CONFLICT', 'Esta permissão já foi revogada')); }));
  const listGrants = jest.fn(async () => ({ grants: [], next_cursor: null }));
  const { store } = setup(listGrants, revokeGrant);
  const first = store.getState().revoke('g1');
  void store.getState().revoke('g1');
  expect(revokeGrant).toHaveBeenCalledTimes(1);
  release();
  await first;
  expect(store.getState()).toMatchObject({ revokingId: null, error: null });
  expect(listGrants).toHaveBeenCalledTimes(2);
});
```

(Check `ApiError`'s constructor in `@/services/api/errors` and adapt the `new ApiError(...)` call to it.) Run `DOCKER 'npm test -w @termhub/mobile -- src/features/chat-grants'` → FAIL.

- [ ] **Step 3: Store** — `viewmodel/createChatGrantsStore.ts`:

```ts
// "Abas confiáveis" (spec 2026-09-26 §5): this user's chat grants, active and a paged history. A
// factory over injected services like the other feature stores; `useChatGrantsStore.ts` builds the
// app's one instance. Revoking needs no PIN: it only takes power away.
import { create } from 'zustand';
import { sessionEnded } from '@/features/shared/signals';
import type { TChatGrantListItem } from '@/services/api/contract';
import { ApiError, isApiError } from '@/services/api/errors';
import type { Auth, MobileApi } from '@/services/api/types';

export interface SessionApi {
  auth(): Auth;
  handleApiError(err: unknown): boolean;
}

export interface ChatGrantsDeps {
  api: MobileApi;
  session: () => SessionApi;
}

export interface ChatGrantsState {
  active: TChatGrantListItem[] | null;
  history: TChatGrantListItem[] | null;
  next: string | null;
  loading: boolean;
  loadingMore: boolean;
  revokingId: string | null;
  error: string | null;
  load(): Promise<void>;
  loadMore(): Promise<void>;
  revoke(id: string): Promise<void>;
}

const NETWORK_MSG = 'Não foi possível falar com o servidor. Tente de novo.';

export function createChatGrantsStore(deps: ChatGrantsDeps) {
  const { api, session } = deps;
  let generation = 0;
  const empty = { active: null, history: null, next: null, loading: false, loadingMore: false, revokingId: null, error: null };

  const store = create<ChatGrantsState>()((set, get) => {
    const fail = (gen: number, e: unknown) => {
      if (gen !== generation || session().handleApiError(e)) return;
      set({ loading: false, loadingMore: false, error: e instanceof ApiError ? e.message : NETWORK_MSG });
    };
    return {
      ...empty,

      async load() {
        const gen = generation;
        set({ loading: true, error: null });
        try {
          const auth = session().auth();
          const [a, h] = await Promise.all([api.listGrants(auth, { state: 'active' }), api.listGrants(auth, { state: 'ended' })]);
          if (gen !== generation) return;
          set({ active: a.grants, history: h.grants, next: h.next_cursor, loading: false });
        } catch (e) {
          fail(gen, e);
        }
      },

      async loadMore() {
        const { next, loadingMore } = get();
        if (!next || loadingMore) return;
        const gen = generation;
        set({ loadingMore: true, error: null });
        try {
          const h = await api.listGrants(session().auth(), { state: 'ended', cursor: next });
          if (gen !== generation) return;
          set((s) => ({ history: [...(s.history ?? []), ...h.grants], next: h.next_cursor, loadingMore: false }));
        } catch (e) {
          fail(gen, e);
        }
      },

      async revoke(id) {
        if (get().revokingId !== null) return;
        const gen = generation;
        set({ revokingId: id, error: null });
        try {
          await api.revokeGrant(session().auth(), id);
        } catch (e) {
          // 409: already revoked elsewhere — the list is stale, not wrong.
          if (!isApiError(e) || e.status !== 409) {
            if (gen === generation) set({ revokingId: null });
            return fail(gen, e);
          }
        }
        if (gen !== generation) return;
        set({ revokingId: null });
        await get().load();
      },
    };
  });

  sessionEnded.subscribe(() => {
    generation++;
    store.setState(empty);
  });

  return store;
}
```

(`isApiError`'s signature: see how `createChatStore.ts` uses `isApiError(e) && e.status === 409`; match it.) `viewmodel/useChatGrantsStore.ts`:

```ts
// The app's one grants store: the factory over the real API singleton and the session store.
import { api } from '@/services/api';
import { useSessionStore } from '@/features/session/viewmodel/useSessionStore';
import { createChatGrantsStore } from './createChatGrantsStore';

export const useChatGrantsStore = createChatGrantsStore({ api, session: () => useSessionStore.getState() });
```

In `test/helpers/ui-stores.ts` add `chatGrants: createChatGrantsStore({ api: ctx.api, session: () => ctx.store.getState() }),` to `stores` (with its import) and mention it in the header comment. Run store tests → PASS.

- [ ] **Step 4: Screen test** — `view/chat-grants-screen.test.tsx` (pattern of `settings-screen.test.tsx`: mock `useSessionStore`, `useChatGrantsStore` with the ui-stores instances, mock `expo-router` with `useRouter: () => mockRouter`, `enrolStores()` in `beforeAll`, `LOAD` timeout):

```tsx
it('lists nothing active and says so, then shows a grant made through the mock and revokes it without a PIN', async () => {
  await render(<ChatGrantsScreen />);
  expect(await screen.findByText('Nenhuma aba confiável agora.', undefined, LOAD)).toBeTruthy();
  expect(screen.getByText('Nada no histórico ainda.')).toBeTruthy();
});

it('shows an active grant with its origin and Revogar', async () => {
  jest.spyOn(stores.api, 'listGrants').mockImplementation(async (_a, q) => (q.state === 'active' ? { grants: [ACTIVE], next_cursor: null } : { grants: [], next_cursor: null }));
  const revoke = jest.spyOn(stores.api, 'revokeGrant').mockResolvedValue(undefined);
  await render(<ChatGrantsScreen />);
  expect(await screen.findByText('Aba api · termhub', undefined, LOAD)).toBeTruthy();
  expect(screen.getByText(/^Chat geral · até/)).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Revogar' }));
  expect(revoke).toHaveBeenCalledWith(expect.anything(), 'g1');
  expect(stores.store.getState().pinPrompt).toBeNull();
});

it('Voltar goes back', async () => {
  await render(<ChatGrantsScreen />);
  await fireEvent.press(screen.getByRole('button', { name: 'Voltar' }));
  expect(mockRouter.back).toHaveBeenCalled();
});
```

with `const ACTIVE = { id: 'g1', tab_id: 't-api', tool: 'send_input', source_action_id: null, created_at: '2026-09-25T10:00:00.000Z', expires_at: '2099-01-01T00:00:00.000Z', tab_name: 'api', project_id: 'p-termhub', project_name: 'termhub', conversation_id: 'c1', conversation_project_name: null, conversation_archived: false, state: 'active' as const, ended_at: null };` and `afterEach(() => jest.restoreAllMocks())`.

- [ ] **Step 5: Screen** — `view/chat-grants-screen.tsx`:

```tsx
import { useRouter } from 'expo-router';
import { useEffect } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { untilLabel } from '@/features/chat/model/grant-time';
import type { TChatGrantListItem } from '@/services/api/contract';
import { AppText, Banner, Button, Screen } from '@/ui';
import { endedAtLabel, GRANT_STATE_LABEL, grantOriginLabel, grantTabLabel } from '../model/labels';
import { useChatGrantsStore } from '../viewmodel/useChatGrantsStore';

const title = (g: TChatGrantListItem) => `${grantTabLabel(g)}${g.project_name ? ` · ${g.project_name}` : ''}`;

/** "Abas confiáveis" (spec 2026-09-26 §5): the phone's copy of the web list. Revogar needs no PIN. */
export function ChatGrantsScreen() {
  const router = useRouter();
  const { active, history, next, loadingMore, revokingId, error, load, loadMore, revoke } = useChatGrantsStore();

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Screen scroll>
      <View className="gap-6 pb-10">
        <View className="flex-row items-center gap-2">
          <Button label="Voltar" variant="ghost" onPress={() => router.back()} />
          <AppText variant="title" className="flex-1">
            Abas confiáveis
          </AppText>
        </View>
        <AppText variant="muted">Abas em que o chat pode digitar sem pedir confirmação. Cada permissão vale para uma conversa, por até 24 horas.</AppText>
        {error ? <Banner tone="danger" text={error} /> : null}
        {active === null || history === null ? (
          error ? <Button label="Tentar de novo" variant="secondary" onPress={() => void load()} /> : <ActivityIndicator />
        ) : (
          <>
            <View className="gap-2">
              <AppText variant="label">Ativas</AppText>
              {active.length === 0 ? (
                <AppText variant="muted">Nenhuma aba confiável agora.</AppText>
              ) : (
                active.map((g) => (
                  <View key={g.id} className="flex-row items-center justify-between gap-2 rounded-xl border border-app-border bg-app-surface2 px-3 py-2">
                    <View className="flex-1">
                      <AppText>{title(g)}</AppText>
                      <AppText variant="muted">{`${grantOriginLabel(g)} · ${untilLabel(g.expires_at)}`}</AppText>
                    </View>
                    <Button label="Revogar" variant="ghost" onPress={() => void revoke(g.id)} disabled={revokingId === g.id} />
                  </View>
                ))
              )}
            </View>
            <View className="gap-2">
              <AppText variant="label">Histórico</AppText>
              {history.length === 0 ? (
                <AppText variant="muted">Nada no histórico ainda.</AppText>
              ) : (
                history.map((g) => (
                  <View key={g.id} className="rounded-xl border border-app-border px-3 py-2">
                    <AppText>{title(g)}</AppText>
                    <AppText variant="muted">{`${grantOriginLabel(g)} · ${GRANT_STATE_LABEL[g.state]}${g.ended_at ? ` em ${endedAtLabel(g.ended_at)}` : ''}`}</AppText>
                  </View>
                ))
              )}
              {next ? <Button label="Carregar mais" variant="secondary" onPress={() => void loadMore()} disabled={loadingMore} /> : null}
            </View>
          </>
        )}
      </View>
    </Screen>
  );
}
```

(Check `@/ui` exports `Banner`; the conversation screen imports it from there. If `Screen`/`Button` props differ, follow `settings-screen.tsx`.) `apps/mobile/app/chat-grants.tsx`: `export { ChatGrantsScreen as default } from '@/features/chat-grants/view/chat-grants-screen';`.

- [ ] **Step 6: Ajustes** — in `settings-screen.tsx` import `useRouter` from `expo-router` and add, after the general chat's machine section, a section:

```tsx
        <Section title="Chat">
          <Button label="Abas confiáveis" variant="secondary" onPress={() => router.push('/chat-grants')} />
        </Section>
```

(If a `Section` titled "Chat" already exists — the host picker — put the button inside it instead of a new section.) In `settings-screen.test.tsx`, mock `expo-router` like `conversation-screen.test.tsx` does (`mockRouter`), and add `it('opens Abas confiáveis', …)` pressing the button and expecting `mockRouter.push` with `'/chat-grants'`.

- [ ] **Step 7: Run** — `DOCKER 'npm test -w @termhub/mobile -- src/features/chat-grants src/features/settings && npm run typecheck -w @termhub/mobile'`. Expected: PASS.

- [ ] **Step 8: Commit** — `git add apps/mobile`; `git commit -m "App: Abas confiáveis screen, reachable from Ajustes"`.

---

### Task 8: App — strip out of the conversation, header button (TER-71, TER-97)

**Files:**
- Modify: `apps/mobile/src/features/chat/view/conversation-screen.tsx`, `apps/mobile/src/features/chat/view/conversation-screen.test.tsx`
- Delete: `apps/mobile/src/features/chat/view/grants-strip.tsx`

**Interfaces:**
- Consumes: `trustedTabsLabel` from `@/features/chat-grants/model/labels` (Task 7), `isGrantActive`.

- [ ] **Step 1: Test** — in `conversation-screen.test.tsx` replace the test `'shows the active grant above the composer and on the card that granted it; Revogar calls revokeGrant'` with:

```tsx
  it('counts the active grant in the header, opens Abas confiáveis, and keeps the card\'s Revogar', async () => {
    serveChat((res) => ({ actions: withAction(res, { status: 'approved' }), grants: [GRANT] }));
    const revokeGrant = stubAction('revokeGrant');
    await render(<ConversationScreen />);
    const link = await screen.findByRole('button', { name: '1 aba confiável' }, LOAD);
    expect(screen.queryByText(/^Enviando direto para/)).toBeNull();
    await fireEvent.press(link);
    expect(mockRouter.push).toHaveBeenCalledWith('/chat-grants');
    const revoke = screen.getAllByRole('button', { name: 'Revogar' });
    expect(revoke).toHaveLength(1);
    await fireEvent.press(revoke[0]!);
    expect(revokeGrant).toHaveBeenCalledWith('g1');
  });

  it('shows no header button without an active grant', async () => {
    serveChat((res) => ({ actions: res.actions, grants: [] }));
    await render(<ConversationScreen />);
    await screen.findByText(SEEDED_USER, undefined, LOAD);
    expect(screen.queryByRole('button', { name: /aba(s)? confiáve/ })).toBeNull();
  });
```

Run `DOCKER 'npm test -w @termhub/mobile -- src/features/chat/view/conversation-screen.test.tsx'` → FAIL.

- [ ] **Step 2: Implement** — in `conversation-screen.tsx`: remove the `GrantsStrip` import and `<GrantsStrip … />`; import `trustedTabsLabel` from `@/features/chat-grants/model/labels`; compute `const activeGrantCount = useMemo(() => grants.filter((g) => isGrantActive(g)).length, [grants]);`; in the header row, before the "Nova conversa" button:

```tsx
          {activeGrantCount > 0 ? <Button label={trustedTabsLabel(activeGrantCount)} variant="ghost" onPress={() => router.push('/chat-grants')} /> : null}
```

`git rm apps/mobile/src/features/chat/view/grants-strip.tsx`; `grep -rn "grants-strip\|GrantsStrip" apps/mobile/src` prints nothing.

- [ ] **Step 3: Run** — `DOCKER 'npm test -w @termhub/mobile -- src/features/chat && npm run typecheck -w @termhub/mobile'`. Expected: PASS.

- [ ] **Step 4: Commit** — `git add -A apps/mobile/src/features/chat`; `git commit -m "App chat: replace the trusted-tab strip with a header button"`.

---

### Task 9: Server — re-inject every pending decision in one run; propose siblings together (TER-94)

**Files:**
- Modify: `apps/server/src/db/repositories/chat-actions.ts`, `apps/server/src/chat/service.ts`, `apps/server/src/chat/gate-runtime.ts`
- Test: `apps/server/src/db/repositories/chat-actions.db.test.ts`, `apps/server/src/chat/service.test.ts`, `apps/server/src/mcp/gate.e2e.test.ts` (only if it asserts the PENDING text)

**Interfaces:**
- Produces: `ChatActionsRepository.listToInject(conversationId: string, excludeIds?: string[], limit?: number): Promise<ChatAction[]>`; `ChatService.resumeAfterDecision(user, action)` unchanged signature, now injecting `action` plus the rest of `listToInject`.

- [ ] **Step 1: DB test** — in `chat-actions.db.test.ts` (read how it creates rows and decides them; reuse its helpers), add: three rows in one conversation decided in order (approve, deny, approve), one of them already `markInjected`, one grant-run row (`insertApproved` with `grant_id`) → `listToInject(conversationId)` returns the two undecided-injection user decisions ordered by `decided_at`; `listToInject(conversationId, [firstId])` excludes it; `limit` caps.

- [ ] **Step 2: Repo** — in `chat-actions.ts` next to `findNextToInject`:

```ts
  /** Every decided-but-uninjected user decision of a conversation, oldest decision first (spec
   * 2026-09-26 §7.2): re-injection takes them all in one run instead of one per run. */
  async listToInject(conversationId: string, excludeIds: string[] = [], limit = 20): Promise<ChatAction[]> {
    const rows = await this.db.chatAction.findMany({
      where: {
        conversationId,
        status: { in: ['approved', 'denied'] satisfies ChatActionStatus[] },
        injectedAt: null,
        grantId: null,
        ...(excludeIds.length ? { id: { notIn: excludeIds } } : {}),
      },
      orderBy: [{ decidedAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });
    return rows.map(mapAction);
  }
```

Also add `markInjectedMany(ids: string[])` (`updateMany({ where: { id: { in: ids } }, data: { injectedAt: new Date() } })`). Run the DB test → PASS.

- [ ] **Step 3: Service tests** — in `service.test.ts` read the existing `resumeAfterDecision` / drain tests (search `markInjected`, `findNextToInject`, `injectionText`/`O usuário autorizou`). Add to the fake repos `listToInject: vi.fn(async () => [])` and `markInjectedMany: vi.fn(async () => undefined)`. New tests:
  - one decision, nothing else waiting → the injected text is exactly today's sentence (assert with the existing expectation) and `markInjectedMany` is called with `[action.id]`.
  - `listToInject` returns two more rows (one approved, one denied) → one `send`/run whose text starts with `O usuário decidiu 3 ações pendentes de uma vez.`, contains `Autorizou: send_input em`, `Recusou: move_task em`, ends with the instruction sentence, and `markInjectedMany` receives all three ids; `listToInject` was called with `(conversationId, [action.id])`.
  - the drain: `findNextToInject` returns a row and `listToInject` returns another → one run with both, both marked.
  - with a fresh session (no `cli_session_id`), each approved line carries `Refaça exatamente esta chamada` with its args.

- [ ] **Step 4: Service** — in `service.ts`:
  - Add, after `GRANT_NOTE`:

```ts
/** Several decisions at once (a batch, or single clicks that queued behind a busy run): one line each,
 * then one instruction — spec 2026-09-26 §7.2. One decision keeps `injectionText`'s own sentence. */
const batchInjectionText = (actions: ChatAction[], freshSession: boolean, summaries: Map<string, string>): string => {
  const sessionNote = freshSession ? ' A sessão de trabalho anterior não está mais disponível, então esta é uma nova sessão, sem o histórico da conversa anterior.' : '';
  const lines = actions.map((a) =>
    a.status === 'denied' ? `- Recusou: ${a.tool} em ${targetDescription(a)}.` : `- Autorizou: ${a.tool} em ${targetDescription(a)}.${freshSession ? approvedProposal(a, summaries.get(a.id)) : ''}`,
  );
  return `O usuário decidiu ${actions.length} ações pendentes de uma vez.${sessionNote}\n${lines.join('\n')}\nSiga com as autorizadas, refazendo cada chamada com os mesmos argumentos; não faça as recusadas e explique ao usuário o que ficou sem fazer.`;
};
```

  - Replace `injectionFor(user, action, freshSession)` with `injectionFor(user, actions: ChatAction[], freshSession)`: for one action return exactly what the old method returned; for several, look up grants for the approved ones (`findActiveBySourceAction`) and append `GRANT_NOTE` once if any; on a fresh session build `summaries` from one `describeActions(this.deps.repos, actions, user.id)` call.
  - `resumeAfterDecision(user, action)`: after the archived check, `const rest = await this.deps.repos.chatActions.listToInject(conversation.id, [action.id]); const batch = [action, ...rest];` then `sendIn(..., await this.injectionFor(user, batch, …), { beforeRun: () => this.deps.repos.chatActions.markInjectedMany(batch.map((a) => a.id)) })`.
  - `drainNextDecision`: after `next` is found, `const batch = [next, ...(await this.deps.repos.chatActions.listToInject(conversation.id, [...this.unmarkable, next.id]))];`, inject `batch`, and in `beforeRun` mark `batch` with `markInjectedMany`, adding every id of `batch` to `this.unmarkable` on failure. Update the two doc comments ("Injects at most one" → "Injects every decided-but-uninjected action in one run, starting from the oldest") without losing their other reasoning.
  - Keep `markInjected` (other callers/tests may use it); remove it only if nothing references it any more.

- [ ] **Step 5: Gate wording** — in `gate-runtime.ts` replace `PENDING` with:

```ts
const PENDING = (tool: string) =>
  `Ação pendente de confirmação: o usuário precisa aprovar a ferramenta ${tool} no chat e nada foi executado. Não repita a chamada nem tente outro caminho. Se o mesmo pedido do usuário precisa de outras ações independentes desta, proponha todas agora, nesta mesma resposta: elas aparecem juntas numa só confirmação. Depois diga a ele que está aguardando a confirmação e pare. Quando ele decidir, você será avisado e poderá repetir as chamadas autorizadas.`;
```

  Update any test that asserts the old PENDING text (`grep -rn "Não repita a chamada, não tente outro caminho e não faça mais nada" apps/server/src`).

- [ ] **Step 6: Run** — `DOCKER 'npx -w @termhub/server vitest run src/chat src/db/repositories/chat-actions.db.test.ts src/mcp src/routes/chat.test.ts src/routes/m-chat.test.ts && npm run typecheck -w @termhub/server'`. Expected: PASS.

- [ ] **Step 7: Commit** — `git commit -am "Chat: re-inject every pending decision in one run"` (add new test files explicitly if any).

---

### Task 10: Server — `decideMany` and the web batch route (TER-94)

**Files:**
- Create: `apps/server/src/chat/decisions.ts`, `apps/server/src/chat/decisions.test.ts`
- Modify: `apps/server/src/routes/chat.ts`, `apps/server/src/routes/chat.test.ts`

**Interfaces:**
- Consumes: `repos.chatActions.findByIdForUser`, `repos.chatActions.decide(id, userId, status)`, `chatBus`, `ChatService.resumeAfterDecision` (Task 9).
- Produces:
  ```ts
  export type BatchItem = { id: string; decision: 'approve' | 'deny' };
  export type Skipped = { id: string; reason: 'not_found' | 'already_decided' };
  export async function pendingBatch(repos: Repositories, userId: string, ids: string[]): Promise<{ pending: ChatAction[]; skipped: Skipped[] }>
  export async function decideMany(repos: Repositories, userId: string, items: BatchItem[]): Promise<{ decided: ChatAction[]; skipped: Skipped[] }>
  ```
  HTTP: `POST /api/chat/actions/decisions` `{ decisions: BatchItem[] }` (1..20, unique ids) → `{ actions, skipped, message? , queued?, note? }`.

- [ ] **Step 1: Tests** — `chat/decisions.test.ts`:

```ts
import { expect, it, vi } from 'vitest';
import { chatBus, type ChatEvent } from './bus.js';
import { decideMany, pendingBatch } from './decisions.js';
import { HttpError } from '../lib/errors.js';

const row = (id: string, over: Record<string, unknown> = {}) => ({ id, conversation_id: 'c1', status: 'pending', tool: 'move_task', args: {}, class: 'write', ...over });

function repos(rows: Record<string, ReturnType<typeof row>>) {
  return {
    chatActions: {
      findByIdForUser: vi.fn(async (id: string) => rows[id]),
      decide: vi.fn(async (id: string, _u: string, status: string) => (rows[id]?.status === 'pending' ? { ...rows[id], status } : undefined)),
    },
  } as never;
}

it('decides each pending row, publishes each decision, and reports what it skipped', async () => {
  const r = repos({ a1: row('a1'), a2: row('a2', { status: 'approved' }) });
  const events: ChatEvent[] = [];
  const off = chatBus.subscribe((e) => events.push(e));
  try {
    const res = await decideMany(r, 'u1', [{ id: 'a1', decision: 'approve' }, { id: 'a2', decision: 'deny' }, { id: 'nope', decision: 'deny' }]);
    expect(res.decided.map((a) => [a.id, a.status])).toEqual([['a1', 'approved']]);
    expect(res.skipped).toEqual([{ id: 'a2', reason: 'already_decided' }, { id: 'nope', reason: 'not_found' }]);
  } finally {
    off();
  }
  expect(events).toContainEqual(expect.objectContaining({ type: 'decision', action_id: 'a1', status: 'approved', conversation_id: 'c1' }));
});

it('refuses ids of two conversations before deciding anything', async () => {
  const r = repos({ a1: row('a1'), b1: row('b1', { conversation_id: 'c2' }) });
  await expect(decideMany(r, 'u1', [{ id: 'a1', decision: 'approve' }, { id: 'b1', decision: 'approve' }])).rejects.toMatchObject({ status: 400, code: 'MIXED_CONVERSATIONS' });
  expect((r as unknown as { chatActions: { decide: ReturnType<typeof vi.fn> } }).chatActions.decide).not.toHaveBeenCalled();
});

it('409 when nothing is left to decide', async () => {
  const r = repos({ a1: row('a1', { status: 'denied' }) });
  await expect(decideMany(r, 'u1', [{ id: 'a1', decision: 'approve' }])).rejects.toBeInstanceOf(HttpError);
});

it('pendingBatch splits pending rows from the rest, owner-scoped', async () => {
  const r = repos({ a1: row('a1'), a2: row('a2', { status: 'expired' }) });
  expect(await pendingBatch(r, 'u1', ['a1', 'a2', 'x'])).toEqual({ pending: [expect.objectContaining({ id: 'a1' })], skipped: [{ id: 'a2', reason: 'already_decided' }, { id: 'x', reason: 'not_found' }] });
});
```

Run → FAIL (module missing).

- [ ] **Step 2: Implement** `chat/decisions.ts`:

```ts
import type { ChatAction } from '../db/repositories/chat-actions.js';
import type { Repositories } from '../db/repositories/index.js';
import { conflict, HttpError } from '../lib/errors.js';
import { chatBus } from './bus.js';

/** One line of a grouped confirmation (spec 2026-09-26 §7): approve or deny — "Permitir sempre nesta
 * aba" is not batchable. */
export type BatchItem = { id: string; decision: 'approve' | 'deny' };
export type Skipped = { id: string; reason: 'not_found' | 'already_decided' };

/**
 * The rows of a batch that can still be decided, read owner-scoped one by one (a batch is ≤ 20). A
 * batch belongs to one conversation — its decisions are injected there in one sentence — so ids of
 * two conversations are refused before anything is decided.
 */
export async function pendingBatch(repos: Repositories, userId: string, ids: string[]): Promise<{ pending: ChatAction[]; skipped: Skipped[] }> {
  const rows = await Promise.all(ids.map((id) => repos.chatActions.findByIdForUser(id, userId)));
  const found = rows.filter((r): r is ChatAction => r !== undefined);
  if (new Set(found.map((r) => r.conversation_id)).size > 1) throw new HttpError(400, 'As ações precisam ser da mesma conversa', 'MIXED_CONVERSATIONS');
  const pending: ChatAction[] = [];
  const skipped: Skipped[] = [];
  ids.forEach((id, i) => {
    const r = rows[i];
    if (!r) skipped.push({ id, reason: 'not_found' });
    else if (r.status !== 'pending') skipped.push({ id, reason: 'already_decided' });
    else pending.push(r);
  });
  return { pending, skipped };
}

/** Decides a batch: each row conditionally, like the single route (a race ends in `already_decided`),
 * each decision published so every open screen sees it. Nothing decided at all is a 409. */
export async function decideMany(repos: Repositories, userId: string, items: BatchItem[]): Promise<{ decided: ChatAction[]; skipped: Skipped[] }> {
  const { pending, skipped } = await pendingBatch(repos, userId, items.map((i) => i.id));
  const decisionOf = new Map(items.map((i) => [i.id, i.decision]));
  const decided: ChatAction[] = [];
  for (const row of pending) {
    const status = decisionOf.get(row.id) === 'deny' ? 'denied' : 'approved';
    const action = await repos.chatActions.decide(row.id, userId, status);
    if (!action) {
      skipped.push({ id: row.id, reason: 'already_decided' });
      continue;
    }
    decided.push(action);
    chatBus.publish({ type: 'decision', user_id: userId, conversation_id: action.conversation_id, action_id: action.id, status });
  }
  if (decided.length === 0) throw conflict('Estas ações já foram decididas');
  return { decided, skipped };
}
```

(Check `chatBus.publish`'s `decision` event fields in `bus.ts` and the `decide` signature/`status` type; cast `status` as the single route does.) Run → PASS.

- [ ] **Step 3: Route test** — in `routes/chat.test.ts` add:

```ts
it('POST /chat/actions/decisions decides the batch and resumes the conversation once', async () => {
  const rows: Record<string, typeof pendingAction & { status: string }> = { a1: { ...pendingAction, id: 'a1', status: 'pending' }, a2: { ...pendingAction, id: 'a2', status: 'pending' } };
  const findByIdForUser = vi.fn(async (id: string) => rows[id]);
  const decide = vi.fn(async (id: string, _u: string, status: string) => ({ ...rows[id], status }));
  const { app, resumeAfterDecision } = build({ findByIdForUser, decide });
  const res = await app.inject({ method: 'POST', url: '/chat/actions/decisions', payload: { decisions: [{ id: 'a1', decision: 'approve' }, { id: 'a2', decision: 'deny' }] } });
  expect(res.statusCode).toBe(200);
  expect(decide).toHaveBeenCalledWith('a1', 'u1', 'approved');
  expect(decide).toHaveBeenCalledWith('a2', 'u1', 'denied');
  expect(resumeAfterDecision).toHaveBeenCalledTimes(1);
  expect(res.json()).toMatchObject({ actions: [{ id: 'a1', status: 'approved' }, { id: 'a2', status: 'denied' }], skipped: [] });
});

it('POST /chat/actions/decisions validates the body', async () => {
  const { app, decide } = build();
  for (const payload of [{}, { decisions: [] }, { decisions: [{ id: 'a1', decision: 'approve_tab' }] }, { decisions: [{ id: 'a1', decision: 'approve' }, { id: 'a1', decision: 'deny' }] }, { decisions: Array.from({ length: 21 }, (_, i) => ({ id: `a${i}`, decision: 'deny' })) }]) {
    expect((await app.inject({ method: 'POST', url: '/chat/actions/decisions', payload })).statusCode).toBe(400);
  }
  expect(decide).not.toHaveBeenCalled();
});

it('POST /chat/actions/decisions answers queued when a run holds the conversation', async () => {
  const findByIdForUser = vi.fn(async (id: string) => ({ ...pendingAction, id, status: 'pending' }));
  const resumeAfterDecision = vi.fn(async () => {
    throw new HttpError(409, 'ocupado', 'CHAT_BUSY');
  });
  const { app } = build({ findByIdForUser, resumeAfterDecision });
  const res = await app.inject({ method: 'POST', url: '/chat/actions/decisions', payload: { decisions: [{ id: 'a1', decision: 'approve' }] } });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({ queued: true });
});
```

- [ ] **Step 4: Route** — in `routes/chat.ts`:

```ts
const batchBody = z.object({
  decisions: z
    .array(z.object({ id: z.string().min(1).max(64), decision: z.enum(['approve', 'deny']) }))
    .min(1)
    .max(20)
    .refine((d) => new Set(d.map((x) => x.id)).size === d.length, 'Ações repetidas'),
});
```

and after the single decision route:

```ts
  /** A grouped confirmation (spec 2026-09-26 §7): the batch decided at once and injected as one sentence. */
  app.post('/actions/decisions', { config: { action: 'create' } }, async (request) => {
    const { decisions } = batchBody.parse(request.body);
    const user = request.scope.user;
    const { decided, skipped } = await decideMany(repos, user.id, decisions);
    try {
      const message = await deps.service.resumeAfterDecision(user, decided[0]!);
      return { actions: decided, skipped, message };
    } catch (err) {
      if (err instanceof HttpError && err.code === 'CHAT_BUSY') return { actions: decided, skipped, queued: true, note: QUEUED_NOTE };
      throw err;
    }
  });
```

(`import { decideMany } from '../chat/decisions.js';`. The single route has no `config.action` today — it defaults to `create` for POST; keep the explicit `create` here.)

- [ ] **Step 5: Run** — `DOCKER 'npx -w @termhub/server vitest run src/chat/decisions.test.ts src/routes/chat.test.ts && npm run typecheck -w @termhub/server'`. Expected: PASS.

- [ ] **Step 6: Commit** — `git add apps/server/src/chat/decisions.ts apps/server/src/chat/decisions.test.ts apps/server/src/routes/chat.ts apps/server/src/routes/chat.test.ts`; `git commit -m "Chat: decide a batch of confirmations in one request"`.

---

### Task 11: Server — phone batch route with one proof per approval (TER-94)

**Files:**
- Modify: `packages/mobile-api/src/chat.ts`, `packages/mobile-api/src/chat.test.ts`, `apps/server/src/routes/m-chat.ts`, `apps/server/src/routes/m-chat.test.ts`

**Interfaces:**
- Consumes: `pendingBatch`, `decideMany` (Task 10); the session's `consumeDecisionChallenge` / `checkPin`; `decisionProofMessage`.
- Produces (mobile-api): `mobileBatchDecisionBody` = `{ decisions: ({ id, decision: 'deny' } | { id, decision: 'approve', challenge, pin_proof })[] }` (1..20, unique ids). HTTP: `POST /api/m/v1/chat/actions/decisions` → `{ actions, skipped, queued: true, note }`.

- [ ] **Step 1: Contract** — in `packages/mobile-api/src/chat.ts`:

```ts
/** A grouped confirmation from the phone (spec 2026-09-26 §7): every approval carries its own proof,
 * bound to that action and the word `approve`, exactly like a single decision. */
export const mobileBatchDecisionBody = z.object({
  decisions: z
    .array(
      z.discriminatedUnion('decision', [
        z.object({ id: z.string().min(1).max(64), decision: z.literal('deny') }),
        z.object({ id: z.string().min(1).max(64), decision: z.literal('approve'), challenge: z.string().min(1).max(128), pin_proof: z.string().min(1).max(128) }),
      ]),
    )
    .min(1)
    .max(20)
    .refine((d) => new Set(d.map((x) => x.id)).size === d.length, 'Ações repetidas'),
});
```

Add a parse test in `chat.test.ts` (accepts deny-only and approve-with-proof; rejects approve without proof, `approve_tab`, duplicates, empty). `DOCKER 'npx -w @termhub/mobile-api vitest run && npm run build -w @termhub/mobile-api'`.

- [ ] **Step 2: Route tests** — in `m-chat.test.ts`, a `describe('batch decisions', …)`:
  - happy path: two pending rows (`findByIdForUser` fake keyed by id), one approve with proof, one deny → 200 `{ queued: true }`, `consumeDecisionChallenge` called once with the approve id, `checkPin` once with `decisionProofMessage(challenge, id, 'approve')`, `decide` for both, `resumeAfterDecision` once.
  - wrong PIN on the second of two approvals → 401 `{ code: 'PIN_INVALID' }` and `decide` **never called**.
  - challenge refused (`consumeDecisionChallenge` → false) → 400 `CHALLENGE_INVALID`, nothing decided.
  - an approve for a row that is no longer pending is skipped without spending its challenge; deny-only batch never calls `checkPin`.
  - mixed conversations → 400 `MIXED_CONVERSATIONS`, no challenge consumed.

- [ ] **Step 3: Route** — in `routes/m-chat.ts`:
  - Extract the proof check of the single route into a local helper and use it there unchanged in behaviour:

```ts
/** Consumes the decision challenge bound to one action and checks the PIN proof over it. Answers the
 * way `POST /session/token` does on failure (sent here, so the caller just stops) and returns false;
 * true when the proof is good. */
async function proofOk(deps: MobileChatDeps, request: FastifyRequest, reply: FastifyReply, device: Device, actionId: string, decision: PinDecision, proof: { challenge: string; pin_proof: string }): Promise<boolean> {
  if (!(await deps.session.consumeDecisionChallenge(device, proof.challenge, actionId))) throw new HttpError(400, 'Desafio inválido ou expirado', 'CHALLENGE_INVALID');
  const pin = await deps.session.checkPin(device, decisionProofMessage(proof.challenge, actionId, decision), proof.pin_proof, { ip: request.ip });
  if (pin.ok) return true;
  if (pin.code === 'DEVICE_LOCKED') {
    reply.header('retry-after', Math.ceil(pin.retryAfterMs / 1000));
    throw new DeviceLockedError(pin.retryAfterMs);
  }
  if (pin.code === 'PIN_INVALID') {
    const err = new PinInvalidError(pin.failures);
    await reply.code(401).send({ error: err.message, code: err.code, failures: err.failures });
    return false;
  }
  throw deviceRevoked();
}
```

  (Import `FastifyReply` and the `PinDecision` type from `@termhub/mobile-api` — check its export name in `proofs.ts`.) The single route becomes `if (!(await proofOk(deps, request, reply, device, id, body.decision, body))) return reply;` in place of its inline block.
  - The batch route:

```ts
  /**
   * A grouped confirmation from the phone (spec 2026-09-26 §7). Every approval is proven like a single
   * one — pending first, then its challenge, then its PIN proof — and all of them before anything is
   * decided, so a wrong PIN leaves the whole batch pending. Then one `decideMany` and one resumed run,
   * in the background like the single route.
   */
  app.post('/actions/decisions', { config: { action: 'create' } }, async (request, reply) => {
    const { decisions } = mobileBatchDecisionBody.parse(request.body);
    const user = request.scope.user;
    const { pending } = await pendingBatch(repos, user.id, decisions.map((d) => d.id));
    const stillPending = new Set(pending.map((p) => p.id));
    const approvals = decisions.filter((d): d is Extract<typeof d, { decision: 'approve' }> => d.decision === 'approve' && stillPending.has(d.id));
    if (approvals.length > 0) {
      const device = deviceOf(request);
      for (const a of approvals) if (!(await proofOk(deps, request, reply, device, a.id, 'approve', a))) return reply;
    }
    const { decided, skipped } = await decideMany(repos, user.id, decisions.map((d) => ({ id: d.id, decision: d.decision })));
    const first = decided[0]!;
    void Promise.resolve()
      .then(() => deps.chat.resumeAfterDecision(user, first))
      .catch((err) => request.log.warn({ code: failureLabel(err), actionId: first.id }, 'mobile batch resume failed'));
    return { actions: decided, skipped, queued: true, note: DECISION_NOTE };
  });
```

  (Import `mobileBatchDecisionBody` and `pendingBatch, decideMany` from `../chat/decisions.js`.)

- [ ] **Step 4: Run** — `DOCKER 'npx -w @termhub/server vitest run src/routes/m-chat.test.ts src/chat && npm run typecheck -w @termhub/server'`. Expected: PASS (the existing single-decision tests too).

- [ ] **Step 5: Commit** — `git add packages/mobile-api/src apps/server/src/routes/m-chat.ts apps/server/src/routes/m-chat.test.ts`; `git commit -m "Mobile API: decide a batch with one PIN proof per approval"`.

---

### Task 12: Web — grouped confirmation card (TER-94)

**Files:**
- Modify: `apps/web/src/lib/chat-timeline.ts`, `apps/web/src/lib/chat-timeline.test.ts`, `apps/web/src/lib/api.ts`, `apps/web/src/components/chat/ChatPanel.tsx`, `apps/web/src/components/chat/ChatPanel.test.tsx`
- Create: `apps/web/src/components/chat/ChatActionGroup.tsx`, `apps/web/src/components/chat/ChatActionGroup.test.tsx`

**Interfaces:**
- Consumes: `POST /api/chat/actions/decisions` (Task 10).
- Produces: `groupPendingActions(entries: ChatEntry[]): ChatEntry[]` adding `{ kind: 'action_group'; at: string; actions: ChatAction[] }` to `ChatEntry`; `api.decideChatActions(decisions: { id: string; decision: 'approve' | 'deny' }[])`; `ChatActionGroup` props `{ actions: ChatAction[]; deciding: boolean; onDecide(decisions: { id: string; decision: 'approve' | 'deny' }[]): void; onShowSeparately(): void }`.

- [ ] **Step 1: Timeline test** — in `chat-timeline.test.ts`:

```ts
describe('groupPendingActions', () => {
  it('leaves a single pending card alone', () => { /* entries with one pending action → unchanged */ });
  it('replaces two or more pending cards with one group at the oldest one\'s place, keeping decided cards', () => {
    // build entries: message m1, pending a1, decided a2, message m2, pending a3
    // expect kinds: message, action_group(a1,a3), action(a2), message
  });
});
```

Write both with real fixtures (reuse the file's action/message builders). Implementation in `chat-timeline.ts`:

```ts
export type ChatEntry =
  | { kind: 'message'; at: string; message: ChatMessage }
  | { kind: 'action'; at: string; action: ChatAction }
  | { kind: 'action_group'; at: string; actions: ChatAction[] }
  | { kind: 'tab_question'; at: string; question: TabQuestion }
  | { kind: 'tab_suggestion'; at: string; suggestion: TabSuggestion };

/** Two or more pending gate cards become one grouped confirmation, where the oldest of them was (spec
 * 2026-09-26 §7.1): while cards wait the concierge has stopped, so they are one request's worth. */
export function groupPendingActions(entries: ChatEntry[]): ChatEntry[] {
  const pending = entries.flatMap((e) => (e.kind === 'action' && e.action.status === 'pending' ? [e.action] : []));
  if (pending.length < 2) return entries;
  let placed = false;
  return entries.flatMap((e): ChatEntry[] => {
    if (e.kind !== 'action' || e.action.status !== 'pending') return [e];
    if (placed) return [];
    placed = true;
    return [{ kind: 'action_group', at: e.at, actions: pending }];
  });
}
```

(Any `switch` over `entry.kind` elsewhere must now handle `action_group`; the typecheck will say where.)

- [ ] **Step 2: Group card test** — `ChatActionGroup.test.tsx`:

```tsx
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatActionGroup } from './ChatActionGroup';
import type { ChatAction } from '../../lib/types';

afterEach(() => cleanup());

const action = (id: string, over: Partial<ChatAction> = {}): ChatAction => ({ id, tool: 'move_task', args: {}, class: 'write', status: 'pending', machine_id: null, project_id: null, tab_id: null, summary: `mover o card ${id}`, created_at: '2026-09-26T00:00:00.000Z', ...over }) as ChatAction;

it('lists every action, checks writes and leaves irreversible ones unchecked', () => {
  render(<ChatActionGroup actions={[action('a1'), action('a2', { class: 'irreversible', summary: 'apagar o card X' })]} deciding={false} onDecide={vi.fn()} onShowSeparately={vi.fn()} />);
  expect(screen.getByText('2 ações aguardando sua confirmação')).toBeInTheDocument();
  expect(screen.getByRole('checkbox', { name: 'mover o card a1' })).toBeChecked();
  expect(screen.getByRole('checkbox', { name: /apagar o card X/ })).not.toBeChecked();
  expect(screen.getByText('irreversível')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Aprovar selecionadas (1)' })).toBeEnabled();
});

it('approves the checked ones and denies the unchecked ones in one call', () => {
  const onDecide = vi.fn();
  render(<ChatActionGroup actions={[action('a1'), action('a2'), action('a3')]} deciding={false} onDecide={onDecide} onShowSeparately={vi.fn()} />);
  fireEvent.click(screen.getByRole('checkbox', { name: 'mover o card a2' }));
  expect(screen.getByText('As desmarcadas serão recusadas.')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Aprovar selecionadas (2)' }));
  expect(onDecide).toHaveBeenCalledWith([{ id: 'a1', decision: 'approve' }, { id: 'a2', decision: 'deny' }, { id: 'a3', decision: 'approve' }]);
});

it('Recusar todas denies every one; nothing checked disables approving; Ver separadas asks for the cards', () => {
  const onDecide = vi.fn();
  const onShowSeparately = vi.fn();
  render(<ChatActionGroup actions={[action('a1', { class: 'irreversible' }), action('a2', { class: 'irreversible' })]} deciding={false} onDecide={onDecide} onShowSeparately={onShowSeparately} />);
  expect(screen.getByRole('button', { name: 'Aprovar selecionadas (0)' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Recusar todas' }));
  expect(onDecide).toHaveBeenCalledWith([{ id: 'a1', decision: 'deny' }, { id: 'a2', decision: 'deny' }]);
  fireEvent.click(screen.getByRole('button', { name: 'Ver separadas' }));
  expect(onShowSeparately).toHaveBeenCalled();
});

it('disables everything while deciding', () => {
  render(<ChatActionGroup actions={[action('a1'), action('a2')]} deciding onDecide={vi.fn()} onShowSeparately={vi.fn()} />);
  expect(screen.getByRole('button', { name: 'Recusar todas' })).toBeDisabled();
});
```

- [ ] **Step 3: Group card** — `ChatActionGroup.tsx`:

```tsx
import { useState } from 'react';
import type { ChatAction } from '../../lib/types';

export type BatchDecision = { id: string; decision: 'approve' | 'deny' };

/**
 * Several pending gate cards as one confirmation (spec 2026-09-26 §7.1). Writes start checked,
 * irreversible actions unchecked; what is left unchecked is denied in the same batch, so the concierge is
 * never left waiting on a card nobody sees. "Ver separadas" hands back to the ordinary cards (the way
 * to "Permitir sempre nesta aba"). Presentational: `ChatPanel` owns the request.
 */
export function ChatActionGroup({ actions, deciding, onDecide, onShowSeparately }: { actions: ChatAction[]; deciding: boolean; onDecide: (d: BatchDecision[]) => void; onShowSeparately: () => void }) {
  const [checked, setChecked] = useState<Record<string, boolean>>(() => Object.fromEntries(actions.map((a) => [a.id, a.class !== 'irreversible'])));
  const isChecked = (a: ChatAction) => checked[a.id] ?? a.class !== 'irreversible';
  const count = actions.filter(isChecked).length;
  return (
    <li className="rounded-xl border border-attention/40 bg-bg-2 px-4 py-3 text-sm">
      <p className="font-medium text-fg">{`${actions.length} ações aguardando sua confirmação`}</p>
      <ul className="mt-2 space-y-1">
        {actions.map((a) => (
          <li key={a.id}>
            <label className="flex items-start gap-2">
              <input type="checkbox" className="mt-1" checked={isChecked(a)} disabled={deciding} onChange={(e) => setChecked((prev) => ({ ...prev, [a.id]: e.target.checked }))} />
              {/* Plain text only — never HTML: a summary can carry a command read off a real terminal screen. */}
              <span className="whitespace-pre-wrap text-fg">{a.summary}</span>
              {a.class === 'irreversible' && <span className="ml-auto shrink-0 text-xs text-danger">irreversível</span>}
            </label>
          </li>
        ))}
      </ul>
      {count < actions.length && <p className="mt-2 text-xs text-fg-dim">As desmarcadas serão recusadas.</p>}
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" className="btn-primary" disabled={deciding || count === 0} onClick={() => onDecide(actions.map((a) => ({ id: a.id, decision: isChecked(a) ? 'approve' : 'deny' })))}>
          {`Aprovar selecionadas (${count})`}
        </button>
        <button type="button" className="btn-danger" disabled={deciding} onClick={() => onDecide(actions.map((a) => ({ id: a.id, decision: 'deny' })))}>
          Recusar todas
        </button>
        <button type="button" className="btn-ghost" disabled={deciding} onClick={onShowSeparately}>
          Ver separadas
        </button>
      </div>
    </li>
  );
}
```

(The checkbox's accessible name comes from the label text; with the "irreversível" tag inside the label the name is "… irreversível", which the test matches with a regex.)

- [ ] **Step 4: Panel** — `api.ts`: `decideChatActions: (decisions: { id: string; decision: 'approve' | 'deny' }[]) => request<{ actions: { id: string; status: ChatActionStatus }[]; skipped: { id: string; reason: string }[]; message?: ChatMessage; queued?: true; note?: string }>('POST', '/chat/actions/decisions', { decisions }),`. In `ChatPanel.tsx`:
  - state `const [separate, setSeparate] = useState(false);` and `const [batchDeciding, setBatchDeciding] = useState(false);`; reset `separate` to false when the set of pending ids changes (a `useEffect` keyed on the joined pending ids).
  - the rendered entries become `separate ? timeline : groupPendingActions(timeline)` (where `timeline` is today's `chatTimeline(...)` result; find the variable).
  - new branch in the map:

```tsx
          if (entry.kind === 'action_group') {
            return <ChatActionGroup key={`g:${entry.actions[0]!.id}`} actions={entry.actions} deciding={batchDeciding} onDecide={(d) => void decideBatch(d)} onShowSeparately={() => setSeparate(true)} />;
          }
```

  - `decideBatch`, modelled on the existing `decide` (read it: how it updates `actions`, `messages`, `queuedNotes`, `actionError`, and what it does with `res.message`):

```ts
  /** A grouped confirmation: one request, one injected sentence (spec 2026-09-26 §7). */
  const decideBatch = async (decisions: BatchDecision[]) => {
    setBatchDeciding(true);
    setActionError(null);
    try {
      const res = await api.decideChatActions(decisions);
      const statusOf = new Map(res.actions.map((a) => [a.id, a.status]));
      setActions((prev) => prev.map((a) => (statusOf.has(a.id) ? { ...a, status: statusOf.get(a.id)! } : a)));
      // then exactly what `decide` does with `res.message` / `res.queued` + `res.note` (note under the first decided card)
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : 'Não foi possível registrar as decisões');
    } finally {
      setBatchDeciding(false);
    }
  };
```

  - `ChatPanel.test.tsx`: add `decideChatActions: (...a: unknown[]) => decideManyMock(...a)` to the api mock (+ `decideManyMock` declared/reset like the others) and a test: GET returns two pending actions → the group renders ("2 ações aguardando sua confirmação"), no "Autorizar" buttons; clicking "Aprovar selecionadas (2)" calls `decideManyMock` with both approvals and the cards end up `Autorizado`/status labels (use whatever label `ACTION_STATUS_LABEL.approved` is); "Ver separadas" shows two "Autorizar" buttons.

- [ ] **Step 5: Run** — `DOCKER 'npx -w @termhub/web vitest run src/lib/chat-timeline.test.ts src/components/chat src/pages && npm run build -w @termhub/web'` (build = typecheck). Expected: PASS.

- [ ] **Step 6: Commit** — `git add apps/web/src`; `git commit -m "Chat: group pending confirmations into one card"`.

---

### Task 13: App — one PIN for many proofs, batch decide in API, mock and store (TER-94)

**Files:**
- Modify: `apps/mobile/src/features/session/model/session.types.ts`, `…/session/viewmodel/createSessionStore.ts`, `…/session/viewmodel/createSessionStore.test.ts`, `…/session/view/pin-prompt-sheet.tsx`, `apps/mobile/src/services/api/types.ts`, `…/client.ts`, `…/mock/handlers/chat.ts`, `…/mock/chat.e2e.test.ts`, `apps/mobile/src/features/chat/viewmodel/createChatStore.ts`, `…/createChatStore.test.ts`

**Interfaces:**
- Consumes: `mobileBatchDecisionBody` (Task 11).
- Produces:
  - session: `requestPinProofs(actionIds: string[], perform: (proofs: Record<string, { challenge: string; pin_proof: string }>) => Promise<void>, decision?: PinDecision): Promise<void>`; `pinPrompt: { actionId: string; actionIds: string[]; decision: PinDecision } | null`.
  - api: `decideMany(auth: Auth, body: z.infer<typeof mobileBatchDecisionBody>): Promise<void>`.
  - chat store: `decideMany(decisions: { id: string; decision: 'approve' | 'deny' }[]): Promise<void>` and `decidingIds: string[]` is not added — reuse `decidingId` set to the first id while a batch is in flight.

- [ ] **Step 1: Session tests** — in `createSessionStore.test.ts`, next to the `requestPinProof` tests: `requestPinProofs(['a1','a2'], perform)` opens `pinPrompt` with `actionIds: ['a1','a2']`; resolving with the right PIN calls `api.challenge` once per id (with `action_id` each) and `perform` once with `{ a1: {challenge, pin_proof}, a2: {…} }` where each proof verifies with `decisionProofMessage(challenge, id, 'approve')` (reuse how the existing test checks a proof); a `PIN_INVALID` thrown by `perform` keeps the prompt open like today. The existing `requestPinProof` tests must stay green unchanged.

- [ ] **Step 2: Session implementation** — generalise the prompt: `prompt = { perform: (proofs) => …, decision, resolve, reject }` holding `actionIds`; `requestPinProof(actionId, perform, decision)` becomes `requestPinProofs([actionId], (proofs) => perform(proofs[actionId]!), decision)`. In `resolvePinPrompt`, replace the single challenge/proof with a loop over `actionIds` building the record (all inside the same `try`, same `superseded()` checks after each await). `pinPrompt` gains `actionIds` (keep `actionId` = first id so the sheet's `useEffect` key keeps working). `pin-prompt-sheet.tsx` title: `approve_tab` → 'Permitir sempre nesta aba'; `actionIds.length > 1` → `` `Autorizar ${n} ações` ``; else 'Autorizar esta ação'.

- [ ] **Step 3: API + mock tests** — in `mock/chat.e2e.test.ts`: a test that makes two actions pending (look at how the fixtures create `a-termhub-1`; if only one pending action exists in the fixtures, add a second pending action to the mock seed for `p-termhub` — `a-termhub-2`, a `move_task`, and update any test that counts the seed's actions), then `api.decideMany(auth, { decisions: [{ id: 'a-termhub-1', decision: 'approve', challenge, pin_proof }, { id: 'a-termhub-2', decision: 'deny' }] })` → both decided, one `decision` event each; a wrong proof → `PIN_INVALID` and both still pending.
  Implement: `types.ts` `decideMany(auth: Auth, body: TMobileBatchDecisionBody): Promise<void>;` (type from `local.ts`: `export type TMobileBatchDecisionBody = z.infer<typeof mobileBatchDecisionBody>;`); `client.ts`: `decideMany: (a: Auth, body: TMobileBatchDecisionBody) => empty('POST', '/api/m/v1/chat/actions/decisions', { token: a.accessToken, body }),`; mock route mirroring the server (verify every approve proof with the mock's existing proof check used by the single decision route — reuse that function — before deciding anything; then decide each, broadcast `decision` events, answer `{ actions, skipped, queued: true, note }`).

- [ ] **Step 4: Chat store** — test in `createChatStore.test.ts` (follow the existing `decide` tests): `decideMany` with a deny-only batch calls `api.decideMany` directly (no PIN prompt); with approvals it calls `session.requestPinProofs(approveIds, perform)` and `perform(proofs)` sends one body whose approve items carry their proofs; errors surface like `decide`'s. Implementation next to `decide`:

```ts
          async decideMany(decisions) {
            const projectId = get().activeProject;
            if (projectId === undefined || get().decidingId !== null || decisions.length === 0) return;
            const gen = generation;
            set({ decidingId: decisions[0]!.id, error: null });
            const approveIds = decisions.filter((d) => d.decision === 'approve').map((d) => d.id);
            const send = (proofs: Record<string, { challenge: string; pin_proof: string }>) =>
              api.decideMany(session().auth(), { decisions: decisions.map((d) => (d.decision === 'approve' ? { id: d.id, decision: 'approve' as const, ...proofs[d.id]! } : { id: d.id, decision: 'deny' as const })) });
            try {
              if (approveIds.length === 0) await send({});
              else await session().requestPinProofs(approveIds, send, 'approve');
            } catch (e) {
              // exactly what `decide` does with an error (read it; reuse its helper)
            } finally {
              if (gen === generation) set({ decidingId: null });
            }
          },
```

  (Declare it in the store interface next to `decide`; the session type the chat store sees must include `requestPinProofs`. Keep the chat store's behaviour after a decision identical to `decide`'s — the `decision` events update the rows.)

- [ ] **Step 5: Run** — `DOCKER 'npm test -w @termhub/mobile -- src/features/session src/features/chat src/services/api && npm run typecheck -w @termhub/mobile'`. Expected: PASS.

- [ ] **Step 6: Commit** — `git add apps/mobile`; `git commit -m "App: one PIN for a batch of approvals"`.

---

### Task 14: App — grouped confirmation card in the conversation (TER-94)

**Files:**
- Modify: `apps/mobile/src/features/chat/model/timeline.ts`, `…/model/timeline.test.ts`, `…/view/conversation-screen.tsx`, `…/view/conversation-screen.test.tsx`
- Create: `apps/mobile/src/features/chat/view/action-group-card.tsx`

**Interfaces:**
- Consumes: `groupPendingActions` semantics (Task 12, copied verbatim), chat store `decideMany` (Task 13).

- [ ] **Step 1: Timeline** — copy `groupPendingActions` and the `action_group` entry kind verbatim from the web (Task 12) into `model/timeline.ts`, with the same test cases in `timeline.test.ts`. Run → PASS.

- [ ] **Step 2: Screen test** — in `conversation-screen.test.tsx`, serve two pending actions (`serveChat` with `a-termhub-1` pending plus a second pending action built with `withAction`'s pattern) and assert: "2 ações aguardando sua confirmação" is shown; no "Autorizar" button; pressing the second row toggles it (its accessibility state `checked: false`); pressing "Aprovar selecionadas (1)" calls a stubbed `decideMany` (add `'decideMany'` to `stubAction`'s allowed names) with `[{ id: 'a-termhub-1', decision: 'approve' }, { id: '<second>', decision: 'deny' }]`; "Ver separadas" brings back two "Autorizar" buttons.

- [ ] **Step 3: Card** — `view/action-group-card.tsx`:

```tsx
import { memo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { AppText, Button } from '@/ui';
import type { ChatAction } from '../model/types';

type Decision = { id: string; decision: 'approve' | 'deny' };
type Props = { actions: ChatAction[]; busy: boolean; onDecide(d: Decision[]): void; onShowSeparately(): void };

/** Several pending confirmations as one (spec 2026-09-26 §7.1), like the web's `ChatActionGroup`:
 * writes start checked, irreversible ones unchecked, and what is left unchecked is denied. Approving
 * asks for the PIN once (the store's `decideMany`). */
export const ActionGroupCard = memo(function ActionGroupCard({ actions, busy, onDecide, onShowSeparately }: Props) {
  const [checked, setChecked] = useState<Record<string, boolean>>(() => Object.fromEntries(actions.map((a) => [a.id, a.class !== 'irreversible'])));
  const isChecked = (a: ChatAction) => checked[a.id] ?? a.class !== 'irreversible';
  const count = actions.filter(isChecked).length;
  return (
    <View className="gap-3 rounded-2xl border border-app-accent bg-app-surface2 p-4">
      <AppText variant="label">{`${actions.length} ações aguardando sua confirmação`}</AppText>
      {actions.map((a) => (
        <Pressable
          key={a.id}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: isChecked(a), disabled: busy }}
          accessibilityLabel={a.summary}
          disabled={busy}
          onPress={() => setChecked((prev) => ({ ...prev, [a.id]: !isChecked(a) }))}
          className="flex-row items-start gap-2"
        >
          <AppText>{isChecked(a) ? '☑' : '☐'}</AppText>
          <AppText className="flex-1">{a.summary}</AppText>
          {a.class === 'irreversible' ? <AppText variant="muted">irreversível</AppText> : null}
        </Pressable>
      ))}
      {count < actions.length ? <AppText variant="muted">As desmarcadas serão recusadas.</AppText> : null}
      <Button label={`Aprovar selecionadas (${count})`} onPress={() => onDecide(actions.map((a) => ({ id: a.id, decision: isChecked(a) ? 'approve' : 'deny' })))} disabled={busy || count === 0} />
      <Button label="Recusar todas" variant="secondary" onPress={() => onDecide(actions.map((a) => ({ id: a.id, decision: 'deny' })))} disabled={busy} />
      <Button label="Ver separadas" variant="ghost" onPress={onShowSeparately} disabled={busy} />
    </View>
  );
});
```

- [ ] **Step 4: Screen** — in `conversation-screen.tsx`: `const [separate, setSeparate] = useState(false);` (reset when the pending ids change), entries = `separate ? entries : groupPendingActions(entries)` wherever the list data is built, a render branch for `action_group` rendering `<ActionGroupCard actions={item.actions} busy={decidingId !== null} onDecide={onDecideMany} onShowSeparately={() => setSeparate(true)} />` with `const decideMany = useChatStore((s) => s.decideMany); const onDecideMany = useCallback((d) => void decideMany(d), [decideMany]);`, and the list's `keyExtractor` handling the new kind (`g:${item.actions[0].id}`).

- [ ] **Step 5: Run** — `DOCKER 'npm test -w @termhub/mobile -- src/features/chat && npm run typecheck -w @termhub/mobile'`. Expected: PASS.

- [ ] **Step 6: Commit** — `git add apps/mobile`; `git commit -m "App chat: group pending confirmations into one card"`.

---

### Task 15: Final verification

- [ ] **Step 1: Full suites** — `DOCKER 'npm run build:packages && npm run prisma:generate && npm run typecheck -w @termhub/server && npm test -w @termhub/server && npm run build:city -w @termhub/web && npm test -w @termhub/web && npm run build -w @termhub/web && npm run build -w @termhub/landing && npm run typecheck -w @termhub/mobile && npm test -w @termhub/mobile && npx -w @termhub/mobile-api vitest run'`, output to a file under the scratchpad. Expected: all green (baseline before this plan: server 1936 passed / 9 skipped, web 1125, mobile 350, mobile-api 19 — the counts must only grow).
- [ ] **Step 2: Leftovers** — `grep -rn "ChatGrantStrip\|GrantsStrip\|grants-strip" apps/ --include=*.ts --include=*.tsx` prints nothing; `git status` clean apart from ignored files; `rm -rf .npm` if the container left one.
- [ ] **Step 3: Board** — mark the last subtask done; leave TER-67 in "Fazendo" for the user to review (no push, no deploy).
