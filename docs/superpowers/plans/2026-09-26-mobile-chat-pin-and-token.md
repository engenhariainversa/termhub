# Mobile chat PIN and token lifetime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Approving a `write` card on the phone needs no PIN (irreversible cards and "Permitir sempre nesta aba" still do), and an expired access token is renewed instead of surfacing "Token inválido".

**Architecture:** The server decides whether an approval needs a PIN proof from the action's stored class, and answers `TOKEN_EXPIRED` for any well-formed token that no longer resolves. The app skips the PIN sheet for `write` approvals (falling back to it on `PIN_REQUIRED`), renews its token before it expires, and renews on a refused socket only when the token is stale.

**Tech Stack:** Fastify + zod + vitest (`apps/server`), zod contract (`packages/mobile-api`, vitest), Expo / zustand + jest (`apps/mobile`).

**Spec:** `docs/superpowers/specs/2026-09-26-mobile-chat-pin-and-token-design.md`

## Global Constraints

- Work in the worktree `/home/pedrogoiania/termhub-wt-mobile-pin`, branch `fix/mobile-chat-pin`. No push, no deploy.
- The host has no reliable Node: run every npm/npx command through Docker from the worktree root, then remove the cache the container leaves:
  `docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:20 sh -c '<command>'; rm -rf .npm`
  Below, `RUN '<command>'` means exactly that.
- Address workspaces by package name (`-w @termhub/server`), never by path.
- `packages/mobile-api` is consumed through its build: after changing it, `RUN 'npm run build -w @termhub/mobile-api'` before running server or mobile tests.
- UI copy and server error messages stay in pt-BR; code, comments, commits in English. Commit subject imperative, ≤ 72 chars, body ends with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Never log a token, a challenge, a proof or a PIN secret.
- Web flow (`apps/server/src/routes/chat.ts`, `apps/web`) unchanged.
- Exact new strings: `TOKEN_EXPIRED` message `Sessão expirada.`; `PIN_REQUIRED` message `Confirme com o PIN para autorizar esta ação.`; app notice `Sessão expirada. Desbloqueie para continuar.`
- Renew margin: 60 s before expiry (`RENEW_BEFORE_MS = 60_000`).

## Review Focus

1. A `write` approval sent with a challenge but no `pin_proof` (or the reverse) must be refused by the schema (400), never approved half-proven. → Task 2, schema test.
2. An `irreversible` card approved without proof must stay pending and consume nothing (no challenge, no PIN count). → Task 2, route test.
3. A proactive renewal timer must not survive a relock or wipe (no token coming back behind the lock screen). → Task 4, test.
4. The socket refused while the token is fresh must not renew (no renewal loop), but a refusal with a stale token must. → Task 5, tests.
5. A `PIN_REQUIRED` answer to a silent approval must open the PIN sheet for the same action and word, not show an error. → Task 3, test.

---

### Task 1: Server answers TOKEN_EXPIRED for a token that no longer resolves

**Files:**
- Modify: `apps/server/src/mobile/auth.ts:92-99`
- Modify: `apps/server/src/cli/mobile-client.ts:417-421`
- Modify: `docs/superpowers/specs/2026-09-24-mobile-chat-app-design.md` (§5.7, line ~149)
- Test: `apps/server/src/mobile/auth.test.ts:153-165`

**Interfaces:**
- Produces: `401 { error: 'Sessão expirada.', code: 'TOKEN_EXPIRED' }` for a well-formed `thb_mob_` token that is expired or unknown and not of a revoked device.

- [ ] **Step 1: Write the failing test.** Replace the test at `auth.test.ts:153` with:

