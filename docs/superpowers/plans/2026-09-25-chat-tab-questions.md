# Chat tab questions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an agent in a tab asks a multiple-choice question (Claude Code's `AskUserQuestion`) or a permission, the project's chat shows it as a card — options, descriptions, the recommended one, a free-text field — and one click answers it in the right tab, on the web and in the mobile app.

**Architecture:** The machines' hook script forwards `AskUserQuestion`'s `PreToolUse` whole and a new `PermissionRequest` hook reduced to the tool name. `monitor/state.ts` turns them into a `question` on the interpretation; `monitor/ingest.ts` hands it to a small service (`chat/tab-questions.ts`) that stores a `tab_questions` row in the project's most recently active conversation and publishes it on the chat bus; any later hook event of the tab closes it. A new answer route checks the row, the live screen and a conditional claim, then types a pure key plan (`chat/tab-question-keys.ts`) with the existing `sendKey` / `sendInput`. The web and the app render the card from `GET /chat` and three new bus events; the concierge learns the answers on the next turn.

**Tech Stack:** Fastify + zod + Prisma 7 (Postgres) in `@termhub/server`, vitest; POSIX sh hook script in `@termhub/machine-ops`; React + Testing Library in `@termhub/web`; Expo/React Native + jest + zustand in `@termhub/mobile`; zod contract in `@termhub/mobile-api`.

**Spec:** `docs/superpowers/specs/2026-09-25-chat-tab-questions-design.md` (read it first; this plan argues from it).

**Board:** card TER-56 (epic TER-1 · Chat), project `termhub`. The controller creates one subtask per task below (titles as the task titles) and moves each to done after its task passes review.

## Global Constraints

- **Chat parity:** everything here works on the web and in the mobile app (`@termhub/mobile`) in the same delivery, same behaviour, same pt-BR copy.
- **No PIN on any platform** for answering a tab question. `requirePinFor(kind, answer)` exists and returns `false`; the mobile route calls it before sending.
- Source of the question: Claude Code hooks only (`PreToolUse` of `AskUserQuestion`, `PermissionRequest`). Never parse a screen to find a question. Machines with the old hook script send neither and keep today's text flow.
- `AskUserQuestion` input caps (zod): 1–4 questions, 2–4 options each, strings capped. An input that does not parse is dropped silently.
- `PermissionRequest` travels as `{"hook_event_name":"PermissionRequest","tool_name":"<NAME>"}` only; `AskUserQuestion`'s own `PermissionRequest` is dropped on the machine. The hook prints nothing on stdout (never allows or denies).
- Pushed into the **most recent non-archived conversation of the tab's project** (by last activity). A project with no conversation gets nothing.
- A click is the confirmation: no gate card, no model turn. Answers do not start a run; the next user turn is prefixed with "Enquanto isso: …" for answered, not-yet-injected questions (`injected_at`).
- Terminal content is never stored nor logged. The permission card's live excerpt (last 20 non-blank lines) is fetched on demand, never persisted. Logs carry ids, kind and counts only — never question text, option labels, answer text or screen text.
- Routes never import Prisma; go through `apps/server/src/db/repositories`. Every request input validated with zod. New routes live in the existing `chat` route plugins (resource `chat`, already `guarded`). Tabs are loaded through `ctx.scoped.tab(id)` (404 outside the scope).
- Migration only adds (one table, two indexes, two foreign keys): the previous release never reads it.
- Error `409 TAB_PROMPT_CHANGED` ("A pergunta mudou na aba") whenever the row is not open, not the tab's latest, not on screen, or already claimed.
- Code, comments, identifiers, commit messages: English. **UI copy: pt-BR**, verbatim from this plan: "Recomendada", "Outra resposta", "Responder", "A aba «X» pede permissão para usar «Bash»", "Permitir", "Negar", "Negar e dizer…", "Enviar", "Tela da aba", "Respondida", "Respondida na aba", "Expirada", "Falhou — …", "A pergunta mudou na aba".
- Commit subject imperative, ≤ 72 chars; every commit ends with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- This host shares production: throwaway containers are named `th-*`; never touch `termhub-*`, `proxy-*`. tmux experiments only in an isolated server (`env -u TMUX tmux -L th-e2e …` or an isolated `TMUX_TMPDIR` with `TMUX` unset) — never the default tmux server. Never write `~/.termhub/*` or `~/.claude/settings.json` on jarvis (jarvis is itself a hooked machine).

## How to run things (worktree `~/termhub-wt-tab-questions`)

All Node commands run in Docker (`node:22`), from the worktree root:

```bash
# one-time: throwaway Postgres for the *.db.test.ts files
docker run -d --name th-tabq-db -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=termhub postgres:16-alpine
# NODE: run a shell command in node:22 sharing that container's network (localhost:5432 = the db)
NODE() { docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp --network container:th-tabq-db \
  -e DATABASE_URL=postgresql://postgres:postgres@localhost:5432/termhub -v "$PWD:/w" -w /w node:22 sh -c "$1"; }
NODE 'npm ci && npm run prisma:generate -w @termhub/server && npm run build:packages'   # one-time
```

- Server unit tests: `NODE 'npm test -w @termhub/server -- <file-or-pattern>'`
- Server db tests: `NODE 'cd apps/server && npx prisma migrate deploy && cd ../.. && TERMHUB_DB_TESTS=1 npm test -w @termhub/server -- <file>'`
- Hook script / machine-ops: `NODE 'npm test -w @termhub/machine-ops -- <file>'` — **rebuild it (`npm run build -w @termhub/machine-ops`) after every change**: the server and the agent import the built package.
- Agent: `NODE 'npm test -w @termhub/agent -- <file>'`
- Contract package: `NODE 'npm test -w @termhub/mobile-api && npm run build -w @termhub/mobile-api'` — **rebuild it (`dist/`) after every change to it**.
- Web tests: `NODE 'npm test -w @termhub/web -- <file>'`
- Mobile tests (jest): `NODE 'npm run build -w @termhub/mobile-api && npm test -w @termhub/mobile -- <pattern>'`; typecheck: `NODE 'npm run typecheck -w @termhub/mobile'`
- Typecheck: `NODE 'npm run typecheck -w @termhub/server'` / web: `NODE 'npm run build -w @termhub/web'`
- After finishing: `rm -rf .npm` (cache the container leaves behind). Leave `th-tabq-db` running until the last task; Task 10 removes it.

## File map

| File | Responsibility |
|---|---|
| `apps/server/src/chat/fixtures/tab-questions/*` (new) | Real Claude Code 2.1.282 payloads and screens, sanitised |
| `apps/server/src/chat/tab-question-payload.ts` (new) | zod parse + normalisation of `AskUserQuestion` input, tool name, answer bodies |
| `apps/server/src/chat/tab-question-keys.ts` (new) | Pure key plan (spec §5.4) |
| `packages/machine-ops/src/hooks.ts` | Hook script: `AskUserQuestion` forwarded whole, `PermissionRequest` reduced; `CLAUDE_HOOK_EVENTS` |
| `apps/agent/package.json`, `apps/agent/src/version.ts`, `package-lock.json` | Agent 0.5.1 (bundles the new script) |
| `docs/superpowers/specs/2026-09-22-agent-activity-design.md` | One-line privacy amendment |
| `apps/server/src/monitor/state.ts` | `question` on `Interpreted`; `PermissionRequest` interpretation |
| `apps/server/prisma/schema.prisma`, `apps/server/prisma/migrations/20260925150000_tab_questions/migration.sql` | `TabQuestion` model |
| `apps/server/src/db/repositories/tab-questions.ts` (new) | `TabQuestionsRepository` |
| `apps/server/src/db/repositories/tab-questions-view.ts` (new) | `TabQuestionView`, `describeTabQuestions` (tab names, owner-scoped) |
| `apps/server/src/db/repositories/chat.ts` | `findLatestActiveForProject` |
| `apps/server/src/db/repositories/index.ts` | register `tabQuestions` |
| `apps/server/src/chat/tab-questions.ts` (new) | Lifecycle: open/close from hook events, tab removed → expired, bus events |
| `apps/server/src/chat/bus.ts` | `tab_question`, `tab_question_answered`, `tab_question_closed` |
| `apps/server/src/monitor/ingest.ts` | Hands every interpreted event to the lifecycle service |
| `apps/server/src/app.ts` | Starts/stops the tab-removed expiry listener |
| `packages/mobile-api/src/{events,chat}.ts` | Contract: question schema, 3 events, answer body, screen response |
| `apps/server/src/mobile/{events-parity.test.ts,push.ts,push-text.ts}` | Parity samples; push on `tab_question` |
| `apps/server/src/chat/tab-question-answer.ts` (new) | Answer (checks, claim, key plan, failure), screen excerpt, `requirePinFor` |
| `apps/server/src/routes/{chat,m-chat}.ts` | Answer + screen routes; `tab_questions` in `GET /` |
| `apps/server/src/chat/tab-question-context.ts` (new) | The "Enquanto isso: …" sentence |
| `apps/server/src/chat/service.ts`, `apps/server/src/chat/project-prompt.ts` | Injection on the next turn; one prompt line |
| `apps/web/src/lib/{types,api,chat-timeline}.ts` | Types, calls, timeline entry |
| `apps/web/src/components/chat/{TabQuestionCard.tsx,tab-question-text.ts,ChatPanel.tsx}` | The card, its copy, the panel wiring |
| `apps/mobile/src/services/api/{contract/local.ts,types.ts,client.ts}` | `tab_questions` in chat response, two calls |
| `apps/mobile/src/services/api/mock/{state.ts,handlers/chat.ts}` | Mock server: questions, answer, screen |
| `apps/mobile/src/features/chat/model/{types,events,timeline,messages,tab-question-text}.ts` | Types, reducer, timeline, copy |
| `apps/mobile/src/features/chat/viewmodel/createChatStore.ts` | Slot `tabQuestions`, `answerTabQuestion`, `loadTabQuestionScreen` |
| `apps/mobile/src/features/chat/view/{tab-question-card,conversation-screen}.tsx` | The card and its place in the thread |

---

### Task 1: Fixtures + normalização do payload + plano de teclas

**Files:**
- Create: `apps/server/src/chat/fixtures/tab-questions/pretooluse-ask-two-questions.json`
- Create: `apps/server/src/chat/fixtures/tab-questions/permissionrequest-ask-one-question.json`
- Create: `apps/server/src/chat/fixtures/tab-questions/permissionrequest-bash.json`
- Create: `apps/server/src/chat/fixtures/tab-questions/notification-permission-prompt.json`
- Create: `apps/server/src/chat/fixtures/tab-questions/screen-choice.txt`
- Create: `apps/server/src/chat/fixtures/tab-questions/screen-review.txt`
- Create: `apps/server/src/chat/fixtures/tab-questions/screen-permission.txt`
- Create: `apps/server/src/chat/tab-question-payload.ts`
- Create: `apps/server/src/chat/tab-question-payload.test.ts`
- Create: `apps/server/src/chat/tab-question-keys.ts`
- Create: `apps/server/src/chat/tab-question-keys.test.ts`

**Interfaces:**
- Consumes: `TmuxKey` from `@termhub/agent-protocol`.
- Produces:
  ```ts
  // tab-question-payload.ts
  export const QUESTION_MAX = 1000, HEADER_MAX = 100, LABEL_MAX = 200, DESCRIPTION_MAX = 1000, ANSWER_TEXT_MAX = 2000;
  export interface TabQuestionOption { label: string; description: string; recommended: boolean }
  export interface TabQuestionItem { question: string; header: string; multi_select: boolean; options: TabQuestionOption[] }
  export interface ChoicePayload { questions: TabQuestionItem[] }
  export interface PermissionPayload { tool_name: string }
  export type TabQuestionKind = 'choice' | 'permission';
  export type TabQuestionInput =
    | { kind: 'choice'; payload: ChoicePayload; tool_use_id: string | null }
    | { kind: 'permission'; payload: PermissionPayload; tool_use_id: null };
  export function normaliseLabel(label: string): { label: string; recommended: boolean };
  export function parseAskUserQuestion(toolInput: unknown): ChoicePayload | null;
  export function parsePermissionTool(name: unknown): PermissionPayload | null;
  export function toolUseIdOf(v: unknown): string | null;
  export const choiceAnswerBody: z.ZodType<ChoiceAnswer>;       // { answers: { selected: number[]; text?: string }[] }
  export const permissionAnswerBody: z.ZodType<PermissionAnswer>; // { allow: boolean; text?: string }
  export type ChoiceAnswer = { answers: { selected: number[]; text?: string }[] };
  export type PermissionAnswer = { allow: boolean; text?: string };
  export type ChoiceAnswerProblem = 'ANSWER_COUNT' | 'ANSWER_OPTION' | 'ANSWER_SHAPE';
  export function checkChoiceAnswer(payload: ChoicePayload, answer: ChoiceAnswer): ChoiceAnswerProblem | null;
  // tab-question-keys.ts
  export type KeyStep = { key: TmuxKey } | { text: string };
  export function choiceKeyPlan(payload: ChoicePayload, answer: ChoiceAnswer): KeyStep[];
  export function permissionKeyPlan(answer: PermissionAnswer): KeyStep[];
  ```

- [ ] **Step 1: Write the fixtures.** Captured in an isolated tmux on 2026-09-25 (Claude Code 2.1.282); every path is replaced by `/home/dev/project`. The single-question payload is the `PermissionRequest` Claude Code fired for a one-question `AskUserQuestion` (its `PreToolUse` was lost when the probe log was truncated; the `tool_input` is identical by spec §3).

  `pretooluse-ask-two-questions.json`:
  ```json
  {"session_id":"9a90b851-e3ed-4eba-90eb-e734b885b785","transcript_path":"/home/dev/.claude/projects/-home-dev-project/9a90b851-e3ed-4eba-90eb-e734b885b785.jsonl","cwd":"/home/dev/project","permission_mode":"auto","hook_event_name":"PreToolUse","tool_name":"AskUserQuestion","tool_input":{"questions":[{"question":"What is your favorite color?","header":"Color","options":[{"label":"Blue (Recommended)","description":"Calm and classic."},{"label":"Green","description":"Fresh and natural."},{"label":"Red","description":"Bold and energetic."}],"multiSelect":false},{"question":"Which fruits do you like?","header":"Fruits","options":[{"label":"Apple","description":"Crisp and sweet."},{"label":"Banana","description":"Soft and easy to eat."},{"label":"Mango","description":"Tropical and juicy."}],"multiSelect":true}]},"tool_use_id":"toolu_01XsgR974r49WEBYg2aeDAGq"}
  ```
  `permissionrequest-ask-one-question.json`:
  ```json
  {"session_id":"9a90b851-e3ed-4eba-90eb-e734b885b785","transcript_path":"/home/dev/.claude/projects/-home-dev-project/9a90b851-e3ed-4eba-90eb-e734b885b785.jsonl","cwd":"/home/dev/project","permission_mode":"default","hook_event_name":"PermissionRequest","tool_name":"AskUserQuestion","tool_input":{"questions":[{"question":"What is your favorite season?","header":"Season","options":[{"label":"Spring","description":"Blooming flowers and mild weather."},{"label":"Summer","description":"Long sunny days and warmth."},{"label":"Autumn","description":"Crisp air and colorful leaves."}],"multiSelect":false}]}}
  ```
  `permissionrequest-bash.json`:
  ```json
  {"session_id":"9a90b851-e3ed-4eba-90eb-e734b885b785","transcript_path":"/home/dev/.claude/projects/-home-dev-project/9a90b851-e3ed-4eba-90eb-e734b885b785.jsonl","cwd":"/home/dev/project","permission_mode":"default","hook_event_name":"PermissionRequest","tool_name":"Bash","tool_input":{"command":"touch probe-file.txt","description":"Create an empty probe file"},"permission_suggestions":[{"type":"addDirectories","directories":["/home/dev/project"],"destination":"session"},{"type":"setMode","mode":"acceptEdits","destination":"session"}]}
  ```
  `notification-permission-prompt.json`:
  ```json
  {"session_id":"9a90b851-e3ed-4eba-90eb-e734b885b785","transcript_path":"/home/dev/.claude/projects/-home-dev-project/9a90b851-e3ed-4eba-90eb-e734b885b785.jsonl","cwd":"/home/dev/project","hook_event_name":"Notification","message":"Claude needs your permission","notification_type":"permission_prompt"}
  ```
  `screen-choice.txt` (the pane while the two-question card is open):
  ```text
   ▐▛███▛█   Claude Code v2.1.282
  ▝▜██████▀  Opus 5.5 (1M context) · Claude Max
   ▝▝   ▝▝   /home/dev/project


  ❯ Use the AskUserQuestion tool to ask me two questions at once: (1) favorite color with 3 options, one marked Recommended, single select; (2) which fruits I
    like, multiSelect with 3 options. Then after my answer, run the bash command: ls /tmp
  ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  ←  ☐ Color  ☐ Fruits  ✔ Submit  →

  What is your favorite color?

  ❯ 1. Blue (Recommended)
       Calm and classic.
    2. Green
       Fresh and natural.
    3. Red
       Bold and energetic.
    4. Type something.
  ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
    5. Chat about this

  Enter to select · Tab/Arrow keys to navigate · Esc to cancel




  ```
  `screen-review.txt` (the Submit tab after both answers):
  ```text
  ▝▜██████▀  Opus 5.5 (1M context) · Claude Max
   ▝▝   ▝▝   /home/dev/project
  ❯ Use the AskUserQuestion tool to ask me two questions at once: (1) favorite color with 3 options, one marked Recommended, single select; (2) which fruits I
    like, multiSelect with 3 options. Then after my answer, run the bash command: ls /tmp
  ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  ←  ☒ Color  ☒ Fruits  ✔ Submit  →
  Review your answers
   ● What is your favorite color?
     → Green
   ● Which fruits do you like?
     → Apple, Mango
  Ready to submit your answers?
  ❯ 1. Submit answers
    2. Cancel
  ```
  `screen-permission.txt` (a `Bash` permission prompt):
  ```text
    - Background services: .NET debug pipes and sockets, systemd-private-* directories, tmux-1000 and snap-private-tmp.
  ✻ Crunched for 9s · done 12:39 PM
  ❯ Run this bash command: touch probe-file.txt
    Creating an empty probe file
    ⎿  $ touch probe-file.txt
  ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
   Bash command
   Tip: auto mode handles these prompts for you — choose "switch to auto mode" below
     touch probe-file.txt
     Create an empty probe file
   Do you want to proceed?
   ❯ 1. Yes
     2. Yes, and always allow access to /home/dev/project from this project
     3. Yes, and switch to auto mode · auto mode handles these prompts for you
     4. No
   Esc to cancel · Tab to amend
  ```
  (The code blocks above are indented two spaces only because they sit inside this list item: write each file without that leading two-space indent, i.e. `screen-choice.txt` starts with ` ▐▛███▛█`.)

- [ ] **Step 2: Write the failing payload test** `apps/server/src/chat/tab-question-payload.test.ts`:
  ```ts
  import { readFileSync } from 'node:fs';
  import { join } from 'node:path';
  import { describe, expect, it } from 'vitest';
  import { checkChoiceAnswer, choiceAnswerBody, normaliseLabel, parseAskUserQuestion, parsePermissionTool, permissionAnswerBody, toolUseIdOf } from './tab-question-payload.js';

  const fixture = (name: string) => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/tab-questions', name), 'utf8')) as Record<string, unknown>;
  const two = fixture('pretooluse-ask-two-questions.json');
  const one = fixture('permissionrequest-ask-one-question.json');

  describe('parseAskUserQuestion', () => {
    it('normalises the captured two-question payload, recommended flag out of the label', () => {
      expect(parseAskUserQuestion(two.tool_input)).toEqual({
        questions: [
          {
            question: 'What is your favorite color?',
            header: 'Color',
            multi_select: false,
            options: [
              { label: 'Blue', description: 'Calm and classic.', recommended: true },
              { label: 'Green', description: 'Fresh and natural.', recommended: false },
              { label: 'Red', description: 'Bold and energetic.', recommended: false },
            ],
          },
          {
            question: 'Which fruits do you like?',
            header: 'Fruits',
            multi_select: true,
            options: [
              { label: 'Apple', description: 'Crisp and sweet.', recommended: false },
              { label: 'Banana', description: 'Soft and easy to eat.', recommended: false },
              { label: 'Mango', description: 'Tropical and juicy.', recommended: false },
            ],
          },
        ],
      });
    });

    it('parses the single-question payload', () => {
      expect(parseAskUserQuestion(one.tool_input)?.questions).toHaveLength(1);
    });

    it('fills a missing header, description and multiSelect', () => {
      const r = parseAskUserQuestion({ questions: [{ question: 'Q?', options: [{ label: 'a' }, { label: 'b' }] }] });
      expect(r?.questions[0]).toEqual({ question: 'Q?', header: '', multi_select: false, options: [{ label: 'a', description: '', recommended: false }, { label: 'b', description: '', recommended: false }] });
    });

    it.each([
      ['no questions', { questions: [] }],
      ['five questions', { questions: Array.from({ length: 5 }, () => ({ question: 'Q', options: [{ label: 'a' }, { label: 'b' }] })) }],
      ['one option', { questions: [{ question: 'Q', options: [{ label: 'a' }] }] }],
      ['five options', { questions: [{ question: 'Q', options: ['a', 'b', 'c', 'd', 'e'].map((label) => ({ label })) }] }],
      ['an oversized question', { questions: [{ question: 'x'.repeat(1001), options: [{ label: 'a' }, { label: 'b' }] }] }],
      ['an empty label', { questions: [{ question: 'Q', options: [{ label: ' ' }, { label: 'b' }] }] }],
      ['not an object', 'questions'],
      ['nothing', undefined],
    ])('drops %s', (_l, input) => {
      expect(parseAskUserQuestion(input)).toBeNull();
    });
  });

  describe('normaliseLabel', () => {
    it.each([
      ['Blue (Recommended)', { label: 'Blue', recommended: true }],
      ['Blue  (recommended) ', { label: 'Blue', recommended: true }],
      ['Blue', { label: 'Blue', recommended: false }],
      ['(Recommended)', { label: '(Recommended)', recommended: false }],
      ['Recommended option', { label: 'Recommended option', recommended: false }],
    ])('%s', (input, out) => {
      expect(normaliseLabel(input)).toEqual(out);
    });
  });

  describe('tool name and tool_use_id', () => {
    it('accepts the names the hook script lets through, nothing else', () => {
      expect(parsePermissionTool('Bash')).toEqual({ tool_name: 'Bash' });
      expect(parsePermissionTool('mcp__claude-in-chrome__click')).toEqual({ tool_name: 'mcp__claude-in-chrome__click' });
      for (const bad of ['', 'Ev"il', 'a b', 42, null, 'x'.repeat(129)]) expect(parsePermissionTool(bad)).toBeNull();
    });
    it('keeps a plain tool_use_id only', () => {
      expect(toolUseIdOf('toolu_01XsgR974r49WEBYg2aeDAGq')).toBe('toolu_01XsgR974r49WEBYg2aeDAGq');
      expect(toolUseIdOf('../x')).toBeNull();
      expect(toolUseIdOf(undefined)).toBeNull();
    });
  });

  describe('answer bodies', () => {
    const payload = parseAskUserQuestion(two.tool_input)!;

    it('accepts one entry per question: one option, several options, or text', () => {
      const ok = choiceAnswerBody.parse({ answers: [{ selected: [1] }, { selected: [0, 2] }] });
      expect(checkChoiceAnswer(payload, ok)).toBeNull();
      expect(checkChoiceAnswer(payload, choiceAnswerBody.parse({ answers: [{ selected: [], text: 'Purple' }, { selected: [1] }] }))).toBeNull();
    });

    it.each([
      ['a missing answer', { answers: [{ selected: [1] }] }, 'ANSWER_COUNT'],
      ['an option that does not exist', { answers: [{ selected: [3] }, { selected: [0] }] }, 'ANSWER_OPTION'],
      ['a repeated option', { answers: [{ selected: [1] }, { selected: [0, 0] }] }, 'ANSWER_OPTION'],
      ['two options on a single-select', { answers: [{ selected: [0, 1] }, { selected: [0] }] }, 'ANSWER_SHAPE'],
      ['nothing picked nor typed', { answers: [{ selected: [] }, { selected: [0] }] }, 'ANSWER_SHAPE'],
      ['both picked and typed', { answers: [{ selected: [0], text: 'x' }, { selected: [0] }] }, 'ANSWER_SHAPE'],
    ])('refuses %s', (_l, body, code) => {
      expect(checkChoiceAnswer(payload, choiceAnswerBody.parse(body))).toBe(code);
    });

    it('refuses control characters, newlines and oversized text', () => {
      for (const text of ['a\u001bb', 'linha 1\nlinha 2', 'x'.repeat(2001), '   ']) {
        expect(choiceAnswerBody.safeParse({ answers: [{ selected: [], text }] }).success).toBe(false);
      }
    });

    it('permission: allow alone, deny with or without text, never text with allow nor a "!" command', () => {
      expect(permissionAnswerBody.parse({ allow: true })).toEqual({ allow: true });
      expect(permissionAnswerBody.parse({ allow: false, text: ' use pnpm ' })).toEqual({ allow: false, text: 'use pnpm' });
      expect(permissionAnswerBody.safeParse({ allow: true, text: 'x' }).success).toBe(false);
      expect(permissionAnswerBody.safeParse({ allow: false, text: '  !rm -rf /' }).success).toBe(false);
      expect(permissionAnswerBody.safeParse({}).success).toBe(false);
    });
  });
  ```

- [ ] **Step 3: Run it to verify it fails.** `NODE 'npm test -w @termhub/server -- src/chat/tab-question-payload.test.ts'` → FAIL: `Failed to load url ./tab-question-payload.js`.

- [ ] **Step 4: Implement** `apps/server/src/chat/tab-question-payload.ts`:
  ```ts
  import { z } from 'zod';

  /**
   * A question a tab puts to the person (spec 2026-09-25 §4.2, §5.4): Claude Code's `AskUserQuestion`
   * input, parsed and normalised, and the bodies the chat answers it with. The input reaches the server
   * whole (it is text written to be shown to the person) but only from a machine's hook token, so every
   * field is capped here and anything off-shape drops the question — the tab falls back to the text flow.
   */
  export const QUESTION_MAX = 1000;
  export const HEADER_MAX = 100;
  export const LABEL_MAX = 200;
  export const DESCRIPTION_MAX = 1000;
  export const ANSWER_TEXT_MAX = 2000;

  const rawOption = z.object({ label: z.string().trim().min(1).max(LABEL_MAX), description: z.string().max(DESCRIPTION_MAX).optional() });
  const rawQuestion = z.object({
    question: z.string().trim().min(1).max(QUESTION_MAX),
    header: z.string().max(HEADER_MAX).optional(),
    // Claude Code asks with 2 to 4 options; its own "Type something." and "Chat about this" rows are not options.
    options: z.array(rawOption).min(2).max(4),
    multiSelect: z.boolean().optional(),
  });
  const rawInput = z.object({ questions: z.array(rawQuestion).min(1).max(4) });

  export interface TabQuestionOption {
    label: string;
    description: string;
    /** Claude Code marks the recommended option in its label: "Blue (Recommended)". */
    recommended: boolean;
  }
  export interface TabQuestionItem {
    question: string;
    header: string;
    multi_select: boolean;
    options: TabQuestionOption[];
  }
  export interface ChoicePayload {
    questions: TabQuestionItem[];
  }
  /** A permission prompt: the tool's name only, never its input (spec §4.1). */
  export interface PermissionPayload {
    tool_name: string;
  }
  export type TabQuestionKind = 'choice' | 'permission';
  /** What the interpretation of a hook event hands the tab-question service. */
  export type TabQuestionInput =
    | { kind: 'choice'; payload: ChoicePayload; tool_use_id: string | null }
    | { kind: 'permission'; payload: PermissionPayload; tool_use_id: null };

  const RECOMMENDED = /\s*\(Recommended\)\s*$/i;

  /** "Blue (Recommended)" → `{ label: "Blue", recommended: true }`. A label that is only the marker stays as it is. */
  export function normaliseLabel(label: string): { label: string; recommended: boolean } {
    const trimmed = label.trim();
    const stripped = trimmed.replace(RECOMMENDED, '').trim();
    return stripped && stripped !== trimmed ? { label: stripped, recommended: true } : { label: trimmed, recommended: false };
  }

  export function parseAskUserQuestion(toolInput: unknown): ChoicePayload | null {
    const r = rawInput.safeParse(toolInput);
    if (!r.success) return null;
    return {
      questions: r.data.questions.map((q) => ({
        question: q.question,
        header: (q.header ?? '').trim(),
        multi_select: q.multiSelect ?? false,
        options: q.options.map((o) => ({ ...normaliseLabel(o.label), description: (o.description ?? '').trim() })),
      })),
    };
  }

  /** The characters the hook script lets through for a tool name (`[A-Za-z0-9_.-]`), checked again here. */
  const TOOL_NAME = z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/);
  const TOOL_USE_ID = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);

  export function parsePermissionTool(name: unknown): PermissionPayload | null {
    const r = TOOL_NAME.safeParse(name);
    return r.success ? { tool_name: r.data } : null;
  }

  export function toolUseIdOf(v: unknown): string | null {
    const r = TOOL_USE_ID.safeParse(v);
    return r.success ? r.data : null;
  }

  /**
   * Text typed into the tab as an answer: one line, no control characters. A newline would be read as
   * Enter halfway through the answer, and any other control byte is a key, not text (the same reasoning
   * as `CONTROL_CHARS` in control/agents.ts, stricter: not even a newline).
   */
  const answerText = z.string().trim().min(1).max(ANSWER_TEXT_MAX).regex(/^[^\x00-\x1f\x7f]*$/, 'sem caracteres de controle nem quebras de linha');

  export const choiceAnswerBody = z.object({
    answers: z
      .array(z.object({ selected: z.array(z.number().int().min(0).max(3)).max(4).default([]), text: answerText.optional() }))
      .min(1)
      .max(4),
  });
  export type ChoiceAnswer = z.infer<typeof choiceAnswerBody>;

  export const permissionAnswerBody = z
    .object({ allow: z.boolean(), text: answerText.optional() })
    .refine((a) => !(a.allow && a.text !== undefined), { message: 'texto só acompanha uma negação', path: ['text'] })
    // After a rejection Claude Code is back at its prompt, where a leading "!" runs the rest in bash.
    .refine((a) => !a.text?.startsWith('!'), { message: 'o texto não pode começar com "!"', path: ['text'] });
  export type PermissionAnswer = z.infer<typeof permissionAnswerBody>;

  export type ChoiceAnswerProblem = 'ANSWER_COUNT' | 'ANSWER_OPTION' | 'ANSWER_SHAPE';

  /** The part of a choice answer zod cannot see without the question: one entry per question, options
   * that exist, and exactly one of "picked" or "typed" (one option at most on a single-select). */
  export function checkChoiceAnswer(payload: ChoicePayload, answer: ChoiceAnswer): ChoiceAnswerProblem | null {
    if (answer.answers.length !== payload.questions.length) return 'ANSWER_COUNT';
    for (const [i, a] of answer.answers.entries()) {
      const q = payload.questions[i]!;
      if (a.selected.some((s) => s >= q.options.length) || new Set(a.selected).size !== a.selected.length) return 'ANSWER_OPTION';
      const picked = a.selected.length > 0;
      const typed = a.text !== undefined;
      if (picked === typed) return 'ANSWER_SHAPE';
      if (!q.multi_select && a.selected.length > 1) return 'ANSWER_SHAPE';
    }
    return null;
  }
  ```

- [ ] **Step 5: Run it to verify it passes.** Same command → PASS.

