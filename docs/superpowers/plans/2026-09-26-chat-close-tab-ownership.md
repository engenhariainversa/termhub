# Chat close_tab: one confirmation (TER-184) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The chat closes any of the user's tabs after one confirmation, and the confirmation card says whose tab it is.

**Architecture:** On a gated (concierge) token the chat gate already asked the user for every `close_tab`, so `closeTab` skips its per-token ownership check for gated tokens; a person's own token keeps it. The card sentence built by `describeActions` names the tab's origin (chat / browser / another API token).

**Tech Stack:** TypeScript, Fastify, vitest (apps/server, `@termhub/server`).

**Spec:** `docs/superpowers/specs/2026-09-26-chat-close-tab-ownership-design.md`

## Global Constraints

- UI copy (card sentences, tool errors) stays pt-BR; code and comments in English.
- Routes never import Prisma; reads go through `repos.*`, owner-scoped.
- Terminal content is never logged.
- Run tests with Docker (no Node on the host):
  `docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:22 sh -c 'npm run test -w @termhub/server -- <file>'`
  (DB tests `*.db.test.ts` need a database and are not touched here.) Remove `.npm` after.

## Review Focus

- A person's own (non-gated) token closing a browser tab without `force` must still get `NOT_YOURS`.
- A gated token closing a tab whose `created_by_token_id` points to a revoked concierge token: card says "aberta pelo chat".
- A close_tab card whose tab does not resolve (gone / foreign) must not look up tokens nor leak anything: still "numa aba que não existe mais".
- A token id on the tab that is not among the owner's tokens (another user's token): reads as "outro token", never names it.
- Cards for tools other than close_tab are unchanged, and `apiTokens.listByUser` is not called when no close_tab card needs it.

---

### Task 1: Gated tokens close without force

**Files:**
- Modify: `apps/server/src/control/context.ts` (token type gains `gated?: boolean`)
- Modify: `apps/server/src/mcp/route.ts:58` (pass `gated: auth.token.gated`)
- Modify: `apps/server/src/control/terminals.ts:176-181` (skip check when `ctx.token.gated`)
- Modify: `apps/server/src/mcp/tools.ts:133` (description)
- Test: `apps/server/src/control/terminals.test.ts`, `apps/server/src/mcp/gate.e2e.test.ts`

**Interfaces:** Produces `ControlContext.token?: { id: string; scopes: readonly ApiTokenScope[]; gated?: boolean }`.

- [ ] **Step 1: failing tests.** In `terminals.test.ts` `describe('closeTab')`:

```ts
it('closes any tab of the user without force on a gated (chat) token: the gate already asked', async () => {
  killTmuxSession.mockResolvedValue(true);
  for (const created_by_token_id of [null, 'tok-old-concierge']) {
    const ctx = ctxWith({ tab: tab({ created_by_token_id }) });
    (ctx as { token: unknown }).token = { id: 'tok1', scopes: ['terminals'], gated: true };
    await expect(closeTab(ctx, { tab_id: 't1' })).resolves.toEqual({ tab_id: 't1', killed: true });
  }
});
```
(Adapt to how `ctxWith` sets `token`; the existing test "refuses a tab opened somewhere else unless force is given" must keep passing with a non-gated token.)

In `gate.e2e.test.ts`, next to "asks before an irreversible action too":

```ts
it('closes an approved tab the chat did not open with the call itself, no force and no second question', async () => {
  const typed: string[] = [];
  attachFakeTmux(typed);
  const { app, actions } = build({ gated: true });
  const row = actions.seed('approved', 'close_tab', { tab_id: 't1' }); // t1.created_by_token_id is null

  const res = await callTool(app, 'close_tab', { tab_id: 't1' });

  expect(resultOf(res).isError).toBeUndefined();
  expect(payloadOf(res)).toMatchObject({ tab_id: 't1' });
  expect(actions.markExecuted).toHaveBeenCalledWith(row.id, true, null, expect.any(Number));
  expect(actions.insertPending).not.toHaveBeenCalled();
});
```
Also: a non-gated token calling close_tab on t1 without force still answers NOT_YOURS (add if not covered).