```ts
  it('answers DEVICE_REVOKED for a token of a revoked device, TOKEN_EXPIRED for an expired or unknown one', async () => {
    const revoked = fakeRepos(deviceRow(key.jwk, 'revoked'));
    const a = await buildTestApp(revoked);
    const r = await a.inject({ method: 'GET', url: '/api/m/v1/me', headers: await deviceHeaders('/api/m/v1/me') });
    expect(r.statusCode).toBe(401);
    expect(r.json()).toEqual({ error: 'Este aparelho foi removido da conta', code: 'DEVICE_REVOKED' });
    await a.close();

    // Expired: the row is still there (findTokenAny sees it), but findValidToken no longer answers.
    const expired = fakeRepos(deviceRow(key.jwk));
    expired.deviceSessions.findValidToken.mockResolvedValue(undefined);
    const e = await buildTestApp(expired);
    const x = await e.inject({ method: 'GET', url: '/api/m/v1/me', headers: await deviceHeaders('/api/m/v1/me') });
    expect(x.statusCode).toBe(401);
    expect(x.json()).toEqual({ error: 'Sessão expirada.', code: 'TOKEN_EXPIRED' });
    await e.close();

    const unknown = `thb_mob_${'B'.repeat(43)}`;
    const u = await app.inject({ method: 'GET', url: '/api/m/v1/me', headers: { authorization: `Bearer ${unknown}`, dpop: await proofFor('/api/m/v1/me', 'GET', { ath: athOf(unknown) }) } });
    expect(u.statusCode).toBe(401);
    expect(u.json().code).toBe('TOKEN_EXPIRED');
  });
```

Also change the title of the next test (`'a device revoked through revokeDevice answers DEVICE_REVOKED on its next call, not TOKEN_INVALID'`) to end in `not TOKEN_EXPIRED`, and any `TOKEN_INVALID` assertion inside it to `TOKEN_EXPIRED`.

- [ ] **Step 2: Run it, expect FAIL** (`TOKEN_INVALID` received):
`RUN 'cd apps/server && npx vitest run src/mobile/auth.test.ts'`

- [ ] **Step 3: Implement.** In `auth.ts`, replace the `TOKEN_INVALID` throw with:

```ts
      // Expired, or already purged: the app renews on TOKEN_EXPIRED (spec 2026-09-24 §5). A token
      // that never existed gets the same answer — the renewal it triggers needs the key and the PIN secret.
      throw new HttpError(401, 'Sessão expirada.', 'TOKEN_EXPIRED');
```

In `mobile-client.ts`, change `err.code === 'TOKEN_INVALID'` to `err.code === 'TOKEN_EXPIRED'` (keep the comment and message).

In `2026-09-24-mobile-chat-app-design.md` §5.7, replace "rather than a plain `TOKEN_INVALID`" with "rather than a plain `TOKEN_EXPIRED`".

- [ ] **Step 4: Run, expect PASS:** `RUN 'cd apps/server && npx vitest run src/mobile'` and `grep -rn TOKEN_INVALID apps/server/src` (expect no match).

- [ ] **Step 5: Commit** `Mobile auth: answer TOKEN_EXPIRED for an expired token` (body: the app only renews on TOKEN_EXPIRED; TOKEN_INVALID surfaced as "Token inválido" 15 min after the last renewal — TER-93).

---

### Task 2: Decision route requires the PIN only for irreversible cards and approve_tab

**Files:**
- Modify: `packages/mobile-api/src/chat.ts:5-10`
- Test: `packages/mobile-api/src/chat.test.ts`
- Modify: `apps/server/src/routes/m-chat.ts:159-195`
- Test: `apps/server/src/routes/m-chat.test.ts` (decision describe, ~line 343)
- Modify: `docs/superpowers/specs/2026-09-24-mobile-chat-app-design.md` §2 table row "Approving an action" (line ~25) and §5.6 bullet (line ~144)

**Interfaces:**
- Produces: `mobileDecisionBody` where `approve` is `{ decision: 'approve' } | { decision: 'approve', challenge, pin_proof }`; `TMobileDecisionBody` type keeps its name.
- Produces: `401 { error: 'Confirme com o PIN para autorizar esta ação.', code: 'PIN_REQUIRED' }`.

