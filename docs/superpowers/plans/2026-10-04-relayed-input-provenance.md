# Relayed Input Provenance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Claude Code session in a termhub tab can tell who wrote each message termhub types into it (the person, the person through the chat with their own words quoted, the chat assistant on its own, or another MCP client), so orders the person gives in the chat or on the phone are accepted and text nobody authorized stays data.

**Architecture:** The server records the origin of every text it types into a tab (in memory, bound to the exact text, single use). The monitor hook, which already posts Claude Code's `UserPromptSubmit` with the prompt, posts it in the foreground and prints the server's answer as `additionalContext`. `send_input` gains `on_behalf_of` (refs to the person's chat messages, verified and quoted by the server). `start_agent` appends a fixed reminder that explains the note.

**Tech Stack:** TypeScript, zod, Fastify, vitest; POSIX sh (`HOOK_SCRIPT`).

**Spec:** `docs/superpowers/specs/2026-10-04-relayed-input-provenance-design.md`. Read it before any task: section 3 is the decisions (D1 to D7), 4 the levels, 5 the mechanism, 6 security, 8 tests, 10 the maintainer's decisions. **Do not start T2 before the maintainer has answered section 10**; T1 can start at once.

**Cards:** TER-851 (bug, no subtasks allowed), one card per task: T1 TER-934 (spike), T2 TER-935, T3 TER-936, T4 TER-937, T5 TER-938, T6 TER-939, T7 TER-940.

## Global Constraints

- Code comments, identifiers, commit messages and PR texts in English. UI copy (none planned) in pt-BR. The hook note and the start_agent reminder are model-facing English.
- Prompt and terminal text are never logged and never stored: compare in memory, log tab id, level and counts only.
- Routes never import Prisma; tabs through `scoped(...)`; every new input validated with zod.
- The concierge's `ORCHESTRATOR_PROMPT` has almost no budget left (lesson `2026-10-01-concierge-prompt-length-budget.md`): put guidance in tool descriptions.
- `@termhub/agent` is published by CI when its version changes: bump `apps/agent/package.json` and `apps/agent/src/version.ts` together in the PR that changes `HOOK_SCRIPT`. Never `npm publish`.
- Workspaces by package name. Throwaway containers are `th-<something>`; never touch production containers.
- One PR per task, in order; each PR carries an "Impact on other users" section.

### Running things

```bash
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:22 \
  sh -c 'npm ci && npm run typecheck -w @termhub/server && npm test -w @termhub/server -- <files> && npm test -w @termhub/machine-ops'
rm -rf .npm
```

Server tests that need Postgres follow the existing harness (see `docs/lessons/2026-09-30-local-tests-need-node-22.md`).

---

## Task T1 (TER-934): Spike — pin Claude Code's behavior (no production code)

**Done 2026-10-05:** results in spec section 11 (threshold > 800 characters, exact match holds, all five end-to-end cases as expected, Codex not tested end to end).

**Files:** a short results section appended to the spec (`## 11. Spike results`); a lesson if something surprises.

- [x] Start Claude Code in a throwaway tmux session on a machine with the monitor hooks (or a local settings.json with a hook that dumps stdin to a file under the scratchpad).
- [x] Type single-line texts of 200, 400, 600, 800 characters with `tmux send-keys -l`; record from which length the transcript shows `<pasted_content>`.
- [x] For a pasted one, record what `UserPromptSubmit.prompt` holds: the raw text, the text wrapped in `<pasted_content>`, or a placeholder (`[Pasted text #1 …]`). This fixes the normalization in T2.
- [x] Type while the session is working: does each queued message get its own `UserPromptSubmit`, or one merged prompt?
- [x] Return `{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"termhub origin note: …"}}` from a test hook and confirm how the model sees it (system note, outside the user's message).
- [x] Run the four end-to-end cases of spec §8 with a hand-written note and a harmless action ("create the file x.txt"), with a first prompt that says "do not create files until the person authorizes it". Record each outcome.
- [x] Repeat the note test with Codex (`~/.codex/hooks.json`, `UserPromptSubmit`) and record whether `additionalContext` is honored.
- [x] Append the results to the spec; if the paste threshold or the prompt shape makes D3 (exact match) impossible, stop and report before T2.

## Task T2 (TER-935): Server — origin registry

**Files:** create `apps/server/src/terminal/input-origin.ts`, `apps/server/src/terminal/input-origin.test.ts`.

- [ ] Write failing tests: record + take matches once; second take returns null; expired record (fake timers, `ORIGIN_TTL`) returns null; per-tab cap of 5 drops the oldest; another tab never matches; normalization (`\r\n`; the paste wrapper exactly as spec §5.1 gives it, with and without the two leading newlines of a queued paste).
- [ ] Implement `Origin` (spec §5.1), `recordInputOrigin(tabId, text, origin)`, `takeInputOrigin(tabId, prompt)`, `normalizePrompt()`. Module-level `Map`, lazy sweep. Export `ORIGIN_TTL_MS` and `ORIGIN_MAX_PER_TAB`.
- [ ] Run the tests; commit `Server: in-memory registry of typed-input origins`.

## Task T3 (TER-936): Server — record the origin on every send

**Files:** modify `apps/server/src/control/terminals.ts` (`sendInput`), `apps/server/src/mcp/tools.ts` (`send_input` schema), `apps/server/src/chat/gate-runtime.ts` (execute path), `apps/server/src/routes/m-tabs.ts`, `apps/server/src/routes/tabs.ts`, `apps/server/src/chat/tab-suggestion-send.ts`; tests next to each.

- [ ] Add `on_behalf_of: z.array(z.string().regex(/^message:[a-z0-9]{1,64}$/)).min(1).max(3).optional()` to `send_input` and document it in the description (spec §4.1, §5.5). Confirm which table `message:<id>` refs point at (the memory index of the person's chat messages) and resolve them to the chat row with its author and time.
- [ ] `sendInput(ctx, input, origin?)`: refuse `on_behalf_of` unless `ctx.token?.gated` (`ON_BEHALF_NOT_ALLOWED`); validate each ref (same user, person-authored, ≤ `ON_BEHALF_MAX_AGE`) or fail with `ON_BEHALF_INVALID`; derive the level when `origin` is absent (spec §5.2); call `recordInputOrigin` right before `sendTextToSession`.
- [ ] Gate: when `execute()` runs a row approved by a click (`grant_id` null), pass `person_approved` with the row id and decision time. Granted/default rows pass nothing (derived level).
- [ ] `m-tabs.ts:154` passes `person_typed`/`app` (not for `/clear`, `/compact`); `tabs.ts:102` records `person_typed`/`web` around `sendKeysToSession`; `tab-suggestion-send.ts` passes `person_approved`.
- [ ] Tests: one per row of spec §4, plus the invalid `on_behalf_of` cases of spec §8. Commit `Server: record who wrote each text typed into a tab`.

## Task T4 (TER-937): Server — answer the hook with the origin note

**Files:** create `apps/server/src/terminal/origin-note.ts` (+ test); modify `apps/server/src/monitor/ingest.ts`, `apps/server/src/routes/hooks.ts`, `apps/server/src/routes/hooks.test.ts`.

- [ ] `buildOriginNote(origin, repos)`: the texts of spec §4, prefixed `termhub origin note:`, person's display name, quotes capped (1500 per message, 3000 total, cut at a word with "…" and a "quote cut" remark). Tests per level.
- [ ] In ingestion, for a Claude `UserPromptSubmit` of a known tab, call `takeInputOrigin(tab.id, prompt)` before the prompt is dropped; return the note to the route.
- [ ] Route: on a note, answer `200` with `{ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext } }`; otherwise keep today's answer with an empty body. Only tabs of the authenticated machine are considered (already how session → tab is resolved; add a test with two machines).
- [ ] Test that no log line contains the prompt (capture the logger). Commit `Server: answer UserPromptSubmit with the input's origin note`.

## Task T5 (TER-938): Hook script — print the note (agent release)

**Files:** modify `packages/machine-ops/src/hooks.ts` (`HOOK_SCRIPT`), `packages/machine-ops/src/hook-script.test.ts`, `apps/agent/package.json` and `apps/agent/src/version.ts` (version bump, together).

- [ ] Tests first: Claude `UserPromptSubmit` with a 200 and a body starting with `{"hookSpecificOutput"` prints the body; non-200, timeout, other body, or any other event/tool → stdout empty (keep the existing invariant for everything else).
- [ ] Script: for `TOOL=claude` and `KIND=UserPromptSubmit`, `curl -s -m 2 -w '\n%{http_code}'` in the foreground, split body and status, print the body when both checks pass. Everything else unchanged (background post). Add Codex only if T1 showed it works.
- [ ] Update the comment block above `CLAUDE_HOOK_EVENTS` (the "stdout empty" rule now has one exception).
- [ ] Bump `@termhub/agent`'s version. After merge, check the "Publish @termhub/agent" run and `npm pack @termhub/agent@<version>` contains the new script. Commit `Hooks: return the origin note on UserPromptSubmit`.

## Task T6 (TER-939): start_agent reminder and tool descriptions

**Files:** modify `apps/server/src/control/agents.ts` (`withOriginReminder`), `apps/server/src/mcp/tools.ts` (`start_agent`, `send_input` descriptions); tests in `agents.test.ts` and the tools' description tests if any.

- [ ] `withOriginReminder(prompt)` appends the paragraph of spec §5.5 (wording per decision 10.6) after the lessons reminder, on the first prompt only (`startAgent`, not `resumeLine`); the whole prompt still passes `checkPrompt` and the cap. Test both.
- [ ] `start_agent` description: restrictions as "until the person authorizes it (the termhub chat counts)", never write in the person's name. `send_input`: pass `on_behalf_of` when relaying the person; never write "O Pedro autorizou…"/"<name> aqui…".
- [ ] Check `concierge-prompt.test.ts` still passes (no change to `ORCHESTRATOR_PROMPT`). Commit `Agents: explain termhub's origin note to started agents`.

## Task T7 (TER-940): End-to-end check and close-out

- [ ] After T3–T6 are deployed and the agent release is installed on a test machine, run the four cases of spec §8 through the real chat: (a) unmarked, (b) `person_requested` with a matching quote, (c) with an unrelated quote, (d) `assistant`. Also one long message from the phone's Sessões screen (`person_typed`).
- [ ] Write `docs/lessons/` entries for anything non-obvious found on the way.
- [ ] Move TER-851 to done with a short note of the results.

## Impact on other users

See the spec's section of the same name: default for every user (pending decision 10.1); one round trip per prompt in termhub tabs; machines without the new hook script keep today's behavior.