- [ ] **Step 6: Write the failing key-plan test** `apps/server/src/chat/tab-question-keys.test.ts`:
  ```ts
  import { readFileSync } from 'node:fs';
  import { join } from 'node:path';
  import { describe, expect, it } from 'vitest';
  import { choiceKeyPlan, permissionKeyPlan } from './tab-question-keys.js';
  import { parseAskUserQuestion, type ChoicePayload } from './tab-question-payload.js';

  const fixture = (name: string) => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/tab-questions', name), 'utf8')) as { tool_input: unknown };
  const two = parseAskUserQuestion(fixture('pretooluse-ask-two-questions.json').tool_input)!;
  const one = parseAskUserQuestion(fixture('permissionrequest-ask-one-question.json').tool_input)!;
  const multiOnly: ChoicePayload = { questions: [two.questions[1]!] };

  describe('choiceKeyPlan (spec §5.4)', () => {
    it('single-select: the option digit; multi-select: a digit per option then Tab; 2+ questions end on the Submit tab', () => {
      expect(choiceKeyPlan(two, { answers: [{ selected: [1] }, { selected: [2, 0] }] })).toEqual([{ key: '2' }, { key: '1' }, { key: '3' }, { key: 'Tab' }, { key: '1' }]);
    });

    it('a single single-select question is one digit, no Submit step', () => {
      expect(choiceKeyPlan(one, { answers: [{ selected: [2] }] })).toEqual([{ key: '3' }]);
    });

    it('a single multi-select question: its digits and Tab, no Submit step', () => {
      expect(choiceKeyPlan(multiOnly, { answers: [{ selected: [0, 1] }] })).toEqual([{ key: '1' }, { key: '2' }, { key: 'Tab' }]);
    });

    it('free text: the digit after the last option, the text, Enter', () => {
      expect(choiceKeyPlan(two, { answers: [{ selected: [], text: 'Purple' }, { selected: [1] }] })).toEqual([
        { key: '4' },
        { text: 'Purple' },
        { key: 'Enter' },
        { key: '2' },
        { key: 'Tab' },
        { key: '1' },
      ]);
    });

    it('never types a key it cannot name', () => {
      const five = { questions: [{ ...one.questions[0]!, options: Array.from({ length: 9 }, (_, i) => ({ label: `o${i}`, description: '', recommended: false })) }] };
      expect(() => choiceKeyPlan(five, { answers: [{ selected: [], text: 'x' }] })).toThrow(RangeError);
    });
  });

  describe('permissionKeyPlan', () => {
    it('allow is "1" (always "Yes")', () => {
      expect(permissionKeyPlan({ allow: true })).toEqual([{ key: '1' }]);
    });
    it('deny is Escape; with text, the text and Enter at the prompt Claude is back at', () => {
      expect(permissionKeyPlan({ allow: false })).toEqual([{ key: 'Escape' }]);
      expect(permissionKeyPlan({ allow: false, text: 'use pnpm' })).toEqual([{ key: 'Escape' }, { text: 'use pnpm' }, { key: 'Enter' }]);
    });
  });
  ```

- [ ] **Step 7: Run it to verify it fails.** `NODE 'npm test -w @termhub/server -- src/chat/tab-question-keys.test.ts'` → FAIL: module not found.

- [ ] **Step 8: Implement** `apps/server/src/chat/tab-question-keys.ts`:
  ```ts
  import type { TmuxKey } from '@termhub/agent-protocol';
  import type { ChoiceAnswer, ChoicePayload, PermissionAnswer } from './tab-question-payload.js';

  /** One thing to do in the tab: press a key from `TMUX_KEYS`, or type text literally (no Enter). */
  export type KeyStep = { key: TmuxKey } | { text: string };

  const DIGITS: readonly TmuxKey[] = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

  function digit(n: number): TmuxKey {
    const key = DIGITS[n - 1];
    if (!key) throw new RangeError(`no key for option ${n}`);
    return key;
  }

  /**
   * The keys that answer Claude Code's question card (spec §3 and §5.4), from the screen as captured:
   * a digit picks a single-select option and moves on; on a multi-select a digit toggles and Tab moves
   * on; the digit after the last option focuses the free-text field, whose text is typed and submitted
   * with Enter; with 2+ questions the last step lands on the Submit tab, where "1" is "Submit answers".
   * Pure: the answer is already checked against the payload (`checkChoiceAnswer`).
   */
  export function choiceKeyPlan(payload: ChoicePayload, answer: ChoiceAnswer): KeyStep[] {
    const steps: KeyStep[] = [];
    payload.questions.forEach((q, i) => {
      const a = answer.answers[i]!;
      if (a.text !== undefined) {
        steps.push({ key: digit(q.options.length + 1) }, { text: a.text }, { key: 'Enter' });
        return;
      }
      if (!q.multi_select) {
        steps.push({ key: digit(a.selected[0]! + 1) });
        return;
      }
      for (const s of [...a.selected].sort((x, y) => x - y)) steps.push({ key: digit(s + 1) });
      steps.push({ key: 'Tab' });
    });
    if (payload.questions.length >= 2) steps.push({ key: '1' });
    return steps;
  }

  /** "1" is always "Yes"; Escape always rejects, and leaves Claude at its prompt for the text, if any. */
  export function permissionKeyPlan(answer: PermissionAnswer): KeyStep[] {
    if (answer.allow) return [{ key: '1' }];
    return answer.text === undefined ? [{ key: 'Escape' }] : [{ key: 'Escape' }, { text: answer.text }, { key: 'Enter' }];
  }
  ```

- [ ] **Step 9: Run both tests.** `NODE 'npm test -w @termhub/server -- src/chat/tab-question-payload.test.ts src/chat/tab-question-keys.test.ts'` → PASS. Typecheck: `NODE 'npm run typecheck -w @termhub/server'` → no errors.

- [ ] **Step 10: Commit**
  ```bash
  git add apps/server/src/chat/fixtures/tab-questions apps/server/src/chat/tab-question-payload.ts apps/server/src/chat/tab-question-payload.test.ts apps/server/src/chat/tab-question-keys.ts apps/server/src/chat/tab-question-keys.test.ts
  git commit -F - <<'MSG'
  Tab questions: parse AskUserQuestion input and plan the answer keys

  Real Claude Code 2.1.282 payloads and screens as fixtures, the zod
  normalisation (recommended flag out of the label) and the pure key plan
  of spec 2026-09-25 §5.4 (TER-56).

  Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
  MSG
  ```

---

### Task 2: Hook script: encaminhar AskUserQuestion e hook PermissionRequest