- [ ] **Step 1: Failing schema test** in `chat.test.ts` (inside `describe('mobileDecisionBody')`):

```ts
  it('accepts approve with both challenge and PIN proof or with neither, never with only one', () => {
    expect(mobileDecisionBody.safeParse({ decision: 'approve' }).success).toBe(true);
    expect(mobileDecisionBody.safeParse({ decision: 'approve', challenge: 'c', pin_proof: 'p' }).success).toBe(true);
    expect(mobileDecisionBody.safeParse({ decision: 'approve', challenge: 'c' }).success).toBe(false);
    expect(mobileDecisionBody.safeParse({ decision: 'approve', pin_proof: 'p' }).success).toBe(false);
  });
```

Run `RUN 'npm test -w @termhub/mobile-api'`, expect FAIL.

- [ ] **Step 2: Implement the schema.** A discriminated union needs one object per `decision`, so express "both or neither" with a refine on the whole union:

```ts
const proof = { challenge: z.string().min(1).max(128), pin_proof: z.string().min(1).max(128) };

export const mobileDecisionBody = z
  .discriminatedUnion('decision', [
    z.object({ decision: z.literal('deny') }),
    /** A `write` card approves with the session alone; an irreversible one needs the PIN proof (the server decides). */
    z.object({ decision: z.literal('approve'), challenge: proof.challenge.optional(), pin_proof: proof.pin_proof.optional() }),
    /** Approve *and* trust the tab for send_input in this conversation (24 h max). Always PIN-proven. */
    z.object({ decision: z.literal('approve_tab'), ...proof }),
  ])
  .refine((b) => b.decision !== 'approve' || (b.challenge === undefined) === (b.pin_proof === undefined), { message: 'challenge e pin_proof vão juntos' });
```

Run the mobile-api tests (PASS), then `RUN 'npm run build -w @termhub/mobile-api'`.

- [ ] **Step 3: Failing route tests** in `m-chat.test.ts`. Replace `'approve: rejects a body without the challenge or the pin proof'` with the tests below. `pendingAction` is the fixture the file already uses (class `write`); build variants with `findByIdForUser`:

```ts
  it('approve: a write card without a proof is approved with no challenge and no PIN work', async () => {
    const { app, session, decide, resumeAfterDecision } = build();
    const res = await app.inject({ method: 'POST', url: '/chat/actions/act1/decision', payload: { decision: 'approve' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ queued: true });
    expect(session.consumeDecisionChallenge).not.toHaveBeenCalled();
    expect(session.checkPin).not.toHaveBeenCalled();
    expect(decide).toHaveBeenCalledWith('act1', 'u1', 'approved');
    await vi.waitFor(() => expect(resumeAfterDecision).toHaveBeenCalled());
  });

  it('approve: an irreversible card without a proof is 401 PIN_REQUIRED and stays pending, nothing consumed', async () => {
    const { app, session, decide } = build({ findByIdForUser: vi.fn(async () => ({ ...pendingAction, class: 'irreversible' })) });
    const res = await app.inject({ method: 'POST', url: '/chat/actions/act1/decision', payload: { decision: 'approve' } });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'Confirme com o PIN para autorizar esta ação.', code: 'PIN_REQUIRED' });
    expect(session.consumeDecisionChallenge).not.toHaveBeenCalled();
    expect(session.checkPin).not.toHaveBeenCalled();
    expect(decide).not.toHaveBeenCalled();
  });

  it('approve: an irreversible card with a good proof is approved as before', async () => {
    const { app, session, decide } = build({ findByIdForUser: vi.fn(async () => ({ ...pendingAction, class: 'irreversible' })) });
    const res = await app.inject({ method: 'POST', url: '/chat/actions/act1/decision', payload: approve });
    expect(res.statusCode).toBe(200);
    expect(session.checkPin).toHaveBeenCalled();
    expect(decide).toHaveBeenCalled();
  });

  it('approve: a write card sent with a proof (an older app) still has it checked and counted', async () => {
    const { app, decide } = build({ checkPin: vi.fn(async () => ({ ok: false, code: 'PIN_INVALID', failures: 1 })) });
    const res = await app.inject({ method: 'POST', url: '/chat/actions/act1/decision', payload: approve });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('PIN_INVALID');
    expect(decide).not.toHaveBeenCalled();
  });

  it('approve: half a proof is a 400', async () => {
    const { app, decide } = build();
    const res = await app.inject({ method: 'POST', url: '/chat/actions/act1/decision', payload: { decision: 'approve', challenge: 'chal-1' } });
    expect(res.statusCode).toBe(400);
    expect(decide).not.toHaveBeenCalled();
  });

  it('approve_tab without a proof is still a 400', async () => {
    const { app, decide } = build();
    const res = await app.inject({ method: 'POST', url: '/chat/actions/act1/decision', payload: { decision: 'approve_tab' } });
    expect(res.statusCode).toBe(400);
    expect(decide).not.toHaveBeenCalled();
  });
```