- [ ] **Step 2: run, expect FAIL** (`NOT_YOURS`).
- [ ] **Step 3: implement.**

```ts
// context.ts
token?: { id: string; scopes: readonly ApiTokenScope[]; gated?: boolean };
// controlContextFor's token param gets the same type.

// route.ts
controlContextFor(repos, auth.user, { id: auth.token.id, scopes: auth.token.scopes, gated: auth.token.gated })

// terminals.ts closeTab
/** Kills the tab's session and removes it. A person's own token closes only the tabs it opened,
 * unless `force`. A gated (chat) token skips that check: the chat gate asked the user for this very
 * call, and its card says whose tab it is (TER-184) — the concierge's token rotates every run, so
 * "opened by this token" would never hold for a tab from an earlier run. */
if (!input.force && ctx.token && !ctx.token.gated && tab.created_by_token_id !== ctx.token.id) { ... }

// tools.ts description
'Kill a terminal tab’s tmux session and remove the tab. A personal token closes only the tabs it opened, unless force is true; in the chat, the user’s confirmation covers any of their tabs (no force needed).'
```
- [ ] **Step 4: run, expect PASS**; run the whole `control/terminals.test.ts`, `mcp/` tests.
- [ ] **Step 5: commit** `Chat: close any of the user's tabs after one confirmation`.

### Task 2: The close_tab card says whose tab it is

**Files:**
- Modify: `apps/server/src/db/repositories/chat-actions-view.ts`
- Test: `apps/server/src/db/repositories/chat-actions-view.test.ts`

**Interfaces:** Consumes `repos.apiTokens.listByUser(userId): Promise<ApiToken[]>` (`ApiToken.gated: boolean`, tokens are revoked, never deleted). Tab rows from `findByIdsForOwner` carry `created_by_token_id: string | null`.

- [ ] **Step 1: failing tests.** Add `apiTokens: { listByUser: vi.fn(async (u) => u === OWNER ? [{ id: 'tokChat', gated: true }, { id: 'tokMine', gated: false }] : []) }` to `fakeRepos`, and the tab fixture gets `created_by_token_id` per test (build a variant). Expected summaries for a `close_tab` action on `t1`:
  - `created_by_token_id: 'tokChat'` → `fechar a aba Terminal 2 (aberta pelo chat) do projeto reactivando, no macbook m3`
  - `null` → `fechar a aba Terminal 2 (aberta por você, não pelo chat) do projeto reactivando, no macbook m3`
  - `'tokMine'` or an unknown id → `fechar a aba Terminal 2 (aberta por um token de API seu, não pelo chat) do projeto reactivando, no macbook m3`
  - tab missing → `fechar a aba numa aba que não existe mais` (unchanged) and `listByUser` not called.
  - a `send_input` batch never calls `listByUser`.

  (Choose the origin placement so the sentence reads naturally; the strings above put it right after the tab name. Put it in `Location` as `tabOrigin?: string` and have `targetPhrase` append it after `na aba X`.)
- [ ] **Step 2: run, expect FAIL.**
- [ ] **Step 3: implement.** In `describeActions`, after tabs resolve: if some action has `tool === 'close_tab'` and its tab resolved with a non-null `created_by_token_id`, load `repos.apiTokens.listByUser(ownerId)` once into `chatTokenIds = new Set(tokens.filter(t => t.gated).map(t => t.id))`. For a close_tab action with a resolved tab, set `loc.tabOrigin`:
  `created_by_token_id === null ? 'aberta por você, não pelo chat' : chatTokenIds.has(id) ? 'aberta pelo chat' : 'aberta por um token de API seu, não pelo chat'`.
  `targetPhrase`: `if (loc.tab) parts.push(loc.tabOrigin ? \`na aba ${loc.tab} (${loc.tabOrigin})\` : \`na aba ${loc.tab}\`)`.
  Check whether `Repositories`'s tab type exposes `created_by_token_id` in `findByIdsForOwner` (it maps through the same mapper in types.ts).
- [ ] **Step 4: run, expect PASS** (whole file).
- [ ] **Step 5: commit** `Chat: say on the close_tab card whose tab it is`.