**Files:**
- Modify: `packages/machine-ops/src/hooks.ts` (`CLAUDE_HOOK_EVENTS` ~line 40, `HOOK_SCRIPT` PreToolUse branch ~lines 70-108, `mergeClaudeSettings` ~line 160)
- Modify: `packages/machine-ops/src/hook-script.test.ts`
- Modify: `packages/machine-ops/src/hooks.test.ts`
- Modify: `apps/agent/package.json` (`"version": "0.5.0"` → `"0.5.1"`), `apps/agent/src/version.ts` (`AGENT_VERSION = '0.5.1'`), `package-lock.json` (line 30, the `apps/agent` entry's `"version"`)
- Modify: `docs/superpowers/specs/2026-09-22-agent-activity-design.md` (line 24)

**Interfaces:**
- Produces: `CLAUDE_HOOK_EVENTS` includes `'PermissionRequest'`; hook posts `{"tool":"claude","session":S,"event":<whole AskUserQuestion PreToolUse>}` and `{"tool":"claude","session":S,"event":{"hook_event_name":"PermissionRequest","tool_name":"<NAME>"}}` (Task 3 reads both). Agent `0.5.1` bundles the script; its `heal()` (apps/agent/src/rpc/hooks.ts) rewrites an older script and merges the new `PermissionRequest` entry on startup/reconnect, so agent machines need no manual reinstall once updated. SSH machines get it on "Reinstalar hooks".

- [ ] **Step 1: Write the failing tests.** Append to `packages/machine-ops/src/hook-script.test.ts`, inside `describe('termhub-hook script', …)` (after `'keeps the marker inside TMPDIR…'`):
  ```ts
  describe('questions and permission prompts (spec 2026-09-25 §4.1)', () => {
    const ask = {
      session_id: 's1',
      transcript_path: '/home/dev/.claude/projects/-home-dev-project/s1.jsonl',
      cwd: '/home/dev/project',
      permission_mode: 'default',
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question: 'Qual cor?', header: 'Cor', options: [{ label: 'Azul (Recommended)', description: 'Calma' }, { label: 'Verde', description: 'Fresca' }], multiSelect: false }] },
      tool_use_id: 'toolu_01',
    };

    it('forwards an AskUserQuestion PreToolUse whole, and prints nothing', async () => {
      expect(runAs('claude', ask)).toBe('');
      const sent = await bodies(1);
      expect(JSON.parse(sent[0])).toEqual({ tool: 'claude', session: 'th-abc', event: ask });
    });

    it('never de-duplicates a question and never touches the marker', async () => {
      run({ hook_event_name: 'PreToolUse', tool_name: 'Edit' });
      run(ask);
      run(ask);
      run({ hook_event_name: 'PreToolUse', tool_name: 'Edit' });
      await bodies(3);
      await sleep(200);
      expect(logged().map((b) => eventOf(b).tool_name)).toEqual(['Edit', 'AskUserQuestion', 'AskUserQuestion']);
      expect(readFileSync(join(tmp, readdirSync(tmp)[0]), 'utf8')).toBe('Edit');
    });

    it('does not forward whole a tool whose input merely names AskUserQuestion', async () => {
      run({ hook_event_name: 'PreToolUse', tool_name: 'Task', tool_input: { tool_name: 'AskUserQuestion', prompt: 'secret' } });
      const sent = await bodies(1);
      expect(eventOf(sent[0])).toEqual({ hook_event_name: 'PreToolUse', tool_name: 'Task' });
    });

    it('reduces a PermissionRequest to the tool name, and prints nothing', async () => {
      const event = { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm -rf /secret' }, permission_suggestions: [{ type: 'addDirectories', directories: ['/secret'] }] };
      expect(runAs('claude', event)).toBe('');
      const sent = await bodies(1);
      expect(JSON.parse(sent[0])).toEqual({ tool: 'claude', session: 'th-abc', event: { hook_event_name: 'PermissionRequest', tool_name: 'Bash' } });
      expect(sent[0]).not.toContain('secret');
    });

    it('drops AskUserQuestion\'s own PermissionRequest (its PreToolUse carried the question) and odd names', async () => {
      expect(runAs('claude', { hook_event_name: 'PermissionRequest', tool_name: 'AskUserQuestion', tool_input: ask.tool_input })).toBe('');
      run({ hook_event_name: 'PermissionRequest', tool_name: 'Ev"il' });
      run({ hook_event_name: 'PermissionRequest' });
      await sleep(300);
      expect(existsSync(log)).toBe(false);
    });
  });
  ```
  And in `packages/machine-ops/src/hooks.test.ts`, inside `describe('mergeClaudeSettings', …)`:
  ```ts
  it('subscribes PermissionRequest with the every-tool matcher, like PreToolUse', () => {
    const out = JSON.parse(mergeClaudeSettings('', script)) as { hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]> };
    expect(CLAUDE_HOOK_EVENTS).toContain('PermissionRequest');
    expect(out.hooks.PermissionRequest[0].matcher).toBe('*');
    expect(out.hooks.PermissionRequest[0].hooks[0].command).toBe(`${script} claude`);
  });
  ```

- [ ] **Step 2: Run them to verify they fail.** `NODE 'npm test -w @termhub/machine-ops -- src/hook-script.test.ts src/hooks.test.ts'` → FAIL: the AskUserQuestion body is reduced to `{hook_event_name, tool_name}`, the PermissionRequest is forwarded whole, and `CLAUDE_HOOK_EVENTS` lacks `PermissionRequest`.

- [ ] **Step 3: Implement.** In `packages/machine-ops/src/hooks.ts`:

  1. Replace the `CLAUDE_HOOK_EVENTS` line with:
     ```ts
     /** Claude Code hook events we subscribe to (see the server's monitor/state.ts for what each one means).
      * `PermissionRequest` is taken for its tool name only; the script prints nothing, which Claude Code
      * reads as "no decision" — our hook never allows or denies (hook-script.test.ts keeps stdout empty). */
     export const CLAUDE_HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'Notification', 'Stop', 'SessionEnd'] as const;

     /** Events Claude Code runs per tool: their entry needs a matcher ('*' = every tool). */
     const CLAUDE_TOOL_EVENTS: ReadonlySet<string> = new Set(['PreToolUse', 'PermissionRequest']);
     ```
  2. In `mergeClaudeSettings`, replace `if (event === 'PreToolUse') entry.matcher = '*';` with `if (CLAUDE_TOOL_EVENTS.has(event)) entry.matcher = '*';`.
  3. In `HOOK_SCRIPT`, replace the PreToolUse branch from the line `    case "$NAME" in '' | *[!A-Za-z0-9_.-]*) exit 0 ;; esac` down to (and including) its closing `    ;;` — i.e. everything up to the comment `# A new turn starts fresh…` — with the block below (this is the source as it appears inside the template literal: keep every `\${`, `\\` exactly):
     ```
         case "$NAME" in '' | *[!A-Za-z0-9_.-]*) exit 0 ;; esac
         # AskUserQuestion's input is the question itself, written to be shown to the person (spec
         # 2026-09-25 §4.1): the whole event goes as it came — the server keeps tool_use_id and
         # tool_input and drops the rest — and the marker is neither read nor written, so two questions
         # in a row are two questions. NAME is the event's own first "tool_name", never one nested in
         # another tool's input.
         if [ "$NAME" != AskUserQuestion ]; then
           # Claude Code's spinner verb ("✻ Moonwalking… (12s · esc to interrupt)"): the visible pane is
           # read here, on the machine, and only the verb may leave it — one word of 2 to 24 ASCII letters
           # right after a spinner glyph at column 0 and a single space, immediately followed by "…" or
           # "...", then the end of the line or a space. Column 0 because Claude Code draws its spinner
           # there, while a draft in the input box or indented tool output can look just like one. The
           # lowest such line of the last 24 non-blank rows wins (the live spinner sits above the todo list
           # and the input box; blank rows under a short session are skipped). Both grep and sed run under
           # LC_ALL=C: bytes the locale calls invalid then neither trip grep's "binary file matches" (which
           # would also swallow the rest of the screen) nor sed's "illegal byte sequence" on macOS, and
           # the match works the same on GNU, BSD and busybox. ASCII only on purpose: a customised verb
           # with accents is dropped rather than half-matched. The case below checks the result again, so
           # the hand-built JSON only ever gets letters.
           VERB=$(tmux capture-pane -p -t "$TMUX_PANE" 2>/dev/null | LC_ALL=C grep -v '^[[:space:]]*$' 2>/dev/null | tail -n 24 |
             LC_ALL=C sed -n -E 's/^(·|✢|✳|✶|✻|✽|\\*) ([A-Za-z]{2,24})(…|\\.\\.\\.)( .*)?$/\\2/p' | tail -n 1)
           case "$VERB" in *[!A-Za-z]*) VERB= ;; esac
           [ "\${#VERB}" -le 24 ] || VERB=
           KEY="$NAME\${VERB:+ $VERB}"
           [ "$(cat "$MARK" 2>/dev/null)" = "$KEY" ] && exit 0
           printf '%s' "$KEY" 2>/dev/null > "$MARK"
           if [ -n "$VERB" ]; then
             EVENT=$(printf '{"hook_event_name":"PreToolUse","tool_name":"%s","verb":"%s"}' "$NAME" "$VERB")
           else
             EVENT=$(printf '{"hook_event_name":"PreToolUse","tool_name":"%s"}' "$NAME")
           fi
         fi
         ;;
       # A permission prompt: only the tool's name travels, exactly like a tool call (never its input,
       # never the suggestions). AskUserQuestion's own prompt is dropped — its PreToolUse already carried
       # the question. Same first-"tool_name" rule and character set as above.
       *'"hook_event_name":"PermissionRequest"'*|*'"hook_event_name": "PermissionRequest"'*)
         REST=\${EVENT#*'"tool_name"'}
         [ "$REST" != "$EVENT" ] || exit 0
         REST=\${REST#*'"'}
         NAME=\${REST%%'"'*}
         case "$NAME" in '' | *[!A-Za-z0-9_.-]* | AskUserQuestion) exit 0 ;; esac
         EVENT=$(printf '{"hook_event_name":"PermissionRequest","tool_name":"%s"}' "$NAME")
         ;;
     ```
     (Indentation shown with four leading spaces for the outer `case` arms, as in the file.) Also extend the comment above `MARK=` ("Tool calls: only the tool's name travels…") with one sentence: `AskUserQuestion is the one exception (below).`

- [ ] **Step 4: Run the tests to verify they pass.** `NODE 'npm test -w @termhub/machine-ops'` → PASS (whole suite: the spinner-verb and Cursor tests must still pass). Then `NODE 'npm run build -w @termhub/machine-ops'`.

- [ ] **Step 5: Bump the agent** (it bundles `HOOK_SCRIPT`; a script change is a patch release, like 0.4.1 "the monitor hook reports the tool being called"):
  - `apps/agent/package.json`: `"version": "0.5.1"`
  - `apps/agent/src/version.ts`: `export const AGENT_VERSION = '0.5.1';`
  - `package-lock.json` line 30 (under `"apps/agent": {`): `"version": "0.5.1",`
  Run: `NODE 'npm test -w @termhub/agent -- src/version.test.ts src/rpc/hooks.test.ts'` → PASS.

- [ ] **Step 6: Amend the agent-activity spec.** In `docs/superpowers/specs/2026-09-22-agent-activity-design.md` replace line 24 with:
  ```markdown
  - The server never receives a tool's input for a `PreToolUse` event — except `AskUserQuestion`'s, whose input is the question written to be shown to the person (see `2026-09-25-chat-tab-questions-design.md` §4.1).
  ```

- [ ] **Step 7: Commit**
  ```bash
  git add packages/machine-ops/src/hooks.ts packages/machine-ops/src/hook-script.test.ts packages/machine-ops/src/hooks.test.ts apps/agent/package.json apps/agent/src/version.ts package-lock.json docs/superpowers/specs/2026-09-22-agent-activity-design.md
  git commit -F - <<'MSG'
  Monitor hook: forward AskUserQuestion and permission prompts

  AskUserQuestion's PreToolUse goes whole (its input is the question) and
  skips the de-dup marker; a new PermissionRequest hook sends the tool
  name only and drops AskUserQuestion's own. Agent 0.5.1 bundles it (TER-56).

  Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
  MSG
  ```

---

### Task 3: Interpretação dos eventos

**Files:**
- Modify: `apps/server/src/monitor/state.ts` (`Interpreted` ~line 12, `interpretClaude` ~line 45)
- Modify: `apps/server/src/monitor/state.test.ts`

**Interfaces:**
- Consumes: `parseAskUserQuestion`, `parsePermissionTool`, `toolUseIdOf`, `TabQuestionInput` (Task 1).
- Produces: `Interpreted.question?: TabQuestionInput` — set on a Claude `PreToolUse` of `AskUserQuestion` whose input parses (`kind: 'choice'`, state stays `working`, `meta` unchanged: `{ event: 'PreToolUse', tool: 'AskUserQuestion' }`), and on a `PermissionRequest` (`kind: 'waiting_permission'`, `text: null`, `meta: { event: 'PermissionRequest', tool }`, `question: { kind: 'permission', payload: { tool_name }, tool_use_id: null }` unless the tool is `AskUserQuestion` or its name is off-shape). `tool_input` never reaches `meta`, `text` or anything `recordEvent` stores. Task 5 relies on `meta.event` / `meta.tool` / `meta.type` to tell a companion event apart.

- [ ] **Step 1: Write the failing tests.** Append to `apps/server/src/monitor/state.test.ts`:
  ```ts
  import { readFileSync } from 'node:fs';
  import { join } from 'node:path';

  const fixture = (name: string) => JSON.parse(readFileSync(join(import.meta.dirname, '../chat/fixtures/tab-questions', name), 'utf8')) as Record<string, unknown>;

  describe('interpretHookEvent — claude questions (spec 2026-09-25 §4.2)', () => {
    it('an AskUserQuestion PreToolUse stays working and carries the normalised question and its tool_use_id', () => {
      const r = interpretHookEvent('claude', fixture('pretooluse-ask-two-questions.json'));
      expect(r).toMatchObject({ kind: 'working', text: null, activity: 'planning', meta: { event: 'PreToolUse', tool: 'AskUserQuestion' } });
      expect(r?.question?.kind).toBe('choice');
      expect(r?.question?.tool_use_id).toBe('toolu_01XsgR974r49WEBYg2aeDAGq');
      expect(r?.question?.kind === 'choice' && r.question.payload.questions[0]!.options[0]).toEqual({ label: 'Blue', description: 'Calm and classic.', recommended: true });
    });

    it('keeps nothing of the question outside `question`: not in meta, not in text', () => {
      const r = interpretHookEvent('claude', fixture('pretooluse-ask-two-questions.json'))!;
      const { question: _question, ...rest } = r;
      expect(JSON.stringify(rest)).not.toContain('favorite');
      expect(JSON.stringify(rest)).not.toContain('/home/dev');
    });

    it('drops a question whose input does not parse, and the event still reads as working', () => {
      const r = interpretHookEvent('claude', { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [] } });
      expect(r).toEqual({ kind: 'working', text: null, activity: 'planning', verb: null, meta: { event: 'PreToolUse', tool: 'AskUserQuestion' } });
    });

    it('never builds a question from another tool\'s input', () => {
      const r = interpretHookEvent('claude', { hook_event_name: 'PreToolUse', tool_name: 'Task', tool_input: fixture('pretooluse-ask-two-questions.json').tool_input });
      expect(r?.question).toBeUndefined();
    });

    it('a PermissionRequest is waiting_permission with a permission question naming the tool only', () => {
      expect(interpretHookEvent('claude', { hook_event_name: 'PermissionRequest', tool_name: 'Bash' })).toEqual({
        kind: 'waiting_permission',
        text: null,
        meta: { event: 'PermissionRequest', tool: 'Bash' },
        question: { kind: 'permission', payload: { tool_name: 'Bash' }, tool_use_id: null },
      });
      // The whole captured event (an old script, or a future one) still yields the name only.
      const whole = interpretHookEvent('claude', fixture('permissionrequest-bash.json'));
      expect(JSON.stringify(whole)).not.toContain('probe-file');
      expect(whole?.question).toEqual({ kind: 'permission', payload: { tool_name: 'Bash' }, tool_use_id: null });
    });

    it('AskUserQuestion\'s own PermissionRequest opens nothing (its PreToolUse did), and an odd name neither', () => {
      expect(interpretHookEvent('claude', fixture('permissionrequest-ask-one-question.json'))).toEqual({ kind: 'waiting_permission', text: null, meta: { event: 'PermissionRequest', tool: 'AskUserQuestion' } });
      expect(interpretHookEvent('claude', { hook_event_name: 'PermissionRequest', tool_name: 'a b' })?.question).toBeUndefined();
    });

    it('the permission_prompt notification that follows is unchanged', () => {
      expect(interpretHookEvent('claude', fixture('notification-permission-prompt.json'))).toEqual({
        kind: 'waiting_permission',
        text: 'Claude needs your permission',
        meta: { event: 'Notification', type: 'permission_prompt' },
      });
    });
  });
  ```
  (Put the two `import` lines at the top of the file with the existing imports.)

- [ ] **Step 2: Run to verify it fails.** `NODE 'npm test -w @termhub/server -- src/monitor/state.test.ts'` → FAIL (no `question`; `PermissionRequest` returns `null`).

- [ ] **Step 3: Implement.** In `apps/server/src/monitor/state.ts`:
  - Add the import: `import { parseAskUserQuestion, parsePermissionTool, toolUseIdOf, type TabQuestionInput } from '../chat/tab-question-payload.js';`
  - Add to `Interpreted`, after `continuesWait`:
    ```ts
    /**
     * A question the tab put to the person (spec 2026-09-25 §4.2): an `AskUserQuestion` card or a
     * permission prompt. For the tab-question service only — never stored on the tab nor its events.
     */
    question?: TabQuestionInput;
    ```
  - Replace the `case 'PreToolUse': { … }` block of `interpretClaude` with:
    ```ts
    case 'PreToolUse': {
      // the script already reduced this event to the tool's name and the spinner's verb; whatever
      // else arrives is ignored, and a verb that is not a plain word is dropped, not the event.
      // The one exception is AskUserQuestion, forwarded whole: its input is the question, written to
      // be shown to the person — parsed into `question`, never into meta or text.
      const tool = str(ev.tool_name);
      const base: Interpreted = { kind: 'working', text: null, activity: activityOf(tool), verb: verbOf(ev.verb), meta: { event: name, tool } };
      if (tool !== 'AskUserQuestion') return base;
      const payload = parseAskUserQuestion(ev.tool_input);
      return payload ? { ...base, question: { kind: 'choice', payload, tool_use_id: toolUseIdOf(ev.tool_use_id) } } : base;
    }
    case 'PermissionRequest': {
      // Reduced to the tool's name on the machine; its state effect is the permission_prompt
      // notification's, which follows it. AskUserQuestion's own prompt opens nothing: its PreToolUse
      // already carried the question (the current script drops it; this covers anything else).
      const tool = str(ev.tool_name);
      const base: Interpreted = { kind: 'waiting_permission', text: null, meta: { event: name, tool } };
      const payload = tool === 'AskUserQuestion' ? null : parsePermissionTool(tool);
      return payload ? { ...base, question: { kind: 'permission', payload, tool_use_id: null } } : base;
    }
    ```

- [ ] **Step 4: Run to verify it passes.** `NODE 'npm test -w @termhub/server -- src/monitor/state.test.ts src/monitor/ingest.test.ts'` → PASS (the existing `PreToolUse` expectations — `withInput` equals `without` — still hold for `Edit`).

- [ ] **Step 5: Commit**
  ```bash
  git add apps/server/src/monitor/state.ts apps/server/src/monitor/state.test.ts
  git commit -F - <<'MSG'
  Monitor: read a tab's question from AskUserQuestion and PermissionRequest

  Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
  MSG
  ```

---

### Task 4: Migração + repositório tab_questions

**Files:**
- Modify: `apps/server/prisma/schema.prisma` (`model Project` ~line 181, `model ChatConversation` ~line 603; new model after `model ChatGrant` ~line 710)
- Create: `apps/server/prisma/migrations/20260925150000_tab_questions/migration.sql`
- Create: `apps/server/src/db/repositories/tab-questions.ts`
- Create: `apps/server/src/db/repositories/tab-questions.db.test.ts`
- Modify: `apps/server/src/db/repositories/chat.ts` (new method after `getOrCreateForProject`)
- Modify: `apps/server/src/db/repositories/index.ts`

**Interfaces:**
- Consumes: `ChoicePayload`, `PermissionPayload`, `ChoiceAnswer`, `PermissionAnswer`, `TabQuestionKind` (Task 1).
- Produces:
  ```ts
  // tab-questions.ts
  export type TabQuestionStatus = 'open' | 'answered' | 'answered_in_tab' | 'expired' | 'failed';
  export type TabQuestionCloseStatus = 'answered_in_tab' | 'expired';
  export interface TabQuestion {
    id: string; tab_id: string; project_id: string; conversation_id: string;
    user_id: string; // the conversation's owner: whom events and pushes go to
    kind: TabQuestionKind; payload: ChoicePayload | PermissionPayload; tool_use_id: string | null;
    status: TabQuestionStatus; answer: ChoiceAnswer | PermissionAnswer | null; error_code: string | null;
    answered_by: string | null; answered_at: string | null; closed_at: string | null; injected_at: string | null; created_at: string;
  }
  export interface OpenTabQuestionInput { tab_id: string; project_id: string; conversation_id: string; kind: TabQuestionKind; payload: ChoicePayload | PermissionPayload; tool_use_id: string | null }
  export class TabQuestionsRepository {
    open(input: OpenTabQuestionInput, now?: Date): Promise<{ question: TabQuestion; closed: TabQuestion[] }>;
    closeForTab(tabId: string, status: TabQuestionCloseStatus, now?: Date): Promise<TabQuestion[]>;
    findOpenForTab(tabId: string): Promise<TabQuestion | undefined>;
    findByIdForUser(id: string, userId: string): Promise<TabQuestion | undefined>;
    claim(id: string, userId: string, answer: ChoiceAnswer | PermissionAnswer, now?: Date): Promise<TabQuestion | undefined>;
    markFailed(id: string, code: string): Promise<TabQuestion | undefined>;
    listByConversation(conversationId: string, limit?: number): Promise<TabQuestion[]>;
    listToInject(conversationId: string): Promise<TabQuestion[]>;
    markInjected(ids: string[], now?: Date): Promise<void>;
  }
  // chat.ts
  ChatRepository.findLatestActiveForProject(projectId: string): Promise<ChatConversation | undefined>;
  // index.ts
  Repositories.tabQuestions: TabQuestionsRepository
  ```

- [ ] **Step 1: Schema.** In `schema.prisma`, add `tabQuestions   TabQuestion[]` to `model Project` (next to `chatConversations ChatConversation[]`) and `tabQuestions  TabQuestion[]` to `model ChatConversation` (next to `grants ChatGrant[]`). Add after `model ChatGrant`:
  ```prisma
  /// A question an agent in a tab put to the person — Claude Code's AskUserQuestion (`choice`) or a
  /// permission prompt (`permission`) — shown as a card in the project's chat (spec 2026-09-25 §5).
  /// `payload` is the normalised question, never a screen; `answer` is what the chat answered.
  model TabQuestion {
    id             String           @id
    /// Not a foreign key: tabs come and go, and a removed tab closes its question as `expired`.
    tabId          String           @map("tab_id")
    projectId      String           @map("project_id")
    project        Project          @relation(fields: [projectId], references: [id], onDelete: Cascade)
    conversationId String           @map("conversation_id")
    conversation   ChatConversation @relation(fields: [conversationId], references: [id], onDelete: Cascade)
    /// choice | permission
    kind           String
    payload        Json
    toolUseId      String?          @map("tool_use_id")
    /// open | answered | answered_in_tab | expired | failed
    status         String
    answer         Json?
    errorCode      String?          @map("error_code")
    answeredBy     String?          @map("answered_by")
    answeredAt     DateTime?        @map("answered_at")
    /// When the question left the tab's screen (the next hook event, or the tab removed).
    closedAt       DateTime?        @map("closed_at")
    /// When the concierge was told about the answer (spec §5.5): set once, before the run.
    injectedAt     DateTime?        @map("injected_at")
    createdAt      DateTime         @default(now()) @map("created_at")

    @@index([tabId, status])
    @@index([conversationId, createdAt])
    @@map("tab_questions")
  }
  ```

- [ ] **Step 2: Migration** `apps/server/prisma/migrations/20260925150000_tab_questions/migration.sql`:
  ```sql
  -- CreateTable
  CREATE TABLE "tab_questions" (
      "id" TEXT NOT NULL,
      "tab_id" TEXT NOT NULL,
      "project_id" TEXT NOT NULL,
      "conversation_id" TEXT NOT NULL,
      "kind" TEXT NOT NULL,
      "payload" JSONB NOT NULL,
      "tool_use_id" TEXT,
      "status" TEXT NOT NULL,
      "answer" JSONB,
      "error_code" TEXT,
      "answered_by" TEXT,
      "answered_at" TIMESTAMP(3),
      "closed_at" TIMESTAMP(3),
      "injected_at" TIMESTAMP(3),
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

      CONSTRAINT "tab_questions_pkey" PRIMARY KEY ("id")
  );

  -- CreateIndex
  CREATE INDEX "tab_questions_tab_id_status_idx" ON "tab_questions"("tab_id", "status");

  -- CreateIndex
  CREATE INDEX "tab_questions_conversation_id_created_at_idx" ON "tab_questions"("conversation_id", "created_at");

  -- AddForeignKey
  ALTER TABLE "tab_questions" ADD CONSTRAINT "tab_questions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

  -- AddForeignKey
  ALTER TABLE "tab_questions" ADD CONSTRAINT "tab_questions_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "chat_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  ```
  Regenerate: `NODE 'npm run prisma:generate -w @termhub/server'`. Prove schema and migrations agree, as CI does:
  `NODE 'cd apps/server && npx prisma migrate deploy && npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code'` → exit 0. If it reports a difference, fix the SQL (not the check).

- [ ] **Step 3: Write the failing repository test** `apps/server/src/db/repositories/tab-questions.db.test.ts`:
  ```ts
  import { PrismaPg } from '@prisma/adapter-pg';
  import { afterAll, beforeAll, describe, expect, it } from 'vitest';
  import { PrismaClient } from '../../generated/prisma/client.js';
  import { newId } from '../../lib/ids.js';
  import { ChatRepository } from './chat.js';
  import { TabQuestionsRepository } from './tab-questions.js';

  const payload = { questions: [{ question: 'Qual cor?', header: 'Cor', multi_select: false, options: [{ label: 'Azul', description: '', recommended: true }, { label: 'Verde', description: '', recommended: false }] }] };

  describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('TabQuestionsRepository (Postgres)', () => {
    let db: PrismaClient;
    let repo: TabQuestionsRepository;
    let chat: ChatRepository;
    let userId: string;
    let otherUserId: string;
    let projectId: string;
    let conversationId: string;

    beforeAll(async () => {
      db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
      repo = new TabQuestionsRepository(db);
      chat = new ChatRepository(db);
      userId = newId();
      otherUserId = newId();
      projectId = newId();
      await db.user.create({ data: { id: userId, email: `${userId}@test.local`, name: 'test' } });
      await db.user.create({ data: { id: otherUserId, email: `${otherUserId}@test.local`, name: 'other' } });
      await db.project.create({ data: { id: projectId, key: `Q${projectId.slice(-5).toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`, name: 'proj', ownerId: userId } });
      conversationId = (await chat.getOrCreateForProject(userId, projectId)).id;
    });

    afterAll(async () => {
      await db.project.deleteMany({ where: { id: projectId } }); // cascades its conversations and questions
      await db.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
      await db.$disconnect();
    });

    const open = (tabId: string, now?: Date) => repo.open({ tab_id: tabId, project_id: projectId, conversation_id: conversationId, kind: 'choice', payload, tool_use_id: 'toolu_1' }, now);

    it('opens a question owned through its conversation, the tab\'s only open one', async () => {
      const { question, closed } = await open('t1');
      expect(closed).toEqual([]);
      expect(question).toMatchObject({ tab_id: 't1', project_id: projectId, conversation_id: conversationId, user_id: userId, kind: 'choice', payload, tool_use_id: 'toolu_1', status: 'open', answer: null, closed_at: null });
      expect((await repo.findOpenForTab('t1'))?.id).toBe(question.id);
      expect((await repo.findByIdForUser(question.id, userId))?.id).toBe(question.id);
      expect(await repo.findByIdForUser(question.id, otherUserId)).toBeUndefined();
    });

    it('a new question on the same tab closes the previous one as answered_in_tab', async () => {
      const first = (await open('t2')).question;
      const { question: second, closed } = await open('t2');
      expect(closed).toEqual([expect.objectContaining({ id: first.id, status: 'answered_in_tab', user_id: userId })]);
      expect(closed[0]!.closed_at).not.toBeNull();
      expect((await repo.findOpenForTab('t2'))?.id).toBe(second.id);
    });

    it('claims once, only for the owner, and keeps the answer', async () => {
      const { question } = await open('t3');
      expect(await repo.claim(question.id, otherUserId, { answers: [{ selected: [0] }] })).toBeUndefined();
      const claimed = await repo.claim(question.id, userId, { answers: [{ selected: [1] }] });
      expect(claimed).toMatchObject({ status: 'answered', answer: { answers: [{ selected: [1] }] }, answered_by: userId });
      expect(claimed?.answered_at).not.toBeNull();
      expect(await repo.claim(question.id, userId, { answers: [{ selected: [0] }] })).toBeUndefined(); // the double click
    });

    it('marks a claimed question failed, and only a claimed one', async () => {
      const { question } = await open('t4');
      expect(await repo.markFailed(question.id, 'MACHINE_OFFLINE')).toBeUndefined();
      await repo.claim(question.id, userId, { answers: [{ selected: [0] }] });
      expect(await repo.markFailed(question.id, 'MACHINE_OFFLINE')).toMatchObject({ status: 'failed', error_code: 'MACHINE_OFFLINE' });
    });

    it('closing a tab: an open question expires, an answered one keeps its status and gets closed_at', async () => {
      const { question: a } = await open('t5');
      await repo.claim(a.id, userId, { answers: [{ selected: [0] }] });
      const closedAnswered = await repo.closeForTab('t5', 'answered_in_tab');
      expect(closedAnswered).toEqual([expect.objectContaining({ id: a.id, status: 'answered' })]);
      expect(closedAnswered[0]!.closed_at).not.toBeNull();
      expect(await repo.closeForTab('t5', 'answered_in_tab')).toEqual([]); // nothing left to close

      const { question: b } = await open('t6');
      expect(await repo.closeForTab('t6', 'expired')).toEqual([expect.objectContaining({ id: b.id, status: 'expired' })]);
      expect(await repo.findOpenForTab('t6')).toBeUndefined();
    });

    it('lists a conversation oldest first, and what the concierge was not told yet, once', async () => {
      const before = await repo.listByConversation(conversationId);
      const { question } = await open('t7');
      const listed = await repo.listByConversation(conversationId);
      expect(listed.map((q) => q.id)).toEqual([...before.map((q) => q.id), question.id]);

      await repo.claim(question.id, userId, { answers: [{ selected: [0] }] });
      const toInject = await repo.listToInject(conversationId);
      expect(toInject.map((q) => q.id)).toContain(question.id);
      expect(toInject.every((q) => q.status === 'answered' && q.injected_at === null)).toBe(true);
      await repo.markInjected(toInject.map((q) => q.id));
      expect(await repo.listToInject(conversationId)).toEqual([]);
    });

    it('findLatestActiveForProject: the most recently active non-archived conversation', async () => {
      expect((await chat.findLatestActiveForProject(projectId))?.id).toBe(conversationId);
      await chat.archive(conversationId);
      expect(await chat.findLatestActiveForProject(projectId)).toBeUndefined();
      expect(await chat.findLatestActiveForProject('nope')).toBeUndefined();
    });
  });
  ```
  (The last test archives the conversation, so it stays the last test in the file.)

- [ ] **Step 4: Run to verify it fails.** `NODE 'cd apps/server && npx prisma migrate deploy && cd ../.. && TERMHUB_DB_TESTS=1 npm test -w @termhub/server -- src/db/repositories/tab-questions.db.test.ts'` → FAIL: module `./tab-questions.js` not found.

- [ ] **Step 5: Implement** `apps/server/src/db/repositories/tab-questions.ts`:
  ```ts
  import type { PrismaClient } from '../prisma.js';
  import type { Prisma, TabQuestion as PrismaTabQuestion } from '../../generated/prisma/client.js';
  import { newId } from '../../lib/ids.js';
  import type { ChoiceAnswer, ChoicePayload, PermissionAnswer, PermissionPayload, TabQuestionKind } from '../../chat/tab-question-payload.js';

  export type TabQuestionStatus = 'open' | 'answered' | 'answered_in_tab' | 'expired' | 'failed';
  /** How a question leaves the screen when the chat did not answer it: the person answered in the tab
   * (or anything else happened there), or the tab is gone. */
  export type TabQuestionCloseStatus = 'answered_in_tab' | 'expired';

  export interface TabQuestion {
    id: string;
    tab_id: string;
    project_id: string;
    conversation_id: string;
    /** The conversation's owner: whom the bus events and the push go to, and who may answer. */
    user_id: string;
    kind: TabQuestionKind;
    payload: ChoicePayload | PermissionPayload;
    tool_use_id: string | null;
    status: TabQuestionStatus;
    answer: ChoiceAnswer | PermissionAnswer | null;
    error_code: string | null;
    answered_by: string | null;
    answered_at: string | null;
    closed_at: string | null;
    injected_at: string | null;
    created_at: string;
  }

  export interface OpenTabQuestionInput {
    tab_id: string;
    project_id: string;
    conversation_id: string;
    kind: TabQuestionKind;
    payload: ChoicePayload | PermissionPayload;
    tool_use_id: string | null;
  }

  const withOwner = { conversation: { select: { userId: true } } } as const;
  type Row = PrismaTabQuestion & { conversation: { userId: string } };

  const iso = (d: Date | null) => d?.toISOString() ?? null;
  const mapQuestion = (q: Row): TabQuestion => ({
    id: q.id,
    tab_id: q.tabId,
    project_id: q.projectId,
    conversation_id: q.conversationId,
    user_id: q.conversation.userId,
    kind: q.kind as TabQuestionKind,
    payload: q.payload as unknown as ChoicePayload | PermissionPayload,
    tool_use_id: q.toolUseId,
    status: q.status as TabQuestionStatus,
    answer: (q.answer ?? null) as unknown as ChoiceAnswer | PermissionAnswer | null,
    error_code: q.errorCode,
    answered_by: q.answeredBy,
    answered_at: iso(q.answeredAt),
    closed_at: iso(q.closedAt),
    injected_at: iso(q.injectedAt),
    created_at: q.createdAt.toISOString(),
  });

  /**
   * Closes whatever of this tab is still on its screen: an `open` question becomes `status`, and one
   * the chat already answered keeps `answered` and only gets its `closed_at` (spec §5.2, "Mirror"). The
   * status filter sits in the UPDATE itself, so a claim racing this close either lands first (the row
   * stays `answered`) or finds the row closed and loses.
   */
  async function closeIn(tx: Prisma.TransactionClient, tabId: string, status: TabQuestionCloseStatus, now: Date): Promise<TabQuestion[]> {
    const rows = await tx.tabQuestion.findMany({ where: { tabId, closedAt: null, status: { in: ['open', 'answered'] } }, select: { id: true } });
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    await tx.tabQuestion.updateMany({ where: { id: { in: ids }, status: 'open' }, data: { status, closedAt: now } });
    await tx.tabQuestion.updateMany({ where: { id: { in: ids }, closedAt: null }, data: { closedAt: now } });
    const after = await tx.tabQuestion.findMany({ where: { id: { in: ids } }, include: withOwner, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    return after.map(mapQuestion);
  }

  /**
   * Who may read what: methods keyed by a tab or a conversation trust the id (the ingest path derives
   * them from a hook token and the tab row; the concierge from the conversation it runs). Methods keyed
   * by an id a client sends (`findByIdForUser`, `claim`) filter by the owning conversation's `user_id`
   * in SQL, so another user's question and no question at all are the same `undefined`.
   */
  export class TabQuestionsRepository {
    constructor(private db: PrismaClient) {}

    /** A new question for a tab: whatever the tab still had open is closed first, in the same transaction. */
    async open(input: OpenTabQuestionInput, now = new Date()): Promise<{ question: TabQuestion; closed: TabQuestion[] }> {
      return this.db.$transaction(async (tx) => {
        const closed = await closeIn(tx, input.tab_id, 'answered_in_tab', now);
        const row = await tx.tabQuestion.create({
          data: {
            id: newId(),
            tabId: input.tab_id,
            projectId: input.project_id,
            conversationId: input.conversation_id,
            kind: input.kind,
            payload: input.payload as never,
            toolUseId: input.tool_use_id,
            status: 'open',
            createdAt: now,
          },
          include: withOwner,
        });
        return { question: mapQuestion(row), closed };
      });
    }

    async closeForTab(tabId: string, status: TabQuestionCloseStatus, now = new Date()): Promise<TabQuestion[]> {
      return this.db.$transaction((tx) => closeIn(tx, tabId, status, now));
    }

    async findOpenForTab(tabId: string): Promise<TabQuestion | undefined> {
      const row = await this.db.tabQuestion.findFirst({ where: { tabId, status: 'open' }, include: withOwner, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
      return row ? mapQuestion(row) : undefined;
    }

    async findByIdForUser(id: string, userId: string): Promise<TabQuestion | undefined> {
      const row = await this.db.tabQuestion.findFirst({ where: { id, conversation: { userId } }, include: withOwner });
      return row ? mapQuestion(row) : undefined;
    }

    /** `open → answered`, conditionally: a double click, a second device or a close that got there first all match nothing. */
    async claim(id: string, userId: string, answer: ChoiceAnswer | PermissionAnswer, now = new Date()): Promise<TabQuestion | undefined> {
      const { count } = await this.db.tabQuestion.updateMany({
        where: { id, status: 'open', conversation: { userId } },
        data: { status: 'answered', answer: answer as never, answeredBy: userId, answeredAt: now },
      });
      return count === 0 ? undefined : this.findByIdForUser(id, userId);
    }

    /** The keys never reached the tab: only a claimed row can fail. */
    async markFailed(id: string, code: string): Promise<TabQuestion | undefined> {
      const { count } = await this.db.tabQuestion.updateMany({ where: { id, status: 'answered' }, data: { status: 'failed', errorCode: code } });
      if (count === 0) return undefined;
      const row = await this.db.tabQuestion.findUnique({ where: { id }, include: withOwner });
      return row ? mapQuestion(row) : undefined;
    }

    /** The newest `limit`, returned oldest-first — the same window rule as `ChatRepository.listMessages`. */
    async listByConversation(conversationId: string, limit = 200): Promise<TabQuestion[]> {
      const rows = await this.db.tabQuestion.findMany({ where: { conversationId }, include: withOwner, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit });
      return rows.reverse().map(mapQuestion);
    }

    /** Answered from the chat and not yet told to the concierge (spec §5.5), in the order they were answered. */
    async listToInject(conversationId: string): Promise<TabQuestion[]> {
      const rows = await this.db.tabQuestion.findMany({ where: { conversationId, status: 'answered', injectedAt: null }, include: withOwner, orderBy: [{ answeredAt: 'asc' }, { id: 'asc' }] });
      return rows.map(mapQuestion);
    }

    async markInjected(ids: string[], now = new Date()): Promise<void> {
      if (ids.length === 0) return;
      await this.db.tabQuestion.updateMany({ where: { id: { in: ids }, injectedAt: null }, data: { injectedAt: now } });
    }
  }
  ```
  In `chat.ts`, after `getOrCreateForProject`:
  ```ts
  /**
   * Where a tab's question is pushed (spec 2026-09-25 §5.2): the project's most recently active
   * conversation that is still on screen somewhere — not archived, not tab-bound. A project nobody has
   * chatted in yet has none, and its tabs' questions stay in the tab.
   */
  async findLatestActiveForProject(projectId: string): Promise<ChatConversation | undefined> {
    const row = await this.db.chatConversation.findFirst({
      where: { projectId, tabId: null, archivedAt: null },
      orderBy: [{ lastMessageAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }, { id: 'desc' }],
    });
    return row ? mapConversation(row) : undefined;
  }
  ```
  In `index.ts`: `import { TabQuestionsRepository } from './tab-questions.js';`, add `tabQuestions: TabQuestionsRepository;` to `Repositories` (after `chatGrants`), `tabQuestions: new TabQuestionsRepository(db),` to `createRepositories`, and `export type { TabQuestion, TabQuestionStatus } from './tab-questions.js';` next to the other chat exports.

- [ ] **Step 6: Run to verify it passes.** The db test command above → PASS. `NODE 'npm run typecheck -w @termhub/server'` → no errors.

- [ ] **Step 7: Commit**
  ```bash
  git add apps/server/prisma/schema.prisma apps/server/prisma/migrations/20260925150000_tab_questions apps/server/src/db/repositories/tab-questions.ts apps/server/src/db/repositories/tab-questions.db.test.ts apps/server/src/db/repositories/chat.ts apps/server/src/db/repositories/index.ts
  git commit -F - <<'MSG'
  Tab questions: store them per project conversation

  Additive migration (one table): the previous release never reads it.

  Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
  MSG
  ```

---

### Task 5: Ciclo de vida: abrir/fechar no ingest + eventos do bus + contrato mobile + push

**Files:**
- Create: `apps/server/src/db/repositories/tab-questions-view.ts`
- Create: `apps/server/src/chat/tab-questions.ts`
- Create: `apps/server/src/chat/tab-questions.test.ts`
- Modify: `apps/server/src/chat/bus.ts` (the `ChatEvent` union)
- Modify: `apps/server/src/monitor/ingest.ts`, `apps/server/src/monitor/ingest.test.ts`
- Modify: `apps/server/src/app.ts` (~line 240, next to `startAgentUpdateScheduler`, and the `onClose` hook)
- Modify: `packages/mobile-api/src/events.ts`, `packages/mobile-api/src/events.test.ts`
- Modify: `apps/server/src/mobile/events-parity.test.ts`
- Modify: `apps/server/src/mobile/push.ts`, `apps/server/src/mobile/push-text.ts`, `apps/server/src/mobile/push.test.ts`, `apps/server/src/mobile/push-text.test.ts`

**Interfaces:**
- Consumes: `Interpreted.question` (Task 3); `TabQuestionsRepository`, `ChatRepository.findLatestActiveForProject` (Task 4).
- Produces:
  ```ts
  // db/repositories/tab-questions-view.ts
  export interface TabQuestionView {
    id: string; tab_id: string; tab_name: string | null; kind: TabQuestionKind;
    payload: ChoicePayload | PermissionPayload; status: TabQuestionStatus;
    answer: ChoiceAnswer | PermissionAnswer | null; error_code: string | null;
    created_at: string; answered_at: string | null; closed_at: string | null;
  }
  export function describeTabQuestions(repos: Pick<Repositories, 'tabs'>, rows: TabQuestion[], userId: string): Promise<TabQuestionView[]>;
  // chat/bus.ts — three new ChatEvent members, each carrying the whole card:
  | { type: 'tab_question' | 'tab_question_answered' | 'tab_question_closed'; user_id: string; conversation_id: string; question: TabQuestionView }
  // chat/tab-questions.ts
  export function closesOpenQuestion(next: Interpreted): boolean;
  export function publishTabQuestions(repos: Pick<Repositories, 'tabs'>, type: TabQuestionEventType, rows: TabQuestion[]): Promise<TabQuestionView[]>;
  export function openTabQuestion(repos: Repositories, tab: Pick<Tab, 'id' | 'project_id'>, input: TabQuestionInput): Promise<TabQuestion | null>;
  export function closeTabQuestions(repos: Repositories, tabId: string, status: TabQuestionCloseStatus): Promise<TabQuestion[]>;
  export function noteHookEvent(repos: Repositories, log: Pick<FastifyBaseLogger, 'info' | 'warn'>, tab: Tab, next: Interpreted): Promise<void>; // never throws
  export function startTabQuestionExpiry(repos: Repositories, log: Pick<FastifyBaseLogger, 'warn'>): () => void;
  // packages/mobile-api/src/events.ts
  export const tabQuestionSchema; // discriminated on `kind`, mirrors TabQuestionView
  // push-text.ts
  export function tabQuestionText(ctx: PushContext, kind: 'choice' | 'permission'): PushText;
  ```
- Lifecycle rule (spec §5.2 "Close", made concrete): an interpreted event with a `question` opens (closing the tab's previous one); any other interpreted event closes the tab's open question as `answered_in_tab`, **except** a `Notification` (it only ever says "still waiting" — the `permission_prompt` that follows every question, or a later reminder) and an `AskUserQuestion` `PermissionRequest` (the question's own companion). Events the interpreter ignores (`null`) change nothing. A removed tab closes as `expired`.
- Push: kind of the history row stays `'confirmation'` (the app's `notificationRow` enum only knows `confirmation | reply | device_request`, so an older app keeps parsing its history); `data = { kind: 'tab_question', conversation_id, project_id, tab_question_id }`; the text names the project and the tab, never the question.

- [ ] **Step 1: Write the view.** `apps/server/src/db/repositories/tab-questions-view.ts`:
  ```ts
  import type { ChoiceAnswer, ChoicePayload, PermissionAnswer, PermissionPayload, TabQuestionKind } from '../../chat/tab-question-payload.js';
  import type { Repositories } from './index.js';
  import type { TabQuestion, TabQuestionStatus } from './tab-questions.js';

  /** A tab's question as both clients render it (`GET /chat`, the bus, the phone): the row minus what
   * only the server needs, plus the tab's name at read time (null once the tab is gone). */
  export interface TabQuestionView {
    id: string;
    tab_id: string;
    tab_name: string | null;
    kind: TabQuestionKind;
    payload: ChoicePayload | PermissionPayload;
    status: TabQuestionStatus;
    answer: ChoiceAnswer | PermissionAnswer | null;
    error_code: string | null;
    created_at: string;
    answered_at: string | null;
    closed_at: string | null;
  }

  /** Names resolved owner-scoped, in one batched read: a tab the user cannot see names nothing. */
  export async function describeTabQuestions(repos: Pick<Repositories, 'tabs'>, rows: TabQuestion[], userId: string): Promise<TabQuestionView[]> {
    const ids = [...new Set(rows.map((r) => r.tab_id))];
    const tabs = ids.length ? await repos.tabs.findByIdsForOwner(ids, userId) : [];
    const nameOf = new Map(tabs.map((t) => [t.id, t.name]));
    return rows.map((r) => ({
      id: r.id,
      tab_id: r.tab_id,
      tab_name: nameOf.get(r.tab_id) ?? null,
      kind: r.kind,
      payload: r.payload,
      status: r.status,
      answer: r.answer,
      error_code: r.error_code,
      created_at: r.created_at,
      answered_at: r.answered_at,
      closed_at: r.closed_at,
    }));
  }
  ```

- [ ] **Step 2: Add the bus events.** In `apps/server/src/chat/bus.ts` add `import type { TabQuestionView } from '../db/repositories/tab-questions-view.js';` and, before the closing `;` of `ChatEvent`:
  ```ts
    /** A tab asked something (spec 2026-09-25 §5.2): the whole card. Pushed to the project's most
     * recently active conversation; its text is the question itself, never a screen. */
    | { type: 'tab_question'; user_id: string; conversation_id: string; question: TabQuestionView }
    /** The chat answered it — or the answer could not be typed (`status: 'failed'`). */
    | { type: 'tab_question_answered'; user_id: string; conversation_id: string; question: TabQuestionView }
    /** It left the tab's screen: answered there, replaced, or the tab is gone. An answered card stays answered. */
    | { type: 'tab_question_closed'; user_id: string; conversation_id: string; question: TabQuestionView }
  ```

- [ ] **Step 3: Write the failing service test** `apps/server/src/chat/tab-questions.test.ts`:
  ```ts
  import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
  import type { Repositories } from '../db/repositories/index.js';
  import type { TabQuestion } from '../db/repositories/tab-questions.js';
  import type { Tab } from '../db/repositories/types.js';
  import { monitorBus } from '../monitor/bus.js';
  import type { Interpreted } from '../monitor/state.js';
  import { chatBus, type ChatEvent } from './bus.js';
  import { closesOpenQuestion, noteHookEvent, openTabQuestion, startTabQuestionExpiry } from './tab-questions.js';

  const tab = { id: 't1', project_id: 'p1', machine_id: 'm1', name: 'api' } as Tab;
  const payload = { questions: [{ question: 'Qual cor?', header: 'Cor', multi_select: false, options: [{ label: 'Azul', description: '', recommended: true }, { label: 'Verde', description: '', recommended: false }] }] };
  const row = (over: Partial<TabQuestion> = {}): TabQuestion => ({
    id: 'q1', tab_id: 't1', project_id: 'p1', conversation_id: 'c1', user_id: 'u1', kind: 'choice', payload, tool_use_id: 'toolu_1',
    status: 'open', answer: null, error_code: null, answered_by: null, answered_at: null, closed_at: null, injected_at: null, created_at: '2026-09-25T12:00:00.000Z', ...over,
  });
  const choice: Interpreted = { kind: 'working', text: null, activity: 'planning', verb: null, meta: { event: 'PreToolUse', tool: 'AskUserQuestion' }, question: { kind: 'choice', payload, tool_use_id: 'toolu_1' } };
  const log = () => ({ info: vi.fn(), warn: vi.fn() });

  function fakeRepos(opts: { conversation?: { id: string; user_id: string } | null; closed?: TabQuestion[]; opened?: TabQuestion } = {}) {
    const conversation = opts.conversation === undefined ? { id: 'c1', user_id: 'u1' } : (opts.conversation ?? undefined);
    return {
      chat: { findLatestActiveForProject: vi.fn(async () => conversation) },
      tabQuestions: {
        open: vi.fn(async () => ({ question: opts.opened ?? row(), closed: opts.closed ?? [] })),
        closeForTab: vi.fn(async () => opts.closed ?? []),
      },
      tabs: { findByIdsForOwner: vi.fn(async (ids: string[], owner: string) => (owner === 'u1' && ids.includes('t1') ? [tab] : [])) },
    };
  }
  const asRepos = (r: ReturnType<typeof fakeRepos>) => r as unknown as Repositories;

  let events: ChatEvent[];
  let unsubscribe: () => void;
  beforeEach(() => {
    events = [];
    unsubscribe = chatBus.subscribe((e) => events.push(e));
  });
  afterEach(() => unsubscribe());

  describe('closesOpenQuestion', () => {
    it.each([
      ['a tool call', { kind: 'working', text: null, meta: { event: 'PreToolUse', tool: 'Edit' } }, true],
      ['a finished turn', { kind: 'waiting_input', text: null, meta: { event: 'Stop' } }, true],
      ['a new prompt', { kind: 'working', text: null, meta: { event: 'UserPromptSubmit' } }, true],
      ['the permission_prompt notification', { kind: 'waiting_permission', text: 'x', meta: { event: 'Notification', type: 'permission_prompt' } }, false],
      ['an idle reminder', { kind: 'waiting_input', text: 'x', meta: { event: 'Notification', type: 'idle_prompt' } }, false],
      ['AskUserQuestion\'s own PermissionRequest', { kind: 'waiting_permission', text: null, meta: { event: 'PermissionRequest', tool: 'AskUserQuestion' } }, false],
      ['an event that opens a question', choice, false],
    ] as [string, Interpreted, boolean][])('%s → %s', (_l, next, closes) => {
      expect(closesOpenQuestion(next)).toBe(closes);
    });
  });

  describe('openTabQuestion', () => {
    it('opens in the project\'s latest conversation, closing and announcing the one it replaces', async () => {
      const replaced = row({ id: 'q0', status: 'answered_in_tab', closed_at: '2026-09-25T12:00:00.000Z' });
      const repos = fakeRepos({ closed: [replaced], opened: row({ id: 'q1' }) });
      const q = await openTabQuestion(asRepos(repos), tab, { kind: 'choice', payload, tool_use_id: 'toolu_1' });
      expect(q?.id).toBe('q1');
      expect(repos.tabQuestions.open).toHaveBeenCalledWith({ tab_id: 't1', project_id: 'p1', conversation_id: 'c1', kind: 'choice', payload, tool_use_id: 'toolu_1' });
      expect(events.map((e) => [e.type, 'question' in e ? e.question.id : null])).toEqual([
        ['tab_question_closed', 'q0'],
        ['tab_question', 'q1'],
      ]);
      expect(events[1]).toMatchObject({ user_id: 'u1', conversation_id: 'c1', question: { tab_name: 'api', status: 'open', payload } });
    });

    it('a project with no conversation gets nothing, but the tab\'s old question still closes', async () => {
      const repos = fakeRepos({ conversation: null, closed: [row({ id: 'q0', status: 'answered_in_tab' })] });
      expect(await openTabQuestion(asRepos(repos), tab, { kind: 'permission', payload: { tool_name: 'Bash' }, tool_use_id: null })).toBeNull();
      expect(repos.tabQuestions.open).not.toHaveBeenCalled();
      expect(repos.tabQuestions.closeForTab).toHaveBeenCalledWith('t1', 'answered_in_tab');
      expect(events.map((e) => e.type)).toEqual(['tab_question_closed']);
    });
  });

  describe('noteHookEvent', () => {
    it('opens on a question, closes on anything else, leaves it alone on a notification', async () => {
      const repos = fakeRepos();
      await noteHookEvent(asRepos(repos), log(), tab, choice);
      expect(repos.tabQuestions.open).toHaveBeenCalledTimes(1);
      await noteHookEvent(asRepos(repos), log(), tab, { kind: 'waiting_permission', text: 'x', meta: { event: 'Notification', type: 'permission_prompt' } });
      expect(repos.tabQuestions.closeForTab).not.toHaveBeenCalled();
      await noteHookEvent(asRepos(repos), log(), tab, { kind: 'working', text: null, meta: { event: 'PreToolUse', tool: 'Bash' } });
      expect(repos.tabQuestions.closeForTab).toHaveBeenCalledWith('t1', 'answered_in_tab');
    });

    it('never throws, and logs the failure by code and ids only', async () => {
      const repos = fakeRepos();
      repos.tabQuestions.open.mockRejectedValue(Object.assign(new Error('Qual cor? secret'), { code: 'P2002' }));
      const l = log();
      await expect(noteHookEvent(asRepos(repos), l, tab, choice)).resolves.toBeUndefined();
      expect(l.warn).toHaveBeenCalledWith({ tabId: 't1', code: 'P2002' }, 'tab question bookkeeping failed');
    });

    it('logs an opened question by id, kind and count — never its text', async () => {
      const l = log();
      await noteHookEvent(asRepos(fakeRepos()), l, tab, choice);
      expect(l.info).toHaveBeenCalledWith({ tabId: 't1', tabQuestionId: 'q1', kind: 'choice', questions: 1 }, 'tab question opened');
      expect(JSON.stringify(l.info.mock.calls)).not.toContain('Qual cor');
    });
  });

  describe('startTabQuestionExpiry', () => {
    it('a removed tab expires its question; an opened or renamed one does not', async () => {
      const repos = fakeRepos({ closed: [row({ status: 'expired' })] });
      const stop = startTabQuestionExpiry(asRepos(repos), log());
      monitorBus.publishLifecycle({ kind: 'upsert', tab, project_id: 'p1', machine_id: 'm1', owner_id: 'u1' });
      monitorBus.publishLifecycle({ kind: 'removed', tab_id: 't1', project_id: 'p1', machine_id: 'm1', owner_id: 'u1' });
      await new Promise((r) => setTimeout(r, 10));
      stop();
      expect(repos.tabQuestions.closeForTab).toHaveBeenCalledTimes(1);
      expect(repos.tabQuestions.closeForTab).toHaveBeenCalledWith('t1', 'expired');
      expect(events.map((e) => e.type)).toEqual(['tab_question_closed']);
    });
  });
  ```

- [ ] **Step 4: Run to verify it fails.** `NODE 'npm test -w @termhub/server -- src/chat/tab-questions.test.ts'` → FAIL: module not found.

- [ ] **Step 5: Implement** `apps/server/src/chat/tab-questions.ts`:
  ```ts
  import type { FastifyBaseLogger } from 'fastify';
  import type { Repositories } from '../db/repositories/index.js';
  import type { TabQuestion, TabQuestionCloseStatus } from '../db/repositories/tab-questions.js';
  import { describeTabQuestions, type TabQuestionView } from '../db/repositories/tab-questions-view.js';
  import type { Tab } from '../db/repositories/types.js';
  import { monitorBus } from '../monitor/bus.js';
  import type { Interpreted } from '../monitor/state.js';
  import { chatBus } from './bus.js';
  import { failureLabel } from './service.js';
  import type { ChoicePayload, TabQuestionInput } from './tab-question-payload.js';

  export type TabQuestionEventType = 'tab_question' | 'tab_question_answered' | 'tab_question_closed';

  /**
   * Whether a hook event means the tab moved past its open question (spec 2026-09-25 §5.2). A
   * `Notification` never does: it only ever says the tab is still waiting — the `permission_prompt`
   * that follows every question, or a reminder a minute later. Nor does AskUserQuestion's own
   * `PermissionRequest`, the question's companion. An event that opens a question closes the previous
   * one itself (`open`).
   */
  export function closesOpenQuestion(next: Interpreted): boolean {
    if (next.question) return false;
    if (next.meta.event === 'Notification') return false;
    if (next.meta.event === 'PermissionRequest' && next.meta.tool === 'AskUserQuestion') return false;
    return true;
  }

  /** Tells every open screen of each row's conversation owner. Resolves the views it published. */
  export async function publishTabQuestions(repos: Pick<Repositories, 'tabs'>, type: TabQuestionEventType, rows: TabQuestion[]): Promise<TabQuestionView[]> {
    const views: TabQuestionView[] = [];
    for (const row of rows) {
      const [question] = await describeTabQuestions(repos, [row], row.user_id);
      chatBus.publish({ type, user_id: row.user_id, conversation_id: row.conversation_id, question });
      views.push(question);
    }
    return views;
  }

  /** Closes the tab's question (if any) and says so. */
  export async function closeTabQuestions(repos: Repositories, tabId: string, status: TabQuestionCloseStatus): Promise<TabQuestion[]> {
    const closed = await repos.tabQuestions.closeForTab(tabId, status);
    await publishTabQuestions(repos, 'tab_question_closed', closed);
    return closed;
  }

  /**
   * A tab asked something: the row goes into the project's most recently active conversation and the
   * card onto every screen showing it. A project nobody chats in gets nothing — the question stays in
   * the tab, as before — but whatever the tab had open is still closed: the screen moved on.
   */
  export async function openTabQuestion(repos: Repositories, tab: Pick<Tab, 'id' | 'project_id'>, input: TabQuestionInput): Promise<TabQuestion | null> {
    const conversation = await repos.chat.findLatestActiveForProject(tab.project_id);
    if (!conversation) {
      await closeTabQuestions(repos, tab.id, 'answered_in_tab');
      return null;
    }
    const { question, closed } = await repos.tabQuestions.open({ tab_id: tab.id, project_id: tab.project_id, conversation_id: conversation.id, kind: input.kind, payload: input.payload, tool_use_id: input.tool_use_id });
    await publishTabQuestions(repos, 'tab_question_closed', closed);
    await publishTabQuestions(repos, 'tab_question', [question]);
    return question;
  }

  /**
   * The ingest step's hand-off (spec §4.2): after the tab row is updated, a question opens and any
   * other event closes. Never throws — a hook event is already recorded, and bookkeeping for a card
   * must not turn it into a failed POST. Logs ids, kind and counts; never the question.
   */
  export async function noteHookEvent(repos: Repositories, log: Pick<FastifyBaseLogger, 'info' | 'warn'>, tab: Tab, next: Interpreted): Promise<void> {
    try {
      if (next.question) {
        const q = await openTabQuestion(repos, tab, next.question);
        if (q) log.info({ tabId: tab.id, tabQuestionId: q.id, kind: q.kind, questions: q.kind === 'choice' ? (q.payload as ChoicePayload).questions.length : 1 }, 'tab question opened');
      } else if (closesOpenQuestion(next)) {
        await closeTabQuestions(repos, tab.id, 'answered_in_tab');
      }
    } catch (err) {
      log.warn({ tabId: tab.id, code: failureLabel(err) }, 'tab question bookkeeping failed');
    }
  }

  /** A removed tab (closed from the UI, by the concierge, or with its machine) expires its question. */
  export function startTabQuestionExpiry(repos: Repositories, log: Pick<FastifyBaseLogger, 'warn'>): () => void {
    return monitorBus.subscribeLifecycle((event) => {
      if (event.kind !== 'removed') return;
      void closeTabQuestions(repos, event.tab_id, 'expired').catch((err) => log.warn({ tabId: event.tab_id, code: failureLabel(err) }, 'tab question expiry failed'));
    });
  }
  ```

- [ ] **Step 6: Run to verify it passes.** `NODE 'npm test -w @termhub/server -- src/chat/tab-questions.test.ts'` → PASS.

- [ ] **Step 7: Hook the ingest.** Add to `apps/server/src/monitor/ingest.test.ts`, below the `vi.mock('./bus.js', …)` line:
  ```ts
  const note = vi.fn(async (..._args: unknown[]) => undefined);
  vi.mock('../chat/tab-questions.js', () => ({ noteHookEvent: (...a: unknown[]) => note(...a) }));
  ```
  and append:
  ```ts
  describe('ingestHookEvent — tab questions', () => {
    const ask = { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_use_id: 'toolu_1', tool_input: { questions: [{ question: 'Qual cor?', header: 'Cor', options: [{ label: 'Azul (Recommended)', description: 'Calma' }, { label: 'Verde', description: 'Fresca' }], multiSelect: false }] } };

    it('hands the interpretation, question included, to the tab-question service — even on the light path that writes nothing', async () => {
      note.mockClear();
      const { r, recordEvent, setActivity } = repos(tab({ state: 'working', activity: 'planning' }));
      await ingestHookEvent(r, log, { machineId: 'm1', tool: 'claude', session: 'th-t1', event: ask });
      expect(recordEvent).not.toHaveBeenCalled();
      expect(setActivity).not.toHaveBeenCalled();
      expect(note).toHaveBeenCalledTimes(1);
      const [, , passedTab, interpreted] = note.mock.calls[0]!;
      expect(passedTab).toMatchObject({ id: 't1' });
      expect(interpreted).toMatchObject({ question: { kind: 'choice', tool_use_id: 'toolu_1' } });
    });

    it('hands over the updated tab after a full state change', async () => {
      note.mockClear();
      const { r } = repos(tab({ state: 'waiting_permission' }));
      await ingestHookEvent(r, log, pre('Bash'));
      expect(note.mock.calls[0]![2]).toMatchObject({ id: 't1', state: 'working' });
    });

    it('does not call the service for an event the interpreter ignores, nor for an unknown session', async () => {
      note.mockClear();
      await ingestHookEvent(repos(tab({})).r, log, { machineId: 'm1', tool: 'claude', session: 'th-t1', event: { hook_event_name: 'SubagentStop' } });
      const none = repos(tab({}));
      (none.r.tabs.findByTmuxSession as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
      await ingestHookEvent(none.r, log, pre('Edit'));
      expect(note).not.toHaveBeenCalled();
    });

    it('never logs the question', async () => {
      const spy = { info: vi.fn(), debug: vi.fn(), warn: vi.fn() };
      await ingestHookEvent(repos(tab({ state: 'waiting_input' })).r, spy as never, { machineId: 'm1', tool: 'claude', session: 'th-t1', event: ask });
      expect(JSON.stringify([spy.info.mock.calls, spy.debug.mock.calls])).not.toContain('Qual cor');
    });
  });
  ```
  Run `NODE 'npm test -w @termhub/server -- src/monitor/ingest.test.ts'` → FAIL (`note` never called).

  Then restructure `ingestHookEvent` in `apps/server/src/monitor/ingest.ts` so every path reaches the hand-off. Add `import { noteHookEvent } from '../chat/tab-questions.js';` and replace the function with:
  ```ts
  export async function ingestHookEvent(
    repos: Repositories,
    log: FastifyBaseLogger,
    input: { machineId: string; tool: HookTool; session: string; event: unknown },
  ): Promise<IngestResult> {
    const tab = await repos.tabs.findByTmuxSession(input.machineId, input.session);
    if (!tab) return { ok: false, reason: 'unknown_session' };
    const interpreted = interpretHookEvent(input.tool, input.event);
    if (!interpreted) return { ok: false, reason: 'ignored' };
    const updated = await recordInterpretation(repos, log, tab, input.tool, interpreted);
    // After the tab row (spec 2026-09-25 §4.2): a question opens a card in the project's chat, any
    // other event closes the one on screen. Never throws.
    await noteHookEvent(repos, log, updated, interpreted);
    return { ok: true, tab: updated };
  }

  /** The tab's side of an interpreted event: the light activity path, or a recorded state. */
  async function recordInterpretation(repos: Repositories, log: FastifyBaseLogger, tab: Tab, tool: HookTool, interpreted: Interpreted): Promise<Tab> {
    // A tool (or spinner verb) change on a tab already working is not a state change: the light path
    // moves only the activity and its verb (no event row) and still tells the subscribers. The script
    // already posts only on a change; the equality check here is a defensive no-op for anything else.
    if (interpreted.activity !== undefined && tab.state === 'working' && interpreted.kind === 'working') {
      const verb = interpreted.verb ?? null;
      if (tab.activity === interpreted.activity && tab.activity_verb === verb) return tab;
      // Nothing updated: the tab stopped working (or is gone) between the read above and this write —
      // the conditional UPDATE is what decides, not the row we read. The full path takes it from here.
      const updated = await repos.tabs.setActivity(tab.id, interpreted.activity, verb);
      if (updated) {
        const machine = await repos.machines.findById(tab.machine_id);
        // the verb came off the person's screen: only whether there was one is logged
        log.debug({ tabId: tab.id, machineId: machine?.id, activity: interpreted.activity, hasVerb: verb !== null }, 'monitor: tab activity');
        publishTabChange(updated, tab.project_id, machine);
        return updated;
      }
    }
    return applyState(repos, log, tab, tool, interpreted);
  }
  ```
  Run it again → PASS (the existing activity tests too).

- [ ] **Step 8: Start the expiry listener.** In `apps/server/src/app.ts`: `import { startTabQuestionExpiry } from './chat/tab-questions.js';`, after `const stopAgentUpdates = startAgentUpdateScheduler(repos, fastify.log);` add `const stopTabQuestionExpiry = startTabQuestionExpiry(repos, fastify.log);`, and call `stopTabQuestionExpiry();` in the `onClose` hook after `stopAgentUpdates();`.

- [ ] **Step 9: Mobile contract.** In `packages/mobile-api/src/events.ts`, before `chatEventSchema`:
  ```ts
  /** Mirrors `TabQuestionView` (apps/server/src/db/repositories/tab-questions-view.ts): a question a tab
   * put to the person, with what the chat answered. `recommended` comes out of Claude Code's own label. */
  export const tabQuestionOption = z.object({ label: z.string(), description: z.string(), recommended: z.boolean() });
  export const tabQuestionItem = z.object({ question: z.string(), header: z.string(), multi_select: z.boolean(), options: z.array(tabQuestionOption) });
  export const tabQuestionStatus = z.enum(['open', 'answered', 'answered_in_tab', 'expired', 'failed']);
  const tabQuestionCommon = {
    id: z.string(),
    tab_id: z.string(),
    tab_name: z.string().nullable(),
    status: tabQuestionStatus,
    error_code: z.string().nullable(),
    created_at: z.string(),
    answered_at: z.string().nullable(),
    closed_at: z.string().nullable(),
  };
  export const tabQuestionSchema = z.discriminatedUnion('kind', [
    z.object({
      ...tabQuestionCommon,
      kind: z.literal('choice'),
      payload: z.object({ questions: z.array(tabQuestionItem) }),
      answer: z.object({ answers: z.array(z.object({ selected: z.array(z.number().int()), text: z.string().optional() })) }).nullable(),
    }),
    z.object({
      ...tabQuestionCommon,
      kind: z.literal('permission'),
      payload: z.object({ tool_name: z.string() }),
      answer: z.object({ allow: z.boolean(), text: z.string().optional() }).nullable(),
    }),
  ]);
  ```
  and add to the `chatEventSchema` union (after `granted_action`):
  ```ts
  z.object({ type: z.literal('tab_question'), user_id: z.string(), conversation_id: z.string(), question: tabQuestionSchema }),
  z.object({ type: z.literal('tab_question_answered'), user_id: z.string(), conversation_id: z.string(), question: tabQuestionSchema }),
  z.object({ type: z.literal('tab_question_closed'), user_id: z.string(), conversation_id: z.string(), question: tabQuestionSchema }),
  ```
  In `packages/mobile-api/src/chat.ts` append:
  ```ts
  /** `POST chat/tab-questions/:id/answer`. The server checks it against the question itself (count,
   * options, one of picked/typed); this is the shape the app sends. No PIN (spec 2026-09-25 §2). */
  export const tabQuestionAnswerBody = z.union([
    z.object({ answers: z.array(z.object({ selected: z.array(z.number().int().min(0).max(3)).max(4), text: z.string().max(2000).optional() })).min(1).max(4) }),
    z.object({ allow: z.boolean(), text: z.string().max(2000).optional() }),
  ]);
  /** `GET chat/tab-questions/:id/screen`: the last lines of the tab, live, for a permission card. */
  export const tabQuestionScreenResponse = z.object({ text: z.string() });
  ```
  Add to `packages/mobile-api/src/events.test.ts`:
  ```ts
  import { tabQuestionSchema } from './events.js';

  it('parses both kinds of tab question and refuses a payload of the other kind', () => {
    const common = { id: 'q1', tab_id: 't1', tab_name: 'api', status: 'open', error_code: null, created_at: '2026-09-25T12:00:00.000Z', answered_at: null, closed_at: null };
    expect(tabQuestionSchema.safeParse({ ...common, kind: 'choice', payload: { questions: [{ question: 'Q?', header: 'Q', multi_select: false, options: [{ label: 'a', description: '', recommended: true }] }] }, answer: null }).success).toBe(true);
    expect(tabQuestionSchema.safeParse({ ...common, kind: 'permission', payload: { tool_name: 'Bash' }, answer: { allow: false, text: 'não' } }).success).toBe(true);
    expect(tabQuestionSchema.safeParse({ ...common, kind: 'permission', payload: { questions: [] }, answer: null }).success).toBe(false);
  });
  ```
  (Merge the import with the file's existing import from `./events.js` if there is one.) Run `NODE 'npm test -w @termhub/mobile-api && npm run build -w @termhub/mobile-api'` → PASS.

- [ ] **Step 10: Parity samples.** In `apps/server/src/mobile/events-parity.test.ts`, above `samples`:
  ```ts
  const question = {
    id: 'q1',
    tab_id: 't1',
    tab_name: 'api',
    kind: 'choice' as const,
    payload: { questions: [{ question: 'Qual cor?', header: 'Cor', multi_select: false, options: [{ label: 'Azul', description: 'Calma', recommended: true }, { label: 'Verde', description: '', recommended: false }] }] },
    status: 'open' as const,
    answer: null,
    error_code: null,
    created_at: '2026-09-25T12:00:00.000Z',
    answered_at: null,
    closed_at: null,
  };
  ```
  and inside `samples`:
  ```ts
  tab_question: { type: 'tab_question', ...base, question },
  tab_question_answered: { type: 'tab_question_answered', ...base, question: { ...question, status: 'answered', answer: { answers: [{ selected: [0] }] }, answered_at: '2026-09-25T12:01:00.000Z' } },
  tab_question_closed: { type: 'tab_question_closed', ...base, question: { ...question, kind: 'permission', payload: { tool_name: 'Bash' }, status: 'answered_in_tab', closed_at: '2026-09-25T12:02:00.000Z' } },
  ```
  Run `NODE 'npm test -w @termhub/server -- src/mobile/events-parity.test.ts'` → PASS.

- [ ] **Step 11: Push — failing tests.** In `apps/server/src/mobile/push-text.test.ts` add:
  ```ts
  it('a tab question names the project and the tab, never the question', () => {
    expect(tabQuestionText({ projectName: 'termhub', tabName: 'api', machineName: null }, 'choice')).toEqual({ title: 'termhub precisa de você', body: 'A aba api fez uma pergunta.' });
    expect(tabQuestionText({ projectName: 'termhub', tabName: 'api', machineName: null }, 'permission')).toEqual({ title: 'termhub precisa de você', body: 'A aba api pede permissão para continuar.' });
    expect(tabQuestionText({ projectName: null, tabName: null, machineName: null }, 'choice')).toEqual({ title: 'termhub precisa de você', body: 'Uma aba fez uma pergunta.' });
  });
  ```
  (add `tabQuestionText` to that file's import from `./push-text.js`). In `apps/server/src/mobile/push.test.ts` add:
  ```ts
  it('a tab question is a confirmation-channel notification naming the tab, never the question', async () => {
    const { service, repos, sent } = setup();
    stop = service.start();
    chatBus.publish({
      type: 'tab_question',
      user_id: 'u1',
      conversation_id: 'cp',
      question: { id: 'q1', tab_id: 't1', tab_name: 'api', kind: 'choice', payload: { questions: [{ question: 'Apagar o banco?', header: 'DB', multi_select: false, options: [{ label: 'Sim', description: '', recommended: false }, { label: 'Não', description: '', recommended: true }] }] }, status: 'open', answer: null, error_code: null, created_at: '', answered_at: null, closed_at: null },
    });
    await flush();
    expect(repos.userNotifications.create).toHaveBeenCalledWith(expect.objectContaining({ kind: 'confirmation', data: { kind: 'tab_question', conversation_id: 'cp', project_id: 'p1', tab_question_id: 'q1' } }));
    expect(sent[0]![0]).toMatchObject({ title: 'termhub precisa de você', body: 'A aba api fez uma pergunta.' });
    expect(JSON.stringify(sent)).not.toContain('Apagar');
  });

  it('answered and closed tab questions push nothing', async () => {
    const { service, sent, repos } = setup();
    stop = service.start();
    const question = { id: 'q1', tab_id: 't1', tab_name: 'api', kind: 'permission' as const, payload: { tool_name: 'Bash' }, status: 'answered' as const, answer: { allow: true }, error_code: null, created_at: '', answered_at: '', closed_at: null };
    chatBus.publish({ type: 'tab_question_answered', user_id: 'u1', conversation_id: 'cp', question });
    chatBus.publish({ type: 'tab_question_closed', user_id: 'u1', conversation_id: 'cp', question });
    await flush();
    expect(sent).toEqual([]);
    expect(repos.userNotifications.create).not.toHaveBeenCalled();
  });
  ```
  Run `NODE 'npm test -w @termhub/server -- src/mobile/push.test.ts src/mobile/push-text.test.ts'` → FAIL (`tabQuestionText` not exported; no notification).

- [ ] **Step 12: Push — implement.** In `push-text.ts` append:
  ```ts
  /** A tab asked something in a project's chat (spec 2026-09-25 §6.1): which tab, never what it asked. */
  export function tabQuestionText(ctx: PushContext, kind: 'choice' | 'permission'): PushText {
    const tab = ctx.tabName ? `A aba ${ctx.tabName}` : 'Uma aba';
    return { title: `${ctx.projectName ?? 'termhub'} precisa de você`, body: kind === 'permission' ? `${tab} pede permissão para continuar.` : `${tab} fez uma pergunta.` };
  }
  ```
  In `push.ts`, import `tabQuestionText`, and add a branch to `handle` after the `confirmation` one:
  ```ts
    } else if (event.type === 'tab_question') {
      // Same channel as a confirmation — the history row keeps that kind, which every app version
      // parses — with its own `data.kind` so a newer app can tell them apart.
      const projectId = await this.conversationProject(event.conversation_id, event.user_id);
      const ctx = await this.names(event.user_id, projectId, event.question.tab_id, null);
      const data = { kind: 'tab_question', conversation_id: event.conversation_id, project_id: projectId, tab_question_id: event.question.id };
      await this.deliver(event.user_id, 'confirmation', tabQuestionText(ctx, event.question.kind), data, await this.offline(event.user_id));
  ```
  Run the push tests → PASS.

- [ ] **Step 13: Whole server suite + typecheck.** `NODE 'npm test -w @termhub/server && npm run typecheck -w @termhub/server'` → PASS, no type errors (the `ChatEvent` union grew: any exhaustive `switch` elsewhere must still compile).

- [ ] **Step 14: Commit**
  ```bash
  git add apps/server/src/db/repositories/tab-questions-view.ts apps/server/src/chat/tab-questions.ts apps/server/src/chat/tab-questions.test.ts apps/server/src/chat/bus.ts apps/server/src/monitor/ingest.ts apps/server/src/monitor/ingest.test.ts apps/server/src/app.ts packages/mobile-api/src/events.ts packages/mobile-api/src/events.test.ts packages/mobile-api/src/chat.ts apps/server/src/mobile/events-parity.test.ts apps/server/src/mobile/push.ts apps/server/src/mobile/push-text.ts apps/server/src/mobile/push.test.ts apps/server/src/mobile/push-text.test.ts
  git commit -F - <<'MSG'
  Tab questions: open and close them from hook events, push the card

  A question opens in the project's latest conversation; the tab's next
  hook event (not a notification) closes it, a removed tab expires it.
  Three chat bus events carry the card; the phone contract and push
  follow (TER-56).

  Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
  MSG
  ```

---

### Task 6: Rota de resposta + trecho da tela

**Files:**
- Create: `apps/server/src/chat/tab-question-answer.ts`
- Create: `apps/server/src/chat/tab-question-answer.test.ts`
- Modify: `apps/server/src/routes/chat.ts`, `apps/server/src/routes/m-chat.ts`
- Create: `apps/server/src/routes/chat.tab-questions.test.ts`
- Modify: `apps/server/src/routes/chat.test.ts`, `apps/server/src/routes/m-chat.test.ts` (a `tabQuestions` stub in `build()`, one test each)

**Interfaces:**
- Consumes: `choiceAnswerBody`, `permissionAnswerBody`, `checkChoiceAnswer`, `choiceKeyPlan`, `permissionKeyPlan`, `KeyStep` (Task 1); `TabQuestionsRepository` (Task 4); `describeTabQuestions`, `publishTabQuestions` (Task 5); `sendKey`, `sendInput` (`control/terminals.ts`), `readScreen` (`control/screen.ts`), `controlContextFor`, `ControlError` (`control/context.ts`).
- Produces:
  ```ts
  // chat/tab-question-answer.ts
  export const KEY_STEP_PAUSE_MS = 150;
  export const SCREEN_CHECK_LINES = 60;
  export const SCREEN_EXCERPT_LINES = 20;
  export type TabAnswer = ChoiceAnswer | PermissionAnswer;
  export const promptChanged: () => HttpError; // 409 TAB_PROMPT_CHANGED "A pergunta mudou na aba"
  export function parseAnswer(row: TabQuestion, raw: unknown): TabAnswer;          // ZodError → 400 VALIDATION; mismatch → 400 ANSWER_*
  export function requirePinFor(kind: TabQuestionKind, answer: TabAnswer): boolean; // false today (spec §5.3)
  export function promptVisible(screen: string, row: Pick<TabQuestion, 'kind' | 'payload'>): boolean;
  export function lastNonBlankLines(text: string, n?: number): string;
  export interface AnswerDeps { log: Pick<FastifyBaseLogger, 'info' | 'warn'>; sleep?: (ms: number) => Promise<void>; beforeSend?: (row: TabQuestion, answer: TabAnswer) => void }
  export function answerTabQuestion(ctx: ControlContext, id: string, raw: unknown, deps: AnswerDeps): Promise<TabQuestionView>;
  export function tabQuestionScreen(ctx: ControlContext, id: string): Promise<{ text: string }>;
  ```
  Routes: `POST /api/chat/tab-questions/:id/answer` and `POST /api/m/v1/chat/tab-questions/:id/answer` → `{ tab_question: TabQuestionView }`; `GET …/tab-questions/:id/screen` → `{ text }`; `GET /api/chat` and `GET /api/m/v1/chat` gain `tab_questions: TabQuestionView[]`.
- Decisions made here (the spec leaves them open): there is no existing "short pause between keys" in the server, so `KEY_STEP_PAUSE_MS = 150` is new; the permission live check accepts "Do you want" (Claude Code also asks "Do you want to make this edit to …?") or the tool name; the screen check reads the last 60 non-blank lines with all whitespace removed on both sides (Claude Code wraps long questions); a failure after the claim answers `502` with the underlying code and leaves the row `failed`.

- [ ] **Step 1: Write the failing answer test** `apps/server/src/chat/tab-question-answer.test.ts`:
  ```ts
  import { readFileSync } from 'node:fs';
  import { join } from 'node:path';
  import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
  import { ControlError, type ControlContext } from '../control/context.js';
  import type { TabQuestion } from '../db/repositories/tab-questions.js';
  import { HttpError, notFound } from '../lib/errors.js';
  import { chatBus, type ChatEvent } from './bus.js';

  const sendKey = vi.fn(async (_ctx: unknown, input: { tab_id: string; key: string }) => ({ tab_id: input.tab_id, key: input.key, sent: true }));
  const sendInput = vi.fn(async (_ctx: unknown, input: { tab_id: string }) => ({ tab_id: input.tab_id, sent: true }));
  const readScreen = vi.fn(async (_ctx: unknown, input: { tab_id: string; lines?: number }) => ({ tab_id: input.tab_id, lines: input.lines ?? 60, text: screens.choice }));
  // Partial mocks: everything else these modules export stays real for whoever else imports them.
  vi.mock('../control/terminals.js', async (orig) => ({
    ...(await orig<typeof import('../control/terminals.js')>()),
    sendKey: (...a: unknown[]) => sendKey(a[0], a[1] as never),
    sendInput: (...a: unknown[]) => sendInput(a[0], a[1] as never),
  }));
  vi.mock('../control/screen.js', async (orig) => ({ ...(await orig<typeof import('../control/screen.js')>()), readScreen: (...a: unknown[]) => readScreen(a[0], a[1] as never) }));

  const { answerTabQuestion, lastNonBlankLines, promptVisible, requirePinFor, tabQuestionScreen } = await import('./tab-question-answer.js');

  const fx = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures/tab-questions', name), 'utf8');
  const screens = { choice: fx('screen-choice.txt'), permission: fx('screen-permission.txt') };

  const colors = { question: 'What is your favorite color?', header: 'Color', multi_select: false, options: ['Blue', 'Green', 'Red'].map((label, i) => ({ label, description: '', recommended: i === 0 })) };
  const fruits = { question: 'Which fruits do you like?', header: 'Fruits', multi_select: true, options: ['Apple', 'Banana', 'Mango'].map((label) => ({ label, description: '', recommended: false })) };
  const row = (over: Partial<TabQuestion> = {}): TabQuestion => ({
    id: 'q1', tab_id: 't1', project_id: 'p1', conversation_id: 'c1', user_id: 'u1', kind: 'choice', payload: { questions: [colors, fruits] }, tool_use_id: 'toolu_1',
    status: 'open', answer: null, error_code: null, answered_by: null, answered_at: null, closed_at: null, injected_at: null, created_at: '2026-09-25T12:00:00.000Z', ...over,
  });
  const permission = (over: Partial<TabQuestion> = {}) => row({ id: 'q2', kind: 'permission', payload: { tool_name: 'Bash' }, tool_use_id: null, ...over });

  function ctxFor(current: TabQuestion | undefined, opts: { latest?: TabQuestion | undefined; outOfScope?: boolean; claimLoses?: boolean } = {}) {
    const tabQuestions = {
      findByIdForUser: vi.fn(async (_id: string, userId: string) => (userId === 'u1' ? current : undefined)),
      findOpenForTab: vi.fn(async () => ('latest' in opts ? opts.latest : current)),
      claim: vi.fn(async (_id: string, _u: string, answer: unknown) => (opts.claimLoses || !current ? undefined : { ...current, status: 'answered' as const, answer: answer as never, answered_by: 'u1', answered_at: '2026-09-25T12:01:00.000Z' })),
      markFailed: vi.fn(async (_id: string, code: string) => (current ? { ...current, status: 'failed' as const, error_code: code } : undefined)),
    };
    const scoped = {
      tab: vi.fn(async (id: string) => {
        if (opts.outOfScope) throw notFound('Tab não encontrada');
        return { tab: { id, kind: 'terminal', tmux_session: 'th-t1', state: 'waiting_permission' }, machine: { id: 'm1', type: 'agent' }, project: { id: 'p1' }, cwd: '/w' };
      }),
    };
    const repos = { tabQuestions, tabs: { findByIdsForOwner: vi.fn(async () => [{ id: 't1', name: 'api' }]) } };
    const ctx = { repos, scoped, scope: { user: { id: 'u1' } } } as unknown as ControlContext;
    return { ctx, tabQuestions, scoped };
  }
  const log = () => ({ info: vi.fn(), warn: vi.fn() });
  const noSleep = async () => undefined;
  /** Every key and text sent, in the order they were sent. */
  const steps = () =>
    [
      ...sendKey.mock.calls.map((c, i) => ({ order: sendKey.mock.invocationCallOrder[i]!, step: `key:${c[1].key}` })),
      ...sendInput.mock.calls.map((c, i) => ({ order: sendInput.mock.invocationCallOrder[i]!, step: `text:${(c[1] as { text: string }).text}` })),
    ]
      .sort((a, b) => a.order - b.order)
      .map((s) => s.step);

  let events: ChatEvent[];
  let unsubscribe: () => void;
  beforeEach(() => {
    vi.clearAllMocks();
    readScreen.mockImplementation(async (_ctx, input) => ({ tab_id: input.tab_id, lines: 60, text: screens.choice }));
    events = [];
    unsubscribe = chatBus.subscribe((e) => events.push(e));
  });
  afterEach(() => unsubscribe());

  const rejects = async (p: Promise<unknown>, status: number, code: string) => {
    const err = await p.then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ statusCode: status, code });
  };

  describe('answerTabQuestion', () => {
    it('checks, claims, types the key plan in order and announces the answered card', async () => {
      const { ctx, tabQuestions } = ctxFor(row());
      const view = await answerTabQuestion(ctx, 'q1', { answers: [{ selected: [1] }, { selected: [2, 0] }] }, { log: log(), sleep: noSleep });
      expect(steps()).toEqual(['key:2', 'key:1', 'key:3', 'key:Tab', 'key:1']);
      expect(sendKey.mock.calls.every((c) => c[1].tab_id === 't1')).toBe(true);
      expect(tabQuestions.claim).toHaveBeenCalledWith('q1', 'u1', { answers: [{ selected: [1] }, { selected: [2, 0] }] });
      expect(view).toMatchObject({ id: 'q1', tab_name: 'api', status: 'answered' });
      expect(events).toEqual([expect.objectContaining({ type: 'tab_question_answered', user_id: 'u1', conversation_id: 'c1', question: expect.objectContaining({ status: 'answered' }) })]);
    });

    it('types free text literally, answering the prompt on purpose, then Enter', async () => {
      const { ctx } = ctxFor(row({ payload: { questions: [colors] } }));
      await answerTabQuestion(ctx, 'q1', { answers: [{ selected: [], text: 'Purple' }] }, { log: log(), sleep: noSleep });
      expect(steps()).toEqual(['key:4', 'text:Purple', 'key:Enter']);
      expect(sendInput).toHaveBeenCalledWith(ctx, { tab_id: 't1', text: 'Purple', enter: false, answering_permission: true });
    });

    it('pauses between keys, never before the first', async () => {
      const sleep = vi.fn(async () => undefined);
      const { ctx } = ctxFor(permission());
      readScreen.mockResolvedValue({ tab_id: 't1', lines: 60, text: screens.permission });
      await answerTabQuestion(ctx, 'q2', { allow: false, text: 'use pnpm' }, { log: log(), sleep });
      expect(steps()).toEqual(['key:Escape', 'text:use pnpm', 'key:Enter']);
      expect(sleep.mock.calls).toEqual([[150], [150]]);
    });

    it('allow is "1"', async () => {
      const { ctx } = ctxFor(permission());
      readScreen.mockResolvedValue({ tab_id: 't1', lines: 60, text: screens.permission });
      await answerTabQuestion(ctx, 'q2', { allow: true }, { log: log(), sleep: noSleep });
      expect(steps()).toEqual(['key:1']);
    });

    it('404: not this user\'s question, or its tab is outside the scope — nothing claimed nor typed', async () => {
      await rejects(answerTabQuestion(ctxFor(undefined).ctx, 'q1', { answers: [{ selected: [0] }, { selected: [0] }] }, { log: log() }), 404, 'NOT_FOUND');
      const out = ctxFor(row(), { outOfScope: true });
      await rejects(answerTabQuestion(out.ctx, 'q1', { answers: [{ selected: [0] }, { selected: [0] }] }, { log: log() }), 404, 'NOT_FOUND');
      expect(out.tabQuestions.claim).not.toHaveBeenCalled();
      expect(sendKey).not.toHaveBeenCalled();
    });

    it('400: a body that does not fit the question', async () => {
      const { ctx } = ctxFor(row());
      await rejects(answerTabQuestion(ctx, 'q1', { answers: [{ selected: [0] }] }, { log: log() }), 400, 'ANSWER_COUNT');
      await expect(answerTabQuestion(ctx, 'q1', { allow: true }, { log: log() })).rejects.toMatchObject({ name: 'ZodError' });
    });

    it.each([
      ['it is no longer open', () => ctxFor(row({ status: 'answered_in_tab' }))],
      ['a newer question replaced it', () => ctxFor(row(), { latest: row({ id: 'q9' }) })],
      ['somebody else claimed it first (the double click)', () => ctxFor(row(), { claimLoses: true })],
    ])('409 TAB_PROMPT_CHANGED when %s — nothing typed', async (_l, make) => {
      const { ctx } = make();
      await rejects(answerTabQuestion(ctx, 'q1', { answers: [{ selected: [0] }, { selected: [0] }] }, { log: log(), sleep: noSleep }), 409, 'TAB_PROMPT_CHANGED');
      expect(sendKey).not.toHaveBeenCalled();
    });

    it('409 TAB_PROMPT_CHANGED when the question is not on the live screen — before any claim', async () => {
      const { ctx, tabQuestions } = ctxFor(row());
      readScreen.mockResolvedValue({ tab_id: 't1', lines: 60, text: '$ ls\nREADME.md\n' });
      await rejects(answerTabQuestion(ctx, 'q1', { answers: [{ selected: [0] }, { selected: [0] }] }, { log: log() }), 409, 'TAB_PROMPT_CHANGED');
      expect(tabQuestions.claim).not.toHaveBeenCalled();
    });

    it('an offline machine at the screen check is a 409 with its own code, nothing claimed', async () => {
      const { ctx, tabQuestions } = ctxFor(row());
      readScreen.mockRejectedValue(new ControlError('MACHINE_OFFLINE', 'A máquina está offline'));
      await rejects(answerTabQuestion(ctx, 'q1', { answers: [{ selected: [0] }, { selected: [0] }] }, { log: log() }), 409, 'MACHINE_OFFLINE');
      expect(tabQuestions.claim).not.toHaveBeenCalled();
    });

    it('a key that fails after the claim marks the row failed, announces it and answers 502 with the code', async () => {
      const { ctx, tabQuestions } = ctxFor(row());
      sendKey.mockRejectedValueOnce(new ControlError('MACHINE_OFFLINE', 'A máquina está offline'));
      const l = log();
      await rejects(answerTabQuestion(ctx, 'q1', { answers: [{ selected: [0] }, { selected: [1] }] }, { log: l, sleep: noSleep }), 502, 'MACHINE_OFFLINE');
      expect(tabQuestions.markFailed).toHaveBeenCalledWith('q1', 'MACHINE_OFFLINE');
      expect(events).toEqual([expect.objectContaining({ type: 'tab_question_answered', question: expect.objectContaining({ status: 'failed', error_code: 'MACHINE_OFFLINE' }) })]);
      expect(l.warn).toHaveBeenCalledWith({ tabQuestionId: 'q1', tabId: 't1', kind: 'choice', code: 'MACHINE_OFFLINE' }, 'tab question answer failed');
    });

    it('logs ids, kind and step count — never the answer', async () => {
      const { ctx } = ctxFor(row({ payload: { questions: [colors] } }));
      const l = log();
      await answerTabQuestion(ctx, 'q1', { answers: [{ selected: [], text: 'segredo' }] }, { log: l, sleep: noSleep });
      expect(l.info).toHaveBeenCalledWith({ tabQuestionId: 'q1', tabId: 't1', kind: 'choice', steps: 3 }, 'tab question answered');
      expect(JSON.stringify([l.info.mock.calls, l.warn.mock.calls])).not.toContain('segredo');
    });

    it('asks `beforeSend` after the checks and before the claim; the PIN is never required today', async () => {
      const { ctx, tabQuestions } = ctxFor(permission());
      readScreen.mockResolvedValue({ tab_id: 't1', lines: 60, text: screens.permission });
      const beforeSend = vi.fn(() => {
        throw new HttpError(403, 'PIN', 'PIN_REQUIRED');
      });
      await rejects(answerTabQuestion(ctx, 'q2', { allow: true }, { log: log(), beforeSend }), 403, 'PIN_REQUIRED');
      expect(beforeSend).toHaveBeenCalledWith(expect.objectContaining({ id: 'q2' }), { allow: true });
      expect(tabQuestions.claim).not.toHaveBeenCalled();
      expect(requirePinFor('permission', { allow: true })).toBe(false);
      expect(requirePinFor('choice', { answers: [{ selected: [0] }] })).toBe(false);
    });
  });

  describe('promptVisible', () => {
    it('finds the first question on the captured card and the permission prompt on its own screen', () => {
      expect(promptVisible(screens.choice, row())).toBe(true);
      expect(promptVisible(screens.permission, permission())).toBe(true);
      expect(promptVisible(screens.permission, row())).toBe(false);
      expect(promptVisible('$ ls\n', permission())).toBe(false);
    });
    it('matches a question the terminal wrapped', () => {
      const long = { ...colors, question: 'Which of these deployment targets should the new staging environment use from now on?' };
      expect(promptVisible('Which of these deployment targets should the new\n  staging environment use from now on?\n❯ 1. A', row({ payload: { questions: [long] } }))).toBe(true);
    });
  });

  describe('tabQuestionScreen', () => {
    it('answers the last 20 non-blank lines while the question is open', async () => {
      const { ctx } = ctxFor(permission());
      readScreen.mockResolvedValue({ tab_id: 't1', lines: 60, text: Array.from({ length: 30 }, (_, i) => `l${i}\n`).join('\n') });
      const { text } = await tabQuestionScreen(ctx, 'q2');
      expect(text.split('\n')).toEqual(Array.from({ length: 20 }, (_, i) => `l${i + 10}`));
    });
    it('409 once it is closed, 404 when it is not this user\'s', async () => {
      await rejects(tabQuestionScreen(ctxFor(permission({ status: 'expired' })).ctx, 'q2'), 409, 'TAB_PROMPT_CHANGED');
      await rejects(tabQuestionScreen(ctxFor(undefined).ctx, 'q2'), 404, 'NOT_FOUND');
      expect(lastNonBlankLines('a\n\n  \nb\n', 5)).toBe('a\nb');
    });
  });
  ```

- [ ] **Step 2: Run to verify it fails.** `NODE 'npm test -w @termhub/server -- src/chat/tab-question-answer.test.ts'` → FAIL: module not found.

- [ ] **Step 3: Implement** `apps/server/src/chat/tab-question-answer.ts`:
  ```ts
  import type { FastifyBaseLogger } from 'fastify';
  import { ControlError, type ControlContext } from '../control/context.js';
  import { readScreen } from '../control/screen.js';
  import { sendInput, sendKey } from '../control/terminals.js';
  import type { TabQuestion } from '../db/repositories/tab-questions.js';
  import type { TabQuestionView } from '../db/repositories/tab-questions-view.js';
  import { HttpError, notFound } from '../lib/errors.js';
  import { choiceKeyPlan, permissionKeyPlan, type KeyStep } from './tab-question-keys.js';
  import { checkChoiceAnswer, choiceAnswerBody, permissionAnswerBody, type ChoiceAnswer, type ChoicePayload, type PermissionAnswer, type PermissionPayload, type TabQuestionKind } from './tab-question-payload.js';
  import { publishTabQuestions } from './tab-questions.js';

  /** Pause between two keys of one answer: Claude Code redraws its card after each key, and a burst of
   * bytes is read as a paste. The server had no such pause yet (spec §5.4 assumed one). */
  export const KEY_STEP_PAUSE_MS = 150;
  /** How much of the pane the live check and the excerpt read. */
  export const SCREEN_CHECK_LINES = 60;
  export const SCREEN_EXCERPT_LINES = 20;

  export type TabAnswer = ChoiceAnswer | PermissionAnswer;

  export const promptChanged = () => new HttpError(409, 'A pergunta mudou na aba', 'TAB_PROMPT_CHANGED');

  /** The body, validated against the row's own kind and question (spec §5.3). */
  export function parseAnswer(row: TabQuestion, raw: unknown): TabAnswer {
    if (row.kind === 'permission') return permissionAnswerBody.parse(raw);
    const answer = choiceAnswerBody.parse(raw);
    const problem = checkChoiceAnswer(row.payload as ChoicePayload, answer);
    if (problem) throw new HttpError(400, 'A resposta não combina com a pergunta', problem);
    return answer;
  }

  /**
   * Whether this answer needs the phone's PIN proof. None does for now (spec §2): the app's access is
   * already restrictive and the chat must stay fluid. Turning it on for `permission` + `allow` is this
   * function plus the app's proof flow (the `decisionProofMessage` pattern of action decisions).
   */
  export function requirePinFor(_kind: TabQuestionKind, _answer: TabAnswer): boolean {
    return false;
  }

  const squash = (s: string) => s.replace(/\s+/g, '');
  /** The last `lines` non-blank rows of a capture, as one string. */
  export function lastNonBlankLines(text: string, n = SCREEN_EXCERPT_LINES): string {
    return text
      .split('\n')
      .filter((l) => l.trim() !== '')
      .slice(-n)
      .join('\n');
  }

  /**
   * The live check (spec §5.3): the question must still be on screen. Whitespace is dropped on both
   * sides, because Claude Code wraps a long question over several indented rows. A permission prompt
   * reads "Do you want to proceed?" (or "Do you want to make this edit…?") and names its tool.
   */
  export function promptVisible(screen: string, row: Pick<TabQuestion, 'kind' | 'payload'>): boolean {
    const shown = squash(lastNonBlankLines(screen, SCREEN_CHECK_LINES));
    if (row.kind === 'choice') {
      const first = (row.payload as ChoicePayload).questions[0];
      return !!first && shown.includes(squash(first.question).slice(0, 80));
    }
    return shown.includes(squash('Do you want')) || shown.includes((row.payload as PermissionPayload).tool_name);
  }

  const asHttp = (err: unknown): unknown => (err instanceof ControlError ? new HttpError(409, err.message, err.code) : err);
  const codeOf = (err: unknown): string => (err instanceof ControlError || err instanceof HttpError ? (err.code ?? 'SEND_FAILED') : 'SEND_FAILED');
  const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  async function runKeyPlan(ctx: ControlContext, tabId: string, steps: KeyStep[], sleep: (ms: number) => Promise<void>): Promise<void> {
    for (const [i, step] of steps.entries()) {
      if (i > 0) await sleep(KEY_STEP_PAUSE_MS);
      if ('key' in step) await sendKey(ctx, { tab_id: tabId, key: step.key });
      // This *is* the answer to the prompt the tab is waiting on: past sendInput's WAITING_PERMISSION guard on purpose.
      else await sendInput(ctx, { tab_id: tabId, text: step.text, enter: false, answering_permission: true });
    }
  }

  export interface AnswerDeps {
    log: Pick<FastifyBaseLogger, 'info' | 'warn'>;
    /** Test seam for the pause between keys. */
    sleep?: (ms: number) => Promise<void>;
    /** The mobile route's PIN hook (`requirePinFor`): runs after every check, before the claim. */
    beforeSend?: (row: TabQuestion, answer: TabAnswer) => void;
  }

  /**
   * Answers a tab's question from its card (spec §5.3). In order: the row through its owner, the body
   * against it, the tab through the scope (404), still open and still the tab's latest (409), still on
   * the live screen (409), the claim (409 for the loser of a double click), then the keys. A failure
   * after the claim leaves the row `failed` with the code and answers 502. Logs ids, kind and counts.
   */
  export async function answerTabQuestion(ctx: ControlContext, id: string, raw: unknown, deps: AnswerDeps): Promise<TabQuestionView> {
    const userId = ctx.scope.user.id;
    const row = await ctx.repos.tabQuestions.findByIdForUser(id, userId);
    if (!row) throw notFound('Pergunta não encontrada');
    const answer = parseAnswer(row, raw);
    const { tab } = await ctx.scoped.tab(row.tab_id);
    if (row.status !== 'open') throw promptChanged();
    const latest = await ctx.repos.tabQuestions.findOpenForTab(tab.id);
    if (latest?.id !== row.id) throw promptChanged();

    let screen: string;
    try {
      screen = (await readScreen(ctx, { tab_id: tab.id, lines: SCREEN_CHECK_LINES })).text;
    } catch (err) {
      throw asHttp(err);
    }
    if (!promptVisible(screen, row)) throw promptChanged();

    deps.beforeSend?.(row, answer);
    const claimed = await ctx.repos.tabQuestions.claim(row.id, userId, answer);
    if (!claimed) throw promptChanged();

    const steps = row.kind === 'choice' ? choiceKeyPlan(row.payload as ChoicePayload, answer as ChoiceAnswer) : permissionKeyPlan(answer as PermissionAnswer);
    try {
      await runKeyPlan(ctx, tab.id, steps, deps.sleep ?? pause);
    } catch (err) {
      const code = codeOf(err);
      const failed = await ctx.repos.tabQuestions.markFailed(row.id, code);
      if (failed) await publishTabQuestions(ctx.repos, 'tab_question_answered', [failed]);
      deps.log.warn({ tabQuestionId: row.id, tabId: tab.id, kind: row.kind, code }, 'tab question answer failed');
      throw new HttpError(502, 'Não foi possível responder na aba', code);
    }
    deps.log.info({ tabQuestionId: row.id, tabId: tab.id, kind: row.kind, steps: steps.length }, 'tab question answered');
    const [view] = await publishTabQuestions(ctx.repos, 'tab_question_answered', [claimed]);
    return view;
  }

  /** The permission card's live excerpt (spec §6.1): read on demand, never stored nor logged. */
  export async function tabQuestionScreen(ctx: ControlContext, id: string): Promise<{ text: string }> {
    const row = await ctx.repos.tabQuestions.findByIdForUser(id, ctx.scope.user.id);
    if (!row) throw notFound('Pergunta não encontrada');
    if (row.status !== 'open') throw promptChanged();
    try {
      const { text } = await readScreen(ctx, { tab_id: row.tab_id, lines: SCREEN_CHECK_LINES });
      return { text: lastNonBlankLines(text) };
    } catch (err) {
      throw asHttp(err);
    }
  }
  ```
  Note `readScreen` goes through `ctx.scoped.tab` itself, so the excerpt is scope-checked too (404).

- [ ] **Step 4: Run to verify it passes.** `NODE 'npm test -w @termhub/server -- src/chat/tab-question-answer.test.ts'` → PASS.

- [ ] **Step 5: Write the failing route tests** `apps/server/src/routes/chat.tab-questions.test.ts`:
  ```ts
  import Fastify from 'fastify';
  import { beforeEach, describe, expect, it, vi } from 'vitest';
  import { applyErrorHandler, HttpError } from '../lib/errors.js';

  const answer = vi.fn(async (..._a: unknown[]) => ({ id: 'q1', status: 'answered' }));
  const screen = vi.fn(async (..._a: unknown[]) => ({ text: 'Do you want to proceed?' }));
  const pin = vi.fn((..._a: unknown[]) => false);
  vi.mock('../chat/tab-question-answer.js', () => ({
    answerTabQuestion: (...a: unknown[]) => answer(...a),
    tabQuestionScreen: (...a: unknown[]) => screen(...a),
    requirePinFor: (...a: unknown[]) => pin(...a),
  }));

  const { chatRoutes } = await import('./chat.js');
  const { mobileChatRoutes } = await import('./m-chat.js');

  function build(kind: 'web' | 'mobile') {
    const app = Fastify();
    applyErrorHandler(app);
    app.decorateRequest('scope', null);
    app.addHook('preHandler', async (req) => {
      (req as unknown as { scope: unknown }).scope = { user: { id: 'u1' }, viewAs: { kind: 'self' }, ownerId: 'u1', createAs: 'u1' };
    });
    const repos = {};
    if (kind === 'web') app.register((a) => chatRoutes(a, repos as never, { service: {} as never }), { prefix: '/chat' });
    else app.register((a) => mobileChatRoutes(a, repos as never, { chat: {} as never, agents: {} as never, session: {} as never }), { prefix: '/chat' });
    return app;
  }

  beforeEach(() => vi.clearAllMocks());

  describe.each(['web', 'mobile'] as const)('%s tab-question routes', (kind) => {
    it('POST answer hands the id, the raw body and the signed-in user\'s context to the service', async () => {
      const res = await build(kind).inject({ method: 'POST', url: '/chat/tab-questions/q1/answer', payload: { allow: true } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ tab_question: { id: 'q1', status: 'answered' } });
      const [ctx, id, body] = answer.mock.calls[0]!;
      expect((ctx as { scope: { user: { id: string } } }).scope.user.id).toBe('u1');
      expect(id).toBe('q1');
      expect(body).toEqual({ allow: true });
    });

    it('GET screen answers the excerpt', async () => {
      const res = await build(kind).inject({ method: 'GET', url: '/chat/tab-questions/q1/screen' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ text: 'Do you want to proceed?' });
      expect(screen.mock.calls[0]![1]).toBe('q1');
    });

    it('refuses an id that is not one', async () => {
      const res = await build(kind).inject({ method: 'POST', url: `/chat/tab-questions/${'x'.repeat(65)}/answer`, payload: { allow: true } });
      expect(res.statusCode).toBe(400);
      expect(answer).not.toHaveBeenCalled();
    });

    it('passes the service\'s 409 through', async () => {
      answer.mockRejectedValueOnce(new HttpError(409, 'A pergunta mudou na aba', 'TAB_PROMPT_CHANGED'));
      const res = await build(kind).inject({ method: 'POST', url: '/chat/tab-questions/q1/answer', payload: { allow: true } });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: 'A pergunta mudou na aba', code: 'TAB_PROMPT_CHANGED' });
    });
  });

  it('the mobile route asks requirePinFor before sending, and refuses when it says so', async () => {
    await build('mobile').inject({ method: 'POST', url: '/chat/tab-questions/q1/answer', payload: { allow: true } });
    const deps = answer.mock.calls[0]![3] as { beforeSend: (row: unknown, a: unknown) => void };
    expect(() => deps.beforeSend({ kind: 'permission' }, { allow: true })).not.toThrow();
    pin.mockReturnValueOnce(true);
    expect(() => deps.beforeSend({ kind: 'permission' }, { allow: true })).toThrow(expect.objectContaining({ statusCode: 403, code: 'PIN_REQUIRED' }));
    expect(pin).toHaveBeenCalledWith('permission', { allow: true });
  });

  it('the web route has no PIN hook', async () => {
    await build('web').inject({ method: 'POST', url: '/chat/tab-questions/q1/answer', payload: { allow: true } });
    expect((answer.mock.calls[0]![3] as { beforeSend?: unknown }).beforeSend).toBeUndefined();
  });
  ```
  In `apps/server/src/routes/chat.test.ts`, add to the `build()` options type `tabQuestions?: unknown[];` and to its `repos` object `tabQuestions: { listByConversation: vi.fn(async () => opts.tabQuestions ?? []) },`, then add:
  ```ts
  it('GET / returns the conversation\'s tab questions, named owner-scoped', async () => {
    const q = { id: 'q1', tab_id: 't1', project_id: 'p1', conversation_id: 'c1', user_id: 'u1', kind: 'permission', payload: { tool_name: 'Bash' }, tool_use_id: null, status: 'open', answer: null, error_code: null, answered_by: null, answered_at: null, closed_at: null, injected_at: null, created_at: '2026-09-25T12:00:00.000Z' };
    const { app, repos } = build({ tabs: [{ id: 't1', project_id: 'p1', name: 'api' }], tabQuestions: [q] });
    const res = await app.inject({ method: 'GET', url: '/chat' });
    expect(res.json().tab_questions).toEqual([{ id: 'q1', tab_id: 't1', tab_name: 'api', kind: 'permission', payload: { tool_name: 'Bash' }, status: 'open', answer: null, error_code: null, created_at: '2026-09-25T12:00:00.000Z', answered_at: null, closed_at: null }]);
    expect(repos.tabQuestions.listByConversation).toHaveBeenCalledWith('c1');
  });
  ```
  In `apps/server/src/routes/m-chat.test.ts`, add the same `tabQuestions?: unknown[]` option and `tabQuestions: { listByConversation: vi.fn(async () => opts.tabQuestions ?? []) },` to its `repos`, and inside `describe('GET /chat', …)`:
  ```ts
  it('returns the tab questions too', async () => {
    const q = { id: 'q1', tab_id: 't1', project_id: 'p1', conversation_id: 'c1', user_id: 'u1', kind: 'permission', payload: { tool_name: 'Bash' }, tool_use_id: null, status: 'open', answer: null, error_code: null, answered_by: null, answered_at: null, closed_at: null, injected_at: null, created_at: '' };
    const { app } = build({ tabs: [{ id: 't1', project_id: 'p1', name: 'api' }], tabQuestions: [q] });
    const res = await app.inject({ method: 'GET', url: '/chat' });
    expect(res.json().tab_questions).toEqual([expect.objectContaining({ id: 'q1', tab_name: 'api', kind: 'permission' })]);
  });
  ```
  Run `NODE 'npm test -w @termhub/server -- src/routes/chat.tab-questions.test.ts src/routes/chat.test.ts src/routes/m-chat.test.ts'` → FAIL (404 route, no `tab_questions`).

- [ ] **Step 6: Implement the routes.** In `apps/server/src/routes/chat.ts`:
  - imports: `import { controlContextFor } from '../control/context.js';`, `import { describeTabQuestions } from '../db/repositories/tab-questions-view.js';`, `import { answerTabQuestion, tabQuestionScreen } from '../chat/tab-question-answer.js';`
  - params: `const tabQuestionIdParam = z.object({ id: z.string().min(1).max(64) });`
  - in `GET /`: add `repos.tabQuestions.listByConversation(conversation.id)` to the `Promise.all` (name it `questionRows`), then `const tab_questions = await describeTabQuestions(repos, questionRows, request.scope.user.id);` and return `{ conversation, messages, actions, host, grants, tab_questions }`.
  - new routes (before the closing brace):
    ```ts
    /**
     * Answers a tab's question from its card (spec 2026-09-25 §5.3). The click is the confirmation: no
     * gate card, no model turn. `create`, the permission deciding a card needs. The body is validated by
     * the service against the question's own kind.
     */
    app.post('/tab-questions/:id/answer', { config: { action: 'create' } }, async (request) => {
      const { id } = tabQuestionIdParam.parse(request.params);
      const ctx = controlContextFor(repos, request.scope.user);
      return { tab_question: await answerTabQuestion(ctx, id, request.body, { log: request.log }) };
    });

    /** The live excerpt a permission card shows (spec §6.1): read now, never stored nor logged. */
    app.get('/tab-questions/:id/screen', async (request) => {
      const { id } = tabQuestionIdParam.parse(request.params);
      return tabQuestionScreen(controlContextFor(repos, request.scope.user), id);
    });
    ```
  In `apps/server/src/routes/m-chat.ts`: the same imports plus `requirePinFor`; the same `GET /` change (`tab_questions`); and:
  ```ts
  /**
   * The phone answers a tab's question like the web (spec 2026-09-25 §5.3). No PIN today:
   * `requirePinFor` says no for every answer; the day it says yes, the proof flow goes here.
   */
  app.post('/tab-questions/:id/answer', { config: { action: 'create' } }, async (request) => {
    const { id } = tabQuestionIdParam.parse(request.params);
    const ctx = controlContextFor(repos, request.scope.user);
    const beforeSend = (row: { kind: 'choice' | 'permission' }, answer: Parameters<typeof requirePinFor>[1]) => {
      if (requirePinFor(row.kind, answer)) throw new HttpError(403, 'Esta resposta precisa do PIN', 'PIN_REQUIRED');
    };
    return { tab_question: await answerTabQuestion(ctx, id, request.body, { log: request.log, beforeSend }) };
  });

  app.get('/tab-questions/:id/screen', async (request) => {
    const { id } = tabQuestionIdParam.parse(request.params);
    return tabQuestionScreen(controlContextFor(repos, request.scope.user), id);
  });
  ```
  Run the route tests again → PASS.

- [ ] **Step 7: Whole server suite + typecheck.** `NODE 'npm test -w @termhub/server && npm run typecheck -w @termhub/server'` → PASS.

- [ ] **Step 8: Commit**
  ```bash
  git add apps/server/src/chat/tab-question-answer.ts apps/server/src/chat/tab-question-answer.test.ts apps/server/src/routes/chat.ts apps/server/src/routes/m-chat.ts apps/server/src/routes/chat.tab-questions.test.ts apps/server/src/routes/chat.test.ts apps/server/src/routes/m-chat.test.ts
  git commit -F - <<'MSG'
  Chat: answer a tab's question from its card, web and mobile

  Scope, still-open, still-latest and live-screen checks, a conditional
  claim against double clicks, then the key plan through sendKey and a
  literal send. Also the permission card's live excerpt (TER-56).

  Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
  MSG
  ```

---

### Task 7: Concierge: contexto das respostas + linha no project-prompt

**Files:**
- Create: `apps/server/src/chat/tab-question-context.ts`
- Create: `apps/server/src/chat/tab-question-context.test.ts`
- Modify: `apps/server/src/chat/service.ts` (`startIn` ~line 450, new private method)
- Modify: `apps/server/src/chat/service.test.ts` (`build()` ~line 33 and ~line 121, new tests)
- Modify: `apps/server/src/chat/project-prompt.ts`, `apps/server/src/chat/project-prompt.test.ts`

**Interfaces:**
- Consumes: `TabQuestionsRepository.listToInject` / `markInjected` (Task 4), `describeTabQuestions` (Task 5).
- Produces: `export function tabQuestionContext(questions: TabQuestionView[]): string | null` — `"Enquanto isso:\n- a aba «api» perguntou «Qual cor?»; o usuário respondeu «Verde».\n- a aba «api» pediu permissão para usar «Bash»; o usuário negou e disse «use pnpm»."`, or `null` when there is nothing to say. `ChatService` prepends it (plus a blank line) to the **runner input** of the next run of that conversation — any run: a typed message, a decision's re-injection, the drain — and never to the stored user message.

- [ ] **Step 1: Write the failing context test** `apps/server/src/chat/tab-question-context.test.ts`:
  ```ts
  import { expect, it } from 'vitest';
  import type { TabQuestionView } from '../db/repositories/tab-questions-view.js';
  import { tabQuestionContext } from './tab-question-context.js';

  const base = { tab_id: 't1', tab_name: 'api', status: 'answered' as const, error_code: null, created_at: '', answered_at: '', closed_at: null };
  const colors = { question: 'Qual cor?', header: 'Cor', multi_select: false, options: [{ label: 'Azul', description: '', recommended: true }, { label: 'Verde', description: '', recommended: false }] };
  const fruits = { question: 'Quais frutas?', header: 'Frutas', multi_select: true, options: ['Maçã', 'Banana', 'Manga'].map((label) => ({ label, description: '', recommended: false })) };

  it('says what each tab asked and what the person answered, one line per question', () => {
    const questions: TabQuestionView[] = [
      { ...base, id: 'q1', kind: 'choice', payload: { questions: [colors, fruits] }, answer: { answers: [{ selected: [1] }, { selected: [0, 2] }] } },
      { ...base, id: 'q2', tab_name: null, tab_id: 't9', kind: 'choice', payload: { questions: [colors] }, answer: { answers: [{ selected: [], text: 'Roxo' }] } },
      { ...base, id: 'q3', kind: 'permission', payload: { tool_name: 'Bash' }, answer: { allow: true } },
      { ...base, id: 'q4', kind: 'permission', payload: { tool_name: 'Edit' }, answer: { allow: false, text: 'use pnpm' } },
      { ...base, id: 'q5', kind: 'permission', payload: { tool_name: 'Write' }, answer: { allow: false } },
    ];
    expect(tabQuestionContext(questions)).toBe(
      [
        'Enquanto isso:',
        '- a aba «api» perguntou «Qual cor?»; o usuário respondeu «Verde».',
        '- a aba «api» perguntou «Quais frutas?»; o usuário respondeu «Maçã, Manga».',
        '- a aba «t9» perguntou «Qual cor?»; o usuário respondeu «Roxo».',
        '- a aba «api» pediu permissão para usar «Bash»; o usuário permitiu.',
        '- a aba «api» pediu permissão para usar «Edit»; o usuário negou e disse «use pnpm».',
        '- a aba «api» pediu permissão para usar «Write»; o usuário negou.',
      ].join('\n'),
    );
  });

  it('is null with nothing to say', () => {
    expect(tabQuestionContext([])).toBeNull();
  });
  ```

- [ ] **Step 2: Run to verify it fails.** `NODE 'npm test -w @termhub/server -- src/chat/tab-question-context.test.ts'` → FAIL: module not found.

- [ ] **Step 3: Implement** `apps/server/src/chat/tab-question-context.ts`:
  ```ts
  import type { TabQuestionView } from '../db/repositories/tab-questions-view.js';
  import type { ChoiceAnswer, ChoicePayload, PermissionAnswer, PermissionPayload } from './tab-question-payload.js';

  const tabOf = (q: TabQuestionView) => `«${q.tab_name ?? q.tab_id}»`;

  function linesOf(q: TabQuestionView): string[] {
    if (q.kind === 'permission') {
      const a = q.answer as PermissionAnswer | null;
      const said = !a ? 'não respondeu' : a.allow ? 'permitiu' : a.text ? `negou e disse «${a.text}»` : 'negou';
      return [`- a aba ${tabOf(q)} pediu permissão para usar «${(q.payload as PermissionPayload).tool_name}»; o usuário ${said}.`];
    }
    const a = q.answer as ChoiceAnswer | null;
    return (q.payload as ChoicePayload).questions.map((item, i) => {
      const ans = a?.answers[i];
      const said = !ans ? '—' : (ans.text ?? ans.selected.map((s) => item.options[s]?.label ?? '?').join(', '));
      return `- a aba ${tabOf(q)} perguntou «${item.question}»; o usuário respondeu «${said}».`;
    });
  }

  /**
   * What the concierge is told about the tabs' questions the person answered from the chat since its
   * last turn (spec 2026-09-25 §5.5): the question and the answer, both written to be shown to the
   * person — never a screen. Null when there is nothing to tell.
   */
  export function tabQuestionContext(questions: TabQuestionView[]): string | null {
    const lines = questions.flatMap(linesOf);
    return lines.length ? `Enquanto isso:\n${lines.join('\n')}` : null;
  }
  ```
  Run the test → PASS.

- [ ] **Step 4: Write the failing service tests.** In `apps/server/src/chat/service.test.ts`:
  - add `import type { TabQuestion } from '../db/repositories/tab-questions.js';`
  - extend `build()`'s `opts` type with `tabQuestions?: TabQuestion[]`, and before `const repos = {` add:
    ```ts
    /** Answered-but-untold questions, drained by `markInjected` exactly like the repository. */
    const toInject = [...(opts.tabQuestions ?? [])];
    const tabQuestions = {
      listToInject: vi.fn(async (_conversationId: string) => [...toInject]),
      markInjected: vi.fn(async (ids: string[]) => {
        for (const id of ids) toInject.splice(toInject.findIndex((q) => q.id === id), 1);
      }),
    };
    ```
    and `tabQuestions,` inside `repos`; return `tabQuestions` from `build()` too.
  - append:
    ```ts
    const answeredQuestion = (): TabQuestion => ({
      id: 'q1', tab_id: 't1', project_id: 'p1', conversation_id: 'c1', user_id: 'u1', kind: 'choice',
      payload: { questions: [{ question: 'Qual cor?', header: 'Cor', multi_select: false, options: [{ label: 'Azul', description: '', recommended: true }, { label: 'Verde', description: '', recommended: false }] }] },
      tool_use_id: 'toolu_1', status: 'answered', answer: { answers: [{ selected: [1] }] }, error_code: null, answered_by: 'u1', answered_at: '2026-09-25T12:01:00.000Z', closed_at: null, injected_at: null, created_at: '2026-09-25T12:00:00.000Z',
    });

    it('tells the next run what the chat answered in the tabs, once, without storing it as the person\'s message', async () => {
      const { service, messages, inputs, tabQuestions } = build([delta('ok'), done()], { tabQuestions: [answeredQuestion()] });
      await service.send(user, 'e agora?');
      expect(inputs()[0]!.text).toBe('Enquanto isso:\n- a aba «Terminal 1» perguntou «Qual cor?»; o usuário respondeu «Verde».\n\ne agora?');
      expect(messages.find((m) => m.role === 'user')?.text).toBe('e agora?');
      expect(tabQuestions.listToInject).toHaveBeenCalledWith('c1');
      expect(tabQuestions.markInjected).toHaveBeenCalledWith(['q1']);
      await service.send(user, 'e depois?');
      expect(inputs()[1]!.text).toBe('e depois?');
    });

    it('a failing read costs the context, never the message, and logs metadata only', async () => {
      const { service, inputs, tabQuestions } = build([delta('ok'), done()], { tabQuestions: [answeredQuestion()] });
      tabQuestions.listToInject.mockRejectedValueOnce(Object.assign(new Error('Qual cor?'), { code: 'P1001' }));
      const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      await service.send(user, 'e agora?');
      expect(inputs()[0]!.text).toBe('e agora?');
      expect(errors).toHaveBeenCalledWith('chat: tab question context skipped', { conversation_id: 'c1', error: 'P1001' });
      errors.mockRestore();
    });
    ```
  Run `NODE 'npm test -w @termhub/server -- src/chat/service.test.ts'` → FAIL (the run text has no context).

- [ ] **Step 5: Implement in `ChatService`.** In `apps/server/src/chat/service.ts`:
  - imports: `import { describeTabQuestions } from '../db/repositories/tab-questions-view.js';` and `import { tabQuestionContext } from './tab-question-context.js';`
  - in `startIn`, right after `if (opts?.beforeRun) await opts.beforeRun();`:
    ```ts
    // What the chat answered in the project's tabs since the model last heard (spec 2026-09-25
    // §5.5): prepended to this run's input only — the stored message stays the person's own words.
    // Read and stamped under the lock, before the run: at most once, like a decision's injection.
    const context = await this.tabQuestionContextFor(user, conversation.id);
    const runText = context ? `${context}\n\n${text}` : text;
    ```
    and pass `runText` instead of `text` as the third argument of `this.finishRun(...)` (the `addMessage` for the user row keeps `text`).
  - add the private method after `promptFor`:
    ```ts
    /** The tabs' answered questions this conversation's model was not told yet, as the lines to prepend,
     * marked told. A failure costs the context — logged by label, never by content — not the message. */
    private async tabQuestionContextFor(user: User, conversationId: string): Promise<string | null> {
      try {
        const rows = await this.deps.repos.tabQuestions.listToInject(conversationId);
        if (rows.length === 0) return null;
        const views = await describeTabQuestions(this.deps.repos, rows, user.id);
        await this.deps.repos.tabQuestions.markInjected(rows.map((r) => r.id));
        return tabQuestionContext(views);
      } catch (err) {
        console.error('chat: tab question context skipped', { conversation_id: conversationId, error: failureLabel(err) });
        return null;
      }
    }
    ```
  Run the service tests → PASS (every existing one too: with no `tabQuestions` option the stub answers `[]`).

- [ ] **Step 6: The prompt line.** Add to `apps/server/src/chat/project-prompt.test.ts`:
  ```ts
  it('tells the concierge that tab questions are the person\'s cards, not its to relay or answer', () => {
    const text = projectSystemPrompt({ name: 'X', key: 'X' }, []);
    expect(text).toMatch(/reach the person as cards in this chat: do not relay them as text, and do not answer them with send_key or send_input while such a card is open/);
  });
  ```
  Run → FAIL. In `project-prompt.ts` replace `tail` with:
  ```ts
  const tail =
    '\nAnswer about this project. Do not report on other projects unless the person asks about them by name.\n' +
    'Questions a tab asks (a multiple-choice question or a permission prompt) reach the person as cards in this chat: do not relay them as text, and do not answer them with send_key or send_input while such a card is open.\n' +
    'Keep answers short unless asked for detail.';
  ```
  Run `NODE 'npm test -w @termhub/server -- src/chat/project-prompt.test.ts'` → PASS (the 4000-char cap test still passes: `room` is computed from `tail`).

- [ ] **Step 7: Suite + typecheck.** `NODE 'npm test -w @termhub/server && npm run typecheck -w @termhub/server'` → PASS.

- [ ] **Step 8: Commit**
  ```bash
  git add apps/server/src/chat/tab-question-context.ts apps/server/src/chat/tab-question-context.test.ts apps/server/src/chat/service.ts apps/server/src/chat/service.test.ts apps/server/src/chat/project-prompt.ts apps/server/src/chat/project-prompt.test.ts
  git commit -F - <<'MSG'
  Concierge: learn the tabs' answered questions on the next turn

  Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
  MSG
  ```

---

### Task 8: Web: TabQuestionCard + timeline + ChatPanel + api

**Files:**
- Modify: `apps/web/src/lib/types.ts` (after `ChatGrant` ~line 800; `ChatEvent` ~line 807)
- Modify: `apps/web/src/lib/api.ts` (`chat` ~line 170; new calls after `revokeChatGrant` ~line 207)
- Modify: `apps/web/src/lib/chat-timeline.ts`, `apps/web/src/lib/chat-timeline.test.ts`
- Create: `apps/web/src/components/chat/tab-question-text.ts`, `apps/web/src/components/chat/tab-question-text.test.ts`
- Create: `apps/web/src/components/chat/TabQuestionCard.tsx`, `apps/web/src/components/chat/TabQuestionCard.test.tsx`
- Modify: `apps/web/src/components/chat/ChatPanel.tsx`, `apps/web/src/components/chat/ChatPanel.test.tsx`

**Interfaces:**
- Consumes: `GET /api/chat` `tab_questions`, the three bus events, `POST /api/chat/tab-questions/:id/answer`, `GET /api/chat/tab-questions/:id/screen` (Tasks 5–6).
- Produces:
  ```ts
  // lib/types.ts
  export interface TabQuestionOption { label: string; description: string; recommended: boolean }
  export interface TabQuestionItem { question: string; header: string; multi_select: boolean; options: TabQuestionOption[] }
  export type TabQuestionStatus = 'open' | 'answered' | 'answered_in_tab' | 'expired' | 'failed';
  export interface ChoiceAnswer { answers: { selected: number[]; text?: string }[] }
  export interface PermissionAnswer { allow: boolean; text?: string }
  export type TabQuestionAnswer = ChoiceAnswer | PermissionAnswer;
  export type TabQuestionChoice = TabQuestionBase & { kind: 'choice'; payload: { questions: TabQuestionItem[] }; answer: ChoiceAnswer | null };
  export type TabQuestionPermission = TabQuestionBase & { kind: 'permission'; payload: { tool_name: string }; answer: PermissionAnswer | null };
  export type TabQuestion = TabQuestionChoice | TabQuestionPermission;
  // lib/api.ts
  api.answerTabQuestion(id: string, body: TabQuestionAnswer): Promise<{ tab_question: TabQuestion }>;
  api.tabQuestionScreen(id: string): Promise<{ text: string }>;
  // lib/chat-timeline.ts
  export type ChatEntry = … | { kind: 'tab_question'; at: string; question: TabQuestion };
  export function chatTimeline(messages: ChatMessage[], actions: ChatAction[], tabQuestions?: TabQuestion[]): ChatEntry[];
  // components/chat/tab-question-text.ts
  export function tabLabel(q: TabQuestion): string;            // "A aba «api»" | "Uma aba"
  export function statusLabel(q: TabQuestion): string;         // "" | "Respondida" | "Respondida na aba" | "Expirada" | "Falhou — …"
  export function answerSummary(q: TabQuestion): string[];
  export function upsertTabQuestion(list: TabQuestion[], q: TabQuestion): TabQuestion[];
  export const PROMPT_CHANGED_TEXT = 'A pergunta mudou na aba';
  // components/chat/TabQuestionCard.tsx
  export function TabQuestionCard(props: { question: TabQuestion; answering: boolean; error?: string | null; onAnswer: (body: TabQuestionAnswer) => void; loadScreen?: (id: string) => Promise<string> }): JSX.Element;
  ```

- [ ] **Step 1: Types and api.** In `apps/web/src/lib/types.ts`, after `ChatGrant`:
  ```ts
  /** One option of a tab's question; `recommended` came out of Claude Code's own "(Recommended)". */
  export interface TabQuestionOption {
    label: string;
    description: string;
    recommended: boolean;
  }
  export interface TabQuestionItem {
    question: string;
    header: string;
    multi_select: boolean;
    options: TabQuestionOption[];
  }
  export type TabQuestionStatus = 'open' | 'answered' | 'answered_in_tab' | 'expired' | 'failed';
  /** One entry per question: option indexes (0-based), or the typed text. */
  export interface ChoiceAnswer {
    answers: { selected: number[]; text?: string }[];
  }
  export interface PermissionAnswer {
    allow: boolean;
    text?: string;
  }
  export type TabQuestionAnswer = ChoiceAnswer | PermissionAnswer;
  interface TabQuestionBase {
    id: string;
    tab_id: string;
    /** The tab's name at read time; null once the tab is gone. */
    tab_name: string | null;
    status: TabQuestionStatus;
    error_code: string | null;
    created_at: string;
    answered_at: string | null;
    closed_at: string | null;
  }
  export type TabQuestionChoice = TabQuestionBase & { kind: 'choice'; payload: { questions: TabQuestionItem[] }; answer: ChoiceAnswer | null };
  export type TabQuestionPermission = TabQuestionBase & { kind: 'permission'; payload: { tool_name: string }; answer: PermissionAnswer | null };
  /**
   * A question an agent in a tab asked (spec 2026-09-25): shown as a card in the project's chat and
   * answered from there. Plain text only — never render any of it as HTML: it is what an agent wrote.
   */
  export type TabQuestion = TabQuestionChoice | TabQuestionPermission;
  ```
  and add to `ChatEvent`:
  ```ts
    /** A tab asked something, the chat answered it (or failed to), or it left the tab's screen: the whole card each time. */
    | { type: 'tab_question' | 'tab_question_answered' | 'tab_question_closed'; question: TabQuestion; conversation_id?: string };
  ```
  In `apps/web/src/lib/api.ts`: add `TabQuestion, TabQuestionAnswer` to the type import; in `chat:` add `tab_questions?: TabQuestion[]` to the response type; after `revokeChatGrant` add:
  ```ts
  /** Answers a tab's question from its card (409 `TAB_PROMPT_CHANGED` when the tab moved on). */
  answerTabQuestion: (id: string, body: TabQuestionAnswer) => request<{ tab_question: TabQuestion }>('POST', `/chat/tab-questions/${encodeURIComponent(id)}/answer`, body),
  /** The last lines of the tab, live, for a permission card; 409 once the question is closed. */
  tabQuestionScreen: (id: string) => request<{ text: string }>('GET', `/chat/tab-questions/${encodeURIComponent(id)}/screen`),
  ```

- [ ] **Step 2: Timeline — failing test.** Append to `apps/web/src/lib/chat-timeline.test.ts` (add `TabQuestion` to its type import):
  ```ts
  function tabQuestion(overrides: Partial<TabQuestion> = {}): TabQuestion {
    return { id: 'q1', tab_id: 't1', tab_name: 'api', kind: 'permission', payload: { tool_name: 'Bash' }, answer: null, status: 'open', error_code: null, created_at: T1, answered_at: null, closed_at: null, ...overrides } as TabQuestion;
  }

  describe('chatTimeline — tab questions', () => {
    it('places a question by its time, after a message of the same instant', () => {
      const entries = chatTimeline([message({ id: 'm1', created_at: T0 }), message({ id: 'm2', created_at: T1 })], [action({ id: 'a1', created_at: T2 })], [tabQuestion({ id: 'q1', created_at: T1 })]);
      expect(entries.map((e) => (e.kind === 'message' ? e.message.id : e.kind === 'action' ? e.action.id : e.question.id))).toEqual(['m1', 'm2', 'q1', 'a1']);
    });
    it('drops a question older than the message window, keeps them all with no messages', () => {
      expect(chatTimeline([message({ created_at: T1 })], [], [tabQuestion({ created_at: T0 })]).map((e) => e.kind)).toEqual(['message']);
      expect(chatTimeline([], [], [tabQuestion()]).map((e) => e.kind)).toEqual(['tab_question']);
    });
    it('keeps working with two arguments', () => {
      expect(chatTimeline([message()], []).map((e) => e.kind)).toEqual(['message']);
    });
  });
  ```
  Run `NODE 'npm test -w @termhub/web -- src/lib/chat-timeline.test.ts'` → FAIL.

- [ ] **Step 3: Timeline — implement.** In `apps/web/src/lib/chat-timeline.ts`: import `TabQuestion`; the entry type becomes
  ```ts
  export type ChatEntry =
    | { kind: 'message'; at: string; message: ChatMessage }
    | { kind: 'action'; at: string; action: ChatAction }
    | { kind: 'tab_question'; at: string; question: TabQuestion };
  ```
  the signature `export function chatTimeline(messages: ChatMessage[], actions: ChatAction[], tabQuestions: TabQuestion[] = []): ChatEntry[]`; after `visibleActions` add
  ```ts
  // A tab's question card follows the same window rule as a gate card: it belongs next to the thread around it.
  const visibleQuestions = oldestMessageAt === null ? tabQuestions : tabQuestions.filter((q) => q.created_at >= oldestMessageAt);
  ```
  add `...visibleQuestions.map((question): ChatEntry => ({ kind: 'tab_question', at: question.created_at, question })),` after the actions in `entries`, and make the tiebreak antisymmetric for three kinds:
  ```ts
  return entries.sort((a, b) => {
    if (a.at !== b.at) return a.at < b.at ? -1 : 1;
    // A card (a gate card or a tab's question) reads after the message of the same instant; two cards keep their order.
    if (a.kind === 'message' && b.kind !== 'message') return -1;
    if (b.kind === 'message' && a.kind !== 'message') return 1;
    return 0;
  });
  ```
  Run → PASS (the existing timeline tests too).

- [ ] **Step 4: Card copy — failing test** `apps/web/src/components/chat/tab-question-text.test.ts`:
  ```ts
  import { expect, it } from 'vitest';
  import type { TabQuestion } from '../../lib/types';
  import { answerSummary, statusLabel, tabLabel, upsertTabQuestion } from './tab-question-text';

  const base = { id: 'q1', tab_id: 't1', tab_name: 'api', error_code: null, created_at: '', answered_at: null, closed_at: null };
  const choice = (over: Partial<TabQuestion> = {}) =>
    ({ ...base, kind: 'choice', status: 'open', answer: null, payload: { questions: [{ question: 'Qual cor?', header: 'Cor', multi_select: false, options: [{ label: 'Azul', description: '', recommended: true }, { label: 'Verde', description: '', recommended: false }] }, { question: 'Quais frutas?', header: 'Frutas', multi_select: true, options: [{ label: 'Maçã', description: '', recommended: false }, { label: 'Manga', description: '', recommended: false }] }] }, ...over }) as TabQuestion;
  const permission = (over: Partial<TabQuestion> = {}) => ({ ...base, kind: 'permission', status: 'open', answer: null, payload: { tool_name: 'Bash' }, ...over }) as TabQuestion;

  it('names the tab, or says it is gone', () => {
    expect(tabLabel(choice())).toBe('A aba «api»');
    expect(tabLabel(choice({ tab_name: null }))).toBe('Uma aba');
  });
  it('states in pt-BR', () => {
    expect(statusLabel(choice())).toBe('');
    expect(statusLabel(choice({ status: 'answered' }))).toBe('Respondida');
    expect(statusLabel(choice({ status: 'answered_in_tab' }))).toBe('Respondida na aba');
    expect(statusLabel(choice({ status: 'expired' }))).toBe('Expirada');
    expect(statusLabel(choice({ status: 'failed', error_code: 'MACHINE_OFFLINE' }))).toBe('Falhou — a máquina está offline');
    expect(statusLabel(choice({ status: 'failed', error_code: 'WHATEVER' }))).toBe('Falhou — não foi possível digitar na aba');
  });
  it('summarises what was answered', () => {
    expect(answerSummary(choice({ status: 'answered', answer: { answers: [{ selected: [1] }, { selected: [0, 1] }] } }))).toEqual(['Qual cor? → Verde', 'Quais frutas? → Maçã, Manga']);
    expect(answerSummary(choice({ status: 'answered', answer: { answers: [{ selected: [], text: 'Roxo' }, { selected: [0] }] } }))[0]).toBe('Qual cor? → Roxo');
    expect(answerSummary(choice({ status: 'answered_in_tab' }))).toEqual(['Qual cor?', 'Quais frutas?']);
    expect(answerSummary(permission({ status: 'answered', answer: { allow: true } }))).toEqual(['Permitido']);
    expect(answerSummary(permission({ status: 'answered', answer: { allow: false, text: 'use pnpm' } }))).toEqual(['Negado: «use pnpm»']);
    expect(answerSummary(permission({ status: 'answered', answer: { allow: false } }))).toEqual(['Negado']);
    expect(answerSummary(permission({ status: 'expired' }))).toEqual([]);
  });
  it('upserts by id, appending a new one', () => {
    const list = [choice()];
    expect(upsertTabQuestion(list, choice({ status: 'answered' }))).toEqual([choice({ status: 'answered' })]);
    expect(upsertTabQuestion(list, permission({ id: 'q2' }))).toHaveLength(2);
  });
  ```
  Run `NODE 'npm test -w @termhub/web -- src/components/chat/tab-question-text.test.ts'` → FAIL.

- [ ] **Step 5: Card copy — implement** `apps/web/src/components/chat/tab-question-text.ts`:
  ```ts
  import type { TabQuestion } from '../../lib/types';

  /** What `409 TAB_PROMPT_CHANGED` reads as on a card. */
  export const PROMPT_CHANGED_TEXT = 'A pergunta mudou na aba';

  /** Why an answer did not reach the tab, by the code the server stored. */
  const FAILURE_TEXT: Record<string, string> = {
    MACHINE_OFFLINE: 'a máquina está offline',
    AGENT_OUTDATED: 'o agente da máquina está desatualizado',
    TAB_PROMPT_CHANGED: 'a pergunta mudou na aba',
  };

  export const tabLabel = (q: TabQuestion): string => (q.tab_name ? `A aba «${q.tab_name}»` : 'Uma aba');

  export function statusLabel(q: TabQuestion): string {
    switch (q.status) {
      case 'open':
        return '';
      case 'answered':
        return 'Respondida';
      case 'answered_in_tab':
        return 'Respondida na aba';
      case 'expired':
        return 'Expirada';
      case 'failed':
        return `Falhou — ${FAILURE_TEXT[q.error_code ?? ''] ?? 'não foi possível digitar na aba'}`;
    }
  }

  /** The read-only summary a closed card keeps: each question and what was answered, when the chat answered it. */
  export function answerSummary(q: TabQuestion): string[] {
    if (q.kind === 'permission') {
      if (!q.answer) return [];
      return [q.answer.allow ? 'Permitido' : q.answer.text ? `Negado: «${q.answer.text}»` : 'Negado'];
    }
    const answers = q.answer?.answers;
    return q.payload.questions.map((item, i) => {
      const a = answers?.[i];
      if (!a) return item.question;
      return `${item.question} → ${a.text ?? a.selected.map((s) => item.options[s]?.label ?? '?').join(', ')}`;
    });
  }

  /** Every event carries the whole card: replace it by id, or append it. */
  export function upsertTabQuestion(list: TabQuestion[], q: TabQuestion): TabQuestion[] {
    return list.some((x) => x.id === q.id) ? list.map((x) => (x.id === q.id ? q : x)) : [...list, q];
  }
  ```
  Run → PASS.

- [ ] **Step 6: The card — failing test** `apps/web/src/components/chat/TabQuestionCard.test.tsx`:
  ```tsx
  // @vitest-environment jsdom
  import '@testing-library/jest-dom/vitest';
  import { cleanup, fireEvent, render, screen } from '@testing-library/react';
  import { afterEach, expect, it, vi } from 'vitest';
  import { TabQuestionCard } from './TabQuestionCard';
  import type { TabQuestion } from '../../lib/types';

  afterEach(() => cleanup());

  const base = { tab_id: 't1', tab_name: 'api', error_code: null, created_at: '', answered_at: null, closed_at: null };
  const colors = { question: 'What is your favorite color?', header: 'Color', multi_select: false, options: [{ label: 'Blue', description: 'Calm and classic.', recommended: true }, { label: 'Green', description: 'Fresh and natural.', recommended: false }, { label: 'Red', description: 'Bold and energetic.', recommended: false }] };
  const fruits = { question: 'Which fruits do you like?', header: 'Fruits', multi_select: true, options: [{ label: 'Apple', description: '', recommended: false }, { label: 'Banana', description: '', recommended: false }, { label: 'Mango', description: '', recommended: false }] };
  const choice = (over: Partial<TabQuestion> = {}) => ({ ...base, id: 'q1', kind: 'choice', status: 'open', answer: null, payload: { questions: [colors, fruits] }, ...over }) as TabQuestion;
  const permission = (over: Partial<TabQuestion> = {}) => ({ ...base, id: 'q2', kind: 'permission', status: 'open', answer: null, payload: { tool_name: 'Bash' }, ...over }) as TabQuestion;

  it('answers a two-question card: a radio on the first tab, checkboxes on the second', () => {
    const onAnswer = vi.fn();
    render(<TabQuestionCard question={choice()} answering={false} onAnswer={onAnswer} />);
    expect(screen.getByText('A aba «api» perguntou')).toBeInTheDocument();
    expect(screen.getByText('Recomendada')).toBeInTheDocument();
    expect(screen.getByText('Calm and classic.')).toBeInTheDocument();
    const submit = screen.getByRole('button', { name: 'Responder' });
    expect(submit).toBeDisabled();
    fireEvent.click(screen.getByRole('radio', { name: /Green/ }));
    fireEvent.click(screen.getByRole('tab', { name: 'Fruits' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Mango/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Apple/ }));
    fireEvent.click(submit);
    expect(onAnswer).toHaveBeenCalledWith({ answers: [{ selected: [1] }, { selected: [0, 2] }] });
  });

  it('"Outra resposta" answers with text and sets the options aside', () => {
    const onAnswer = vi.fn();
    render(<TabQuestionCard question={choice({ payload: { questions: [colors] } } as Partial<TabQuestion>)} answering={false} onAnswer={onAnswer} />);
    expect(screen.queryByRole('tab')).toBeNull(); // one question: no tab strip
    fireEvent.change(screen.getByLabelText('Outra resposta'), { target: { value: '  Purple ' } });
    expect(screen.getByRole('radio', { name: /Blue/ })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Responder' }));
    expect(onAnswer).toHaveBeenCalledWith({ answers: [{ selected: [], text: 'Purple' }] });
  });

  it('a permission card shows the live excerpt and allows, denies, or denies with a sentence', async () => {
    const onAnswer = vi.fn();
    const loadScreen = vi.fn(async () => 'Bash command\n  touch probe-file.txt\nDo you want to proceed?');
    render(<TabQuestionCard question={permission()} answering={false} onAnswer={onAnswer} loadScreen={loadScreen} />);
    expect(screen.getByText('A aba «api» pede permissão para usar «Bash»')).toBeInTheDocument();
    expect(await screen.findByText(/touch probe-file\.txt/)).toBeInTheDocument();
    expect(screen.getByText('Tela da aba')).toBeInTheDocument();
    expect(loadScreen).toHaveBeenCalledWith('q2');
    fireEvent.click(screen.getByRole('button', { name: 'Permitir' }));
    expect(onAnswer).toHaveBeenLastCalledWith({ allow: true });
    fireEvent.click(screen.getByRole('button', { name: 'Negar' }));
    expect(onAnswer).toHaveBeenLastCalledWith({ allow: false });
    fireEvent.click(screen.getByRole('button', { name: 'Negar e dizer…' }));
    fireEvent.change(screen.getByLabelText('O que dizer à aba'), { target: { value: 'use pnpm' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    expect(onAnswer).toHaveBeenLastCalledWith({ allow: false, text: 'use pnpm' });
  });

  it('disables every answer while one is in flight', () => {
    render(<TabQuestionCard question={permission()} answering onAnswer={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Permitir' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Negar' })).toBeDisabled();
  });

  it.each([
    [choice({ status: 'answered', answer: { answers: [{ selected: [1] }, { selected: [0] }] } } as Partial<TabQuestion>), ['What is your favorite color? → Green', 'Respondida']],
    [choice({ status: 'answered_in_tab' }), ['Respondida na aba']],
    [permission({ status: 'expired' }), ['Expirada']],
    [permission({ status: 'failed', error_code: 'MACHINE_OFFLINE', answer: { allow: true } } as Partial<TabQuestion>), ['Permitido', 'Falhou — a máquina está offline']],
  ])('a closed card is read-only and says how it ended (%#)', (q, texts) => {
    render(<TabQuestionCard question={q} answering={false} onAnswer={vi.fn()} loadScreen={vi.fn(async () => 'x')} />);
    for (const t of texts) expect(screen.getByText(t)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Responder|Permitir/ })).toBeNull();
  });

  it('shows the error it is given', () => {
    render(<TabQuestionCard question={permission()} answering={false} onAnswer={vi.fn()} error="A pergunta mudou na aba" />);
    expect(screen.getByText('A pergunta mudou na aba')).toBeInTheDocument();
  });
  ```
  Run `NODE 'npm test -w @termhub/web -- src/components/chat/TabQuestionCard.test.tsx'` → FAIL.

- [ ] **Step 7: The card — implement** `apps/web/src/components/chat/TabQuestionCard.tsx`:
  ```tsx
  import { useEffect, useState } from 'react';
  import type { TabQuestion, TabQuestionAnswer, TabQuestionChoice, TabQuestionPermission } from '../../lib/types';
  import { answerSummary, statusLabel, tabLabel } from './tab-question-text';

  export interface TabQuestionCardProps {
    question: TabQuestion;
    /** This card's answer is in flight: every control is disabled. */
    answering: boolean;
    /** Why the last answer did not go through (pt-BR). */
    error?: string | null;
    onAnswer: (body: TabQuestionAnswer) => void;
    /** The tab's live excerpt, for a permission card while it is open. Stable across renders. */
    loadScreen?: (id: string) => Promise<string>;
  }

  /**
   * A question an agent in a tab asked, inline in the thread (spec 2026-09-25 §6.2). Presentational:
   * the request and the error handling live in `ChatPanel`. Everything shown is plain text — never HTML.
   */
  export function TabQuestionCard(props: TabQuestionCardProps) {
    const { question, error } = props;
    return (
      <li className="rounded-xl border border-attention/40 bg-bg-2 px-4 py-3 text-sm">
        {question.kind === 'choice' ? <ChoiceBody {...props} question={question} /> : <PermissionBody {...props} question={question} />}
        {question.status !== 'open' && <p className="mt-1 text-xs text-fg-dim">{statusLabel(question)}</p>}
        {error && <p className="mt-1 text-xs text-danger">{error}</p>}
      </li>
    );
  }

  function ChoiceBody({ question, answering, onAnswer }: TabQuestionCardProps & { question: TabQuestionChoice }) {
    const items = question.payload.questions;
    const [current, setCurrent] = useState(0);
    const [selected, setSelected] = useState<number[][]>(() => items.map(() => []));
    const [texts, setTexts] = useState<string[]>(() => items.map(() => ''));
    const title = <p className="font-medium text-fg">{`${tabLabel(question)} perguntou`}</p>;
    if (question.status !== 'open') {
      return (
        <>
          {title}
          <ul className="mt-1 space-y-0.5 whitespace-pre-wrap text-fg">
            {answerSummary(question).map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </>
      );
    }
    const answers = items.map((_, i) => (texts[i]!.trim() ? { selected: [], text: texts[i]!.trim() } : { selected: [...selected[i]!].sort((a, b) => a - b) }));
    const complete = answers.every((a) => 'text' in a || a.selected.length > 0);
    const item = items[current]!;
    const typing = texts[current]!.trim() !== '';
    const toggle = (option: number) =>
      setSelected((prev) => prev.map((s, j) => (j !== current ? s : item.multi_select ? (s.includes(option) ? s.filter((x) => x !== option) : [...s, option]) : [option])));
    return (
      <>
        {title}
        {items.length > 1 && (
          <div role="tablist" className="mt-2 flex flex-wrap gap-1">
            {items.map((it, i) => (
              <button key={i} type="button" role="tab" aria-selected={i === current} className={i === current ? 'btn-primary' : 'btn-ghost'} onClick={() => setCurrent(i)}>
                {it.header || `Pergunta ${i + 1}`}
              </button>
            ))}
          </div>
        )}
        <fieldset className="mt-2" disabled={answering}>
          <legend className="whitespace-pre-wrap text-fg">{item.question}</legend>
          {item.options.map((o, oi) => (
            <label key={oi} className="mt-1 flex items-start gap-2">
              <input type={item.multi_select ? 'checkbox' : 'radio'} name={`${question.id}-${current}`} checked={selected[current]!.includes(oi)} disabled={typing} onChange={() => toggle(oi)} />
              <span>
                <span className="text-fg">{o.label}</span>
                {o.recommended && <span className="ml-2 rounded bg-accent/20 px-1 text-xs text-fg">Recomendada</span>}
                {o.description && <span className="block text-xs text-fg-dim">{o.description}</span>}
              </span>
            </label>
          ))}
          <label className="mt-2 block text-xs text-fg-dim">
            Outra resposta
            <input
              type="text"
              className="input mt-1"
              maxLength={2000}
              value={texts[current]}
              onChange={(e) => setTexts((prev) => prev.map((t, j) => (j === current ? e.target.value : t)))}
            />
          </label>
        </fieldset>
        <button type="button" className="btn-primary mt-2" disabled={answering || !complete} onClick={() => onAnswer({ answers })}>
          Responder
        </button>
      </>
    );
  }

  function PermissionBody({ question, answering, onAnswer, loadScreen }: TabQuestionCardProps & { question: TabQuestionPermission }) {
    const open = question.status === 'open';
    const [screen, setScreen] = useState<string | null>(null);
    const [denying, setDenying] = useState(false);
    const [text, setText] = useState('');
    useEffect(() => {
      if (!open || !loadScreen) return;
      let alive = true;
      // A card whose tab moved on answers 409 here: it simply shows no excerpt.
      loadScreen(question.id).then(
        (t) => {
          if (alive) setScreen(t);
        },
        () => {},
      );
      return () => {
        alive = false;
      };
    }, [open, question.id, loadScreen]);
    return (
      <>
        <p className="whitespace-pre-wrap text-fg">{`${tabLabel(question)} pede permissão para usar «${question.payload.tool_name}»`}</p>
        {open && screen !== null && (
          <details className="mt-2">
            <summary className="cursor-pointer text-xs text-fg-dim">Tela da aba</summary>
            <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap font-mono text-xs text-fg">{screen}</pre>
          </details>
        )}
        {open ? (
          <>
            <div className="mt-2 flex flex-wrap gap-2">
              <button type="button" className="btn-primary" disabled={answering} onClick={() => onAnswer({ allow: true })}>
                Permitir
              </button>
              <button type="button" className="btn-danger" disabled={answering} onClick={() => onAnswer({ allow: false })}>
                Negar
              </button>
              <button type="button" className="btn-ghost" disabled={answering} onClick={() => setDenying(true)}>
                Negar e dizer…
              </button>
            </div>
            {denying && (
              <div className="mt-2 flex gap-2">
                <input aria-label="O que dizer à aba" className="input" maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} />
                <button type="button" className="btn-danger" disabled={answering || !text.trim()} onClick={() => onAnswer({ allow: false, text: text.trim() })}>
                  Enviar
                </button>
              </div>
            )}
          </>
        ) : (
          answerSummary(question).map((line, i) => (
            <p key={i} className="mt-1 text-fg">
              {line}
            </p>
          ))
        )}
      </>
    );
  }
  ```
  Run the card test → PASS.

- [ ] **Step 8: The panel — failing test.** In `apps/web/src/components/chat/ChatPanel.test.tsx`: add `const answerMock = vi.fn(); const screenMock = vi.fn();` next to the other mocks, `answerTabQuestion: (...a: unknown[]) => answerMock(...a), tabQuestionScreen: (...a: unknown[]) => screenMock(...a),` to the mocked `api`, `answerMock.mockReset(); screenMock.mockReset(); screenMock.mockResolvedValue({ text: 'Do you want to proceed?' });` to `beforeEach`, add `TabQuestion` to the type import, and append:
  ```tsx
  const question = (over: Partial<TabQuestion> & { id: string }): TabQuestion =>
    ({ tab_id: 't1', tab_name: 'api', kind: 'permission', payload: { tool_name: 'Bash' }, answer: null, status: 'open', error_code: null, created_at: '2026-09-21T00:00:00.000Z', answered_at: null, closed_at: null, ...over }) as TabQuestion;

  it('shows a tab question from GET /chat and answers it with one click', async () => {
    chatMock.mockResolvedValue({ conversation: { id: 'c_p1', project_id: 'p1', ai_account_id: null }, messages: [], actions: [], host: READY, grants: [], tab_questions: [question({ id: 'q1' })] });
    answerMock.mockResolvedValue({ tab_question: question({ id: 'q1', status: 'answered', answer: { allow: true } } as Partial<TabQuestion> & { id: string }) });
    render(
      <MemoryRouter>
        <ChatPanel projectId="p1" />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Permitir' }));
    await waitFor(() => expect(answerMock).toHaveBeenCalledWith('q1', { allow: true }));
    expect(await screen.findByText('Respondida')).toBeInTheDocument();
    expect(screenMock).toHaveBeenCalledWith('q1');
  });

  it('a stale question reads "A pergunta mudou na aba"', async () => {
    const { ApiError } = await import('../../lib/api');
    chatMock.mockResolvedValue({ conversation: { id: 'c_p1', project_id: 'p1', ai_account_id: null }, messages: [], actions: [], host: READY, grants: [], tab_questions: [question({ id: 'q1' })] });
    answerMock.mockRejectedValue(new ApiError(409, 'A pergunta mudou na aba', 'TAB_PROMPT_CHANGED'));
    render(
      <MemoryRouter>
        <ChatPanel projectId="p1" />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Negar' }));
    expect(await screen.findByText('A pergunta mudou na aba')).toBeInTheDocument();
  });

  it('tab question events add and update the card; another conversation\'s are ignored', async () => {
    let onEvent!: (e: unknown) => void;
    streamMock.mockImplementation((_reload: unknown, cb: (e: unknown) => void) => {
      onEvent = cb;
      return { events: [], connected: true };
    });
    chatMock.mockResolvedValue({ conversation: { id: 'c_p1', project_id: 'p1', ai_account_id: null }, messages: [], actions: [], host: READY, grants: [] });
    render(
      <MemoryRouter>
        <ChatPanel projectId="p1" />
      </MemoryRouter>,
    );
    await waitFor(() => expect(chatMock).toHaveBeenCalled());
    onEvent({ type: 'tab_question', conversation_id: 'c_other', question: question({ id: 'q9', tab_name: 'OUTRA' }) });
    expect(screen.queryByText(/OUTRA/)).toBeNull();
    onEvent({ type: 'tab_question', conversation_id: 'c_p1', question: question({ id: 'q1' }) });
    expect(await screen.findByText('A aba «api» pede permissão para usar «Bash»')).toBeInTheDocument();
    onEvent({ type: 'tab_question_closed', conversation_id: 'c_p1', question: question({ id: 'q1', status: 'answered_in_tab' }) });
    expect(await screen.findByText('Respondida na aba')).toBeInTheDocument();
  });
  ```
  Run `NODE 'npm test -w @termhub/web -- src/components/chat/ChatPanel.test.tsx'` → FAIL.

- [ ] **Step 9: The panel — implement.** In `apps/web/src/components/chat/ChatPanel.tsx`:
  - imports: `import { TabQuestionCard } from './TabQuestionCard';`, `import { PROMPT_CHANGED_TEXT, upsertTabQuestion } from './tab-question-text';`, add `TabQuestion, TabQuestionAnswer` to the type import.
  - state, next to `grants`:
    ```tsx
    /** The tabs' questions of this conversation (spec 2026-09-25 §6.2), from `GET /api/chat` and the three events. */
    const [tabQuestions, setTabQuestions] = useState<TabQuestion[]>([]);
    const [answeringQuestionId, setAnsweringQuestionId] = useState<string | null>(null);
    const [questionErrors, setQuestionErrors] = useState<Record<string, string>>({});
    ```
  - in `load`: destructure `tab_questions` too and `setTabQuestions(tab_questions ?? []);`
  - in `onEvent`, a branch before the closing of the chain:
    ```tsx
    else if (e.type === 'tab_question' || e.type === 'tab_question_answered' || e.type === 'tab_question_closed') setTabQuestions((prev) => upsertTabQuestion(prev, e.question));
    ```
  - after `revoke`:
    ```tsx
    /** A click on a tab question's card is the answer: no confirmation, no model turn. */
    const answerQuestion = async (id: string, body: TabQuestionAnswer) => {
      setAnsweringQuestionId(id);
      setQuestionErrors(({ [id]: _dropped, ...rest }) => rest);
      try {
        const { tab_question } = await api.answerTabQuestion(id, body);
        setTabQuestions((prev) => upsertTabQuestion(prev, tab_question));
      } catch (e) {
        const text = e instanceof ApiError && e.code === 'TAB_PROMPT_CHANGED' ? PROMPT_CHANGED_TEXT : e instanceof ApiError ? e.message : 'Não foi possível responder';
        setQuestionErrors((prev) => ({ ...prev, [id]: text }));
      } finally {
        setAnsweringQuestionId(null);
      }
    };
    /** Stable, so the permission card's effect runs once per question. */
    const loadTabQuestionScreen = useCallback(async (id: string) => (await api.tabQuestionScreen(id)).text, []);
    ```
  - `const timeline = useMemo(() => chatTimeline(messages, actions, tabQuestions), [messages, actions, tabQuestions]);`
  - in `reset`, next to `setGrants([]);`: `setTabQuestions([]);` and `setQuestionErrors({});`
  - in the thread's `timeline.map`, before the `entry.kind === 'action'` branch:
    ```tsx
    if (entry.kind === 'tab_question') {
      const q = entry.question;
      return <TabQuestionCard key={`q:${q.id}`} question={q} answering={answeringQuestionId === q.id} error={questionErrors[q.id]} onAnswer={(body) => void answerQuestion(q.id, body)} loadScreen={loadTabQuestionScreen} />;
    }
    ```
  Run the panel test → PASS, then the whole web suite and the build: `NODE 'npm test -w @termhub/web && npm run build -w @termhub/web'` → PASS.

- [ ] **Step 10: Commit**
  ```bash
  git add apps/web/src/lib/types.ts apps/web/src/lib/api.ts apps/web/src/lib/chat-timeline.ts apps/web/src/lib/chat-timeline.test.ts apps/web/src/components/chat/tab-question-text.ts apps/web/src/components/chat/tab-question-text.test.ts apps/web/src/components/chat/TabQuestionCard.tsx apps/web/src/components/chat/TabQuestionCard.test.tsx apps/web/src/components/chat/ChatPanel.tsx apps/web/src/components/chat/ChatPanel.test.tsx
  git commit -F - <<'MSG'
  Chat: show a tab's question as a card and answer it in one click

  Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
  MSG
  ```

---

### Task 9: App mobile: cliente, store, reducer, card, mock

**Files:**
- Modify: `apps/mobile/src/services/api/contract/local.ts` (`chatResponse` ~line 90, types ~line 150)
- Modify: `apps/mobile/src/services/api/types.ts`, `apps/mobile/src/services/api/client.ts` (~line 212)
- Modify: `apps/mobile/src/services/api/mock/state.ts`, `apps/mobile/src/services/api/mock/handlers/chat.ts`, `apps/mobile/src/services/api/mock/chat.e2e.test.ts`
- Modify: `apps/mobile/src/features/chat/model/types.ts`, `events.ts`, `events.test.ts`, `timeline.ts`, `timeline.test.ts`, `messages.ts`
- Create: `apps/mobile/src/features/chat/model/tab-question-text.ts`, `apps/mobile/src/features/chat/model/tab-question-text.test.ts`
- Modify: `apps/mobile/src/features/chat/viewmodel/createChatStore.ts`, `createChatStore.test.ts`
- Create: `apps/mobile/src/features/chat/view/tab-question-card.tsx`
- Modify: `apps/mobile/src/features/chat/view/conversation-screen.tsx`, `conversation-screen.test.tsx`

**Interfaces:**
- Consumes: `tabQuestionSchema`, `tabQuestionAnswerBody`, `tabQuestionScreenResponse` from `@termhub/mobile-api` (Task 5; rebuild it first); routes of Task 6.
- Produces:
  ```ts
  // contract/local.ts
  chatResponse.tab_questions: TTabQuestion[] (default [])
  export type TTabQuestion; export type TTabQuestionAnswerBody; export type TTabQuestionScreenResponse;
  // services/api/types.ts (MobileApi)
  answerTabQuestion(auth: Auth, questionId: string, body: TTabQuestionAnswerBody): Promise<void>;
  tabQuestionScreen(auth: Auth, questionId: string): Promise<TTabQuestionScreenResponse>;
  // features/chat/model
  export type TabQuestion = TTabQuestion;                       // types.ts
  EventSlice.tabQuestions: TabQuestion[]                         // events.ts
  export function upsertTabQuestion(list: TabQuestion[], q: TabQuestion): TabQuestion[]; // events.ts
  export function chatTimeline(messages, actions, tabQuestions?: TabQuestion[]): ChatEntry[]; // timeline.ts
  CHAT_MSG.tabPromptChanged = 'A pergunta mudou na aba'           // messages.ts
  tabLabel / statusLabel / answerSummary                          // tab-question-text.ts (same as the web's)
  // viewmodel
  ConversationSlot.tabQuestions: TabQuestion[];
  ChatState.answeringQuestionId: string | null;
  ChatState.answerTabQuestion(questionId: string, body: TTabQuestionAnswerBody): Promise<void>;
  ChatState.loadTabQuestionScreen(questionId: string): Promise<string | null>;
  // view
  export const TabQuestionCard: React.MemoExoticComponent<(p: { question: TabQuestion; busy: boolean; onAnswer(id: string, body: TTabQuestionAnswerBody): void; loadScreen(id: string): Promise<string | null> }) => JSX.Element>;
  ```
- Mock: a message containing `pergunta` makes the mock push an open `choice` question on the tab `t-api`; one containing `permiss` a `permission` for `Bash`. The mock's answer route answers `409 TAB_PROMPT_CHANGED` for a closed question, like the server.

- [ ] **Step 1: Contract and client.** In `contract/local.ts`: import `tabQuestionSchema`, `tabQuestionAnswerBody`, `tabQuestionScreenResponse`; add `tab_questions: z.array(tabQuestionSchema).default([]),` to `chatResponse` (after `grants`); add the types:
  ```ts
  export type TTabQuestion = z.infer<typeof tabQuestionSchema>;
  export type TTabQuestionAnswerBody = z.infer<typeof tabQuestionAnswerBody>;
  export type TTabQuestionScreenResponse = z.infer<typeof tabQuestionScreenResponse>;
  ```
  In `services/api/types.ts` import the two new types and add to `MobileApi`, after `revokeGrant`:
  ```ts
  /** Answers a tab's question from its card — no PIN (spec 2026-09-25 §2). 409 `TAB_PROMPT_CHANGED`
   * when the tab moved on, 404 unknown. */
  answerTabQuestion(auth: Auth, questionId: string, body: TTabQuestionAnswerBody): Promise<void>;
  /** The tab's last lines, live, for a permission card; 409 once the question is closed. */
  tabQuestionScreen(auth: Auth, questionId: string): Promise<TTabQuestionScreenResponse>;
  ```
  In `client.ts` import `tabQuestionScreenResponse` and the body type; after `revokeGrant`:
  ```ts
  answerTabQuestion: (a: Auth, id: string, body: TTabQuestionAnswerBody) =>
    empty('POST', `/api/m/v1/chat/tab-questions/${encodeURIComponent(id)}/answer`, { token: a.accessToken, body }),
  tabQuestionScreen: (a: Auth, id: string) => call('GET', `/api/m/v1/chat/tab-questions/${encodeURIComponent(id)}/screen`, tabQuestionScreenResponse, { token: a.accessToken }),
  ```

- [ ] **Step 2: Mock — failing e2e test.** Append to `apps/mobile/src/services/api/mock/chat.e2e.test.ts`:
  ```ts
  it('a message containing pergunta raises a tab question; answering it once works, twice is 409', async () => {
    const clock = { value: START };
    const { api, auth } = await enrol(clock);
    const collected = collectEvents(api, auth);
    await jest.advanceTimersByTimeAsync(0);

    await api.sendMessage(auth, { text: 'tem alguma pergunta pendente?', project_id: 'p-termhub' });
    await jest.advanceTimersByTimeAsync(5000);

    const opened = collected.events.find((e): e is Extract<TChatEvent, { type: 'tab_question' }> => e.type === 'tab_question');
    expect(opened?.question).toMatchObject({ kind: 'choice', status: 'open', tab_id: 't-api', tab_name: 'api' });
    const id = opened!.question.id;
    expect((await api.chat(auth, 'p-termhub')).tab_questions.map((q) => q.id)).toContain(id);
    expect((await api.tabQuestionScreen(auth, id)).text).toContain('Qual banco usamos nos testes?');

    await api.answerTabQuestion(auth, id, { answers: [{ selected: [0] }] });
    await jest.advanceTimersByTimeAsync(0);
    expect(collected.events.some((e) => e.type === 'tab_question_answered' && e.question.id === id && e.question.status === 'answered')).toBe(true);
    expect((await api.chat(auth, 'p-termhub')).tab_questions.find((q) => q.id === id)).toMatchObject({ status: 'answered', answer: { answers: [{ selected: [0] }] } });

    await expect(api.answerTabQuestion(auth, id, { answers: [{ selected: [0] }] })).rejects.toMatchObject({ status: 409, code: 'TAB_PROMPT_CHANGED' });
    await expect(api.tabQuestionScreen(auth, id)).rejects.toMatchObject({ status: 409 });
    await expect(api.answerTabQuestion(auth, 'nope', { allow: true })).rejects.toMatchObject({ status: 404 });

    collected.close();
  });

  it('a message containing permissão raises a permission question for Bash', async () => {
    const clock = { value: START };
    const { api, auth } = await enrol(clock);
    const collected = collectEvents(api, auth);
    await jest.advanceTimersByTimeAsync(0);
    await api.sendMessage(auth, { text: 'preciso da sua permissão', project_id: 'p-termhub' });
    await jest.advanceTimersByTimeAsync(5000);
    const opened = collected.events.find((e): e is Extract<TChatEvent, { type: 'tab_question' }> => e.type === 'tab_question');
    expect(opened?.question).toMatchObject({ kind: 'permission', payload: { tool_name: 'Bash' } });
    await expect(api.answerTabQuestion(auth, opened!.question.id, { answers: [{ selected: [0] }] })).rejects.toMatchObject({ status: 400 });
    await api.answerTabQuestion(auth, opened!.question.id, { allow: false, text: 'use pnpm' });
    collected.close();
  });
  ```
  Run `NODE 'npm run build -w @termhub/mobile-api && npm test -w @termhub/mobile -- src/services/api/mock/chat.e2e.test.ts'` → FAIL.

- [ ] **Step 3: Mock — implement.** In `mock/state.ts`: import `TTabQuestion`; add
  ```ts
  /** A tab's question (spec 2026-09-25): the wire shape plus the conversation it was pushed into. */
  export type MockTabQuestion = TTabQuestion & { conversation_id: string };
  ```
  `tabQuestions: MockTabQuestion[];` to `MockState` (doc: "Oldest first; answered rows stay (a second answer is a 409, as on the server)"), and `tabQuestions: [],` to `createMockState()`.
  In `mock/handlers/chat.ts`: import `tabQuestionAnswerBody`, `type TTabQuestion` from `../../contract` and `type MockTabQuestion` from `../state`; then
  ```ts
  // --- tab questions (spec 2026-09-25 §6.3) ---------------------------------------------------------

  /** The wire shape of a question (the server's `TabQuestionView`): the mock's row minus its conversation. */
  function tabQuestionView(q: MockTabQuestion): TTabQuestion {
    const { conversation_id: _conversation, ...view } = q;
    return view as TTabQuestion;
  }

  /** The canned question a `pergunta` / `permiss` message makes the tab `api` ask. */
  function createTabQuestion(state: MockState, now: number, conversationId: string, kind: 'choice' | 'permission'): MockTabQuestion {
    const common = { id: randomId(10), conversation_id: conversationId, tab_id: 't-api', tab_name: 'api', status: 'open' as const, error_code: null, created_at: new Date(now).toISOString(), answered_at: null, closed_at: null };
    const question: MockTabQuestion =
      kind === 'choice'
        ? {
            ...common,
            kind: 'choice',
            answer: null,
            payload: {
              questions: [
                {
                  question: 'Qual banco usamos nos testes?',
                  header: 'Banco',
                  multi_select: false,
                  options: [
                    { label: 'Postgres', description: 'O mesmo da produção.', recommended: true },
                    { label: 'SQLite', description: 'Mais rápido, menos fiel.', recommended: false },
                  ],
                },
              ],
            },
          }
        : { ...common, kind: 'permission', answer: null, payload: { tool_name: 'Bash' } };
    state.tabQuestions.push(question);
    return question;
  }

  /** What `GET …/screen` shows: the card as the tab would draw it. */
  function tabQuestionScreenText(q: MockTabQuestion): string {
    return q.kind === 'choice' ? `${q.payload.questions[0]!.question}\n❯ 1. Postgres\n  2. SQLite\n  3. Type something.` : 'Bash command\n  npm test\n Do you want to proceed?\n ❯ 1. Yes\n   2. No';
  }
  ```
  - `AnswerOutcome['kind']` gains `'tab_question' | 'tab_permission'`; in `pickAnswer`, after the `confirma` branch:
    ```ts
    if (/pergunta/.test(text)) return { kind: 'tab_question', text: 'A aba api tem uma pergunta para você — responda no card.' };
    if (/permiss/.test(text)) return { kind: 'tab_permission', text: 'A aba api pede permissão — responda no card.' };
    ```
  - in `scheduleStream`, after the `if (outcome.kind === 'confirmation') { … }` block:
    ```ts
    if (outcome.kind === 'tab_question' || outcome.kind === 'tab_permission') {
      const question = createTabQuestion(o.state, o.now(), o.conversationId, outcome.kind === 'tab_question' ? 'choice' : 'permission');
      broadcast(o.state, { type: 'tab_question', user_id: USER_ID, conversation_id: o.conversationId, question: tabQuestionView(question) });
    }
    ```
  - in `GET /api/m/v1/chat`'s body, after `grants`: `tab_questions: state.tabQuestions.filter((q) => q.conversation_id === conversation.id).map(tabQuestionView),`
  - two routes at the end of `registerChatRoutes`:
    ```ts
    /** Answers a tab's question (no PIN): 404 unknown, 409 once it is closed, 400 a body of the other kind. */
    router.route('POST', '/api/m/v1/chat/tab-questions/:id/answer', (ctx) => {
      verifyAuth(state, { headers: ctx.headers, htm: 'POST', htu: ctx.htu, now: ctx.now() });
      const question = state.tabQuestions.find((q) => q.id === ctx.params.id);
      if (!question) throw new WireError(404, 'NOT_FOUND', 'Pergunta não encontrada');
      if (question.status !== 'open') throw new WireError(409, 'TAB_PROMPT_CHANGED', 'A pergunta mudou na aba');
      const body = tabQuestionAnswerBody.parse(ctx.body);
      if ((question.kind === 'choice') !== 'answers' in body) throw new WireError(400, 'VALIDATION', 'Dados inválidos');
      Object.assign(question, { status: 'answered', answer: body, answered_at: new Date(ctx.now()).toISOString() });
      const view = tabQuestionView(question);
      broadcast(state, { type: 'tab_question_answered', user_id: USER_ID, conversation_id: question.conversation_id, question: view });
      return { status: 200, body: { tab_question: view } };
    });

    router.route('GET', '/api/m/v1/chat/tab-questions/:id/screen', (ctx) => {
      verifyAuth(state, { headers: ctx.headers, htm: 'GET', htu: ctx.htu, now: ctx.now() });
      const question = state.tabQuestions.find((q) => q.id === ctx.params.id);
      if (!question) throw new WireError(404, 'NOT_FOUND', 'Pergunta não encontrada');
      if (question.status !== 'open') throw new WireError(409, 'TAB_PROMPT_CHANGED', 'A pergunta mudou na aba');
      return { status: 200, body: { text: tabQuestionScreenText(question) } };
    });
    ```
  Run the e2e test → PASS, then the whole mock folder: `NODE 'npm test -w @termhub/mobile -- src/services/api'` → PASS.

- [ ] **Step 4: Model — failing tests.** In `features/chat/model/events.test.ts`: add `TabQuestion` to the type import, change `empty` to `{ messages: [], actions: [], live: [], grants: [], tabQuestions: [] }`, and append:
  ```ts
  it('tab question events upsert the card by id and never ask for a re-read', () => {
    const q = { id: 'q1', tab_id: 't1', tab_name: 'api', kind: 'permission', payload: { tool_name: 'Bash' }, answer: null, status: 'open', error_code: null, created_at: at, answered_at: null, closed_at: null } as TabQuestion;
    const opened = applyEvent(empty, { type: 'tab_question', ...base, question: q });
    expect(opened).toEqual({ slice: { ...empty, tabQuestions: [q] }, reread: false });
    const answered = { ...q, status: 'answered', answer: { allow: true } } as TabQuestion;
    expect(applyEvent(opened.slice, { type: 'tab_question_answered', ...base, question: answered }).slice.tabQuestions).toEqual([answered]);
    const closed = { ...answered, closed_at: at } as TabQuestion;
    expect(applyEvent(opened.slice, { type: 'tab_question_closed', ...base, question: closed }).slice.tabQuestions).toEqual([closed]);
  });
  ```
  In `timeline.test.ts` add (and `TabQuestion` to its import):
  ```ts
  it('places a tab question by its time, after a message of the same instant, inside the message window', () => {
    const q = { id: 'q1', tab_id: 't1', tab_name: 'api', kind: 'permission', payload: { tool_name: 'Bash' }, answer: null, status: 'open', error_code: null, created_at: T1, answered_at: null, closed_at: null } as TabQuestion;
    const entries = chatTimeline([message({ id: 'm1', created_at: T0 }), message({ id: 'm2', created_at: T1 })], [], [q, { ...q, id: 'q0', created_at: '2025-12-31T23:59:00.000Z' } as TabQuestion]);
    expect(entries.map((e) => (e.kind === 'message' ? e.message.id : e.kind === 'action' ? e.action.id : e.question.id))).toEqual(['m1', 'm2', 'q1']);
  });
  ```
  Create `features/chat/model/tab-question-text.test.ts` (jest globals, no import of `it`/`expect`):
  ```ts
  import type { TabQuestion } from './types';
  import { answerSummary, statusLabel, tabLabel } from './tab-question-text';

  const base = { id: 'q1', tab_id: 't1', tab_name: 'api', error_code: null, created_at: '', answered_at: null, closed_at: null };
  const choice = (over: Partial<TabQuestion> = {}) =>
    ({ ...base, kind: 'choice', status: 'open', answer: null, payload: { questions: [{ question: 'Qual cor?', header: 'Cor', multi_select: false, options: [{ label: 'Azul', description: '', recommended: true }, { label: 'Verde', description: '', recommended: false }] }, { question: 'Quais frutas?', header: 'Frutas', multi_select: true, options: [{ label: 'Maçã', description: '', recommended: false }, { label: 'Manga', description: '', recommended: false }] }] }, ...over }) as TabQuestion;
  const permission = (over: Partial<TabQuestion> = {}) => ({ ...base, kind: 'permission', status: 'open', answer: null, payload: { tool_name: 'Bash' }, ...over }) as TabQuestion;

  it('names the tab, or says it is gone', () => {
    expect(tabLabel(choice())).toBe('A aba «api»');
    expect(tabLabel(choice({ tab_name: null }))).toBe('Uma aba');
  });
  it('states in pt-BR, the same words as the web', () => {
    expect(statusLabel(choice())).toBe('');
    expect(statusLabel(choice({ status: 'answered' }))).toBe('Respondida');
    expect(statusLabel(choice({ status: 'answered_in_tab' }))).toBe('Respondida na aba');
    expect(statusLabel(choice({ status: 'expired' }))).toBe('Expirada');
    expect(statusLabel(choice({ status: 'failed', error_code: 'MACHINE_OFFLINE' }))).toBe('Falhou — a máquina está offline');
    expect(statusLabel(choice({ status: 'failed', error_code: 'WHATEVER' }))).toBe('Falhou — não foi possível digitar na aba');
  });
  it('summarises what was answered', () => {
    expect(answerSummary(choice({ status: 'answered', answer: { answers: [{ selected: [1] }, { selected: [0, 1] }] } }))).toEqual(['Qual cor? → Verde', 'Quais frutas? → Maçã, Manga']);
    expect(answerSummary(choice({ status: 'answered', answer: { answers: [{ selected: [], text: 'Roxo' }, { selected: [0] }] } }))[0]).toBe('Qual cor? → Roxo');
    expect(answerSummary(choice({ status: 'answered_in_tab' }))).toEqual(['Qual cor?', 'Quais frutas?']);
    expect(answerSummary(permission({ status: 'answered', answer: { allow: true } }))).toEqual(['Permitido']);
    expect(answerSummary(permission({ status: 'answered', answer: { allow: false, text: 'use pnpm' } }))).toEqual(['Negado: «use pnpm»']);
    expect(answerSummary(permission({ status: 'answered', answer: { allow: false } }))).toEqual(['Negado']);
    expect(answerSummary(permission({ status: 'expired' }))).toEqual([]);
  });
  ```
  Run `NODE 'npm test -w @termhub/mobile -- src/features/chat/model'` → FAIL.

- [ ] **Step 5: Model — implement.**
  - `types.ts`: add `TTabQuestion` to the contract import and `/** A question an agent in a tab asked (spec 2026-09-25). */ export type TabQuestion = TTabQuestion;`
  - `messages.ts`: add `tabPromptChanged: 'A pergunta mudou na aba',` to `CHAT_MSG`.
  - `tab-question-text.ts`:
    ```ts
    // Copied from apps/web/src/components/chat/tab-question-text.ts — keep the two in step (same pt-BR copy).
    import type { TabQuestion } from './types';

    /** Why an answer did not reach the tab, by the code the server stored. */
    const FAILURE_TEXT: Record<string, string> = {
      MACHINE_OFFLINE: 'a máquina está offline',
      AGENT_OUTDATED: 'o agente da máquina está desatualizado',
      TAB_PROMPT_CHANGED: 'a pergunta mudou na aba',
    };

    export const tabLabel = (q: TabQuestion): string => (q.tab_name ? `A aba «${q.tab_name}»` : 'Uma aba');

    export function statusLabel(q: TabQuestion): string {
      switch (q.status) {
        case 'open':
          return '';
        case 'answered':
          return 'Respondida';
        case 'answered_in_tab':
          return 'Respondida na aba';
        case 'expired':
          return 'Expirada';
        case 'failed':
          return `Falhou — ${FAILURE_TEXT[q.error_code ?? ''] ?? 'não foi possível digitar na aba'}`;
      }
    }

    /** The read-only summary a closed card keeps: each question and what was answered, when the chat answered it. */
    export function answerSummary(q: TabQuestion): string[] {
      if (q.kind === 'permission') {
        if (!q.answer) return [];
        return [q.answer.allow ? 'Permitido' : q.answer.text ? `Negado: «${q.answer.text}»` : 'Negado'];
      }
      const answers = q.answer?.answers;
      return q.payload.questions.map((item, i) => {
        const a = answers?.[i];
        if (!a) return item.question;
        return `${item.question} → ${a.text ?? a.selected.map((s) => item.options[s]?.label ?? '?').join(', ')}`;
      });
    }
    ```
  - `events.ts`: add `TabQuestion` to the import; `EventSlice` gains `/** The tabs' questions pushed into this conversation (spec 2026-09-25 §6.3). */ tabQuestions: TabQuestion[];`; add
    ```ts
    /** Every tab-question event carries the whole card: replace it by id, or append it. */
    export function upsertTabQuestion(list: TabQuestion[], q: TabQuestion): TabQuestion[] {
      return list.some((x) => x.id === q.id) ? list.map((x) => (x.id === q.id ? q : x)) : [...list, q];
    }
    ```
    and in `applyEvent`, before `case 'delta':`:
    ```ts
    case 'tab_question':
    case 'tab_question_answered':
    case 'tab_question_closed':
      return { slice: { ...slice, tabQuestions: upsertTabQuestion(slice.tabQuestions, e.question) }, reread: false };
    ```
  - `timeline.ts` (the same change the web's `lib/chat-timeline.ts` gets — keep the copy in step): import `TabQuestion` from `./types`; the entry type becomes
    ```ts
    export type ChatEntry =
      | { kind: 'message'; at: string; message: ChatMessage }
      | { kind: 'action'; at: string; action: ChatAction }
      | { kind: 'tab_question'; at: string; question: TabQuestion };
    ```
    the signature `export function chatTimeline(messages: ChatMessage[], actions: ChatAction[], tabQuestions: TabQuestion[] = []): ChatEntry[]`; after `visibleActions`:
    ```ts
    // A tab's question card follows the same window rule as a gate card: it belongs next to the thread around it.
    const visibleQuestions = oldestMessageAt === null ? tabQuestions : tabQuestions.filter((q) => q.created_at >= oldestMessageAt);
    ```
    `...visibleQuestions.map((question): ChatEntry => ({ kind: 'tab_question', at: question.created_at, question })),` after the actions in `entries`, and the three-kind tiebreak:
    ```ts
    return entries.sort((a, b) => {
      if (a.at !== b.at) return a.at < b.at ? -1 : 1;
      // A card (a gate card or a tab's question) reads after the message of the same instant; two cards keep their order.
      if (a.kind === 'message' && b.kind !== 'message') return -1;
      if (b.kind === 'message' && a.kind !== 'message') return 1;
      return 0;
    });
    ```
  Run the model tests → PASS.

- [ ] **Step 6: Store — failing tests.** Append to `features/chat/viewmodel/createChatStore.test.ts`:
  ```ts
  it('answerTabQuestion answers over the mock and the card turns answered; a second answer reads "A pergunta mudou na aba"', async () => {
    const { chat } = await setup();
    await openAndConnect(chat, 'p-termhub');
    await chat.getState().send('tem alguma pergunta?');
    await jest.advanceTimersByTimeAsync(5000);
    const q = slot(chat, 'p-termhub').tabQuestions.find((x) => x.status === 'open')!;
    expect(q).toMatchObject({ kind: 'choice', tab_name: 'api' });

    await chat.getState().answerTabQuestion(q.id, { answers: [{ selected: [0] }] });
    await jest.advanceTimersByTimeAsync(0);
    await flush();
    expect(slot(chat, 'p-termhub').tabQuestions.find((x) => x.id === q.id)?.status).toBe('answered');
    expect(chat.getState().answeringQuestionId).toBeNull();

    await chat.getState().answerTabQuestion(q.id, { answers: [{ selected: [0] }] });
    expect(chat.getState().error).toBe('A pergunta mudou na aba');
  });

  it('loadTabQuestionScreen answers the excerpt while open, null once it is not', async () => {
    const { chat } = await setup();
    await openAndConnect(chat, 'p-termhub');
    await chat.getState().send('preciso da sua permissão');
    await jest.advanceTimersByTimeAsync(5000);
    const q = slot(chat, 'p-termhub').tabQuestions.find((x) => x.kind === 'permission')!;
    expect(await chat.getState().loadTabQuestionScreen(q.id)).toContain('Do you want to proceed?');
    await chat.getState().answerTabQuestion(q.id, { allow: true });
    expect(await chat.getState().loadTabQuestionScreen(q.id)).toBeNull();
  });

  it('keeps the tab questions of a slot across a restart (persisted with the thread)', async () => {
    const { chat } = await setup();
    await openAndConnect(chat, 'p-termhub');
    await chat.getState().send('tem alguma pergunta?');
    await jest.advanceTimersByTimeAsync(5000);
    const saved = JSON.parse(mmkv.getString('chat')!).state as { conversations: Record<string, { tabQuestions?: unknown[] }> };
    expect(saved.conversations['p-termhub']!.tabQuestions!.length).toBeGreaterThan(0);
  });
  ```
  (`mmkv.getString('chat')` is how the existing "persists projects and each conversation…" test in this file reads the saved state.) Run `NODE 'npm run build -w @termhub/mobile-api && npm test -w @termhub/mobile -- src/features/chat/viewmodel'` → FAIL.

- [ ] **Step 7: Store — implement** in `createChatStore.ts`:
  - imports: `TTabQuestionAnswerBody` from the contract; `TabQuestion` from `../model/types`.
  - `ConversationSlot` gains `/** The tabs' questions pushed into this conversation (spec 2026-09-25 §6.3). */ tabQuestions: TabQuestion[];`
  - `ChatState` gains:
    ```ts
    /** The tab question whose answer is in flight. */
    answeringQuestionId: string | null;
    /** Answers a tab's question from its card — no PIN. A question the tab moved past (409) says so and re-reads. */
    answerTabQuestion(questionId: string, body: TTabQuestionAnswerBody): Promise<void>;
    /** The tab's live excerpt for a permission card; null when it cannot be read (closed, offline). */
    loadTabQuestionScreen(questionId: string): Promise<string | null>;
    ```
  - `PersistedSlot` picks `'tabQuestions'` too; `initialData()` gets `answeringQuestionId: null`; `emptySlot()` gets `tabQuestions: []`; `partialize` copies `tabQuestions: c.tabQuestions`.
  - `reread`'s patch adds `tabQuestions: res.tab_questions`.
  - `onEvent`: `before` adds `tabQuestions: current.tabQuestions`; `patchSlot` adds `tabQuestions: slice.tabQuestions`.
  - `close()` resets `answeringQuestionId: null` too; `reset()`'s `patchSlot` clears `tabQuestions: []`.
  - the two actions, after `revokeGrant`:
    ```ts
    async answerTabQuestion(questionId, body) {
      const projectId = get().activeProject;
      if (projectId === undefined || get().answeringQuestionId !== null) return;
      const key = keyOf(projectId);
      const gen = generation;
      set({ answeringQuestionId: questionId, error: null });
      try {
        await api.answerTabQuestion(session().auth(), questionId, body);
        // The `tab_question_answered` event brings the card; the re-read covers a socket that is down.
        if (gen === generation) void reread(key);
      } catch (e) {
        if (gen !== generation) return;
        if (isApiError(e, 'TAB_PROMPT_CHANGED')) {
          set({ error: CHAT_MSG.tabPromptChanged });
          void reread(key); // show how it ended
        } else {
          fail(gen, e);
        }
      } finally {
        if (gen === generation) set({ answeringQuestionId: null });
      }
    },

    async loadTabQuestionScreen(questionId) {
      try {
        return (await api.tabQuestionScreen(session().auth(), questionId)).text;
      } catch {
        return null;
      }
    },
    ```
  Update the existing test "persists projects and each conversation, never live or transient state": its sorted key list becomes `['actions', 'conversation', 'grants', 'host', 'messages', 'tabQuestions']`. Run the store tests → PASS (every slot literal compared with `toEqual` elsewhere in the file must now include `tabQuestions: []`).

- [ ] **Step 8: The card and the screen — failing tests.** In `features/chat/view/conversation-screen.test.tsx`: extend `stubAction`'s key union with `'answerTabQuestion'`, add `answerTabQuestion: realActions.answerTabQuestion` to the `afterEach` restore, import `TTabQuestion`, and append inside `describe('Conversa', …)`:
  ```tsx
  const QUESTION_BASE = { tab_id: 't-api', tab_name: 'api', error_code: null, created_at: new Date().toISOString(), answered_at: null, closed_at: null };
  const OPEN_CHOICE = { ...QUESTION_BASE, id: 'q1', kind: 'choice', status: 'open', answer: null, payload: { questions: [{ question: 'Qual banco usamos nos testes?', header: 'Banco', multi_select: false, options: [{ label: 'Postgres', description: 'O mesmo da produção.', recommended: true }, { label: 'SQLite', description: '', recommended: false }] }] } } as TTabQuestion;
  const OPEN_PERMISSION = { ...QUESTION_BASE, id: 'q2', kind: 'permission', status: 'open', answer: null, payload: { tool_name: 'Bash' } } as TTabQuestion;

  /** Serves the open project's `GET chat` with these tab questions. */
  function serveQuestions(questions: TTabQuestion[]) {
    const real = stores.api.chat.bind(stores.api);
    jest.spyOn(stores.api, 'chat').mockImplementation(async (auth, projectId) => {
      const res = await real(auth, projectId);
      return projectId === 'p-termhub' ? { ...res, tab_questions: questions } : res;
    });
  }

  it('renders a tab\'s question; picking an option and Responder answers it', async () => {
    serveQuestions([OPEN_CHOICE]);
    const answer = stubAction('answerTabQuestion');
    await render(<ConversationScreen />);
    expect(await screen.findByText('Qual banco usamos nos testes?', undefined, LOAD)).toBeTruthy();
    expect(screen.getByText('A aba «api» perguntou')).toBeTruthy();
    expect(screen.getByText('Recomendada')).toBeTruthy();
    await fireEvent.press(screen.getByRole('radio', { name: 'Postgres' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Responder' }));
    expect(answer).toHaveBeenCalledWith('q1', { answers: [{ selected: [0] }] });
  });

  it('"Outra resposta" answers with the text', async () => {
    serveQuestions([OPEN_CHOICE]);
    const answer = stubAction('answerTabQuestion');
    await render(<ConversationScreen />);
    await fireEvent.changeText(await screen.findByLabelText('Outra resposta', undefined, LOAD), 'Os dois');
    await fireEvent.press(screen.getByRole('button', { name: 'Responder' }));
    expect(answer).toHaveBeenCalledWith('q1', { answers: [{ selected: [], text: 'Os dois' }] });
  });

  it('a permission card shows the live excerpt; Permitir, Negar and Negar e dizer… answer it', async () => {
    serveQuestions([OPEN_PERMISSION]);
    jest.spyOn(stores.api, 'tabQuestionScreen').mockResolvedValue({ text: 'Bash command\n  npm test\nDo you want to proceed?' });
    const answer = stubAction('answerTabQuestion');
    await render(<ConversationScreen />);
    expect(await screen.findByText('A aba «api» pede permissão para usar «Bash»', undefined, LOAD)).toBeTruthy();
    await fireEvent.press(await screen.findByRole('button', { name: 'Tela da aba' }));
    expect(screen.getByText(/Do you want to proceed\?/)).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Permitir' }));
    expect(answer).toHaveBeenLastCalledWith('q2', { allow: true });
    await fireEvent.press(screen.getByRole('button', { name: 'Negar' }));
    expect(answer).toHaveBeenLastCalledWith('q2', { allow: false });
    await fireEvent.press(screen.getByRole('button', { name: 'Negar e dizer…' }));
    await fireEvent.changeText(screen.getByLabelText('O que dizer à aba'), 'use pnpm');
    await fireEvent.press(screen.getByRole('button', { name: 'Enviar' }));
    expect(answer).toHaveBeenLastCalledWith('q2', { allow: false, text: 'use pnpm' });
  });

  it.each([
    [{ ...OPEN_CHOICE, status: 'answered', answer: { answers: [{ selected: [1] }] } } as TTabQuestion, ['Qual banco usamos nos testes? → SQLite', 'Respondida']],
    [{ ...OPEN_PERMISSION, status: 'answered_in_tab' } as TTabQuestion, ['Respondida na aba']],
    [{ ...OPEN_PERMISSION, status: 'expired' } as TTabQuestion, ['Expirada']],
    [{ ...OPEN_PERMISSION, status: 'failed', error_code: 'MACHINE_OFFLINE', answer: { allow: true } } as TTabQuestion, ['Permitido', 'Falhou — a máquina está offline']],
  ])('a closed tab question is read-only and says how it ended (%#)', async (q, texts) => {
    serveQuestions([q]);
    await render(<ConversationScreen />);
    for (const t of texts) expect(await screen.findByText(t, undefined, LOAD)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Responder' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Permitir' })).toBeNull();
  });
  ```
  Run `NODE 'npm test -w @termhub/mobile -- src/features/chat/view/conversation-screen.test.tsx'` → FAIL.

- [ ] **Step 9: The card — implement** `features/chat/view/tab-question-card.tsx`:
  ```tsx
  import { memo, useEffect, useState } from 'react';
  import { Pressable, TextInput, View } from 'react-native';
  import type { TTabQuestionAnswerBody } from '@/services/api/contract';
  import { AppText, Button } from '@/ui';
  import { answerSummary, statusLabel, tabLabel } from '../model/tab-question-text';
  import type { TabQuestion } from '../model/types';

  type Props = {
    question: TabQuestion;
    /** An answer (this one or another card's) is in flight. */
    busy: boolean;
    onAnswer(questionId: string, body: TTabQuestionAnswerBody): void;
    loadScreen(questionId: string): Promise<string | null>;
  };
  type Choice = Extract<TabQuestion, { kind: 'choice' }>;
  type Permission = Extract<TabQuestion, { kind: 'permission' }>;

  const INPUT = 'rounded-xl border border-app-border bg-app-surface px-4 py-3 text-base text-app-text placeholder:text-app-muted';

  /** A question an agent in a tab asked (spec 2026-09-25 §6.3), the web card's twin: options with the
   * recommended one marked, "Outra resposta", or Permitir / Negar / Negar e dizer… — no PIN. Memoised:
   * `onAnswer` and `loadScreen` are the store's own (stable) actions. */
  export const TabQuestionCard = memo(function TabQuestionCard(props: Props) {
    const { question } = props;
    return (
      <View className="gap-3 rounded-2xl border border-app-accent bg-app-surface2 p-4">
        {question.kind === 'choice' ? <ChoiceBody {...props} question={question} /> : <PermissionBody {...props} question={question} />}
        {question.status !== 'open' ? <AppText variant="muted">{statusLabel(question)}</AppText> : null}
      </View>
    );
  });

  function ChoiceBody({ question, busy, onAnswer }: Props & { question: Choice }) {
    const items = question.payload.questions;
    const [current, setCurrent] = useState(0);
    const [selected, setSelected] = useState<number[][]>(() => items.map(() => []));
    const [texts, setTexts] = useState<string[]>(() => items.map(() => ''));
    const title = <AppText variant="label">{`${tabLabel(question)} perguntou`}</AppText>;
    if (question.status !== 'open') {
      return (
        <View className="gap-1">
          {title}
          {answerSummary(question).map((line, i) => (
            <AppText key={i}>{line}</AppText>
          ))}
        </View>
      );
    }
    const item = items[current]!;
    const typing = texts[current]!.trim() !== '';
    const answers = items.map((_, i) => (texts[i]!.trim() ? { selected: [], text: texts[i]!.trim() } : { selected: [...selected[i]!].sort((a, b) => a - b) }));
    const complete = answers.every((a) => 'text' in a || a.selected.length > 0);
    const toggle = (option: number) =>
      setSelected((prev) => prev.map((s, j) => (j !== current ? s : item.multi_select ? (s.includes(option) ? s.filter((x) => x !== option) : [...s, option]) : [option])));
    return (
      <View className="gap-2">
        {title}
        {items.length > 1 ? (
          <View className="flex-row flex-wrap gap-2">
            {items.map((it, i) => (
              <Button key={i} label={it.header || `Pergunta ${i + 1}`} variant={i === current ? 'primary' : 'secondary'} onPress={() => setCurrent(i)} />
            ))}
          </View>
        ) : null}
        <AppText>{item.question}</AppText>
        {item.options.map((o, oi) => {
          const checked = selected[current]!.includes(oi);
          return (
            <Pressable
              key={oi}
              accessibilityRole={item.multi_select ? 'checkbox' : 'radio'}
              accessibilityLabel={o.label}
              accessibilityState={{ checked, disabled: busy || typing }}
              disabled={busy || typing}
              onPress={() => toggle(oi)}
              className={`gap-1 rounded-xl border p-3 ${checked ? 'border-app-accent' : 'border-app-border'}`}
            >
              <AppText>{`${checked ? '●' : '○'} ${o.label}`}</AppText>
              {o.recommended ? <AppText variant="muted">Recomendada</AppText> : null}
              {o.description ? <AppText variant="muted">{o.description}</AppText> : null}
            </Pressable>
          );
        })}
        <TextInput
          accessibilityLabel="Outra resposta"
          placeholder="Outra resposta"
          value={texts[current]}
          maxLength={2000}
          editable={!busy}
          onChangeText={(t) => setTexts((prev) => prev.map((x, j) => (j === current ? t : x)))}
          className={INPUT}
        />
        <Button label="Responder" onPress={() => onAnswer(question.id, { answers })} disabled={busy || !complete} />
      </View>
    );
  }

  function PermissionBody({ question, busy, onAnswer, loadScreen }: Props & { question: Permission }) {
    const open = question.status === 'open';
    const [excerpt, setExcerpt] = useState<string | null>(null);
    const [showing, setShowing] = useState(false);
    const [denying, setDenying] = useState(false);
    const [text, setText] = useState('');
    useEffect(() => {
      if (!open) return;
      let alive = true;
      void loadScreen(question.id).then((t) => {
        if (alive) setExcerpt(t);
      });
      return () => {
        alive = false;
      };
    }, [open, question.id, loadScreen]);
    return (
      <View className="gap-2">
        <AppText>{`${tabLabel(question)} pede permissão para usar «${question.payload.tool_name}»`}</AppText>
        {open && excerpt !== null ? <Button label="Tela da aba" variant="ghost" onPress={() => setShowing((v) => !v)} /> : null}
        {open && showing && excerpt !== null ? <AppText className="font-mono text-xs">{excerpt}</AppText> : null}
        {open ? (
          <View className="gap-2">
            <View className="flex-row gap-2">
              <View className="flex-1">
                <Button label="Permitir" onPress={() => onAnswer(question.id, { allow: true })} disabled={busy} />
              </View>
              <View className="flex-1">
                <Button label="Negar" variant="danger" onPress={() => onAnswer(question.id, { allow: false })} disabled={busy} />
              </View>
            </View>
            <Button label="Negar e dizer…" variant="secondary" onPress={() => setDenying(true)} disabled={busy} />
            {denying ? (
              <View className="gap-2">
                <TextInput accessibilityLabel="O que dizer à aba" value={text} maxLength={2000} editable={!busy} onChangeText={setText} className={INPUT} />
                <Button label="Enviar" variant="danger" onPress={() => onAnswer(question.id, { allow: false, text: text.trim() })} disabled={busy || !text.trim()} />
              </View>
            ) : null}
          </View>
        ) : (
          answerSummary(question).map((line, i) => <AppText key={i}>{line}</AppText>)
        )}
      </View>
    );
  }
  ```
  In `conversation-screen.tsx`:
  - import `TabQuestionCard` and `TTabQuestionAnswerBody`;
  - `entryKey`: `entry.kind === 'message' ? `m:${entry.message.id}` : entry.kind === 'action' ? `a:${entry.action.id}` : `q:${entry.question.id}``;
  - read `answeringQuestionId`, `answerTabQuestion`, `loadTabQuestionScreen` from the store; `const tabQuestions = slot?.tabQuestions;`; `const onAnswer = useCallback((id: string, body: TTabQuestionAnswerBody) => void answerTabQuestion(id, body), [answerTabQuestion]);`
  - `entries = useMemo(() => chatTimeline(messages ?? [], actions ?? [], tabQuestions ?? []).reverse(), [messages, actions, tabQuestions]);`
  - `extra` gains `answeringQuestionId` (and its deps);
  - `renderItem`: a first branch `item.kind === 'tab_question' ? <TabQuestionCard question={item.question} busy={answeringQuestionId !== null} onAnswer={onAnswer} loadScreen={loadTabQuestionScreen} /> : item.kind === 'message' ? … : …`.
  Run the screen test → PASS.

- [ ] **Step 10: Whole app suite + typecheck.** `NODE 'npm run build -w @termhub/mobile-api && npm test -w @termhub/mobile && npm run typecheck -w @termhub/mobile'` → PASS, no type errors.

- [ ] **Step 11: Commit**
  ```bash
  git add apps/mobile/src/services/api apps/mobile/src/features/chat
  git commit -F - <<'MSG'
  Mobile chat: show a tab's question and answer it from the card

  Same card as the web, no PIN; the mock asks one on "pergunta" or
  "permissão" (TER-56).

  Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
  MSG
  ```

---

### Task 10: E2E manual no jarvis + verificação final

**Files:**
- Possibly modify (only if Part A disproves spec §3's two unverified behaviours): `apps/server/src/chat/tab-question-keys.ts`, `apps/server/src/chat/tab-question-keys.test.ts`, `docs/superpowers/specs/2026-09-25-chat-tab-questions-design.md` (§3 "Not yet observed…" and §5.4).
- Possibly modify (only if Part B shows a false 409 on a real screen): `apps/server/src/chat/tab-question-answer.ts` (`promptVisible`), `apps/server/src/chat/tab-question-answer.test.ts` (add the real screen as a fixture).
- Scratch only (never committed): everything under `$E2E`.

**Interfaces:**
- Consumes: the whole feature (Tasks 1–9), the built `@termhub/machine-ops` (`HOOK_SCRIPT`).
- Produces: confirmation (or a corrected key plan) for "a digit on a single-question single-select submits at once" and "Tab after a single-question multi-select reaches the submit step"; a full-route run against real Claude Code.

**Safety, before anything:** every tmux command below is either `env -u TMUX tmux -L th-e2e …` (a server named `th-e2e`) or `env -u TMUX tmux -S "$E2E/tmux/tmux-$(id -u)/default" …` (a socket inside `$E2E`). Never run a bare `tmux` here, never `kill-server` without `-L th-e2e` / `-S $E2E/…`, never write `~/.termhub/*` or `~/.claude/settings.json` (jarvis is itself a hooked machine). The only containers this task creates and removes are `th-tabq-e2e-db` (and, at the end, `th-tabq-db` from "How to run things"); remove nothing else. The Claude sessions below also load your user settings, whose real termhub hook posts to production with an unknown session name: production answers `202 unknown_session` and stores nothing — harmless.

#### Part A — the real key behaviours (no server)

- [ ] **Step 1: Scratch, the new hook script and a capture server.**
  ```bash
  cd ~/termhub-wt-tab-questions
  export E2E=/tmp/claude-1000/th-e2e-tabq && rm -rf "$E2E" && mkdir -p "$E2E/homeA/.termhub/bin" "$E2E/work"
  NODE 'npm run build -w @termhub/machine-ops'
  node -e "import('$PWD/packages/machine-ops/dist/index.js').then((m) => require('node:fs').writeFileSync('$E2E/homeA/.termhub/bin/termhub-hook', m.HOOK_SCRIPT, { mode: 0o755 }))"
  cat > "$E2E/capture.mjs" <<'JS'
  import { createServer } from 'node:http';
  import { appendFileSync } from 'node:fs';
  createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => { appendFileSync(process.argv[2], body + '\n'); res.end('{}'); });
  }).listen(39998, '127.0.0.1');
  JS
  node "$E2E/capture.mjs" "$E2E/posted.ndjson" & echo $! > "$E2E/capture.pid"
  printf "TERMHUB_HOOK_URL='http://127.0.0.1:39998/api/hooks/events'\nTERMHUB_HOOK_TOKEN='thb_hk_e2e'\n" > "$E2E/homeA/.termhub/hook.env"
  HOOK="env HOME=$E2E/homeA $E2E/homeA/.termhub/bin/termhub-hook claude"
  cat > "$E2E/settingsA.json" <<JSON
  {"hooks":{
   "SessionStart":[{"hooks":[{"type":"command","command":"$HOOK","timeout":10}]}],
   "UserPromptSubmit":[{"hooks":[{"type":"command","command":"$HOOK","timeout":10}]}],
   "PreToolUse":[{"matcher":"*","hooks":[{"type":"command","command":"$HOOK","timeout":10}]}],
   "PermissionRequest":[{"matcher":"*","hooks":[{"type":"command","command":"$HOOK","timeout":10}]}],
   "Notification":[{"hooks":[{"type":"command","command":"$HOOK","timeout":10}]}],
   "Stop":[{"hooks":[{"type":"command","command":"$HOOK","timeout":10}]}],
   "SessionEnd":[{"hooks":[{"type":"command","command":"$HOOK","timeout":10}]}]}}
  JSON
  T() { env -u TMUX tmux -L th-e2e "$@"; }
  T new-session -d -s th-e2e-q -x 160 -y 50 -c "$E2E/work" "claude --settings $E2E/settingsA.json"
  sleep 5; T capture-pane -p -t th-e2e-q | tail -20   # a trust prompt for the folder? answer it:
  T send-keys -t th-e2e-q Enter
  ```
  Helpers (keep them in this shell):
  ```bash
  say() { T send-keys -t th-e2e-q -l -- "$1"; sleep 0.3; T send-keys -t th-e2e-q Enter; }
  shot() { T capture-pane -p -t th-e2e-q | grep -v '^[[:space:]]*$' | tail -${1:-25}; }
  waitfor() { for i in $(seq 1 90); do shot 60 | grep -q -- "$1" && return 0; sleep 1; done; echo "timeout waiting for: $1"; return 1; }
  cat > "$E2E/plan.ts" <<'TS'
  import { readFileSync } from 'node:fs';
  import { interpretHookEvent } from '/home/pedrogoiania/termhub-wt-tab-questions/apps/server/src/monitor/state.ts';
  import { choiceKeyPlan, permissionKeyPlan } from '/home/pedrogoiania/termhub-wt-tab-questions/apps/server/src/chat/tab-question-keys.ts';
  import { checkChoiceAnswer, choiceAnswerBody, permissionAnswerBody } from '/home/pedrogoiania/termhub-wt-tab-questions/apps/server/src/chat/tab-question-payload.ts';
  // argv: <posted.ndjson> <answer json> — plans the answer to the LAST question the hook posted
  const posted = readFileSync(process.argv[2]!, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { event: unknown });
  const q = posted.map((p) => interpretHookEvent('claude', p.event)?.question).filter((x) => x !== undefined).at(-1);
  if (!q) throw new Error('no question posted');
  const raw = JSON.parse(process.argv[3]!);
  if (q.kind === 'choice') {
    const a = choiceAnswerBody.parse(raw);
    const problem = checkChoiceAnswer(q.payload, a);
    if (problem) throw new Error(problem);
    console.log(JSON.stringify(choiceKeyPlan(q.payload, a)));
  } else console.log(JSON.stringify(permissionKeyPlan(permissionAnswerBody.parse(raw))));
  TS
  plan() { npx tsx "$E2E/plan.ts" "$E2E/posted.ndjson" "$1"; }
  send_plan() { node -e '
    const { execFileSync } = require("node:child_process");
    const env = { ...process.env }; delete env.TMUX;
    JSON.parse(process.argv[1]).forEach((s, i) => {
      if (i) execFileSync("sleep", ["0.15"]);
      const args = s.key ? [s.key] : ["-l", "--", s.text];
      execFileSync("tmux", ["-L", "th-e2e", "send-keys", "-t", "th-e2e-q", ...args], { env });
    });' "$1"; }
  ```

- [ ] **Step 2: What the hook posts.** `say 'Use the AskUserQuestion tool to ask me ONE question: my favorite season, 3 options, single select, one marked Recommended. Then reply with only my answer.'`, `waitfor 'Type something'`. Then `tail -5 "$E2E/posted.ndjson"`. Expected: a `PreToolUse` body whose `event` has `tool_name: "AskUserQuestion"`, the whole `tool_input` and `tool_use_id`; **no** `PermissionRequest` body for `AskUserQuestion`; a `Notification` `permission_prompt` body.

- [ ] **Step 3: Unverified behaviour #1 — a single single-select question.** `P=$(plan '{"answers":[{"selected":[1]}]}'); echo "$P"` → `[{"key":"2"}]`. `send_plan "$P"; sleep 3; shot`. Expected: the card is gone and Claude's reply names the second option, **with no "Review your answers" step**. If a review step is still on screen (`Submit answers`), the rule is wrong: change `choiceKeyPlan` to push `{ key: '1' }` after the last question for **every** payload (not only 2+), update the key-plan tests (single-question cases end with `{ key: '1' }`) and spec §3/§5.4, then re-run this step with a fresh question.

- [ ] **Step 4: Unverified behaviour #2 — a single multi-select question.** `say 'Use the AskUserQuestion tool to ask me ONE multiSelect question: which fruits I like, 3 options. Then reply with only my answer.'`, `waitfor 'Type something'`. `P=$(plan '{"answers":[{"selected":[0,2]}]}'); echo "$P"` → `[{"key":"1"},{"key":"3"},{"key":"Tab"}]`. `send_plan "$P"; sleep 2; shot`. Record what is on screen:
  - Claude already answered (both fruits) → the plan is right as is.
  - "Review your answers / ❯ 1. Submit answers" is on screen → change `choiceKeyPlan` so a final multi-select question is followed by `{ key: '1' }` even when it is the only question (keep the 2+ rule), update its tests and spec §3/§5.4, then `send_plan '[{"key":"1"}]'` and confirm Claude answered.
  - Anything else (Tab moved focus elsewhere) → stop and report the screen (`shot 40`) to the controller: the plan needs a different key and the spec a correction.

- [ ] **Step 5: Two questions and free text.** `say 'Use the AskUserQuestion tool to ask me two questions at once: (1) favorite color, 3 options, one Recommended, single select; (2) which fruits I like, multiSelect, 3 options. Then reply with only my answers.'`, `waitfor 'Submit'`. `P=$(plan '{"answers":[{"selected":[],"text":"Roxo"},{"selected":[0,2]}]}'); echo "$P"` → `[{"key":"4"},{"text":"Roxo"},{"key":"Enter"},{"key":"1"},{"key":"3"},{"key":"Tab"},{"key":"1"}]`. `send_plan "$P"; sleep 3; shot`. Expected: Claude's reply says "Roxo" and the two fruits. (If free text in the first question does not move on to the second after Enter, report the screen and adjust the free-text rule the same way.)

- [ ] **Step 6: A Bash permission, allowed and denied.**
  - `say 'Run this bash command: touch e2e-allow.txt'`, `waitfor 'Do you want to proceed'`; `tail -3 "$E2E/posted.ndjson"` shows `{"hook_event_name":"PermissionRequest","tool_name":"Bash"}` (nothing of the command). `send_plan "$(plan '{"allow":true}')"`; `sleep 3; ls "$E2E/work"` → `e2e-allow.txt` exists.
  - `say 'Run this bash command: touch e2e-deny.txt'`, `waitfor 'Do you want to proceed'`; `send_plan "$(plan '{"allow":false,"text":"não crie esse arquivo, só diga ok"}')"`; `sleep 5; ls "$E2E/work"; shot` → no `e2e-deny.txt`, and Claude's reply answers the sentence.
  - Save `shot 40` of the permission prompt: Part B checks `promptVisible` against the real screen.

- [ ] **Step 7: Close Part A.** `T kill-server; kill "$(cat "$E2E/capture.pid")"`. If Steps 3–5 changed the key plan: `NODE 'npm test -w @termhub/server -- src/chat/tab-question-keys.test.ts src/chat/tab-question-answer.test.ts'` → PASS, then commit:
  ```bash
  git add apps/server/src/chat/tab-question-keys.ts apps/server/src/chat/tab-question-keys.test.ts docs/superpowers/specs/2026-09-25-chat-tab-questions-design.md
  git commit -F - <<'MSG'
  Tab questions: key plan as Claude Code 2.1.282 really submits

  Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
  MSG
  ```

#### Part B — the whole route against a dev server

- [ ] **Step 8: A throwaway database and a seeded tab.**
  ```bash
  docker run -d --name th-tabq-e2e-db -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=termhub -p 127.0.0.1:55432:5432 postgres:16-alpine
  export DB=postgresql://postgres:postgres@127.0.0.1:55432/termhub
  sleep 3; (cd apps/server && DATABASE_URL=$DB npx prisma migrate deploy)
  DATABASE_URL=$DB npx tsx apps/server/src/cli/create-user.ts --email e2e@test.local --name E2E --password e2e-pass-123
  cat > "$E2E/seed.ts" <<'TS'
  import { closePrisma, getPrisma } from '/home/pedrogoiania/termhub-wt-tab-questions/apps/server/src/db/prisma.ts';
  import { createRepositories } from '/home/pedrogoiania/termhub-wt-tab-questions/apps/server/src/db/repositories/index.ts';
  import { newHookToken } from '/home/pedrogoiania/termhub-wt-tab-questions/apps/server/src/monitor/token.ts';
  const repos = createRepositories(getPrisma());
  const user = (await repos.users.findByEmail('e2e@test.local'))!;
  const machine = await repos.machines.create({ name: 'th-e2e', type: 'local', owner_id: user.id });
  const project = await repos.projects.create({ owner_id: user.id, key: 'EZE', name: 'e2e' });
  await repos.projectMachines.link({ project_id: project.id, machine_id: machine.id, cwd: process.env.E2E_WORK! });
  const tab = await repos.tabs.create(project.id, machine.id, 'e2e');
  const { token, hash } = newHookToken();
  await repos.machineHooks.upsert(machine.id, hash);
  console.log(JSON.stringify({ project_id: project.id, tab_id: tab.id, session: tab.tmux_session, token }));
  await closePrisma();
  TS
  SEED=$(DATABASE_URL=$DB E2E_WORK="$E2E/work" npx tsx "$E2E/seed.ts" | tail -1); echo "$SEED"
  PROJECT=$(echo "$SEED" | node -pe 'JSON.parse(require("fs").readFileSync(0)).project_id')
  SESSION=$(echo "$SEED" | node -pe 'JSON.parse(require("fs").readFileSync(0)).session')
  TOKEN=$(echo "$SEED" | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')
  ```

- [ ] **Step 9: The dev server, on an isolated tmux socket dir.** The server's local-machine tmux calls use a bare `tmux`, so its whole process runs with `TMUX` unset and `TMUX_TMPDIR=$E2E/tmux` — its "default" server is `$E2E/tmux/tmux-<uid>/default`, never jarvis' own.
  ```bash
  mkdir -p "$E2E/tmux" && chmod 700 "$E2E/tmux"
  (cd apps/server && env -u TMUX TMUX_TMPDIR="$E2E/tmux" DATABASE_URL=$DB AUTH_MODE=disabled PORT=3999 HOST=127.0.0.1 PUBLIC_URL=http://127.0.0.1:3999 npx tsx src/index.ts > "$E2E/server.log" 2>&1 & echo $! > "$E2E/server.pid")
  sleep 5; curl -s http://127.0.0.1:3999/api/health   # {"ok":true}
  TB() { env -u TMUX tmux -S "$E2E/tmux/tmux-$(id -u)/default" "$@"; }
  mkdir -p "$E2E/homeB/.termhub/bin" && cp "$E2E/homeA/.termhub/bin/termhub-hook" "$E2E/homeB/.termhub/bin/"
  printf "TERMHUB_HOOK_URL='http://127.0.0.1:3999/api/hooks/events'\nTERMHUB_HOOK_TOKEN='%s'\n" "$TOKEN" > "$E2E/homeB/.termhub/hook.env"
  sed "s#$E2E/homeA#$E2E/homeB#g" "$E2E/settingsA.json" > "$E2E/settingsB.json"
  TB new-session -d -s "$SESSION" -x 160 -y 50 -c "$E2E/work" "claude --settings $E2E/settingsB.json"
  sleep 5; TB send-keys -t "$SESSION" Enter   # the folder trust prompt, if shown
  curl -s "http://127.0.0.1:3999/api/chat?project=$PROJECT" > /dev/null   # creates the project's conversation
  sayB() { TB send-keys -t "$SESSION" -l -- "$1"; sleep 0.3; TB send-keys -t "$SESSION" Enter; }
  questions() { curl -s "http://127.0.0.1:3999/api/chat?project=$PROJECT" | node -pe 'JSON.stringify(JSON.parse(require("fs").readFileSync(0)).tab_questions.map(({ id, kind, status, closed_at }) => ({ id, kind, status, closed_at })))'; }
  answer() { curl -s -w ' %{http_code}\n' -X POST "http://127.0.0.1:3999/api/chat/tab-questions/$1/answer" -H 'content-type: application/json' -d "$2"; }
  ```
  (`AUTH_MODE=disabled` makes every request the first owner — the user created above — and skips CSRF: dev only, on 127.0.0.1.)

- [ ] **Step 10: Choice through the route, a double click, the close.** `sayB 'Use the AskUserQuestion tool to ask me two questions at once: favorite color (3 options, one Recommended) and which fruits I like (multiSelect, 3 options). Then reply with only my answers.'`; wait ~15 s; `questions` → one `choice`, `status: "open"`. `Q=<its id>`; `answer $Q '{"answers":[{"selected":[1]},{"selected":[0,2]}]}'` → `200`, `"status":"answered"`; `TB capture-pane -p -t "$SESSION" | tail -15` → Claude answered with those choices. `answer $Q '{"answers":[{"selected":[0]},{"selected":[0]}]}'` → `409` `TAB_PROMPT_CHANGED`. After Claude's next hook event, `questions` shows it `answered` with `closed_at` set.

- [ ] **Step 11: Permission through the route, with the excerpt.** `sayB 'Run this bash command: touch e2e-route.txt'`; wait; `questions` → an open `permission`; `curl -s http://127.0.0.1:3999/api/chat/tab-questions/<id>/screen` → the last lines, containing "Do you want to proceed?"; `answer <id> '{"allow":true}'` → `200`; `ls "$E2E/work"` → `e2e-route.txt`.

- [ ] **Step 12: Stale — answered in the tab first.** `sayB 'Run this bash command: touch e2e-stale.txt'`; wait; note the open id; answer **in the tab**: `TB send-keys -t "$SESSION" Escape`; wait 3 s; `answer <id> '{"allow":true}'` → `409` `TAB_PROMPT_CHANGED` (closed by the next hook event, or refused by the live screen check); `questions` → `answered_in_tab`. If the 409 never comes and keys were typed, stop and report: the live check is too loose.

- [ ] **Step 13: Nothing leaked into the log.** `grep -c -e 'favorite' -e 'fruits' -e 'touch e2e' -e 'Do you want' "$E2E/server.log"` → `0`.

- [ ] **Step 14: Close Part B.** `kill "$(cat "$E2E/server.pid")"; TB kill-server`, then remove the e2e database container this task created (`th-tabq-e2e-db`) with `docker rm -f`. If Part B forced a change to `promptVisible`, add the real screen as a fixture, a test for it, run `NODE 'npm test -w @termhub/server -- src/chat/tab-question-answer.test.ts'` and commit ("Tab questions: match the prompt as Claude Code draws it").

#### Final verification

- [ ] **Step 15: Everything, as CI and CLAUDE.md run it.**
  ```bash
  NODE 'cd apps/server && npx prisma migrate deploy && npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code && cd ../.. && TERMHUB_DB_TESTS=1 npm test'
  NODE 'npm run typecheck -w @termhub/mobile && npm run typecheck -w @termhub/agent'
  docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:22 \
    sh -c 'npm run typecheck -w @termhub/server && npm run build -w @termhub/web && npm run build -w @termhub/landing'
  rm -rf .npm
  git status   # clean: only the commits of Tasks 1–10
  ```
  Then remove the unit-test database container of "How to run things" (`th-tabq-db`) with `docker rm -f`. Expected: every workspace's tests pass (`npm test` runs agent-protocol, machine-ops, claude-cli, mobile-api, server, web, mobile, agent), the migration diff is empty, every typecheck and build passes.

- [ ] **Step 16: After the merge (controller).** The push to `main` deploys; confirm it as CLAUDE.md says (the active color healthy, the two local-proxy curls). `@termhub/agent` 0.5.1 is published by the "Publish @termhub/agent" workflow (filter by that workflow name, not `gh run list --limit 1`); confirm the artifact, not the number: `npm pack @termhub/agent@0.5.1` and `tar -xOf termhub-agent-0.5.1.tgz package/dist/*.js | grep -c 'AskUserQuestion'` → ≥ 1. Agent machines heal their hook script and settings on the next reconnect (`heal()` in apps/agent/src/rpc/hooks.ts); SSH machines need "Reinstalar hooks" in Máquinas.

---

## Self-review (writing-plans checklist)

**Spec coverage.** §2 decisions → Global Constraints; §3 captured behaviour → Task 1 fixtures, Task 10 Steps 3–5 for the two unverified behaviours; §4.1 hook script, privacy amendment, rollout → Task 2 (agent 0.5.1; `heal()` already reinstalls on agent machines); §4.2 interpretation → Task 3, ingest hand-off → Task 5 Step 7; §5.1 table → Task 4; §5.2 lifecycle (open, close, companion, deleted tab → expired, mirror) → Tasks 4 (`closeIn`) and 5; §5.3 route (scope, stale, live check, claim, failure, logs, `requirePinFor`) → Task 6; §5.4 key plan and normalisation → Task 1, execution → Task 6; §5.5 concierge context and prompt line → Task 7; §6.1 contract, events, push, excerpt → Tasks 5 and 6; §6.2 web → Task 8; §6.3 mobile → Task 9; §7 testing → every task's tests plus Task 10's manual e2e.

**Deviations from the spec, on purpose (the implementer keeps them unless the controller says otherwise):**
- The spec's `GET /api/chat/conversations/:id` and `/m/chat/…` do not exist: the conversation is read with `GET /api/chat?project=` and the phone's API lives under `/api/m/v1/chat`. `tab_questions` is added there, and the new routes are `/api/chat/tab-questions/:id/{answer,screen}` and `/api/m/v1/chat/tab-questions/:id/{answer,screen}`.
- "The existing short pause between keys" does not exist in the server: `KEY_STEP_PAUSE_MS = 150` is new (Task 6).
- Timestamps are `TIMESTAMP(3)` like every other table (the spec says timestamptz); a second index `(conversation_id, created_at)` serves `GET /chat`.
- "Tabs without a project" cannot happen (`tabs.project_id` is required); only "a project without a conversation" is handled.
- Any `Notification` (not only the `permission_prompt` right after a question) leaves an open question alone: Claude Code's reminders say "still waiting", never "moved on".
- Every choice answer entry is exactly one of "picked" or "typed" (the spec states it for single-select only); answer text is one line without control characters, and a deny text may not start with `!` (after Escape it lands at Claude's prompt, where `!` runs bash).
- The push history row keeps kind `confirmation` (with `data.kind = 'tab_question'`) so an older app still parses its notifications list.
- The permission live check accepts "Do you want" or the tool name (Claude Code also asks "Do you want to make this edit…?").

**Placeholders:** none — every code step carries its code; Task 10's conditional edits name the exact rule to change and the tests to update.

**Type consistency:** `TabQuestionInput` (Task 1) → `Interpreted.question` (Task 3) → `openTabQuestion` (Task 5); `TabQuestion` (Task 4) → `TabQuestionView` / `describeTabQuestions` (Task 5) → bus events, `GET /chat`, `answerTabQuestion` (Task 6), `tabQuestionContext` (Task 7); `tabQuestionSchema` mirrors `TabQuestionView` and the parity test enforces it; web `TabQuestion` and mobile `TTabQuestion` share field names with it; `choiceKeyPlan` / `permissionKeyPlan` / `KeyStep` are used by Task 6 and Task 10's `plan.ts` with the same signatures.