If `pendingAction` in the file has no `class`, add `class: 'write'` to it. If `decide` is called with different argument shapes in this file's other tests, match them. Run `RUN 'cd apps/server && npx vitest run src/routes/m-chat.test.ts'`, expect FAIL.

- [ ] **Step 4: Implement the route.** In `m-chat.ts`, inside `if (body.decision === 'approve' || body.decision === 'approve_tab')`, after the 404/409 checks:

```ts
      // TER-92: a `write` card approves with the session alone (token + hardware-key proof, like deny);
      // an irreversible card and a tab grant still need the PIN. A proof that comes anyway (an older
      // app) is checked and counted as before.
      const hasProof = body.challenge !== undefined && body.pin_proof !== undefined;
      const needsPin = body.decision === 'approve_tab' || existing.class !== 'write';
      if (needsPin && !hasProof) throw new HttpError(401, 'Confirme com o PIN para autorizar esta ação.', 'PIN_REQUIRED');
      if (hasProof) {
        // (the existing consumeDecisionChallenge + checkPin block, unchanged, using body.challenge! / body.pin_proof!)
      }
```

Move the existing challenge + PIN block (lines 180-194) inside `if (hasProof) { … }` verbatim; TypeScript narrows nothing across the refine, so use `body.challenge!` and `body.pin_proof!` there. Update the route's doc comment (lines 159-167) to say approve needs the PIN proof only for a non-`write` card or `approve_tab`.

- [ ] **Step 5: Update the old spec.** §2 row "Approving an action": `Asks for the PIN or biometrics at the moment of the tap only for an irreversible action or "Permitir sempre nesta aba"; a write action approves with the unlocked session, like denying (TER-92).` §5.6 bullet: same rule, `pin_proof` required when the action's class is not `write` or the decision is `approve_tab`, otherwise optional; missing when required → `401 PIN_REQUIRED`.

- [ ] **Step 6: Run** `RUN 'npm test -w @termhub/mobile-api && cd apps/server && npx vitest run src/routes/m-chat.test.ts src/mobile && npx tsc --noEmit -p tsconfig.json'`, expect PASS.

- [ ] **Step 7: Commit** `Mobile decisions: ask the PIN only for irreversible cards and grants`.

---

### Task 3: App approves write cards without the PIN sheet (mock + chat store)

**Files:**
- Modify: `apps/mobile/src/services/api/mock/handlers/chat.ts:451-497`
- Modify: `apps/mobile/src/features/chat/viewmodel/createChatStore.ts:330-363`
- Test: `apps/mobile/src/features/chat/viewmodel/createChatStore.test.ts:146-256`
- Test: `apps/mobile/src/services/api/mock/chat.e2e.test.ts` (approve paths)

**Interfaces:**
- Consumes: Task 2's `mobileDecisionBody` (approve without proof), `PIN_REQUIRED` code.
- The chat slot's `actions[i].class` (`'read' | 'write' | 'irreversible'`) already exists.

- [ ] **Step 1: Mock mirrors the server.** In the mock decision handler, after the 409 check and the `deny` branch, before the `approve_tab` grantable check:

```ts
    const hasProof = 'challenge' in body && body.challenge !== undefined && body.pin_proof !== undefined;
    if (!hasProof) {
      // Mirrors the server (TER-92): only a `write` card approves with the session alone.
      if (body.decision === 'approve_tab' || action.class !== 'write') throw new WireError(401, 'PIN_REQUIRED', 'Confirme com o PIN para autorizar esta ação.');
      action.status = 'approved';
      broadcast(state, { type: 'decision', user_id: USER_ID, conversation_id: action.conversation_id, action_id: action.id, status: 'approved' });
      return { status: 200, body: {} };
    }
```

Leave the rest (lock check, challenge, proof) for the proof path; use `body.challenge!` / `body.pin_proof!` there if TypeScript needs it.

- [ ] **Step 2: Failing store tests.** Rewrite the two first decide tests and add three (the fixture `a-termhub-1` is class `write`; make it irreversible in the store's slot to exercise the PIN path — the mock verifies a proof whenever one is sent):

```ts
const markIrreversible = (chat: ChatStore, projectId: string, id: string) =>
  chat.setState((s) => ({
    conversations: { ...s.conversations, [projectId]: { ...s.conversations[projectId]!, actions: s.conversations[projectId]!.actions.map((a) => (a.id === id ? { ...a, class: 'irreversible' as const } : a)) } },
  }));

it("decide(id, 'approve') on a write card approves at once, with no PIN sheet and no proof", async () => {
  const { chat, store, api } = await setup();
  await openAndConnect(chat, 'p-termhub');
  const decide = jest.spyOn(api, 'decide');
  await chat.getState().decide('a-termhub-1', 'approve');
  expect(store.getState().pinPrompt).toBeNull();
  expect(decide).toHaveBeenCalledWith(expect.anything(), 'a-termhub-1', { decision: 'approve' });
  expect(slot(chat, 'p-termhub').actions[0]!.status).toBe('approved');
  expect(chat.getState()).toMatchObject({ decidingId: null, error: null });
});

it("decide(id, 'approve') on an irreversible card asks requestPinProof(id) and, once resolved, the card is approved", async () => {
  const { chat, store } = await setup();
  await openAndConnect(chat, 'p-termhub');
  markIrreversible(chat, 'p-termhub', 'a-termhub-1');
  const deciding = chat.getState().decide('a-termhub-1', 'approve');
  expect(store.getState().pinPrompt).toEqual({ actionId: 'a-termhub-1', decision: 'approve' });
  await store.getState().resolvePinPrompt(PIN);
  await deciding;
  expect(slot(chat, 'p-termhub').actions[0]!.status).toBe('approved');
});

it('a PIN_REQUIRED answer to a silent approval opens the PIN sheet for the same action and word', async () => {
  const { chat, store, api } = await setup();
  await openAndConnect(chat, 'p-termhub');
  jest.spyOn(api, 'decide').mockRejectedValueOnce(new ApiError(401, 'PIN_REQUIRED', 'Confirme com o PIN para autorizar esta ação.'));
  const deciding = chat.getState().decide('a-termhub-1', 'approve');
  await jest.advanceTimersByTimeAsync(0);
  expect(store.getState().pinPrompt).toEqual({ actionId: 'a-termhub-1', decision: 'approve' });
  expect(chat.getState().error).toBeNull();
  await store.getState().resolvePinPrompt(PIN);
  await deciding;
  expect(slot(chat, 'p-termhub').actions[0]!.status).toBe('approved');
});
```

Keep the `approve_tab` test as is (it must still open the sheet on a write card). In the wrong-PIN test (line ~202) and the cancelled-prompt test (line ~245), call `markIrreversible(chat, 'p-termhub', 'a-termhub-1')` right after `openAndConnect`. Check the `ApiError` constructor order in `apps/mobile/src/services/api/errors.ts` and match it. Run `RUN 'cd apps/mobile && npx jest src/features/chat src/services/api/mock'`, expect FAIL.

- [ ] **Step 3: Implement `decide`.** Replace the `else` branch of `decide`:

```ts
              } else {
                const word = decision; // keeps the narrowed type (no 'deny') inside the closures below
                const withPin = () => session().requestPinProof(actionId, (proof) => api.decide(session().auth(), actionId, { decision: word, ...proof }), word);
                const card = get().conversations[key]?.actions.find((a) => a.id === actionId);
                // TER-92: a write card approves with the unlocked session; the server is the judge and
                // answers PIN_REQUIRED when it disagrees, which falls back to the sheet.
                if (word === 'approve' && card?.class === 'write') {
                  try {
                    await api.decide(session().auth(), actionId, { decision: 'approve' });
                  } catch (e) {
                    if (!isApiError(e, 'PIN_REQUIRED')) throw e;
                    await withPin();
                  }
                } else {
                  // The session store performs the call with the proof while its PIN sheet stays open:
                  // a wrong PIN is answered there, and this only resolves once the server accepted it.
                  // The proof signs the decision word, so `approve_tab` asks the PIN for exactly that.
                  await withPin();
                }
              }
```

Use the slot lookup that the store already uses (`keyOf(projectId)` → `get().conversations[key]`); adjust if the slot map is named differently.

- [ ] **Step 4: Fix the mock e2e tests** that approve `a-termhub-1` expecting a proof requirement (`chat.e2e.test.ts` ~line 180-200): a wrong-purpose challenge with a proof must still be refused (`PIN_INVALID`) — keep it, since a sent proof is always checked. Add one e2e: `api.decide(auth, 'a-termhub-1', { decision: 'approve' })` resolves and a `decision` event with `approved` is broadcast.

- [ ] **Step 5: Run** `RUN 'cd apps/mobile && npx jest src/features/chat src/services/api && npx tsc --noEmit -p tsconfig.json'`, expect PASS.

- [ ] **Step 6: Commit** `Mobile chat: approve write cards without the PIN sheet`.

---

### Task 4: Session store renews the token before it expires

**Files:**
- Modify: `apps/mobile/src/features/session/viewmodel/createSessionStore.ts`
- Modify: `apps/mobile/src/features/session/model/session.types.ts` (add `tokenStale`)
- Modify: `apps/mobile/src/features/session/model/messages.ts` (add `sessionExpired`)
- Test: `apps/mobile/src/features/session/viewmodel/createSessionStore.test.ts`

**Interfaces:**
- Produces: `SessionState.tokenStale(): boolean` — true when no token, no known expiry, or `now() >= expiresAt - RENEW_BEFORE_MS`.
- Produces: `export const RENEW_BEFORE_MS = 60_000` from `createSessionStore.ts`.
- Produces: `MSG.sessionExpired = 'Sessão expirada. Desbloqueie para continuar.'`

- [ ] **Step 1: Failing tests** (append; use the file's own `setupSession`/`enrol` helpers and fake timers, as the neighbouring tests do; the mock's token lives 900 s):

```ts
it('renews the token on its own 60 s before it expires, while unlocked', async () => {
  const ctx = setupSession();
  await enrol(ctx);
  const token = jest.spyOn(ctx.api, 'token');
  ctx.clock.value += 839_000;
  await jest.advanceTimersByTimeAsync(839_000);
  expect(token).not.toHaveBeenCalled();
  expect(ctx.store.getState().tokenStale()).toBe(false);
  ctx.clock.value += 1_000;
  await jest.advanceTimersByTimeAsync(1_000);
  expect(token).toHaveBeenCalledTimes(1);
  expect(ctx.store.getState().tokenStale()).toBe(false);
});

it('a relock clears the renewal timer: nothing renews behind the lock screen', async () => {
  const ctx = setupSession();
  await enrol(ctx);
  const token = jest.spyOn(ctx.api, 'token');
  ctx.store.getState().background();
  ctx.clock.value += RELOCK_AFTER_MS;
  ctx.store.getState().foreground();
  expect(ctx.store.getState().phase).toBe('locked');
  ctx.clock.value += 900_000;
  await jest.advanceTimersByTimeAsync(900_000);
  expect(token).not.toHaveBeenCalled();
  expect(ctx.store.getState().tokenStale()).toBe(true);
});

it('tokenStale is true past expires_at - 60 s', async () => {
  const ctx = setupSession();
  await enrol(ctx);
  jest.spyOn(ctx.api, 'token').mockImplementation(() => new Promise(() => {})); // the renewal never lands
  ctx.clock.value += 840_000;
  expect(ctx.store.getState().tokenStale()).toBe(true);
});

it('a renewal with no secret in memory relocks with the "Sessão expirada" message', async () => {
  const ctx = setupSession();
  await enrol(ctx);
  // A second store over the same vault has no secret in memory; force it to unlocked.
  const cold = ctx.make();
  cold.setState({ phase: 'unlocked' });
  expect(await cold.getState().renewToken()).toBeNull();
  expect(cold.getState()).toMatchObject({ phase: 'locked', error: 'Sessão expirada. Desbloqueie para continuar.' });
});
```

Look at the existing test at line ~240 (`cold.getState().renewToken()`) and build the "no secret" case the same way it does. Run `RUN 'cd apps/mobile && npx jest src/features/session'`, expect FAIL.

- [ ] **Step 2: Implement.** In the store closure:

```ts
export const RENEW_BEFORE_MS = 60_000;
// ...
  let tokenExpiresAt: number | null = null;
  let renewTimer: ReturnType<typeof setTimeout> | null = null;

  const clearRenewTimer = () => {
    if (renewTimer) clearTimeout(renewTimer);
    renewTimer = null;
  };

  /** Remembers the new token's expiry and schedules its renewal `RENEW_BEFORE_MS` ahead (TER-93).
   * A timer that fires late (the app was in the background) is harmless: a `TOKEN_EXPIRED` still renews. */
  const tokenIssued = (expiresInS: number) => {
    tokenExpiresAt = now() + expiresInS * 1000;
    clearRenewTimer();
    renewTimer = setTimeout(() => {
      renewTimer = null;
      void store.getState().renewToken();
    }, Math.max(0, expiresInS * 1000 - RENEW_BEFORE_MS));
  };
```

- `forgetSession`: also `clearRenewTimer(); tokenExpiresAt = null;`.
- `startSession(token, secret, expiresInS)`: call `tokenIssued(expiresInS)`. Pass `res.expires_in` from `redeem` and from `createPin` (activation response has `expires_in`).
- `renewToken` success: after `accessToken = res.access_token;` call `tokenIssued(res.expires_in)`.
- `renewToken` with no secret: `if (get().phase === 'unlocked') { relock(); set({ error: MSG.sessionExpired }); }`.
- New action: `tokenStale() { return accessToken === null || tokenExpiresAt === null || now() >= tokenExpiresAt - RENEW_BEFORE_MS; }`.
- `session.types.ts`: `/** True when the token is missing or within RENEW_BEFORE_MS of its expiry: a refused socket renews only then. */ tokenStale(): boolean;`
- If `store` is not in scope inside the closure (it is the `create(...)` result), use `get().renewToken()` by defining `tokenIssued` inside the `(set, get) => {}` initializer next to `forgetSession`.

- [ ] **Step 3: Run** `RUN 'cd apps/mobile && npx jest src/features/session && npx tsc --noEmit -p tsconfig.json'`, expect PASS (existing tests included; if one counts `api.token` calls over a long fake-timer advance, adjust its expectation and say why in the commit body).

- [ ] **Step 4: Commit** `Mobile session: renew the access token before it expires`.

---

### Task 5: A refused socket renews only a stale token

**Files:**
- Modify: `apps/mobile/src/services/api/client.ts` (options + `events`)
- Modify: `apps/mobile/src/services/api/index.ts` (`setTokenStaleCheck`)
- Modify: `apps/mobile/src/features/session/viewmodel/useSessionStore.ts` (register it)
- Modify: `apps/mobile/test/helpers/enrolled-session.ts` (wire it)
- Test: `apps/mobile/src/services/api/client.test.ts` (events tests)

**Interfaces:**
- Consumes: Task 4's `SessionState.tokenStale()`.
- Produces: `CreateHttpMobileApiOptions.tokenStale?: () => boolean` (default: always stale — today's behaviour); `setTokenStaleCheck(fn: () => boolean): void` exported from `services/api/index.ts`.

- [ ] **Step 1: Failing tests** in `client.test.ts`, next to the existing socket-refusal tests (find them with `grep -n "onRefused\|refus" client.test.ts` and reuse their fake transport / socket setup exactly):

```ts
it('a refused upgrade with a fresh token only backs off: no renewal', async () => {
  // same setup as the existing "refused upgrade renews before the next attempt" test, plus tokenStale: () => false
  // assert: after the refusal and the backoff, the renewer was not called and the next attempt used the same token
});

it('a refused upgrade with a stale token renews before the next attempt', async () => {
  // same setup with tokenStale: () => true — assert the renewer ran once and the next attempt carried the fresh token
});
```

Write both as full tests by copying the existing refusal test's body and changing only the `tokenStale` option and the renewer assertion (`expect(renew).not.toHaveBeenCalled()` / `toHaveBeenCalledTimes(1)`). Run `RUN 'cd apps/mobile && npx jest src/services/api/client.test.ts'`, expect FAIL (the option does not exist).

- [ ] **Step 2: Implement.** In `CreateHttpMobileApiOptions`:

```ts
  /** Whether the access token is missing or about to expire (the session store's `tokenStale`). A
   * refused socket renews only then; a refusal with a fresh token is not a token problem and only
   * backs off (TER-93: the Origin refusal used to renew every 1–30 s). Defaults to always stale. */
  tokenStale?: () => boolean;
```

In `events`, replace `onRefused: () => { renewBeforeNext = true; }` and the `1008` line with a helper:

```ts
      const refusedByServer = () => {
        if (o.tokenStale?.() ?? true) renewBeforeNext = true;
      };
      // ...
        onRefused: refusedByServer,
        onClose: (code, final) => {
          if (code === 1008) refusedByServer();
          handlers.onClose(code, final);
        },
```

Update the comment above `renewBeforeNext` accordingly.

In `index.ts`, next to `setTokenRenewer`:

```ts
let staleCheck: () => boolean = () => true;
export function setTokenStaleCheck(fn: () => boolean): void {
  staleCheck = fn;
}
```

and pass `tokenStale: () => staleCheck()` to `createHttpMobileApi`. In `useSessionStore.ts`: `setTokenStaleCheck(() => useSessionStore.getState().tokenStale());`. In `enrolled-session.ts`: `tokenStale: () => store!.getState().tokenStale(),`.

- [ ] **Step 3: Run the whole mobile suite and typecheck:** `RUN 'cd apps/mobile && npx jest && npx tsc --noEmit -p tsconfig.json'`, expect PASS.

- [ ] **Step 4: Commit** `Mobile socket: renew on a refused upgrade only when the token is stale`.

---

### Final verification (after all tasks)

`RUN 'npm run typecheck -w @termhub/server && npm test -w @termhub/mobile-api && npm test -w @termhub/server && npm test -w @termhub/mobile && npm run build -w @termhub/web && npm run build -w @termhub/landing'` — all green before handing the branch back.
