# Tab suggestions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The concierge stops reporting Claude Code's dimmed suggested prompt as "a message typed and not sent", and the project's chat offers that suggestion as a card the person can edit and send (or dismiss) with one click, on the web and in the mobile app.

**Architecture:** A pure parser (`terminal/ansi.ts`) reads `tmux capture-pane -e` output: `renderStyled` turns dim runs into `⟦…⟧` for the MCP `read_screen`, `promptSuggestion` finds a prompt line that holds only dim text. A styled capture (`captureStyledScreen`) exists for SSH/local machines and, through a new optional `escapes` param of `tmux.capture`, for agents 0.5.2+. After a Claude `Stop` hook, a 3 s fire-and-forget timer (cancelled by any other hook event of the tab) captures the prompt and, when it holds a suggestion, opens a `tab_questions` row of `kind = 'suggestion'`; it travels on its own bus events and its own `tab_suggestions` array so older apps keep parsing `tab_questions`. Two routes send (live check, atomic claim, `sendInput`) or dismiss it; sent suggestions join the concierge's "Enquanto isso: …" context.

**Tech Stack:** Fastify + zod + Prisma 7 (Postgres) in `@termhub/server`, vitest; zod RPC catalog in `@termhub/agent-protocol`; Node agent in `@termhub/agent`; zod contract in `@termhub/mobile-api`; React + Testing Library in `@termhub/web`; Expo/React Native + jest + zustand in `@termhub/mobile`.

**Spec:** `docs/superpowers/specs/2026-09-25-tab-suggestions-design.md` (read it first; this plan argues from it). Builds on TER-56 (`docs/superpowers/plans/2026-09-25-chat-tab-questions.md`), already on `main`.

**Board:** card TER-82 (bug, epic TER-1 · Chat), project `termhub`. The controller creates one subtask per task below (titles as the task titles) and moves each to done after its task passes review.

## Global Constraints

- **Chat parity:** everything the chat does here works on the web and in the mobile app (`@termhub/mobile`) in the same delivery, same behaviour, same pt-BR copy.
- Dim is **SGR 2**, cleared by **0** or **22**; `renderStyled` wraps each maximal run of dim non-blank text as `⟦…⟧` (blanks inside a run stay outside the brackets); every other escape is dropped.
- `promptSuggestion`: the **last line starting with `❯`** (after optional spaces); the dim text when the rest of that line is only dim text (whitespace allowed), else `null` — `null` whenever anything non-dim is typed.
- Styled capture: SSH/local run `capture-pane -p -e …`; agents get `tmux.capture` with `escapes: true`, **`@termhub/agent` 0.5.2**. The result carries `styled: boolean`; an agent that ignores the param returns plain text (`styled: false`) and **never gets suggestion cards**.
- `read_screen` returns `⟦…⟧` and `styled`; the tool description and `project-prompt.ts` say `⟦…⟧` is dimmed text (a suggestion or a hint), never typed, never a reason to press Enter; with `styled: false`, text after `❯` may be a suggestion too. Terminal content is never logged.
- **Other captures stay plain text:** TER-56's live check and permission excerpt, settle-by-screen, the hook spinner.
- Storage: `tab_questions` with `kind = 'suggestion'`, `payload = { text }` (**≤ 2000 chars, one line, control chars stripped**), new status value **`dismissed`**. **No migration** (plain text columns).
- Trigger: after ingesting a Claude `Stop` (tab → `waiting_input`) for a tab whose project has a conversation of the project owner (TER-56 rule), wait **`SUGGESTION_DELAY_MS = 3000`**, capture styled (**last 15 lines**), open a row when `promptSuggestion` finds text. Fire-and-forget: never delays the hook POST; **any hook event of the tab meanwhile → nothing opens**.
- A suggestion never takes part in the permission queue rules and never closes an open choice/permission question.
- Closing: the tab's next closing hook event closes it (`answered_in_tab`); **Dispensar** closes it as `dismissed` without touching the tab.
- API: `GET /api/chat?project=` and `GET /api/m/v1/chat`: `tab_questions` **excludes** suggestions; a new `tab_suggestions` array carries them. Bus events **`tab_suggestion`**, **`tab_suggestion_closed`** (answered, dismissed or closed), in `packages/mobile-api` with their own schema (parity test).
- `POST /api/chat/tab-suggestions/:id/send` `{ text }` and `POST …/dismiss` (web + mobile `/api/m/v1/chat/tab-suggestions/:id/{send,dismiss}`). Send requires **`terminals:write`**; the row must be open and the tab's latest; live check (styled capture, `promptSuggestion` still returns the same text, else **`409 TAB_PROMPT_CHANGED`** and the row closes as `answered_in_tab`); atomic claim; then type `text` literally and press Enter with `sendInput`: one line, no control chars, ≤ 2000, not starting with `!` (nor `/`, TER-56's own guard). **No gate card, no PIN, no push.** Logs: ids and counts only.
- Concierge context: sent suggestions join TER-56's "Enquanto isso: …" as `- a aba «X» sugeria «…»; o usuário enviou «…».`, sanitised the same way; dismissed ones are not reported.
- Routes never import Prisma; every input validated with zod; new routes live in the existing `chat` route plugins (resource `chat`, already `guarded`); tabs loaded through `ctx.scoped.tab(id)`.
- Code, comments, identifiers, commit messages: English. **UI copy: pt-BR, verbatim:** "«X» sugere:" ("Uma aba sugere:" without a tab name), field label "Texto da sugestão", **Enviar** (disabled while sending or empty), **Dispensar**, "Enviada", "Dispensada", "Respondida na aba", "Expirada", "Falhou — …", "A sugestão mudou na aba".
- Commit subject imperative, ≤ 72 chars; every commit ends with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- `@termhub/agent` is published by CI on the version bump (never `npm publish` by hand).
- This host shares production: throwaway containers are named `th-*`; never touch `termhub-*`, `proxy-*`. tmux experiments only on an isolated server (`env -u TMUX tmux -L th-e2e …`, or an isolated `TMUX_TMPDIR` with `TMUX` unset) — never the default tmux server. Never write `~/.termhub/*` or `~/.claude/settings.json` on jarvis.

## How to run things (worktree `~/termhub-wt-dim-suggestion`)

All Node commands run in Docker (`node:22`), from the worktree root. The throwaway Postgres `th-tabq-db` **already exists and is running** (created for TER-56): do not create it again, and do not remove it at the end (it is shared).

```bash
cd ~/termhub-wt-dim-suggestion
# NODE: run a shell command in node:22 sharing th-tabq-db's network (localhost:5432 = the db)
NODE() { docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp --network container:th-tabq-db \
  -e DATABASE_URL=postgresql://postgres:postgres@localhost:5432/termhub -v "$PWD:/w" -w /w node:22 sh -c "$1"; }
NODE 'npm ci && npm run prisma:generate -w @termhub/server && npm run build:packages'   # one-time
```

- Server unit tests: `NODE 'npm test -w @termhub/server -- <file-or-pattern>'`
- Server db tests: `NODE 'cd apps/server && npx prisma migrate deploy && cd ../.. && TERMHUB_DB_TESTS=1 npm test -w @termhub/server -- <file>'`
- Agent protocol: `NODE 'npm test -w @termhub/agent-protocol && npm run build -w @termhub/agent-protocol'` — **rebuild it (`dist/`) after every change to it**: the server and the agent import the built package.
- Agent: `NODE 'npm test -w @termhub/agent -- <file>'`
- Contract package: `NODE 'npm test -w @termhub/mobile-api && npm run build -w @termhub/mobile-api'` — **rebuild it after every change to it**.
- Web tests: `NODE 'npm test -w @termhub/web -- <file>'`
- Mobile tests (jest): `NODE 'npm run build -w @termhub/mobile-api && npm test -w @termhub/mobile -- <pattern>'`; typecheck: `NODE 'npm run typecheck -w @termhub/mobile'`
- Typecheck: `NODE 'npm run typecheck -w @termhub/server'` / agent: `NODE 'npm run typecheck -w @termhub/agent'` / web: `NODE 'npm run build -w @termhub/web'`
- After finishing: `rm -rf .npm` (cache the container leaves behind).

## File Structure

| File | Responsibility |
|---|---|
| `apps/server/src/terminal/ansi.ts` (new) | Pure: `renderStyled`, `promptSuggestion` over `capture-pane -e` text |
| `apps/server/src/chat/fixtures/tab-suggestions/*` (exist) | Real Claude Code 2.1.282 screens, plain and with attributes |
| `packages/agent-protocol/src/rpc.ts` | `tmux.capture`: optional `escapes` param and result flag |
| `apps/agent/src/rpc/tmux.ts`, `apps/agent/package.json`, `apps/agent/src/version.ts`, `package-lock.json` | `-e` when asked; agent 0.5.2 |
| `apps/server/src/agent/screen.ts` | `captureStyledScreen` → `{ text, styled }` |
| `apps/server/src/control/screen.ts` | `readScreen` styled (`⟦…⟧`, `styled`), `{ plain: true }` for TER-56's checks |
| `apps/server/src/mcp/tools.ts`, `apps/server/src/chat/project-prompt.ts` | What `⟦…⟧` and `styled: false` mean |
| `apps/server/src/chat/tab-question-payload.ts` | `SuggestionPayload`, `SuggestionAnswer`, `TabRowKind`, exported `answerText` |
| `apps/server/src/db/repositories/tab-questions.ts` | `kind: 'suggestion'`, status `dismissed`, queue rule skips suggestions, `dismiss` |
| `apps/server/src/db/repositories/tab-questions-view.ts` | Widened view, `splitTabRows` |
| `apps/server/src/chat/bus.ts` | `tab_suggestion`, `tab_suggestion_closed` |
| `apps/server/src/chat/tab-questions.ts` | `publishTabQuestions` routes suggestion rows to their own events |
| `apps/server/src/chat/tab-suggestions.ts` (new) | Trigger: schedule/cancel, `checkTabSuggestion`, `readSuggestion`, `cleanSuggestion` |
| `apps/server/src/monitor/ingest.ts`, `apps/server/src/app.ts` | Cancel on every event, schedule on a Claude `Stop`; stop timers on close |
| `apps/server/src/chat/tab-question-answer.ts` | Suggestion rows are not questions (404); `readScreen` plain; `asHttp`/`codeOf` exported |
| `apps/server/src/chat/tab-question-context.ts` | "sugeria … enviou …" line |
| `apps/server/src/chat/tab-suggestion-send.ts` (new) | Send (checks, live check, claim, `sendInput`, failure) and dismiss |
| `apps/server/src/routes/{chat,m-chat}.ts` | `tab_suggestions` in `GET /`; send + dismiss routes |
| `packages/mobile-api/src/{events,chat}.ts`, `apps/server/src/mobile/events-parity.test.ts` | Contract: schema, 2 events, send body |
| `apps/web/src/lib/{types,api,chat-timeline}.ts`, `apps/web/src/components/chat/{TabSuggestionCard.tsx,tab-suggestion-text.ts,ChatPanel.tsx}` | Web card |
| `apps/mobile/src/services/api/{contract/local.ts,types.ts,client.ts,mock/state.ts,mock/handlers/chat.ts}` | App client and mock |
| `apps/mobile/src/features/chat/{model/*,viewmodel/createChatStore.ts,view/tab-suggestion-card.tsx,view/conversation-screen.tsx}` | App reducer, timeline, store, card, screen |

---

### Task 1: Parser ANSI puro: renderStyled + promptSuggestion

**Files:**
- Create: `apps/server/src/terminal/ansi.ts`
- Test: `apps/server/src/terminal/ansi.test.ts`
- Read (fixtures, already committed): `apps/server/src/chat/fixtures/tab-suggestions/{screen-suggestion,screen-typed}.{ansi,txt}`

**Interfaces:**
- Consumes: nothing.
- Produces: `renderStyled(ansi: string): string`, `promptSuggestion(ansi: string): string | null`, constants `DIM_OPEN = '⟦'`, `DIM_CLOSE = '⟧'`, `PROMPT_MARK = '❯'`.

Facts from the fixtures (checked while writing this plan): the prompt line of the suggestion is `ESC[39m❯` + U+00A0 (no-break space) + `ESC[2m` + `commit it` + `ESC[0m`; of the typed one, `ESC[39m❯` + U+00A0 + `roda a migration`. Older prompts in the scrollback also start with `❯ ` (not dim). The only SGR 2 in either file is the suggestion. With escapes stripped, each `.ansi` equals its `.txt` except one trailing blank (`  Read 1 file `): tmux trims trailing blanks only in a plain capture, so the tests compare line by line after `trimEnd`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/server/src/terminal/ansi.test.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { promptSuggestion, renderStyled } from './ansi.js';

const fx = (name: string) => readFileSync(join(import.meta.dirname, '../chat/fixtures/tab-suggestions', name), 'utf8');
const suggestion = { ansi: fx('screen-suggestion.ansi'), txt: fx('screen-suggestion.txt') };
const typed = { ansi: fx('screen-typed.ansi'), txt: fx('screen-typed.txt') };
/** tmux trims trailing blanks only in a plain capture: compare line by line without them. */
const lines = (s: string) => s.split('\n').map((l) => l.trimEnd());
const NBSP = ' ';

describe('renderStyled', () => {
  it('drops every escape of a real screen and marks its one dim run — the suggestion', () => {
    const out = renderStyled(suggestion.ansi);
    expect(out).not.toContain('\x1b');
    expect(out.match(/⟦/g)).toHaveLength(1);
    expect(lines(out)).toEqual(lines(suggestion.txt.replace(`❯${NBSP}commit it`, `❯${NBSP}⟦commit it⟧`)));
  });

  it('typed text has no dim attribute: the screen reads exactly as the plain capture', () => {
    expect(lines(renderStyled(typed.ansi))).toEqual(lines(typed.txt));
  });

  it.each([
    ['SGR 2 closed by 22', 'a \x1b[2mhint\x1b[22m b', 'a ⟦hint⟧ b'],
    ['SGR 2 closed by 0', '\x1b[2mhint\x1b[0m', '⟦hint⟧'],
    ['SGR 2 closed by an empty SGR', '\x1b[2mhint\x1b[m!', '⟦hint⟧!'],
    ['dim combined with a colour', '\x1b[2;38;5;244mhint\x1b[0m', '⟦hint⟧'],
    ['a 256-colour index 2 is a colour, not dim', '\x1b[38;5;2mgreen\x1b[0m', 'green'],
    ['a true-colour 2 is a colour, not dim', '\x1b[38;2;2;2;2mrgb\x1b[39m', 'rgb'],
    ['blanks stay outside the brackets', '❯ \x1b[2m  run it  \x1b[0m|', '❯   ⟦run it⟧  |'],
    ['a dim run of blanks is left as it is', 'a\x1b[2m   \x1b[0mb', 'a   b'],
    ['a run is closed at the end of each line', '\x1b[2mone\ntwo\x1b[0m', '⟦one⟧\n⟦two⟧'],
    ['other escapes (cursor, OSC title, private modes) are dropped', '\x1b[2K\x1b]0;title\x07ok\x1b[?25h', 'ok'],
    ['plain text is unchanged, trailing newline included', '$ ls\nREADME.md\n', '$ ls\nREADME.md\n'],
  ])('%s', (_label, input, expected) => {
    expect(renderStyled(input)).toBe(expected);
  });
});

describe('promptSuggestion', () => {
  it('reads the suggestion off the real screen', () => {
    expect(promptSuggestion(suggestion.ansi)).toBe('commit it');
  });

  it('is null for text the person typed', () => {
    expect(promptSuggestion(typed.ansi)).toBeNull();
  });

  it('is null when something typed sits before the rest of the suggestion', () => {
    expect(promptSuggestion(`\x1b[39m❯${NBSP}com\x1b[2mmit it\x1b[0m`)).toBeNull();
  });

  it('is null with no prompt on screen, or an empty prompt', () => {
    expect(promptSuggestion('$ ls\nREADME.md\n')).toBeNull();
    expect(promptSuggestion(`❯${NBSP}\n`)).toBeNull();
    expect(promptSuggestion('')).toBeNull();
  });

  it('reads only the last prompt line, after optional spaces, with any SGR that sets dim', () => {
    expect(promptSuggestion('❯ \x1b[2mold\x1b[0m\n❯ roda a migration\n')).toBeNull();
    expect(promptSuggestion('❯ typed before\n  ❯ \x1b[2;38;5;244mrun the tests\x1b[22m  \n')).toBe('run the tests');
  });

  it("a dialog's selection marker is not a suggestion", () => {
    expect(promptSuggestion(' Do you want to proceed?\n ❯ 1. Yes\n   2. No\n')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `NODE 'npm test -w @termhub/server -- src/terminal/ansi.test.ts'`
Expected: FAIL — `Failed to resolve import "./ansi.js"`.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/server/src/terminal/ansi.ts
/**
 * Terminal captures with attributes (`tmux capture-pane -e`), read as text (spec 2026-09-25 tab
 * suggestions §4). Pure: no I/O, nothing logged. Only one attribute matters — dim (SGR 2), which
 * Claude Code uses for its suggested next prompt — and every other escape is dropped.
 */

/** Marks a dim run in `renderStyled`'s output. Nothing a shell prints uses these two. */
export const DIM_OPEN = '⟦';
export const DIM_CLOSE = '⟧';
/** Claude Code's input prompt (followed by a no-break space in 2.1.282). */
export const PROMPT_MARK = '❯';

interface Cell {
  ch: string;
  dim: boolean;
}

/** CSI (ESC [ params intermediates final), OSC (ESC ] … BEL or ST), or any other two-byte escape. */
const ESCAPE = /\x1b\[([0-9;:?<=>]*)[ -\/]*([@-~])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[^[\]]?/g;

/** Dim after one SGR sequence: 2 sets it, 0 and 22 clear it (22 also clears bold); colours are skipped whole. */
function applySgr(params: string, dim: boolean): boolean {
  const list = params === '' ? ['0'] : params.split(';');
  for (let i = 0; i < list.length; i++) {
    const p = list[i] as string;
    if (p.includes(':')) continue; // 38:5:244 and friends: one self-contained colour
    const n = p === '' ? 0 : Number(p);
    if (n === 0 || n === 22) dim = false;
    else if (n === 2) dim = true;
    else if (n === 38 || n === 48 || n === 58) {
      // 38;5;N (256 colours) or 38;2;R;G;B (true colour): N, R, G, B are not attributes
      if (list[i + 1] === '5') i += 2;
      else if (list[i + 1] === '2') i += 4;
    }
  }
  return dim;
}

/** The capture as lines of cells: escapes dropped, dim tracked across the whole text (tmux carries it over lines). */
function parse(ansi: string): Cell[][] {
  const lines: Cell[][] = [[]];
  let dim = false;
  const text = (s: string) => {
    for (const ch of s) {
      if (ch === '\n') lines.push([]);
      else if (ch === '\t' || (ch >= ' ' && ch !== '\x7f')) (lines[lines.length - 1] as Cell[]).push({ ch, dim });
    }
  };
  let last = 0;
  for (const m of ansi.matchAll(ESCAPE)) {
    const at = m.index ?? 0;
    text(ansi.slice(last, at));
    last = at + m[0].length;
    const params = m[1] ?? '';
    if (m[2] === 'm' && !/[?<=>]/.test(params)) dim = applySgr(params, dim);
  }
  text(ansi.slice(last));
  return lines;
}

const isBlank = (ch: string) => /\s/.test(ch);

function renderLine(cells: Cell[]): string {
  let out = '';
  let i = 0;
  while (i < cells.length) {
    const cell = cells[i] as Cell;
    if (!cell.dim) {
      out += cell.ch;
      i++;
      continue;
    }
    let j = i;
    while (j < cells.length && (cells[j] as Cell).dim) j++;
    const run = cells
      .slice(i, j)
      .map((c) => c.ch)
      .join('');
    const body = run.trim();
    if (body === '') out += run;
    else {
      const lead = run.slice(0, run.length - run.trimStart().length);
      const tail = run.slice(run.trimEnd().length);
      out += `${lead}${DIM_OPEN}${body}${DIM_CLOSE}${tail}`;
    }
    i = j;
  }
  return out;
}

/** The capture as plain text with each dim run marked `⟦…⟧` (per line; blanks stay outside the brackets). */
export function renderStyled(ansi: string): string {
  return parse(ansi).map(renderLine).join('\n');
}

/**
 * Claude Code's suggested next prompt, when the input box shows one: the last line whose first
 * non-blank character is `❯`, when everything after it is dim (blanks allowed). Anything non-dim —
 * text the person typed, a dialog's "❯ 1. Yes" — means there is no suggestion to offer.
 */
export function promptSuggestion(ansi: string): string | null {
  const lines = parse(ansi);
  for (let k = lines.length - 1; k >= 0; k--) {
    const cells = lines[k] as Cell[];
    const start = cells.findIndex((c) => !isBlank(c.ch));
    if (start < 0 || (cells[start] as Cell).ch !== PROMPT_MARK) continue;
    const rest = cells.slice(start + 1);
    if (rest.some((c) => !c.dim && !isBlank(c.ch))) return null;
    const text = rest
      .map((c) => c.ch)
      .join('')
      .trim();
    return text === '' ? null : text;
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `NODE 'npm test -w @termhub/server -- src/terminal/ansi.test.ts'`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/terminal/ansi.ts apps/server/src/terminal/ansi.test.ts
git commit -F - <<'MSG'
Terminal: read dimmed text in styled tmux captures

Claude Code draws its suggested next prompt dimmed. A plain capture
cannot tell it from typed text; renderStyled marks dim runs as ⟦…⟧ and
promptSuggestion reads a prompt line that holds only dim text.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
MSG
```

---

### Task 2: Captura com atributos (agent-protocol, agent 0.5.2, captureStyledScreen)

**Files:**
- Modify: `packages/agent-protocol/src/rpc.ts:45` (`tmux.capture`)
- Test: `packages/agent-protocol/src/rpc.test.ts`
- Modify: `apps/agent/src/rpc/tmux.ts` (`capture`)
- Test: `apps/agent/src/rpc/tmux.test.ts`
- Modify: `apps/agent/package.json` (`"version": "0.5.2"`), `apps/agent/src/version.ts` (`AGENT_VERSION = '0.5.2'`), `package-lock.json` (the `apps/agent` entry, line ~30: `"version": "0.5.2"`)
- Modify: `apps/server/src/agent/screen.ts`
- Test: `apps/server/src/agent/screen.test.ts` (local/ssh), `apps/server/src/agent/ops.test.ts` (agent)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: RPC `tmux.capture` params `{ session, lines, escapes?: boolean }`, result `{ text: string, escapes?: boolean }`; server `captureStyledScreen(machine: Machine, session: string, lines?: number): Promise<StyledCapture>` with `export interface StyledCapture { text: string; styled: boolean }`.

Why a result flag and not the agent version: an older agent validates the params with its own (older) zod object, which strips the unknown `escapes` and captures plain text; its result has no flag, so `styled` is simply `r.escapes === true` — no version table to keep in sync.

- [ ] **Step 1: Write the failing tests**

Append inside `describe('rpc catalog', …)` of `packages/agent-protocol/src/rpc.test.ts`:

```ts
  it('tmux.capture takes an optional escapes flag and may say so in its result', () => {
    expect(RPC['tmux.capture'].params.safeParse({ session: 'a', lines: 15, escapes: true }).success).toBe(true);
    expect(RPC['tmux.capture'].params.safeParse({ session: 'a', lines: 15 }).success).toBe(true);
    expect(RPC['tmux.capture'].params.safeParse({ session: 'a', lines: 15, escapes: 'yes' }).success).toBe(false);
    expect(RPC['tmux.capture'].result.safeParse({ text: 'x' }).success).toBe(true); // an agent older than 0.5.2
    expect(RPC['tmux.capture'].result.safeParse({ text: 'x', escapes: true }).success).toBe(true);
  });
```

Add to `describe('tmux rpc handlers', …)` of `apps/agent/src/rpc/tmux.test.ts`, after the `tmux.capture uses -S …` test:

```ts
  it('tmux.capture with escapes adds -e and says the text carries them', async () => {
    run.mockResolvedValue({ code: 0, stdout: '❯ \x1b[2mcommit it\x1b[0m\n', stderr: '', timedOut: false });
    await expect(capture({ session: 'th-a', lines: 15, escapes: true })).resolves.toEqual({ text: '❯ \x1b[2mcommit it\x1b[0m\n', escapes: true });
    expect(run).toHaveBeenCalledWith('tmux', ['capture-pane', '-p', '-e', '-S', '-15', '-t', '=th-a:']);
  });
```

(The existing `tmux.capture uses -S -<lines> and =session` test keeps asserting the plain argv and `{ text }` exactly: without `escapes`, nothing changes.)

Append to `apps/server/src/agent/screen.test.ts` (change the import to `import { captureScreen, captureStyledScreen } from './screen.js';`):

```ts
describe('captureStyledScreen (local/ssh)', () => {
  beforeEach(() => {
    runOnMachineMock.mockReset();
  });

  it('local machine: capture-pane -e keeps the attributes, and says the text is styled', async () => {
    runOnMachineMock.mockResolvedValue({ code: 0, stdout: '❯ \x1b[2mcommit it\x1b[0m\n', stderr: '', timedOut: false });
    await expect(captureStyledScreen(localMachine(), 'th-a', 15)).resolves.toEqual({ text: '❯ \x1b[2mcommit it\x1b[0m\n', styled: true });
    expect(runOnMachineMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'local' }),
      { file: config.terminal.tmuxPath, args: ['capture-pane', '-p', '-e', '-S', '-15', '-t', '=th-a:'] },
      expect.any(String),
    );
  });

  it('ssh machine: the remote command carries -e', async () => {
    runOnMachineMock.mockResolvedValue({ code: 0, stdout: '', stderr: '', timedOut: false });
    await captureStyledScreen(sshMachine(), 'th-a', 15);
    expect(runOnMachineMock.mock.calls[0]?.[2] as string).toContain(`capture-pane -p -e -S -15 -t '=th-a:'`);
  });

  it('a non-zero exit is an empty screen, as with the plain capture', async () => {
    runOnMachineMock.mockResolvedValue({ code: 1, stdout: 'ignored', stderr: 'boom', timedOut: false });
    await expect(captureStyledScreen(localMachine(), 'th-a')).resolves.toEqual({ text: '', styled: true });
  });

  it('an invalid session name throws before ever calling runOnMachine', async () => {
    await expect(captureStyledScreen(localMachine(), 'bad session!', 10)).rejects.toThrow();
    expect(runOnMachineMock).not.toHaveBeenCalled();
  });
});
```

Add to `apps/server/src/agent/ops.test.ts`, right after `captureScreen calls tmux.capture with clamped lines` (change the import to `import { captureScreen, captureStyledScreen } from './screen.js';`):

```ts
  it('captureStyledScreen asks the agent for escapes and trusts its answer', async () => {
    const machine = agentMachine();
    const conn = attachFakeConn(machine.id, () => ({ text: '❯ \x1b[2mcommit it\x1b[0m', escapes: true }));
    await expect(captureStyledScreen(machine, 'sess1', 15)).resolves.toEqual({ text: '❯ \x1b[2mcommit it\x1b[0m', styled: true });
    expect(conn.rpc).toHaveBeenCalledWith('tmux.capture', { session: 'sess1', lines: 15, escapes: true }, undefined);
    expect(execFile).not.toHaveBeenCalled();
  });

  it('captureStyledScreen: an agent older than 0.5.2 answers plain text, and says nothing about escapes', async () => {
    const machine = agentMachine();
    attachFakeConn(machine.id, () => ({ text: '❯ commit it' }));
    await expect(captureStyledScreen(machine, 'sess1', 15)).resolves.toEqual({ text: '❯ commit it', styled: false });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `NODE 'npm test -w @termhub/agent-protocol'` → FAIL (`escapes: 'yes'` parses: the key is stripped, `success` is true).
Run: `NODE 'npm test -w @termhub/agent -- src/rpc/tmux.test.ts'` → FAIL (argv without `-e`).
Run: `NODE 'npm test -w @termhub/server -- src/agent/screen.test.ts src/agent/ops.test.ts'` → FAIL (`captureStyledScreen` is not exported).

- [ ] **Step 3: Implement**

`packages/agent-protocol/src/rpc.ts`, replace the `tmux.capture` line:

```ts
  /**
   * `escapes`: keep the SGR attributes (`capture-pane -e`) so the server can tell dimmed text from typed
   * text (since agent 0.5.2). An older agent strips the unknown param and answers plain text with no
   * `escapes` in the result — which is how the server knows.
   */
  'tmux.capture': def(
    z.object({ session: sessionName, lines: z.number().int().min(1).max(5000), escapes: z.boolean().optional() }),
    z.object({ text: z.string(), escapes: z.boolean().optional() }),
  ),
```

`apps/agent/src/rpc/tmux.ts`, replace the body of `capture` (keep its comment, add one line to it):

```ts
export async function capture(params: RpcParams<'tmux.capture'>): Promise<RpcResult<'tmux.capture'>> {
  // Trailing ':' matters: '-t =name' alone is a target-pane, and tmux only resolves an exact
  // ('=') target-pane string as a session name when it's colon-qualified — with no client
  // attached (as here, run from execFile) a bare '=name' fails with "can't find pane:
  // =name" instead of defaulting to that session's active window/pane. kill-session takes a
  // target-session, which resolves a bare '=name' fine, so it doesn't need this.
  // `-e` keeps colours and attributes as escapes: the server reads a dimmed suggestion off them.
  const r = await run(tmuxPath(), ['capture-pane', '-p', ...(params.escapes ? ['-e'] : []), '-S', `-${params.lines}`, '-t', `=${params.session}:`]);
  const failure = processFailure(r);
  if (failure) throw failure;
  if (r.code !== 0) throw new RpcFailure('notfound', 'session not found');
  return params.escapes ? { text: r.stdout, escapes: true } : { text: r.stdout };
}
```

Bump the agent: `apps/agent/package.json` `"version": "0.5.2"`, `apps/agent/src/version.ts` `export const AGENT_VERSION = '0.5.2';`, and in `package-lock.json` the `"apps/agent": { "name": "@termhub/agent", "version": "0.5.1"` entry → `"0.5.2"` (only that entry).

`apps/server/src/agent/screen.ts` — replace the whole file:

```ts
import { config } from '../config.js';
import type { Machine } from '../db/repositories/types.js';
import { REMOTE_PATH_PREFIX, assertSessionName, runOnMachine } from '../terminal/machine-exec.js';
import { agentRpc } from './errors.js';

const tmux = () => config.terminal.tmuxPath;
const clampLines = (lines: number) => Math.max(1, Math.min(5000, Math.trunc(lines)));

/** A capture that may carry SGR escapes: `styled` says whether it does (an agent older than 0.5.2 cannot). */
export interface StyledCapture {
  text: string;
  styled: boolean;
}

/**
 * Captures the last `lines` of a tmux pane's output as plain text. Internal helper only
 * (no HTTP route) — used wherever the server needs a snapshot of what's on screen.
 * Returns '' on any local/ssh failure instead of throwing, matching the pre-agent behaviour.
 */
export async function captureScreen(machine: Machine, session: string, lines = 500): Promise<string> {
  assertSessionName(session);
  const n = clampLines(lines);

  if (machine.type === 'agent') {
    const { text } = await agentRpc(machine, 'tmux.capture', { session, lines: n });
    return text;
  }

  // Trailing ':' matters: '-t =name' alone is a target-pane, and tmux only resolves an exact
  // ('=') target-pane string as a session name when it's colon-qualified — with no client
  // attached (as here, an unattended local/ssh exec) a bare '=name' fails with "can't find
  // pane: =name" instead of defaulting to that session's active window/pane.
  const r = await runOnMachine(
    machine,
    { file: tmux(), args: ['capture-pane', '-p', '-S', `-${n}`, '-t', `=${session}:`] },
    `${REMOTE_PATH_PREFIX}tmux capture-pane -p -S -${n} -t '=${session}:'`,
  );
  return r.code === 0 ? r.stdout : '';
}

/**
 * Like `captureScreen`, with the attributes kept as escapes (`capture-pane -e`, spec 2026-09-25 tab
 * suggestions §4): only `terminal/ansi.ts` reads the result. Never logged.
 */
export async function captureStyledScreen(machine: Machine, session: string, lines = 500): Promise<StyledCapture> {
  assertSessionName(session);
  const n = clampLines(lines);

  if (machine.type === 'agent') {
    const r = await agentRpc(machine, 'tmux.capture', { session, lines: n, escapes: true });
    return { text: r.text, styled: r.escapes === true };
  }

  const r = await runOnMachine(
    machine,
    { file: tmux(), args: ['capture-pane', '-p', '-e', '-S', `-${n}`, '-t', `=${session}:`] },
    `${REMOTE_PATH_PREFIX}tmux capture-pane -p -e -S -${n} -t '=${session}:'`,
  );
  return { text: r.code === 0 ? r.stdout : '', styled: true };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `NODE 'npm test -w @termhub/agent-protocol && npm run build -w @termhub/agent-protocol'` → PASS.
Run: `NODE 'npm test -w @termhub/agent && npm run typecheck -w @termhub/agent'` → PASS (including `version.test.ts`: package.json and `AGENT_VERSION` both 0.5.2).
Run: `NODE 'npm test -w @termhub/server -- src/agent/screen.test.ts src/agent/ops.test.ts && npm run typecheck -w @termhub/server'` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-protocol/src/rpc.ts packages/agent-protocol/src/rpc.test.ts apps/agent/src/rpc/tmux.ts apps/agent/src/rpc/tmux.test.ts apps/agent/package.json apps/agent/src/version.ts package-lock.json apps/server/src/agent/screen.ts apps/server/src/agent/screen.test.ts apps/server/src/agent/ops.test.ts
git commit -F - <<'MSG'
Agent: capture tmux screens with attributes (0.5.2)

tmux.capture takes an optional escapes flag (capture-pane -e) and says
so in its result; an older agent strips the param and answers plain
text. captureStyledScreen returns { text, styled } for every machine.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
MSG
```

---

### Task 3: Correção do concierge: read_screen estilizado + descrição + project-prompt

**Files:**
- Modify: `apps/server/src/control/screen.ts` (`readScreen`)
- Test: `apps/server/src/control/screen.test.ts`
- Modify: `apps/server/src/chat/tab-question-answer.ts` (both `readScreen` calls → `{ plain: true }`)
- Test: `apps/server/src/chat/tab-question-answer.test.ts`
- Modify: `apps/server/src/mcp/tools.ts:90` (`read_screen` description)
- Create: `apps/server/src/mcp/tools.test.ts`
- Modify: `apps/server/src/chat/project-prompt.ts`
- Test: `apps/server/src/chat/project-prompt.test.ts`

**Interfaces:**
- Consumes: `captureStyledScreen` (Task 2), `renderStyled` (Task 1).
- Produces: `readScreen(ctx: ControlContext, input: { tab_id: string; lines?: number }, opts?: { plain?: boolean }): Promise<{ tab_id: string; lines: number; text: string; styled: boolean }>`.

Spec §2 keeps TER-56's live check and permission excerpt plain, but both go through `readScreen` — hence `{ plain: true }` there (the excerpt is shown to the person; `⟦…⟧` is for the concierge).

- [ ] **Step 1: Write the failing tests**

`apps/server/src/control/screen.test.ts` — replace line 3 and line 5:

```ts
vi.mock('../agent/screen.js', () => ({ captureScreen: vi.fn(), captureStyledScreen: vi.fn() }));
```
```ts
import { captureScreen, captureStyledScreen } from '../agent/screen.js';
```

In `beforeEach`, after `vi.mocked(captureScreen).mockReset();`, add `vi.mocked(captureStyledScreen).mockReset();`. Replace the whole `describe('readScreen', …)` block with:

```ts
describe('readScreen', () => {
  it('captures the default 200 lines, styled, and clamps to 2000', async () => {
    vi.mocked(captureStyledScreen).mockResolvedValue({ text: '$ ls\nREADME.md\n', styled: true });
    const r = await readScreen(ctx(), { tab_id: 't1' });
    expect(r).toEqual({ tab_id: 't1', lines: 200, text: '$ ls\nREADME.md\n', styled: true });
    expect(captureStyledScreen).toHaveBeenCalledWith(m1, 'th-t1', 200);
    await readScreen(ctx(), { tab_id: 't1', lines: 99999 });
    expect(vi.mocked(captureStyledScreen).mock.calls[1]![2]).toBe(2000);
  });

  it('marks dimmed text ⟦…⟧: Claude Code\'s suggestion is not typed text', async () => {
    vi.mocked(captureStyledScreen).mockResolvedValue({ text: '\x1b[39m❯ \x1b[2mcommit it\x1b[0m\n', styled: true });
    const r = await readScreen(ctx(), { tab_id: 't1' });
    expect(r.text).toBe('❯ ⟦commit it⟧\n');
    expect(r.styled).toBe(true);
  });

  it('an older agent answers plain text: passed through as it is, styled false', async () => {
    vi.mocked(captureStyledScreen).mockResolvedValue({ text: '❯ commit it\n', styled: false });
    expect(await readScreen(ctx(), { tab_id: 't1' })).toMatchObject({ text: '❯ commit it\n', styled: false });
  });

  it('plain: true reads the plain capture (TER-56\'s own checks)', async () => {
    vi.mocked(captureScreen).mockResolvedValue('❯ commit it\n');
    expect(await readScreen(ctx(), { tab_id: 't1', lines: 60 }, { plain: true })).toEqual({ tab_id: 't1', lines: 60, text: '❯ commit it\n', styled: false });
    expect(captureStyledScreen).not.toHaveBeenCalled();
  });

  it('refuses simulator tabs and foreign tabs', async () => {
    await expect(readScreen(ctx(baseTab({ kind: 'simulator', tmux_session: null })), { tab_id: 't1' })).rejects.toThrow('Esta aba não é um terminal');
    await expect(readScreen(ctx(), { tab_id: 'nope' })).rejects.toThrow('Tab não encontrada');
  });

  it('reports an offline agent machine as MACHINE_OFFLINE without trying to capture', async () => {
    vi.mocked(agents.isOnline).mockReturnValue(false);
    await expect(readScreen(ctx(), { tab_id: 't1' })).rejects.toMatchObject({ code: 'MACHINE_OFFLINE', message: 'A máquina está offline: o termhub-agent dela não está conectado' });
    expect(captureStyledScreen).not.toHaveBeenCalled();
  });

  it('reports an agent that dropped mid-capture as MACHINE_OFFLINE', async () => {
    // exactly what captureStyledScreen -> agentRpc -> toHttpError throws when the connection is gone
    const dropped = toHttpError(new AgentOfflineError('agent offline: m1'));
    expect(dropped).toMatchObject({ statusCode: 503, message: 'Agente desconectado' });
    // mockRejectedValueOnce: with the beforeEach mockReset, vitest 3.2.7's persistent mockRejectedValue
    // spuriously reports an awaited rejection as unhandled (same pattern as terminal/ws.test.ts).
    vi.mocked(captureStyledScreen).mockRejectedValueOnce(dropped);
    await expect(readScreen(ctx(), { tab_id: 't1' })).rejects.toMatchObject({ code: 'MACHINE_OFFLINE' });
  });

  it('keeps other machine failures as they are', async () => {
    const timeout = toHttpError(new AgentTimeoutError('agent rpc timeout: tmux.capture'));
    vi.mocked(captureStyledScreen).mockRejectedValueOnce(timeout);
    await expect(readScreen(ctx(), { tab_id: 't1' })).rejects.toBe(timeout);
  });
});
```

`apps/server/src/chat/tab-question-answer.test.ts` — replace the `readScreen` mock (line 11) and its `vi.mock` (line 18):

```ts
const readScreen = vi.fn(async (_ctx: unknown, input: { tab_id: string; lines?: number }, _opts?: { plain?: boolean }) => ({ tab_id: input.tab_id, lines: input.lines ?? 60, text: screens.choice, styled: false }));
```
```ts
vi.mock('../control/screen.js', async (orig) => ({ ...(await orig<typeof import('../control/screen.js')>()), readScreen: (...a: unknown[]) => readScreen(a[0], a[1] as never, a[2] as never) }));
```

In its `beforeEach`, the `readScreen.mockImplementation(...)` returns `{ tab_id: input.tab_id, lines: 60, text: screens.choice, styled: false }`. Add to `describe('answerTabQuestion', …)`:

```ts
  it('reads the live screen plain: ⟦…⟧ is for the concierge, not for this check', async () => {
    const { ctx } = ctxFor(row());
    await answerTabQuestion(ctx, 'q1', { answers: [{ selected: [1] }, { selected: [2, 0] }] }, { log: log(), sleep: noSleep });
    expect(readScreen).toHaveBeenCalledWith(expect.anything(), { tab_id: 't1', lines: 60 }, { plain: true });
  });
```

and to `describe('tabQuestionScreen', …)`:

```ts
  it('the excerpt is the plain screen', async () => {
    const { ctx } = ctxFor(permission());
    await tabQuestionScreen(ctx, 'q2');
    expect(readScreen).toHaveBeenCalledWith(expect.anything(), { tab_id: 't1', lines: 60 }, { plain: true });
  });
```

Create `apps/server/src/mcp/tools.test.ts`:

```ts
import { expect, it } from 'vitest';
import { TOOLS } from './tools.js';

it('read_screen says what ⟦…⟧ means and what styled: false means', () => {
  const d = TOOLS.find((t) => t.name === 'read_screen')!.description;
  expect(d).toContain('Text between ⟦ and ⟧ is dimmed');
  expect(d).toContain('never report it as an unsent message and never press Enter because of it');
  expect(d).toContain('styled: false');
});
```

Append to `apps/server/src/chat/project-prompt.test.ts`:

```ts
it('tells the concierge that ⟦…⟧ is a dimmed suggestion, never typed text nor a reason to press Enter', () => {
  const text = projectSystemPrompt({ name: 'X', key: 'X' }, []);
  expect(text).toMatch(/text between ⟦ and ⟧ is dimmed on the terminal — usually Claude Code's suggested next prompt/);
  expect(text).toMatch(/never report it as a message typed and not sent, and never press Enter because of it/);
  expect(text).toMatch(/styled: false, text after ❯ may be such a suggestion too/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `NODE 'npm test -w @termhub/server -- src/control/screen.test.ts src/chat/tab-question-answer.test.ts src/mcp/tools.test.ts src/chat/project-prompt.test.ts'`
Expected: FAIL — `readScreen` still calls `captureScreen` and has no `styled`; no `{ plain: true }`; the old description and prompt.

- [ ] **Step 3: Implement**

`apps/server/src/control/screen.ts` — imports:

```ts
import { captureScreen, captureStyledScreen } from '../agent/screen.js';
import { renderStyled } from '../terminal/ansi.js';
```

Replace `readScreen`:

```ts
/**
 * Last lines of a terminal tab (spec 2026-09-25 tab suggestions §5): dimmed runs come back as ⟦…⟧, so
 * Claude Code's suggested prompt never reads as typed text. `styled: false` when the machine could not
 * keep the attributes (an agent older than 0.5.2). `plain` is for the server's own screen checks, which
 * compare plain text. Never logged.
 */
export async function readScreen(
  ctx: ControlContext,
  input: { tab_id: string; lines?: number },
  opts: { plain?: boolean } = {},
): Promise<{ tab_id: string; lines: number; text: string; styled: boolean }> {
  const { tab, machine } = await ctx.scoped.tab(input.tab_id);
  assertTerminal(tab);
  if (machine.type === 'agent' && !agents.isOnline(machine.id)) throw offline();
  const lines = clamp(input.lines, SCREEN_DEFAULT_LINES, SCREEN_MAX_LINES);
  try {
    if (opts.plain) return { tab_id: tab.id, lines, text: await captureScreen(machine, tab.tmux_session, lines), styled: false };
    const shot = await captureStyledScreen(machine, tab.tmux_session, lines);
    return { tab_id: tab.id, lines, text: shot.styled ? renderStyled(shot.text) : shot.text, styled: shot.styled };
  } catch (e) {
    // agentRpc turns a connection that dropped mid-call into a bare 503 (toHttpError)
    if (e instanceof HttpError && e.statusCode === 503) throw offline();
    throw e;
  }
}
```

`apps/server/src/chat/tab-question-answer.ts` — the two calls become:

```ts
    screen = (await readScreen(ctx, { tab_id: tab.id, lines: SCREEN_CHECK_LINES }, { plain: true })).text;
```
```ts
    const { text } = await readScreen(ctx, { tab_id: tab.id, lines: SCREEN_CHECK_LINES }, { plain: true });
```

`apps/server/src/mcp/tools.ts` — the `read_screen` description:

```ts
    description: `Read the last lines of a terminal tab (default 200, max ${SCREEN_MAX_LINES}). Text between ⟦ and ⟧ is dimmed on screen — usually Claude Code's suggested next prompt: nobody typed it, so never report it as an unsent message and never press Enter because of it (you may offer to send it). styled: false means the machine's agent is too old to mark dimmed text, so text after ❯ may be a suggestion too.`,
```

`apps/server/src/chat/project-prompt.ts` — in `tail`, after the "Questions a tab asks …" line, add:

```ts
    'In read_screen, text between ⟦ and ⟧ is dimmed on the terminal — usually Claude Code\'s suggested next prompt. Nobody typed it: never report it as a message typed and not sent, and never press Enter because of it. You may mention it as a suggestion ("o Claude sugere «…»; quer que eu envie?") and send it only with send_input, like any other text. When read_screen answers styled: false, text after ❯ may be such a suggestion too.\n' +
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `NODE 'npm test -w @termhub/server -- src/control src/chat src/mcp && npm run typecheck -w @termhub/server'`
Expected: PASS (including `project-prompt.test.ts`'s "stays under the protocol cap").

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/control/screen.ts apps/server/src/control/screen.test.ts apps/server/src/chat/tab-question-answer.ts apps/server/src/chat/tab-question-answer.test.ts apps/server/src/mcp/tools.ts apps/server/src/mcp/tools.test.ts apps/server/src/chat/project-prompt.ts apps/server/src/chat/project-prompt.test.ts
git commit -F - <<'MSG'
Concierge: mark dimmed suggestions in read_screen

A customer's concierge reported three tabs with "a message typed and
not sent": all three were Claude Code suggestions. read_screen now
reads a styled capture and marks dim runs ⟦…⟧; the tool description
and the project prompt say what that means. TER-56's own screen
checks keep the plain capture.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
MSG
```

---

### Task 4: Sugestões no servidor: linha, gatilho no Stop, GET separado, eventos, contexto

**Files:**
- Modify: `apps/server/src/chat/tab-question-payload.ts`
- Modify: `apps/server/src/db/repositories/tab-questions.ts`, `apps/server/src/db/repositories/tab-questions-view.ts`, `apps/server/prisma/schema.prisma` (the two `///` comments of `TabQuestion.kind`/`status` only — no migration)
- Test: `apps/server/src/db/repositories/tab-questions.db.test.ts`
- Modify: `apps/server/src/chat/bus.ts`, `apps/server/src/chat/tab-questions.ts`
- Test: `apps/server/src/chat/tab-questions.test.ts`
- Modify: `apps/server/src/chat/tab-question-answer.ts` (suggestion rows are not questions)
- Test: `apps/server/src/chat/tab-question-answer.test.ts`
- Create: `apps/server/src/chat/tab-suggestions.ts`
- Test: `apps/server/src/chat/tab-suggestions.test.ts`
- Modify: `apps/server/src/monitor/ingest.ts`, `apps/server/src/app.ts`
- Test: `apps/server/src/monitor/ingest.test.ts`
- Modify: `apps/server/src/routes/chat.ts`, `apps/server/src/routes/m-chat.ts` (`GET /`)
- Test: `apps/server/src/routes/chat.test.ts`, `apps/server/src/routes/m-chat.test.ts`
- Modify: `packages/mobile-api/src/events.ts`
- Test: `packages/mobile-api/src/events.test.ts`, `apps/server/src/mobile/events-parity.test.ts`
- Modify: `apps/server/src/chat/tab-question-context.ts`
- Test: `apps/server/src/chat/tab-question-context.test.ts`

**Interfaces:**
- Consumes: `captureStyledScreen` (Task 2), `promptSuggestion` (Task 1).
- Produces:
  - `SuggestionPayload { text: string }`, `SuggestionAnswer { text: string }`, `TabRowKind = TabQuestionKind | 'suggestion'`, `export const answerText` (tab-question-payload.ts).
  - `TabQuestionStatus` gains `'dismissed'`; `TabQuestion.kind: TabRowKind`, `.payload: TabRowPayload`, `.answer: TabRowAnswer | null`; `TabRowPayload = ChoicePayload | PermissionPayload | SuggestionPayload`; `TabRowAnswer = ChoiceAnswer | PermissionAnswer | SuggestionAnswer`; `TabQuestionsRepository.dismiss(id: string, userId: string, now?: Date): Promise<TabQuestion | undefined>`; `claim(id, userId, answer: TabRowAnswer)`.
  - `TabQuestionView` widened the same way; `splitTabRows(views: TabQuestionView[]): { tab_questions: TabQuestionView[]; tab_suggestions: TabQuestionView[] }`.
  - Bus: `{ type: 'tab_suggestion' | 'tab_suggestion_closed'; user_id; conversation_id; suggestion: TabQuestionView }`. `publishTabQuestions(repos, type, rows)` keeps its signature and sends suggestion rows as `tab_suggestion` (for `'tab_question'`) or `tab_suggestion_closed` (for the other two).
  - `chat/tab-suggestions.ts`: `SUGGESTION_DELAY_MS = 3000`, `SUGGESTION_CAPTURE_LINES = 15`, `SUGGESTION_MAX = 2000`, `cleanSuggestion(text: string | null): string | null`, `readSuggestion(machine: Machine, session: string): Promise<string | null>`, `checkTabSuggestion(repos, log, tabId: string, still?: () => boolean): Promise<void>`, `scheduleTabSuggestion(repos, log, tabId: string): void`, `cancelTabSuggestion(tabId: string): void`, `stopTabSuggestions(): void`.
  - `tab-question-answer.ts`: `type QuestionRow = TabQuestion & { kind: TabQuestionKind }`, `isQuestionRow(row: TabQuestion | undefined): row is QuestionRow`; `AnswerDeps.beforeSend?: (row: QuestionRow, answer: TabAnswer) => void`.
  - mobile-api: `tabSuggestionStatus`, `tabSuggestionSchema`, events `tab_suggestion` / `tab_suggestion_closed`.

Why suggestions are routed inside `publishTabQuestions`: every existing close path (`closeTabQuestions` on a hook event or a removed tab, `openTabQuestion`'s replaced rows, the answer's stale close) already calls it with whatever rows `closeForTab` closed, and `closeIn` closes suggestion rows too (spec §6.1 "like other questions"). Routing there keeps each suggestion off the `tab_question*` events, which older apps parse strictly.

- [ ] **Step 1: Write the failing db test**

Append inside the `describe.skipIf(…)('TabQuestionsRepository (Postgres)', …)` block of `apps/server/src/db/repositories/tab-questions.db.test.ts`:

```ts
  const openSuggestion = (tabId: string, text = 'commit it') => repo.open({ tab_id: tabId, project_id: projectId, conversation_id: conversationId, kind: 'suggestion', payload: { text }, tool_use_id: null });

  it("a suggestion is a row like the others: the tab's open one, closed by the tab's next event", async () => {
    const { question: s } = await openSuggestion('ts1');
    expect(s).toMatchObject({ kind: 'suggestion', payload: { text: 'commit it' }, status: 'open', user_id: userId, tool_use_id: null });
    expect((await repo.findOpenForTab('ts1'))?.id).toBe(s!.id);
    expect(await repo.closeForTab('ts1', 'answered_in_tab')).toEqual([expect.objectContaining({ id: s!.id, status: 'answered_in_tab' })]);
  });

  it('dismiss: only an open suggestion, only its owner, once — never a question', async () => {
    const { question: s } = await openSuggestion('ts2');
    expect(await repo.dismiss(s!.id, otherUserId)).toBeUndefined();
    const d = await repo.dismiss(s!.id, userId);
    expect(d).toMatchObject({ id: s!.id, status: 'dismissed' });
    expect(d?.closed_at).not.toBeNull();
    expect(await repo.dismiss(s!.id, userId)).toBeUndefined();
    const { question: q } = await open('ts3');
    expect(await repo.dismiss(q.id, userId)).toBeUndefined();
  });

  it('a sent suggestion is claimed with its text and is told to the concierge', async () => {
    const { question: s } = await openSuggestion('ts4');
    expect(await repo.claim(s!.id, userId, { text: 'commit it and push' })).toMatchObject({ status: 'answered', answer: { text: 'commit it and push' }, answered_by: userId });
    expect((await repo.listToInject(conversationId)).map((r) => r.id)).toContain(s!.id);
  });

  it('a suggestion never takes part in the permission queue', async () => {
    await openPermission('ts5', 'Bash');
    expect((await openPermission('ts5', 'Edit')).question).toBeNull(); // the queue starts
    expect((await openSuggestion('ts5')).question).not.toBeNull();
    // Still queued: the suggestion is not "the newest row" of the queue rule.
    expect((await openPermission('ts5', 'Write')).question).toBeNull();
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `NODE 'cd apps/server && npx prisma migrate deploy && cd ../.. && TERMHUB_DB_TESTS=1 npm test -w @termhub/server -- src/db/repositories/tab-questions.db.test.ts'`
Expected: FAIL — `repo.dismiss is not a function`, and the queue test opens a card for `Write` (the suggestion was the newest row).

- [ ] **Step 3: Types, repository, view**

`apps/server/src/chat/tab-question-payload.ts` — after `PermissionPayload`:

```ts
/** Claude Code's dimmed next prompt, read off the tab's screen (spec 2026-09-25 tab suggestions §6.1). */
export interface SuggestionPayload {
  text: string;
}
/** What the person sent for it, as edited. */
export interface SuggestionAnswer {
  text: string;
}
```

after `export type TabQuestionKind = 'choice' | 'permission';`:

```ts
/** Every kind a `tab_questions` row holds: a question the tab asked, or a suggestion it shows. */
export type TabRowKind = TabQuestionKind | 'suggestion';
```

and export `answerText` (`const answerText = …` → `export const answerText = …`).

`apps/server/src/db/repositories/tab-questions.ts`:

```ts
import type { ChoiceAnswer, ChoicePayload, PermissionAnswer, PermissionPayload, SuggestionAnswer, SuggestionPayload, TabRowKind } from '../../chat/tab-question-payload.js';

export type TabQuestionStatus = 'open' | 'answered' | 'answered_in_tab' | 'expired' | 'failed' | 'dismissed';
export type TabRowPayload = ChoicePayload | PermissionPayload | SuggestionPayload;
export type TabRowAnswer = ChoiceAnswer | PermissionAnswer | SuggestionAnswer;
```

In `TabQuestion`: `kind: TabRowKind; payload: TabRowPayload; … answer: TabRowAnswer | null;`. In `OpenTabQuestionInput`: `kind: TabRowKind; payload: TabRowPayload;`. In `mapQuestion`: `kind: q.kind as TabRowKind`, `payload: q.payload as unknown as TabRowPayload`, `answer: (q.answer ?? null) as unknown as TabRowAnswer | null`. `claim(id: string, userId: string, answer: TabRowAnswer, now = new Date())`.

In `open()`, the newest-row lookup of the permission queue skips suggestions (add one sentence to its doc comment: "A suggestion row never counts here: it is not part of Claude Code's permission queue (spec 2026-09-25 tab suggestions §6.1)."):

```ts
        const newest = await tx.tabQuestion.findFirst({ where: { tabId: input.tab_id, kind: { not: 'suggestion' } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true, kind: true, status: true, errorCode: true } });
```

New method, after `claim`:

```ts
  /** "Dispensar": `open → dismissed` for a suggestion of this user, conditionally. The tab is not touched. */
  async dismiss(id: string, userId: string, now = new Date()): Promise<TabQuestion | undefined> {
    const { count } = await this.db.tabQuestion.updateMany({
      where: { id, kind: 'suggestion', status: 'open', conversation: { userId } },
      data: { status: 'dismissed', closedAt: now },
    });
    return count === 0 ? undefined : this.findByIdForUser(id, userId);
  }
```

`apps/server/prisma/schema.prisma` — comments only: `/// choice | permission | suggestion` and `/// open | answered | answered_in_tab | expired | failed | dismissed`.

`apps/server/src/db/repositories/tab-questions-view.ts`:

```ts
import type { TabRowKind } from '../../chat/tab-question-payload.js';
import type { Repositories } from './index.js';
import type { TabQuestion, TabQuestionStatus, TabRowAnswer, TabRowPayload } from './tab-questions.js';
```

`TabQuestionView`: `kind: TabRowKind; payload: TabRowPayload; … answer: TabRowAnswer | null;`. Append:

```ts
/**
 * `GET /chat` keeps suggestions out of `tab_questions` (spec 2026-09-25 tab suggestions §6.2): an app
 * that predates them parses that array strictly. They travel in `tab_suggestions`.
 */
export function splitTabRows(views: TabQuestionView[]): { tab_questions: TabQuestionView[]; tab_suggestions: TabQuestionView[] } {
  return { tab_questions: views.filter((v) => v.kind !== 'suggestion'), tab_suggestions: views.filter((v) => v.kind === 'suggestion') };
}
```

Run the db test again → PASS.

- [ ] **Step 4: Write the failing unit tests (bus routing, guard, trigger, ingest, GET, contract, context)**

`apps/server/src/chat/tab-questions.test.ts` — import `publishTabQuestions` too (`import { closesOpenQuestion, noteHookEvent, openTabQuestion, publishTabQuestions, startTabQuestionExpiry } from './tab-questions.js';`) and append:

```ts
describe('publishTabQuestions', () => {
  it('a suggestion row goes out on its own events, never as a tab question', async () => {
    const repos = fakeRepos();
    const s = row({ id: 's1', kind: 'suggestion', payload: { text: 'commit it' }, tool_use_id: null });
    await publishTabQuestions(asRepos(repos), 'tab_question', [s]);
    await publishTabQuestions(asRepos(repos), 'tab_question_answered', [{ ...s, status: 'answered', answer: { text: 'commit it' } }]);
    await publishTabQuestions(asRepos(repos), 'tab_question_closed', [{ ...s, status: 'dismissed' }]);
    expect(events.map((e) => e.type)).toEqual(['tab_suggestion', 'tab_suggestion_closed', 'tab_suggestion_closed']);
    expect(events[0]).toMatchObject({ user_id: 'u1', conversation_id: 'c1', suggestion: { id: 's1', tab_name: 'api', kind: 'suggestion', payload: { text: 'commit it' } } });
  });
});
```

`apps/server/src/chat/tab-question-answer.test.ts` — append:

```ts
describe('suggestion rows', () => {
  it('are not questions: 404 on answer and screen, nothing read', async () => {
    const { ctx } = ctxFor(row({ id: 's1', kind: 'suggestion', payload: { text: 'commit it' }, tool_use_id: null }));
    await rejects(answerTabQuestion(ctx, 's1', { allow: true }, { log: log(), sleep: noSleep }), 404, 'NOT_FOUND');
    await rejects(tabQuestionScreen(ctx, 's1'), 404, 'NOT_FOUND');
    expect(readScreen).not.toHaveBeenCalled();
  });
});
```

Create `apps/server/src/chat/tab-suggestions.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agents } from '../agent/registry.js';
import type { Repositories } from '../db/repositories/index.js';
import type { TabQuestion } from '../db/repositories/tab-questions.js';
import { chatBus, type ChatEvent } from './bus.js';

const captureStyledScreen = vi.fn();
vi.mock('../agent/screen.js', async (orig) => ({ ...(await orig<typeof import('../agent/screen.js')>()), captureStyledScreen: (...a: unknown[]) => captureStyledScreen(...a) }));

const { SUGGESTION_DELAY_MS, cancelTabSuggestion, checkTabSuggestion, cleanSuggestion, scheduleTabSuggestion, stopTabSuggestions } = await import('./tab-suggestions.js');

const fx = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures/tab-suggestions', name), 'utf8');
const screens = { suggestion: fx('screen-suggestion.ansi'), typed: fx('screen-typed.ansi') };

const tab = { id: 't1', project_id: 'p1', machine_id: 'm1', name: 'api', kind: 'terminal', tmux_session: 'th-t1', state: 'waiting_input' };
const machine = { id: 'm1', type: 'agent', owner_id: 'u1' };
const opened = (over: Partial<TabQuestion> = {}): TabQuestion => ({
  id: 's1', tab_id: 't1', project_id: 'p1', conversation_id: 'c1', user_id: 'u1', kind: 'suggestion', payload: { text: 'commit it' }, tool_use_id: null,
  status: 'open', answer: null, error_code: null, answered_by: null, answered_at: null, closed_at: null, injected_at: null, created_at: '2026-09-25T12:00:00.000Z', ...over,
});

function fakeRepos(opts: { tab?: object | undefined; conversation?: object | null } = {}) {
  const t = 'tab' in opts ? opts.tab : tab;
  const conversation = opts.conversation === undefined ? { id: 'c1', user_id: 'u1' } : (opts.conversation ?? undefined);
  return {
    tabs: { findById: vi.fn(async () => t), findByIdsForOwner: vi.fn(async () => [tab]) },
    projects: { findById: vi.fn(async () => ({ id: 'p1', owner_id: 'u1' })) },
    chat: { findLatestActiveForProject: vi.fn(async () => conversation) },
    machines: { findById: vi.fn(async () => machine) },
    tabQuestions: { open: vi.fn(async () => ({ question: opened(), closed: [] as TabQuestion[] })) },
  };
}
const asRepos = (r: ReturnType<typeof fakeRepos>) => r as unknown as Repositories;
const log = () => ({ info: vi.fn(), warn: vi.fn() });
/** Only setTimeout is faked: setImmediate stays real, so `settle` lets every resolved mock run. */
const fakeTimers = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
const settle = async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
};

let events: ChatEvent[];
let unsubscribe: () => void;
beforeEach(() => {
  captureStyledScreen.mockReset();
  captureStyledScreen.mockResolvedValue({ text: screens.suggestion, styled: true });
  vi.spyOn(agents, 'isOnline').mockReturnValue(true);
  events = [];
  unsubscribe = chatBus.subscribe((e) => events.push(e));
});
afterEach(() => {
  unsubscribe();
  stopTabSuggestions();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('cleanSuggestion', () => {
  it('keeps one line of plain text, capped at 2000', () => {
    expect(cleanSuggestion('  commit\u0007 it ')).toBe('commit it');
    expect(cleanSuggestion('x'.repeat(2500))).toHaveLength(2000);
    expect(cleanSuggestion('\u0001 ')).toBeNull();
    expect(cleanSuggestion(null)).toBeNull();
  });
});

describe('checkTabSuggestion', () => {
  it("opens a suggestion row in the project's latest conversation and announces it on its own event", async () => {
    const repos = fakeRepos();
    const l = log();
    await checkTabSuggestion(asRepos(repos), l, 't1');
    expect(captureStyledScreen).toHaveBeenCalledWith(machine, 'th-t1', 15);
    expect(repos.chat.findLatestActiveForProject).toHaveBeenCalledWith('p1', 'u1');
    expect(repos.tabQuestions.open).toHaveBeenCalledWith({ tab_id: 't1', project_id: 'p1', conversation_id: 'c1', kind: 'suggestion', payload: { text: 'commit it' }, tool_use_id: null });
    expect(events).toEqual([expect.objectContaining({ type: 'tab_suggestion', user_id: 'u1', conversation_id: 'c1', suggestion: expect.objectContaining({ id: 's1', tab_name: 'api', kind: 'suggestion' }) })]);
    expect(l.info).toHaveBeenCalledWith({ tabId: 't1', tabQuestionId: 's1', kind: 'suggestion', chars: 9 }, 'tab suggestion opened');
    expect(JSON.stringify(l.info.mock.calls)).not.toContain('commit');
  });

  it.each([
    ['text the person typed', { text: screens.typed, styled: true }],
    ['an older agent (plain capture)', { text: 'x\n❯ commit it\n', styled: false }],
  ])('opens nothing for %s', async (_label, shot) => {
    captureStyledScreen.mockResolvedValue(shot);
    const repos = fakeRepos();
    await checkTabSuggestion(asRepos(repos), log(), 't1');
    expect(repos.tabQuestions.open).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it('reads nothing when the tab is gone or busy again, the project has no conversation, or the agent is offline', async () => {
    await checkTabSuggestion(asRepos(fakeRepos({ tab: undefined })), log(), 't1');
    await checkTabSuggestion(asRepos(fakeRepos({ tab: { ...tab, state: 'working' } })), log(), 't1');
    await checkTabSuggestion(asRepos(fakeRepos({ conversation: null })), log(), 't1');
    vi.mocked(agents.isOnline).mockReturnValue(false);
    await checkTabSuggestion(asRepos(fakeRepos()), log(), 't1');
    expect(captureStyledScreen).not.toHaveBeenCalled();
  });

  it('opens nothing when the tab moved while its screen was read', async () => {
    const repos = fakeRepos();
    await checkTabSuggestion(asRepos(repos), log(), 't1', () => false);
    expect(repos.tabQuestions.open).not.toHaveBeenCalled();
  });

  it('never throws, and logs by code only', async () => {
    captureStyledScreen.mockRejectedValueOnce(Object.assign(new Error('❯ commit it'), { code: 'MACHINE_FAILED' }));
    const l = log();
    await expect(checkTabSuggestion(asRepos(fakeRepos()), l, 't1')).resolves.toBeUndefined();
    expect(l.warn).toHaveBeenCalledWith({ tabId: 't1', code: 'MACHINE_FAILED' }, 'tab suggestion check failed');
  });
});

describe('scheduleTabSuggestion', () => {
  it(`reads the prompt ${SUGGESTION_DELAY_MS} ms after the Stop, not before`, async () => {
    fakeTimers();
    const repos = fakeRepos();
    scheduleTabSuggestion(asRepos(repos), log(), 't1');
    await vi.advanceTimersByTimeAsync(SUGGESTION_DELAY_MS - 1);
    expect(repos.tabs.findById).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(repos.tabQuestions.open).toHaveBeenCalledTimes(1);
  });

  it('any event of the tab meanwhile cancels it', async () => {
    fakeTimers();
    const repos = fakeRepos();
    scheduleTabSuggestion(asRepos(repos), log(), 't1');
    await vi.advanceTimersByTimeAsync(1000);
    cancelTabSuggestion('t1');
    await vi.advanceTimersByTimeAsync(SUGGESTION_DELAY_MS);
    await settle();
    expect(repos.tabs.findById).not.toHaveBeenCalled();
  });

  it("a second Stop restarts the wait; another tab's event does not touch it", async () => {
    fakeTimers();
    const repos = fakeRepos();
    scheduleTabSuggestion(asRepos(repos), log(), 't1');
    await vi.advanceTimersByTimeAsync(2000);
    scheduleTabSuggestion(asRepos(repos), log(), 't1');
    cancelTabSuggestion('t2');
    await vi.advanceTimersByTimeAsync(2000);
    expect(repos.tabs.findById).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    await settle();
    expect(repos.tabQuestions.open).toHaveBeenCalledTimes(1);
  });

  it('an event that arrives while the screen is being read keeps the row from opening', async () => {
    fakeTimers();
    let release!: (v: unknown) => void;
    captureStyledScreen.mockReturnValue(new Promise((r) => (release = r)));
    const repos = fakeRepos();
    scheduleTabSuggestion(asRepos(repos), log(), 't1');
    await vi.advanceTimersByTimeAsync(SUGGESTION_DELAY_MS);
    await settle();
    expect(captureStyledScreen).toHaveBeenCalled();
    cancelTabSuggestion('t1');
    release({ text: screens.suggestion, styled: true });
    await settle();
    expect(repos.tabQuestions.open).not.toHaveBeenCalled();
  });
});
```

`apps/server/src/monitor/ingest.test.ts` — below the `tab-questions.js` mock:

```ts
const schedule = vi.fn();
const cancel = vi.fn();
vi.mock('../chat/tab-suggestions.js', () => ({ scheduleTabSuggestion: (...a: unknown[]) => schedule(...a), cancelTabSuggestion: (...a: unknown[]) => cancel(...a) }));
```

and append:

```ts
describe('ingestHookEvent — suggestions', () => {
  it('a Claude Stop schedules the suggestion check; every event of the tab first cancels a pending one', async () => {
    schedule.mockClear();
    cancel.mockClear();
    const { r } = repos(tab({ state: 'working' }));
    await ingestHookEvent(r, log, { machineId: 'm1', tool: 'claude', session: 'th-t1', event: { hook_event_name: 'Stop' } });
    expect(cancel).toHaveBeenCalledWith('t1');
    expect(schedule).toHaveBeenCalledWith(r, log, 't1');
    expect(cancel.mock.invocationCallOrder[0]!).toBeLessThan(schedule.mock.invocationCallOrder[0]!);
  });

  it('any other event only cancels — even one the interpreter ignores', async () => {
    schedule.mockClear();
    cancel.mockClear();
    const { r } = repos(tab({ state: 'waiting_input' }));
    await ingestHookEvent(r, log, pre('Edit'));
    await ingestHookEvent(r, log, { machineId: 'm1', tool: 'claude', session: 'th-t1', event: { hook_event_name: 'SomethingNew' } });
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(schedule).not.toHaveBeenCalled();
  });

  it('a Codex turn end is not a Claude Stop', async () => {
    schedule.mockClear();
    const { r } = repos(tab({ state: 'working' }));
    await ingestHookEvent(r, log, { machineId: 'm1', tool: 'codex', session: 'th-t1', event: { type: 'agent-turn-complete', 'last-assistant-message': 'ok' } });
    expect(schedule).not.toHaveBeenCalled();
  });
});
```

`apps/server/src/routes/chat.test.ts` — append:

```ts
it('GET / keeps suggestions out of tab_questions and lists them in tab_suggestions', async () => {
  const common = { tab_id: 't1', project_id: 'p1', conversation_id: 'c1', user_id: 'u1', tool_use_id: null, answer: null, error_code: null, answered_by: null, answered_at: null, closed_at: null, injected_at: null, created_at: '2026-09-25T12:00:00.000Z' };
  const q = { ...common, id: 'q1', kind: 'permission', payload: { tool_name: 'Bash' }, status: 'open' };
  const s = { ...common, id: 's1', kind: 'suggestion', payload: { text: 'commit it' }, status: 'open' };
  const { app } = build({ tabs: [{ id: 't1', project_id: 'p1', name: 'api' }], tabQuestions: [q, s] });
  const res = await app.inject({ method: 'GET', url: '/chat' });
  expect(res.json().tab_questions.map((x: { id: string }) => x.id)).toEqual(['q1']);
  expect(res.json().tab_suggestions).toEqual([{ id: 's1', tab_id: 't1', tab_name: 'api', kind: 'suggestion', payload: { text: 'commit it' }, status: 'open', answer: null, error_code: null, created_at: '2026-09-25T12:00:00.000Z', answered_at: null, closed_at: null }]);
});
```

`apps/server/src/routes/m-chat.test.ts` — inside the describe that holds `returns the tab questions too`, append:

```ts
  it('returns the suggestions apart from the tab questions', async () => {
    const common = { tab_id: 't1', project_id: 'p1', conversation_id: 'c1', user_id: 'u1', tool_use_id: null, status: 'open', answer: null, error_code: null, answered_by: null, answered_at: null, closed_at: null, injected_at: null, created_at: '' };
    const { app } = build({ tabs: [{ id: 't1', project_id: 'p1', name: 'api' }], tabQuestions: [{ ...common, id: 'q1', kind: 'permission', payload: { tool_name: 'Bash' } }, { ...common, id: 's1', kind: 'suggestion', payload: { text: 'commit it' } }] });
    const res = await app.inject({ method: 'GET', url: '/chat' });
    expect(res.json().tab_questions).toEqual([expect.objectContaining({ id: 'q1' })]);
    expect(res.json().tab_suggestions).toEqual([expect.objectContaining({ id: 's1', kind: 'suggestion', payload: { text: 'commit it' } })]);
  });
```

`packages/mobile-api/src/events.test.ts` — import `tabSuggestionSchema` too (`import { chatEventSchema, tabQuestionSchema, tabSuggestionSchema } from './events.js';`) and append:

```ts
it('parses a tab suggestion and its two events; refuses a question on them', () => {
  const s = { id: 's1', tab_id: 't1', tab_name: 'api', kind: 'suggestion', payload: { text: 'commit it' }, status: 'open', answer: null, error_code: null, created_at: '2026-09-25T12:00:00.000Z', answered_at: null, closed_at: null };
  expect(tabSuggestionSchema.safeParse(s).success).toBe(true);
  expect(tabSuggestionSchema.safeParse({ ...s, status: 'dismissed', closed_at: '2026-09-25T12:01:00.000Z' }).success).toBe(true);
  expect(tabSuggestionSchema.safeParse({ ...s, kind: 'permission', payload: { tool_name: 'Bash' } }).success).toBe(false);
  expect(chatEventSchema.safeParse({ type: 'tab_suggestion', ...base, suggestion: s }).success).toBe(true);
  expect(chatEventSchema.safeParse({ type: 'tab_suggestion_closed', ...base, suggestion: { ...s, status: 'answered', answer: { text: 'commit it' } } }).success).toBe(true);
});

it('a tab question never carries the dismissed status: that value is the suggestions\' own', () => {
  const common = { id: 'q1', tab_id: 't1', tab_name: 'api', error_code: null, created_at: '2026-09-25T12:00:00.000Z', answered_at: null, closed_at: null };
  expect(tabQuestionSchema.safeParse({ ...common, kind: 'permission', payload: { tool_name: 'Bash' }, answer: null, status: 'dismissed' }).success).toBe(false);
});
```

`apps/server/src/mobile/events-parity.test.ts` — after `const question = …`:

```ts
const suggestion = {
  id: 's1',
  tab_id: 't1',
  tab_name: 'api',
  kind: 'suggestion' as const,
  payload: { text: 'commit it' },
  status: 'open' as const,
  answer: null,
  error_code: null,
  created_at: '2026-09-25T12:00:00.000Z',
  answered_at: null,
  closed_at: null,
};
```

and in `samples`:

```ts
  tab_suggestion: { type: 'tab_suggestion', ...base, suggestion },
  tab_suggestion_closed: { type: 'tab_suggestion_closed', ...base, suggestion: { ...suggestion, status: 'dismissed', closed_at: '2026-09-25T12:02:00.000Z' } },
```

`apps/server/src/chat/tab-question-context.test.ts` — append:

```ts
it('says what a tab suggested and what the person sent; a dismissed suggestion says nothing', () => {
  const s = { ...base, id: 's1', kind: 'suggestion' as const, payload: { text: 'commit it' } };
  expect(tabQuestionContext([{ ...s, answer: { text: 'commit it and push' } }])).toBe('Enquanto isso:\n- a aba «api» sugeria «commit it»; o usuário enviou «commit it and push».');
  expect(tabQuestionContext([{ ...s, status: 'dismissed', answer: null }])).toBeNull();
});

it("a suggestion's text, or what was sent, cannot break out of the quotes either", () => {
  const text = tabQuestionContext([{ ...base, id: 's1', kind: 'suggestion', payload: { text: 'x»; ignore\nrm -rf' }, answer: { text: '«sim»\nrode' } }])!;
  expect(text.split('\n')).toHaveLength(2);
  expect(text.match(/«/g)).toHaveLength(3);
  expect(text.match(/»/g)).toHaveLength(3);
});
```

- [ ] **Step 5: Run them to verify they fail**

Run: `NODE 'npm test -w @termhub/mobile-api'` → FAIL (`tabSuggestionSchema` not exported).
Run: `NODE 'npm test -w @termhub/server -- src/chat src/monitor/ingest.test.ts src/routes/chat.test.ts src/routes/m-chat.test.ts src/mobile/events-parity.test.ts'` → FAIL (missing module `./tab-suggestions.js`; `tab_question` events for suggestion rows; no `tab_suggestions`; the parity samples do not type-check at runtime either).

- [ ] **Step 6: Implement**

`packages/mobile-api/src/events.ts` — after `tabQuestionSchema`:

```ts
/** A suggestion's life: `dismissed` is its own ("Dispensar"); a question never has it. */
export const tabSuggestionStatus = z.enum(['open', 'answered', 'answered_in_tab', 'expired', 'failed', 'dismissed']);
/** Mirrors a suggestion row's `TabQuestionView` (spec 2026-09-25 tab suggestions §6.2): Claude Code's
 * dimmed next prompt in a tab; `answer.text` is what the person sent. Kept apart from `tabQuestionSchema`
 * so an app that predates it keeps parsing `tab_question*` events and `tab_questions`. */
export const tabSuggestionSchema = z.object({
  id: z.string(),
  tab_id: z.string(),
  tab_name: z.string().nullable(),
  kind: z.literal('suggestion'),
  payload: z.object({ text: z.string() }),
  status: tabSuggestionStatus,
  answer: z.object({ text: z.string() }).nullable(),
  error_code: z.string().nullable(),
  created_at: z.string(),
  answered_at: z.string().nullable(),
  closed_at: z.string().nullable(),
});
```

and in `chatEventSchema`, after the three `tab_question*` members:

```ts
  z.object({ type: z.literal('tab_suggestion'), user_id: z.string(), conversation_id: z.string(), suggestion: tabSuggestionSchema }),
  z.object({ type: z.literal('tab_suggestion_closed'), user_id: z.string(), conversation_id: z.string(), suggestion: tabSuggestionSchema }),
```

Rebuild it: `NODE 'npm test -w @termhub/mobile-api && npm run build -w @termhub/mobile-api'`.

`apps/server/src/chat/bus.ts` — append to `ChatEvent`:

```ts
  /** A tab stopped with Claude Code's dimmed next prompt in its input (spec 2026-09-25 tab suggestions
   * §6): the card. Never pushed to the phone (noise). Its own events: older apps parse `tab_question`. */
  | { type: 'tab_suggestion'; user_id: string; conversation_id: string; suggestion: TabQuestionView }
  /** It was sent (`answered`, or `failed`), dismissed, or left the tab's screen. */
  | { type: 'tab_suggestion_closed'; user_id: string; conversation_id: string; suggestion: TabQuestionView };
```

`apps/server/src/chat/tab-questions.ts` — replace `publishTabQuestions`:

```ts
/**
 * Tells every open screen of each row's conversation owner. Resolves the views it published. A
 * suggestion row goes out on its own events (spec 2026-09-25 tab suggestions §6.2) — `tab_suggestion`
 * when it opens, `tab_suggestion_closed` for anything after — so every close path here also closes it.
 */
export async function publishTabQuestions(repos: Pick<Repositories, 'tabs'>, type: TabQuestionEventType, rows: TabQuestion[]): Promise<TabQuestionView[]> {
  const views: TabQuestionView[] = [];
  for (const row of rows) {
    const [view] = await describeTabQuestions(repos, [row], row.user_id);
    if (row.kind === 'suggestion') chatBus.publish({ type: type === 'tab_question' ? 'tab_suggestion' : 'tab_suggestion_closed', user_id: row.user_id, conversation_id: row.conversation_id, suggestion: view });
    else chatBus.publish({ type, user_id: row.user_id, conversation_id: row.conversation_id, question: view });
    views.push(view);
  }
  return views;
}
```

`apps/server/src/chat/tab-question-answer.ts`:

```ts
import type { TabQuestion } from '../db/repositories/tab-questions.js';
```
(unchanged) and, after `export type TabAnswer = …`:

```ts
/** A `tab_questions` row that is a question — not a suggestion (spec 2026-09-25 tab suggestions §6.1). */
export type QuestionRow = TabQuestion & { kind: TabQuestionKind };
export const isQuestionRow = (row: TabQuestion | undefined): row is QuestionRow => row !== undefined && row.kind !== 'suggestion';
```

`AnswerDeps.beforeSend?: (row: QuestionRow, answer: TabAnswer) => void;`. In `answerTabQuestion`:

```ts
  const found = await ctx.repos.tabQuestions.findByIdForUser(id, userId);
  // A suggestion has its own routes (tab-suggestion-send.ts): here it is no question at all.
  if (!isQuestionRow(found)) throw notFound('Pergunta não encontrada');
  const row = found;
```

In `tabQuestionScreen`:

```ts
  const row = await ctx.repos.tabQuestions.findByIdForUser(id, ctx.scope.user.id);
  if (!isQuestionRow(row)) throw notFound('Pergunta não encontrada');
```

Create `apps/server/src/chat/tab-suggestions.ts`:

```ts
import type { FastifyBaseLogger } from 'fastify';
import { agents } from '../agent/registry.js';
import { captureStyledScreen } from '../agent/screen.js';
import type { Repositories } from '../db/repositories/index.js';
import type { Machine } from '../db/repositories/types.js';
import { promptSuggestion } from '../terminal/ansi.js';
import { failureLabel } from './service.js';
import { ANSWER_TEXT_MAX } from './tab-question-payload.js';
import { publishTabQuestions } from './tab-questions.js';

/** How long after Claude's `Stop` the prompt is read: the suggestion is drawn shortly after the turn ends (spec §3, §6.1). */
export const SUGGESTION_DELAY_MS = 3000;
/** The input box sits at the bottom of the pane. */
export const SUGGESTION_CAPTURE_LINES = 15;
export const SUGGESTION_MAX = ANSWER_TEXT_MAX;

type Log = Pick<FastifyBaseLogger, 'info' | 'warn'>;

/** One line of plain text, ≤ 2000 chars, control characters stripped; null when nothing is left. */
export function cleanSuggestion(text: string | null): string | null {
  if (text === null) return null;
  const clean = text.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, SUGGESTION_MAX).trim();
  return clean === '' ? null : clean;
}

/** The suggestion on the tab's prompt now, or null — also for a machine that cannot keep attributes. Never logged. */
export async function readSuggestion(machine: Machine, session: string): Promise<string | null> {
  const { text, styled } = await captureStyledScreen(machine, session, SUGGESTION_CAPTURE_LINES);
  return styled ? cleanSuggestion(promptSuggestion(text)) : null;
}

/**
 * The delayed half of a Claude `Stop` (spec §6.1): when the tab still waits for input and its prompt
 * shows a suggestion, a row opens in the project owner's most recently active conversation — the same
 * owner rule as a question — and the card reaches every screen showing it. `still` is false once another
 * hook event of the tab arrived (the screen moved on). Never throws; logs ids and counts only.
 */
export async function checkTabSuggestion(repos: Repositories, log: Log, tabId: string, still: () => boolean = () => true): Promise<void> {
  try {
    const tab = await repos.tabs.findById(tabId);
    if (!tab || tab.kind !== 'terminal' || !tab.tmux_session || tab.state !== 'waiting_input') return;
    const owner = (await repos.projects.findById(tab.project_id))?.owner_id;
    const conversation = owner ? await repos.chat.findLatestActiveForProject(tab.project_id, owner) : undefined;
    if (!conversation) return;
    const machine = await repos.machines.findById(tab.machine_id);
    if (!machine || (machine.type === 'agent' && !agents.isOnline(machine.id))) return;
    const text = await readSuggestion(machine, tab.tmux_session);
    if (text === null || !still()) return;
    const { question, closed } = await repos.tabQuestions.open({ tab_id: tab.id, project_id: tab.project_id, conversation_id: conversation.id, kind: 'suggestion', payload: { text }, tool_use_id: null });
    await publishTabQuestions(repos, 'tab_question_closed', closed);
    if (question) {
      await publishTabQuestions(repos, 'tab_question', [question]);
      log.info({ tabId: tab.id, tabQuestionId: question.id, kind: 'suggestion', chars: text.length }, 'tab suggestion opened');
    }
  } catch (err) {
    log.warn({ tabId, code: failureLabel(err) }, 'tab suggestion check failed');
  }
}

/** One pending check per tab. In-process: only the active color receives hooks. */
const pending = new Map<string, ReturnType<typeof setTimeout>>();

/** Any hook event of the tab: a check still waiting (or reading the screen) opens nothing. */
export function cancelTabSuggestion(tabId: string): void {
  const timer = pending.get(tabId);
  if (timer === undefined) return;
  clearTimeout(timer);
  pending.delete(tabId);
}

/** After a Claude `Stop`: fire-and-forget, never delays the hook POST. A second Stop restarts the wait. */
export function scheduleTabSuggestion(repos: Repositories, log: Log, tabId: string): void {
  cancelTabSuggestion(tabId);
  const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
    const still = () => pending.get(tabId) === timer;
    void checkTabSuggestion(repos, log, tabId, still).finally(() => {
      if (still()) pending.delete(tabId);
    });
  }, SUGGESTION_DELAY_MS);
  timer.unref?.();
  pending.set(tabId, timer);
}

/** The server is closing: no check runs against a closed database. */
export function stopTabSuggestions(): void {
  for (const timer of pending.values()) clearTimeout(timer);
  pending.clear();
}
```

`apps/server/src/monitor/ingest.ts`:

```ts
import { cancelTabSuggestion, scheduleTabSuggestion } from '../chat/tab-suggestions.js';
```

In `ingestHookEvent`:

```ts
  const tab = await repos.tabs.findByTmuxSession(input.machineId, input.session);
  if (!tab) return { ok: false, reason: 'unknown_session' };
  // Any hook event of the tab means its screen moved: a suggestion check still waiting opens nothing
  // (spec 2026-09-25 tab suggestions §6.1).
  cancelTabSuggestion(tab.id);
  const interpreted = interpretHookEvent(input.tool, input.event);
  if (!interpreted) return { ok: false, reason: 'ignored' };
  const updated = await recordInterpretation(repos, log, tab, input.tool, interpreted);
  // After the tab row (spec 2026-09-25 §4.2): a question opens a card in the project's chat, any
  // other event closes the one on screen. Never throws.
  await noteHookEvent(repos, log, updated, interpreted);
  // Claude Code draws its suggested next prompt shortly after the turn ends: look in a few seconds.
  if (input.tool === 'claude' && interpreted.meta.event === 'Stop') scheduleTabSuggestion(repos, log, updated.id);
  return { ok: true, tab: updated };
```

`apps/server/src/app.ts`: `import { stopTabSuggestions } from './chat/tab-suggestions.js';` and, in the `onClose` hook after `stopTabQuestionExpiry();`, add `stopTabSuggestions();`.

`apps/server/src/routes/chat.ts` and `apps/server/src/routes/m-chat.ts` — import `splitTabRows` next to `describeTabQuestions` (`import { describeTabQuestions, splitTabRows } from '../db/repositories/tab-questions-view.js';`) and replace the last two lines of `GET /`:

```ts
    const { tab_questions, tab_suggestions } = splitTabRows(await describeTabQuestions(repos, questionRows, request.scope.user.id));
    return { conversation, messages, actions, host, grants, tab_questions, tab_suggestions };
```

(in `m-chat.ts`, `user.id` instead of `request.scope.user.id`).

`apps/server/src/chat/tab-question-context.ts` — import `SuggestionAnswer, SuggestionPayload` too, and at the top of `linesOf`:

```ts
  if (q.kind === 'suggestion') {
    // Only a sent suggestion is news for the concierge; a dismissed one never reaches here (not `answered`).
    const sent = (q.answer as SuggestionAnswer | null)?.text;
    return sent === undefined ? [] : [`- a aba ${tabOf(q)} sugeria «${sanitise((q.payload as SuggestionPayload).text)}»; o usuário enviou «${sanitise(sent)}».`];
  }
```

- [ ] **Step 7: Run everything to verify it passes**

Run: `NODE 'npm test -w @termhub/server -- src/chat src/monitor src/routes src/mobile && npm run typecheck -w @termhub/server'` → PASS.
Run: `NODE 'cd apps/server && npx prisma migrate deploy && npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code && cd ../.. && TERMHUB_DB_TESTS=1 npm test -w @termhub/server -- src/db/repositories/tab-questions.db.test.ts'` → PASS, and the diff is empty (comments only: no migration).

- [ ] **Step 8: Commit**

```bash
git add packages/mobile-api/src/events.ts packages/mobile-api/src/events.test.ts apps/server/prisma/schema.prisma apps/server/src/chat/tab-question-payload.ts apps/server/src/db/repositories/tab-questions.ts apps/server/src/db/repositories/tab-questions-view.ts apps/server/src/db/repositories/tab-questions.db.test.ts apps/server/src/chat/bus.ts apps/server/src/chat/tab-questions.ts apps/server/src/chat/tab-questions.test.ts apps/server/src/chat/tab-question-answer.ts apps/server/src/chat/tab-question-answer.test.ts apps/server/src/chat/tab-suggestions.ts apps/server/src/chat/tab-suggestions.test.ts apps/server/src/monitor/ingest.ts apps/server/src/monitor/ingest.test.ts apps/server/src/app.ts apps/server/src/routes/chat.ts apps/server/src/routes/chat.test.ts apps/server/src/routes/m-chat.ts apps/server/src/routes/m-chat.test.ts apps/server/src/mobile/events-parity.test.ts apps/server/src/chat/tab-question-context.ts apps/server/src/chat/tab-question-context.test.ts
git commit -F - <<'MSG'
Chat: open suggestion cards when a tab stops with one

Three seconds after a Claude Stop (cancelled by any other event of
the tab), a styled capture of the prompt opens a tab_questions row of
kind suggestion when it holds one. Suggestions travel on their own
events and in tab_suggestions, stay out of the permission queue rule,
can be dismissed, and sent ones reach the concierge's context.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
MSG
```

---

### Task 5: Rotas enviar/dispensar (web + mobile)

**Files:**
- Modify: `apps/server/src/chat/tab-question-answer.ts` (export `asHttp`, `codeOf`)
- Create: `apps/server/src/chat/tab-suggestion-send.ts`
- Test: `apps/server/src/chat/tab-suggestion-send.test.ts`
- Modify: `apps/server/src/routes/chat.ts`, `apps/server/src/routes/m-chat.ts`
- Create: `apps/server/src/routes/chat.tab-suggestions.test.ts`

**Interfaces:**
- Consumes: `readSuggestion` (Task 4), `QuestionRow`/repository `claim`/`closeOne`/`markFailed`/`dismiss`/`findOpenForTab` (Task 4), `publishTabQuestions` (Task 4), `sendInput` (control/terminals.ts), `assertTerminal`/`offline` (control/screen.ts), `answerText` (Task 4).
- Produces: `suggestionSendBody` (zod), `suggestionChanged(): HttpError`, `sendTabSuggestion(ctx: ControlContext, id: string, raw: unknown, deps: { log }): Promise<TabQuestionView>`, `dismissTabSuggestion(ctx: ControlContext, id: string, deps: { log }): Promise<TabQuestionView>`; routes `POST /chat/tab-suggestions/:id/send` → `{ tab_suggestion }`, `POST /chat/tab-suggestions/:id/dismiss` → `{ tab_suggestion }` on both plugins.

- [ ] **Step 1: Write the failing tests**

Create `apps/server/src/chat/tab-suggestion-send.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import { agents } from '../agent/registry.js';
import { ControlError, type ControlContext } from '../control/context.js';
import type { TabQuestion } from '../db/repositories/tab-questions.js';
import { HttpError, notFound } from '../lib/errors.js';
import { chatBus, type ChatEvent } from './bus.js';

const sendInput = vi.fn(async (_ctx: unknown, input: { tab_id: string }) => ({ tab_id: input.tab_id, sent: true }));
vi.mock('../control/terminals.js', async (orig) => ({ ...(await orig<typeof import('../control/terminals.js')>()), sendInput: (...a: unknown[]) => sendInput(a[0], a[1] as never) }));
const captureStyledScreen = vi.fn();
vi.mock('../agent/screen.js', async (orig) => ({ ...(await orig<typeof import('../agent/screen.js')>()), captureStyledScreen: (...a: unknown[]) => captureStyledScreen(...a) }));

const { dismissTabSuggestion, sendTabSuggestion } = await import('./tab-suggestion-send.js');

const fx = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures/tab-suggestions', name), 'utf8');
const screens = { suggestion: fx('screen-suggestion.ansi'), typed: fx('screen-typed.ansi') };

const row = (over: Partial<TabQuestion> = {}): TabQuestion => ({
  id: 's1', tab_id: 't1', project_id: 'p1', conversation_id: 'c1', user_id: 'u1', kind: 'suggestion', payload: { text: 'commit it' }, tool_use_id: null,
  status: 'open', answer: null, error_code: null, answered_by: null, answered_at: null, closed_at: null, injected_at: null, created_at: '2026-09-25T12:00:00.000Z', ...over,
});

function ctxFor(current: TabQuestion | undefined, opts: { latest?: TabQuestion | undefined; claimLoses?: boolean; denied?: string[]; outOfScope?: boolean } = {}) {
  const tabQuestions = {
    findByIdForUser: vi.fn(async (_id: string, userId: string) => (userId === 'u1' ? current : undefined)),
    findOpenForTab: vi.fn(async () => ('latest' in opts ? opts.latest : current)),
    claim: vi.fn(async (_id: string, _u: string, answer: unknown) => (opts.claimLoses || !current ? undefined : { ...current, status: 'answered' as const, answer: answer as never, answered_by: 'u1', answered_at: '2026-09-25T12:01:00.000Z' })),
    markFailed: vi.fn(async (_id: string, code: string) => (current ? { ...current, status: 'failed' as const, error_code: code } : undefined)),
    closeOne: vi.fn(async (_id: string, status: 'answered_in_tab' | 'expired') => (current ? { ...current, status, closed_at: '2026-09-25T12:01:00.000Z' } : undefined)),
    dismiss: vi.fn(async () => (current?.status === 'open' ? { ...current, status: 'dismissed' as const, closed_at: '2026-09-25T12:01:00.000Z' } : undefined)),
  };
  const scoped = {
    tab: vi.fn(async (id: string) => {
      if (opts.outOfScope) throw notFound('Tab não encontrada');
      return { tab: { id, name: 'api', kind: 'terminal', tmux_session: 'th-t1', state: 'waiting_input' }, machine: { id: 'm1', type: 'agent' }, project: { id: 'p1' }, cwd: '/w' };
    }),
  };
  const repos = { tabQuestions, tabs: { findByIdsForOwner: vi.fn(async () => [{ id: 't1', name: 'api' }]) } };
  const can = vi.fn(async (resource: string, action: string) => !(opts.denied ?? []).includes(`${resource}:${action}`));
  const ctx = { repos, scoped, scope: { user: { id: 'u1' } }, can } as unknown as ControlContext;
  return { ctx, tabQuestions, scoped, can };
}
const log = () => ({ info: vi.fn(), warn: vi.fn() });
const rejects = async (p: Promise<unknown>, status: number, code: string) => {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(HttpError);
  expect(err).toMatchObject({ statusCode: status, code });
};

let events: ChatEvent[];
let unsubscribe: () => void;
beforeEach(() => {
  vi.clearAllMocks();
  captureStyledScreen.mockResolvedValue({ text: screens.suggestion, styled: true });
  vi.spyOn(agents, 'isOnline').mockReturnValue(true);
  events = [];
  unsubscribe = chatBus.subscribe((e) => events.push(e));
});
afterEach(() => {
  unsubscribe();
  vi.restoreAllMocks();
});

describe('sendTabSuggestion', () => {
  it('checks the live prompt, claims, types the text and Enter, and announces the card closed as sent', async () => {
    const { ctx, tabQuestions } = ctxFor(row());
    const l = log();
    const view = await sendTabSuggestion(ctx, 's1', { text: 'commit it' }, { log: l });
    expect(captureStyledScreen).toHaveBeenCalledWith({ id: 'm1', type: 'agent' }, 'th-t1', 15);
    expect(tabQuestions.claim).toHaveBeenCalledWith('s1', 'u1', { text: 'commit it' });
    expect(sendInput).toHaveBeenCalledWith(ctx, { tab_id: 't1', text: 'commit it', enter: true });
    expect(tabQuestions.claim.mock.invocationCallOrder[0]!).toBeLessThan(sendInput.mock.invocationCallOrder[0]!);
    expect(view).toMatchObject({ id: 's1', tab_name: 'api', status: 'answered', answer: { text: 'commit it' } });
    expect(events).toEqual([expect.objectContaining({ type: 'tab_suggestion_closed', user_id: 'u1', conversation_id: 'c1', suggestion: expect.objectContaining({ status: 'answered' }) })]);
    expect(l.info).toHaveBeenCalledWith({ tabQuestionId: 's1', tabId: 't1', kind: 'suggestion', chars: 9, edited: false }, 'tab suggestion sent');
    expect(JSON.stringify(l.info.mock.calls)).not.toContain('commit');
  });

  it('sends the text as edited; the live check still compares the suggestion itself', async () => {
    const { ctx, tabQuestions } = ctxFor(row());
    await sendTabSuggestion(ctx, 's1', { text: '  commit it and push ' }, { log: log() });
    expect(tabQuestions.claim).toHaveBeenCalledWith('s1', 'u1', { text: 'commit it and push' });
    expect(sendInput).toHaveBeenCalledWith(ctx, { tab_id: 't1', text: 'commit it and push', enter: true });
  });

  it.each([
    ['text typed in the tab', { text: screens.typed, styled: true }],
    ['a different suggestion now', { text: '❯ \x1b[2mrun the tests\x1b[0m', styled: true }],
    ['a capture without attributes', { text: '❯ commit it', styled: false }],
  ])('409 TAB_PROMPT_CHANGED and the card closes when the prompt shows %s', async (_label, shot) => {
    captureStyledScreen.mockResolvedValue(shot);
    const { ctx, tabQuestions } = ctxFor(row());
    await rejects(sendTabSuggestion(ctx, 's1', { text: 'commit it' }, { log: log() }), 409, 'TAB_PROMPT_CHANGED');
    expect(tabQuestions.closeOne).toHaveBeenCalledWith('s1', 'answered_in_tab');
    expect(events).toEqual([expect.objectContaining({ type: 'tab_suggestion_closed', suggestion: expect.objectContaining({ status: 'answered_in_tab' }) })]);
    expect(tabQuestions.claim).not.toHaveBeenCalled();
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('says "A sugestão mudou na aba"', async () => {
    captureStyledScreen.mockResolvedValue({ text: screens.typed, styled: true });
    const { ctx } = ctxFor(row());
    await expect(sendTabSuggestion(ctx, 's1', { text: 'commit it' }, { log: log() })).rejects.toThrow('A sugestão mudou na aba');
  });

  it('403 FORBIDDEN without terminals:write, nothing read', async () => {
    const { ctx, can, tabQuestions } = ctxFor(row(), { denied: ['terminals:write'] });
    await rejects(sendTabSuggestion(ctx, 's1', { text: 'commit it' }, { log: log() }), 403, 'FORBIDDEN');
    expect(can).toHaveBeenCalledWith('terminals', 'write');
    expect(tabQuestions.findByIdForUser).not.toHaveBeenCalled();
  });

  it.each([
    ['unknown', undefined],
    ['a question, not a suggestion', row({ id: 'q1', kind: 'permission', payload: { tool_name: 'Bash' } })],
  ])('404 for %s', async (_label, current) => {
    const { ctx } = ctxFor(current);
    await rejects(sendTabSuggestion(ctx, 's1', { text: 'commit it' }, { log: log() }), 404, 'NOT_FOUND');
  });

  it('404 when the tab left the scope', async () => {
    const { ctx } = ctxFor(row(), { outOfScope: true });
    await rejects(sendTabSuggestion(ctx, 's1', { text: 'commit it' }, { log: log() }), 404, 'NOT_FOUND');
  });

  it('409 without typing: not open, not the tab\'s latest, or the claim lost (a double click)', async () => {
    await rejects(sendTabSuggestion(ctxFor(row({ status: 'dismissed' })).ctx, 's1', { text: 'commit it' }, { log: log() }), 409, 'TAB_PROMPT_CHANGED');
    await rejects(sendTabSuggestion(ctxFor(row(), { latest: row({ id: 's2' }) }).ctx, 's1', { text: 'commit it' }, { log: log() }), 409, 'TAB_PROMPT_CHANGED');
    await rejects(sendTabSuggestion(ctxFor(row(), { claimLoses: true }).ctx, 's1', { text: 'commit it' }, { log: log() }), 409, 'TAB_PROMPT_CHANGED');
    expect(sendInput).not.toHaveBeenCalled();
  });

  it.each([['!rm -rf .'], ['/exit'], ['a\nb'], ['tab\there'], [''], ['   '], ['x'.repeat(2001)]])('refuses %j before anything is read', async (text) => {
    const { ctx } = ctxFor(row());
    await expect(sendTabSuggestion(ctx, 's1', { text }, { log: log() })).rejects.toBeInstanceOf(ZodError);
    expect(captureStyledScreen).not.toHaveBeenCalled();
  });

  it('an offline agent is 409 MACHINE_OFFLINE, nothing claimed', async () => {
    vi.mocked(agents.isOnline).mockReturnValue(false);
    const { ctx, tabQuestions } = ctxFor(row());
    await rejects(sendTabSuggestion(ctx, 's1', { text: 'commit it' }, { log: log() }), 409, 'MACHINE_OFFLINE');
    expect(tabQuestions.claim).not.toHaveBeenCalled();
  });

  it('a send that fails after the claim marks the card failed and answers 502', async () => {
    sendInput.mockRejectedValueOnce(new ControlError('MACHINE_OFFLINE', 'A máquina está offline'));
    const { ctx, tabQuestions } = ctxFor(row());
    await rejects(sendTabSuggestion(ctx, 's1', { text: 'commit it' }, { log: log() }), 502, 'MACHINE_OFFLINE');
    expect(tabQuestions.markFailed).toHaveBeenCalledWith('s1', 'MACHINE_OFFLINE');
    expect(events).toEqual([expect.objectContaining({ type: 'tab_suggestion_closed', suggestion: expect.objectContaining({ status: 'failed', error_code: 'MACHINE_OFFLINE' }) })]);
  });
});

describe('dismissTabSuggestion', () => {
  it('closes an open suggestion as dismissed without touching the tab', async () => {
    const { ctx, tabQuestions } = ctxFor(row());
    const view = await dismissTabSuggestion(ctx, 's1', { log: log() });
    expect(tabQuestions.dismiss).toHaveBeenCalledWith('s1', 'u1');
    expect(view).toMatchObject({ id: 's1', status: 'dismissed' });
    expect(events).toEqual([expect.objectContaining({ type: 'tab_suggestion_closed', suggestion: expect.objectContaining({ status: 'dismissed' }) })]);
    expect(captureStyledScreen).not.toHaveBeenCalled();
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('a suggestion already sent or closed stays as it is, and nothing is announced', async () => {
    const { ctx } = ctxFor(row({ status: 'answered', answer: { text: 'commit it' } }));
    expect(await dismissTabSuggestion(ctx, 's1', { log: log() })).toMatchObject({ status: 'answered' });
    expect(events).toEqual([]);
  });

  it('404 for a question id or another user\'s row', async () => {
    await rejects(dismissTabSuggestion(ctxFor(row({ kind: 'choice' })).ctx, 's1', { log: log() }), 404, 'NOT_FOUND');
    await rejects(dismissTabSuggestion(ctxFor(undefined).ctx, 's1', { log: log() }), 404, 'NOT_FOUND');
  });
});
```

Create `apps/server/src/routes/chat.tab-suggestions.test.ts`:

```ts
import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyErrorHandler, HttpError } from '../lib/errors.js';

const send = vi.fn(async (..._a: unknown[]) => ({ id: 's1', status: 'answered' }));
const dismiss = vi.fn(async (..._a: unknown[]) => ({ id: 's1', status: 'dismissed' }));
vi.mock('../chat/tab-suggestion-send.js', () => ({
  sendTabSuggestion: (...a: unknown[]) => send(...a),
  dismissTabSuggestion: (...a: unknown[]) => dismiss(...a),
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

describe.each(['web', 'mobile'] as const)('%s tab-suggestion routes', (kind) => {
  it("POST send hands the id, the raw body and the signed-in user's context to the service", async () => {
    const res = await build(kind).inject({ method: 'POST', url: '/chat/tab-suggestions/s1/send', payload: { text: 'commit it' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ tab_suggestion: { id: 's1', status: 'answered' } });
    const [ctx, id, body] = send.mock.calls[0]!;
    expect((ctx as { scope: { user: { id: string } } }).scope.user.id).toBe('u1');
    expect(id).toBe('s1');
    expect(body).toEqual({ text: 'commit it' });
  });

  it('POST dismiss answers the dismissed card', async () => {
    const res = await build(kind).inject({ method: 'POST', url: '/chat/tab-suggestions/s1/dismiss', payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ tab_suggestion: { id: 's1', status: 'dismissed' } });
    expect(dismiss.mock.calls[0]![1]).toBe('s1');
  });

  it('refuses an id that is not one', async () => {
    const res = await build(kind).inject({ method: 'POST', url: `/chat/tab-suggestions/${'x'.repeat(65)}/send`, payload: { text: 'a' } });
    expect(res.statusCode).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });

  it("passes the service's 409 through", async () => {
    send.mockRejectedValueOnce(new HttpError(409, 'A sugestão mudou na aba', 'TAB_PROMPT_CHANGED'));
    const res = await build(kind).inject({ method: 'POST', url: '/chat/tab-suggestions/s1/send', payload: { text: 'commit it' } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'A sugestão mudou na aba', code: 'TAB_PROMPT_CHANGED' });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `NODE 'npm test -w @termhub/server -- src/chat/tab-suggestion-send.test.ts src/routes/chat.tab-suggestions.test.ts'`
Expected: FAIL — `./tab-suggestion-send.js` does not exist; the routes answer 404.

- [ ] **Step 3: Implement**

`apps/server/src/chat/tab-question-answer.ts` — export the two helpers (`const asHttp` → `export const asHttp`, `const codeOf` → `export const codeOf`), unchanged otherwise.

Create `apps/server/src/chat/tab-suggestion-send.ts`:

```ts
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import { agents } from '../agent/registry.js';
import type { ControlContext } from '../control/context.js';
import { assertTerminal, offline } from '../control/screen.js';
import { sendInput } from '../control/terminals.js';
import { describeTabQuestions, toTabQuestionView, type TabQuestionView } from '../db/repositories/tab-questions-view.js';
import { forbidden, HttpError, notFound } from '../lib/errors.js';
import { asHttp, codeOf } from './tab-question-answer.js';
import { answerText, type SuggestionPayload } from './tab-question-payload.js';
import { publishTabQuestions } from './tab-questions.js';
import { readSuggestion } from './tab-suggestions.js';

type Log = Pick<FastifyBaseLogger, 'info' | 'warn'>;

export const suggestionChanged = () => new HttpError(409, 'A sugestão mudou na aba', 'TAB_PROMPT_CHANGED');

/**
 * What "Enviar" types (spec 2026-09-25 tab suggestions §6.2): TER-56's answer text — one line, no control
 * characters, ≤ 2000 — which lands at Claude Code's prompt, where a leading "!" runs bash and a leading
 * "/" a slash command: both refused, as for a permission's deny text.
 */
export const suggestionSendBody = z.object({
  text: answerText
    .refine((t) => !t.startsWith('!'), 'o texto não pode começar com "!"')
    .refine((t) => !t.startsWith('/'), 'o texto não pode começar com "/"'),
});

const suggestionRow = async (ctx: ControlContext, id: string) => {
  const row = await ctx.repos.tabQuestions.findByIdForUser(id, ctx.scope.user.id);
  if (!row || row.kind !== 'suggestion') throw notFound('Sugestão não encontrada');
  return row;
};

/**
 * Sends a tab's suggestion from its card (spec §6.2). In order: `terminals:write`, the row through its
 * owner, the body, the tab through the scope (404), still open and still the tab's latest (409), the live
 * prompt still shows the same suggestion (else 409 and the card closes), the claim (409 for the loser of
 * a double click), then the text and Enter. A failure after the claim leaves the row `failed` and answers
 * 502. Logs ids and counts only — never the text.
 */
export async function sendTabSuggestion(ctx: ControlContext, id: string, raw: unknown, deps: { log: Log }): Promise<TabQuestionView> {
  // Typing into a terminal: the same grant as the MCP write tools.
  if (!(await ctx.can('terminals', 'write'))) throw forbidden('Enviar para a aba precisa da permissão terminals:write na sua role');
  const userId = ctx.scope.user.id;
  const row = await suggestionRow(ctx, id);
  const { text } = suggestionSendBody.parse(raw);
  const suggested = (row.payload as SuggestionPayload).text;
  const { tab, machine } = await ctx.scoped.tab(row.tab_id);
  if (row.status !== 'open') throw suggestionChanged();
  const latest = await ctx.repos.tabQuestions.findOpenForTab(tab.id);
  if (latest?.id !== row.id) throw suggestionChanged();

  let shown: string | null;
  try {
    assertTerminal(tab);
    if (machine.type === 'agent' && !agents.isOnline(machine.id)) throw offline();
    shown = await readSuggestion(machine, tab.tmux_session);
  } catch (err) {
    // agentRpc turns a connection that dropped mid-call into a bare 503 (toHttpError)
    throw asHttp(err instanceof HttpError && err.statusCode === 503 ? offline() : err);
  }
  if (shown !== suggested) {
    // The tab moved on without telling us: this card is stale, so it leaves the screens now (only this
    // row, only while still open). Best effort: the 409 is the answer either way.
    try {
      const closed = await ctx.repos.tabQuestions.closeOne(row.id, 'answered_in_tab');
      if (closed) await publishTabQuestions(ctx.repos, 'tab_question_closed', [closed]);
    } catch (err) {
      deps.log.warn({ tabQuestionId: row.id, tabId: tab.id, code: codeOf(err, 'CLOSE_FAILED') }, 'stale tab suggestion not closed');
    }
    throw suggestionChanged();
  }

  const claimed = await ctx.repos.tabQuestions.claim(row.id, userId, { text });
  if (!claimed) throw suggestionChanged();
  try {
    await sendInput(ctx, { tab_id: tab.id, text, enter: true });
  } catch (err) {
    const code = codeOf(err);
    deps.log.warn({ tabQuestionId: row.id, tabId: tab.id, kind: 'suggestion', code }, 'tab suggestion send failed');
    // Recording the failure is best effort: a db or bus error here must not replace the send's own error.
    try {
      const failed = await ctx.repos.tabQuestions.markFailed(row.id, code);
      if (failed) await publishTabQuestions(ctx.repos, 'tab_question_answered', [failed]);
    } catch (recordErr) {
      deps.log.warn({ tabQuestionId: row.id, tabId: tab.id, code: codeOf(recordErr, 'RECORD_FAILED') }, 'tab suggestion failure not recorded');
    }
    throw new HttpError(502, 'Não foi possível enviar para a aba', code);
  }
  deps.log.info({ tabQuestionId: row.id, tabId: tab.id, kind: 'suggestion', chars: text.length, edited: text !== suggested }, 'tab suggestion sent');
  // The text is in the tab: announcing it is best effort and can no longer turn the send into an error.
  try {
    const [view] = await publishTabQuestions(ctx.repos, 'tab_question_answered', [claimed]);
    if (view) return view;
  } catch (err) {
    deps.log.warn({ tabQuestionId: row.id, tabId: tab.id, code: codeOf(err, 'PUBLISH_FAILED') }, 'tab suggestion send not announced');
  }
  return toTabQuestionView(claimed, tab.name);
}

/**
 * "Dispensar" (spec §6.1): the card closes as `dismissed`; the tab is not touched, so no terminal grant is
 * needed. Idempotent: a suggestion already sent, closed or dismissed comes back as it is.
 */
export async function dismissTabSuggestion(ctx: ControlContext, id: string, deps: { log: Log }): Promise<TabQuestionView> {
  const userId = ctx.scope.user.id;
  const row = await suggestionRow(ctx, id);
  const dismissed = await ctx.repos.tabQuestions.dismiss(row.id, userId);
  if (!dismissed) {
    const now = (await ctx.repos.tabQuestions.findByIdForUser(row.id, userId)) ?? row;
    const [view] = await describeTabQuestions(ctx.repos, [now], userId);
    return view;
  }
  deps.log.info({ tabQuestionId: row.id, tabId: row.tab_id, kind: 'suggestion' }, 'tab suggestion dismissed');
  const [view] = await publishTabQuestions(ctx.repos, 'tab_question_closed', [dismissed]);
  return view;
}
```

(Note for the test's `ctxFor`: `dismissTabSuggestion`'s already-closed path calls `findByIdForUser` again — the fake answers the same row.)

`apps/server/src/routes/chat.ts` — `import { dismissTabSuggestion, sendTabSuggestion } from '../chat/tab-suggestion-send.js';` and, at the end of `chatRoutes`:

```ts
  /**
   * "Enviar" on a tab's suggestion card (spec 2026-09-25 tab suggestions §6.2): one click, no gate card,
   * no PIN. `create`, like answering a tab's question; the service also requires `terminals:write`.
   */
  app.post('/tab-suggestions/:id/send', { config: { action: 'create' } }, async (request) => {
    const { id } = tabQuestionIdParam.parse(request.params);
    return { tab_suggestion: await sendTabSuggestion(controlContextFor(repos, request.scope.user), id, request.body, { log: request.log }) };
  });

  /** "Dispensar": the card closes, the tab is not touched. */
  app.post('/tab-suggestions/:id/dismiss', { config: { action: 'create' } }, async (request) => {
    const { id } = tabQuestionIdParam.parse(request.params);
    return { tab_suggestion: await dismissTabSuggestion(controlContextFor(repos, request.scope.user), id, { log: request.log }) };
  });
```

`apps/server/src/routes/m-chat.ts` — `import { dismissTabSuggestion, sendTabSuggestion } from '../chat/tab-suggestion-send.js';` and, at the end of `mobileChatRoutes`:

```ts
  /** The phone sends a tab's suggestion like the web: no PIN (spec 2026-09-25 tab suggestions §2). */
  app.post('/tab-suggestions/:id/send', { config: { action: 'create' } }, async (request) => {
    const { id } = tabQuestionIdParam.parse(request.params);
    return { tab_suggestion: await sendTabSuggestion(controlContextFor(repos, request.scope.user), id, request.body, { log: request.log }) };
  });

  /** "Dispensar" from the phone: the card closes, the tab is not touched. */
  app.post('/tab-suggestions/:id/dismiss', { config: { action: 'create' } }, async (request) => {
    const { id } = tabQuestionIdParam.parse(request.params);
    return { tab_suggestion: await dismissTabSuggestion(controlContextFor(repos, request.scope.user), id, { log: request.log }) };
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `NODE 'npm test -w @termhub/server -- src/chat src/routes && npm run typecheck -w @termhub/server'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/chat/tab-question-answer.ts apps/server/src/chat/tab-suggestion-send.ts apps/server/src/chat/tab-suggestion-send.test.ts apps/server/src/routes/chat.ts apps/server/src/routes/m-chat.ts apps/server/src/routes/chat.tab-suggestions.test.ts
git commit -F - <<'MSG'
Chat: send or dismiss a tab's suggestion

Enviar re-reads the prompt (409 and closes the card when it changed),
claims the row and types the text with Enter, with TER-56's guards;
Dispensar closes the card without touching the tab. Web and mobile
routes share the service.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
MSG
```

---

### Task 6: Web: TabSuggestionCard + timeline + ChatPanel + api

**Files:**
- Modify: `apps/web/src/lib/types.ts` (after `TabQuestion`; `ChatEvent`)
- Modify: `apps/web/src/lib/api.ts` (`chat` response type; two calls)
- Modify: `apps/web/src/lib/chat-timeline.ts`
- Test: `apps/web/src/lib/chat-timeline.test.ts`
- Create: `apps/web/src/components/chat/tab-suggestion-text.ts`, `apps/web/src/components/chat/TabSuggestionCard.tsx`
- Test: `apps/web/src/components/chat/TabSuggestionCard.test.tsx`
- Modify: `apps/web/src/components/chat/ChatPanel.tsx`
- Test: `apps/web/src/components/chat/ChatPanel.test.tsx`

**Interfaces:**
- Consumes: `GET /api/chat` `tab_suggestions`, events `tab_suggestion` / `tab_suggestion_closed`, `POST /api/chat/tab-suggestions/:id/{send,dismiss}` → `{ tab_suggestion }` (Tasks 4–5).
- Produces: web types `TabSuggestionStatus`, `TabSuggestion`; `api.sendTabSuggestion(id: string, text: string)`, `api.dismissTabSuggestion(id: string)`; `chatTimeline(messages, actions, tabQuestions = [], tabSuggestions = [])` with entry `{ kind: 'tab_suggestion'; at; suggestion }`; `TabSuggestionCard`; `SUGGESTION_CHANGED_TEXT`, `suggestionTitle`, `suggestionStatusLabel`, `upsertTabSuggestion`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/web/src/lib/chat-timeline.test.ts` (import `TabSuggestion` from `./types` too):

```ts
describe('tab suggestions', () => {
  const suggestion = (over: Partial<TabSuggestion> = {}): TabSuggestion => ({ id: 's1', tab_id: 't1', tab_name: 'api', kind: 'suggestion', payload: { text: 'commit it' }, status: 'open', answer: null, error_code: null, created_at: T1, answered_at: null, closed_at: null, ...over });
  const message = (id: string, created_at: string): ChatMessage => ({ id, conversation_id: 'c1', role: 'assistant', text: 'x', error_code: null, created_at }) as ChatMessage;

  it('interleaves a suggestion by created_at, after the message of the same instant', () => {
    const entries = chatTimeline([message('m1', T0), message('m2', T1)], [], [], [suggestion()]);
    expect(entries.map((e) => e.kind)).toEqual(['message', 'message', 'tab_suggestion']);
  });

  it('follows the message window like a question card', () => {
    expect(chatTimeline([message('m1', T1)], [], [], [suggestion({ created_at: T0 })])).toHaveLength(1);
  });
});
```

Create `apps/web/src/components/chat/TabSuggestionCard.test.tsx`:

```tsx
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TabSuggestionCard } from './TabSuggestionCard';
import type { TabSuggestion } from '../../lib/types';

afterEach(() => cleanup());

const open = (over: Partial<TabSuggestion> = {}): TabSuggestion => ({ id: 's1', tab_id: 't1', tab_name: 'api', kind: 'suggestion', payload: { text: 'commit it' }, status: 'open', answer: null, error_code: null, created_at: '', answered_at: null, closed_at: null, ...over });

it('"«api» sugere:" with the text editable; Enviar sends it as edited, Dispensar dismisses', () => {
  const onSend = vi.fn();
  const onDismiss = vi.fn();
  render(<TabSuggestionCard suggestion={open()} busy={false} onSend={onSend} onDismiss={onDismiss} />);
  expect(screen.getByText('«api» sugere:')).toBeInTheDocument();
  const field = screen.getByLabelText('Texto da sugestão');
  expect(field).toHaveValue('commit it');
  fireEvent.change(field, { target: { value: '  commit it and push ' } });
  fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
  expect(onSend).toHaveBeenCalledWith('commit it and push');
  fireEvent.click(screen.getByRole('button', { name: 'Dispensar' }));
  expect(onDismiss).toHaveBeenCalled();
});

it('Enviar is disabled while sending or with an empty field', () => {
  const { rerender } = render(<TabSuggestionCard suggestion={open()} busy={true} onSend={vi.fn()} onDismiss={vi.fn()} />);
  expect(screen.getByRole('button', { name: 'Enviar' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Dispensar' })).toBeDisabled();
  rerender(<TabSuggestionCard suggestion={open()} busy={false} onSend={vi.fn()} onDismiss={vi.fn()} />);
  fireEvent.change(screen.getByLabelText('Texto da sugestão'), { target: { value: '   ' } });
  expect(screen.getByRole('button', { name: 'Enviar' })).toBeDisabled();
});

it('a card with no tab name says "Uma aba sugere:"', () => {
  render(<TabSuggestionCard suggestion={open({ tab_name: null })} busy={false} onSend={vi.fn()} onDismiss={vi.fn()} />);
  expect(screen.getByText('Uma aba sugere:')).toBeInTheDocument();
});

it.each([
  [open({ status: 'answered', answer: { text: 'commit it and push' } }), 'commit it and push', 'Enviada'],
  [open({ status: 'dismissed' }), 'commit it', 'Dispensada'],
  [open({ status: 'answered_in_tab' }), 'commit it', 'Respondida na aba'],
  [open({ status: 'expired' }), 'commit it', 'Expirada'],
  [open({ status: 'failed', error_code: 'MACHINE_OFFLINE', answer: { text: 'commit it' } }), 'commit it', 'Falhou — a máquina está offline'],
])('a closed card is read-only and says how it ended (%#)', (s, text, label) => {
  render(<TabSuggestionCard suggestion={s} busy={false} onSend={vi.fn()} onDismiss={vi.fn()} />);
  expect(screen.getByText(text)).toBeInTheDocument();
  expect(screen.getByText(label)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Enviar' })).toBeNull();
  expect(screen.queryByLabelText('Texto da sugestão')).toBeNull();
});

it('shows the error it is given', () => {
  render(<TabSuggestionCard suggestion={open()} busy={false} error="A sugestão mudou na aba" onSend={vi.fn()} onDismiss={vi.fn()} />);
  expect(screen.getByText('A sugestão mudou na aba')).toBeInTheDocument();
});
```

`apps/web/src/components/chat/ChatPanel.test.tsx` — change the testing-library import to include `within`, import `TabSuggestion` with the other types, add two mocks next to `screenMock`:

```ts
const sendSuggestionMock = vi.fn();
const dismissSuggestionMock = vi.fn();
```

in the `api` of the `vi.mock('../../lib/api', …)` factory:

```ts
      sendTabSuggestion: (...a: unknown[]) => sendSuggestionMock(...a),
      dismissTabSuggestion: (...a: unknown[]) => dismissSuggestionMock(...a),
```

in `beforeEach`: `sendSuggestionMock.mockReset(); dismissSuggestionMock.mockReset();`, and append:

```tsx
const suggestion = (over: Partial<TabSuggestion> & { id: string }): TabSuggestion => ({ tab_id: 't1', tab_name: 'api', kind: 'suggestion', payload: { text: 'commit it' }, status: 'open', answer: null, error_code: null, created_at: '2026-09-21T00:00:00.000Z', answered_at: null, closed_at: null, ...over });
const card = async () => (await screen.findByText('«api» sugere:')).closest('li') as HTMLElement;

it('shows a tab suggestion from GET /chat and sends it, as edited, with one click', async () => {
  chatMock.mockResolvedValue({ conversation: { id: 'c_p1', project_id: 'p1', ai_account_id: null }, messages: [], actions: [], host: READY, grants: [], tab_questions: [], tab_suggestions: [suggestion({ id: 's1' })] });
  sendSuggestionMock.mockResolvedValue({ tab_suggestion: suggestion({ id: 's1', status: 'answered', answer: { text: 'commit it and push' } }) });
  render(
    <MemoryRouter>
      <ChatPanel projectId="p1" />
    </MemoryRouter>,
  );
  const li = await card();
  fireEvent.change(within(li).getByLabelText('Texto da sugestão'), { target: { value: 'commit it and push' } });
  fireEvent.click(within(li).getByRole('button', { name: 'Enviar' }));
  await waitFor(() => expect(sendSuggestionMock).toHaveBeenCalledWith('s1', 'commit it and push'));
  expect(await screen.findByText('Enviada')).toBeInTheDocument();
});

it('Dispensar closes the card; a stale suggestion reads "A sugestão mudou na aba"', async () => {
  const { ApiError } = await import('../../lib/api');
  chatMock.mockResolvedValue({ conversation: { id: 'c_p1', project_id: 'p1', ai_account_id: null }, messages: [], actions: [], host: READY, grants: [], tab_suggestions: [suggestion({ id: 's1' }), suggestion({ id: 's2', tab_name: 'web', created_at: '2026-09-21T00:01:00.000Z' })] });
  dismissSuggestionMock.mockResolvedValue({ tab_suggestion: suggestion({ id: 's1', status: 'dismissed' }) });
  sendSuggestionMock.mockRejectedValue(new ApiError(409, 'A sugestão mudou na aba', 'TAB_PROMPT_CHANGED'));
  render(
    <MemoryRouter>
      <ChatPanel projectId="p1" />
    </MemoryRouter>,
  );
  fireEvent.click(within(await card()).getByRole('button', { name: 'Dispensar' }));
  expect(await screen.findByText('Dispensada')).toBeInTheDocument();
  expect(dismissSuggestionMock).toHaveBeenCalledWith('s1');
  const other = (await screen.findByText('«web» sugere:')).closest('li') as HTMLElement;
  fireEvent.click(within(other).getByRole('button', { name: 'Enviar' }));
  expect(await screen.findByText('A sugestão mudou na aba')).toBeInTheDocument();
});

it("tab suggestion events add and update the card; another conversation's are ignored", async () => {
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
  onEvent({ type: 'tab_suggestion', conversation_id: 'c_other', suggestion: suggestion({ id: 's9', tab_name: 'OUTRA' }) });
  expect(screen.queryByText(/OUTRA/)).toBeNull();
  onEvent({ type: 'tab_suggestion', conversation_id: 'c_p1', suggestion: suggestion({ id: 's1' }) });
  expect(await screen.findByText('«api» sugere:')).toBeInTheDocument();
  onEvent({ type: 'tab_suggestion_closed', conversation_id: 'c_p1', suggestion: suggestion({ id: 's1', status: 'answered_in_tab' }) });
  expect(await screen.findByText('Respondida na aba')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `NODE 'npm test -w @termhub/web -- src/lib/chat-timeline.test.ts src/components/chat/TabSuggestionCard.test.tsx src/components/chat/ChatPanel.test.tsx'`
Expected: FAIL — `./TabSuggestionCard` missing; the timeline ignores a 4th argument; the panel renders no suggestion.

- [ ] **Step 3: Implement**

`apps/web/src/lib/types.ts` — after `export type TabQuestion = …`:

```ts
export type TabSuggestionStatus = TabQuestionStatus | 'dismissed';
/**
 * Claude Code's dimmed next prompt in a tab (spec 2026-09-25 tab suggestions §6.4): a card with the text
 * editable, Enviar / Dispensar. `answer.text` is what was sent. Plain text only — never render it as HTML.
 */
export interface TabSuggestion {
  id: string;
  tab_id: string;
  /** The tab's name at read time; null once the tab is gone. */
  tab_name: string | null;
  kind: 'suggestion';
  payload: { text: string };
  status: TabSuggestionStatus;
  answer: { text: string } | null;
  error_code: string | null;
  created_at: string;
  answered_at: string | null;
  closed_at: string | null;
}
```

and in `ChatEvent`, after the `tab_question*` member:

```ts
  /** A tab shows a suggestion, or it was sent, dismissed or left the screen: the whole card each time. */
  | { type: 'tab_suggestion' | 'tab_suggestion_closed'; suggestion: TabSuggestion; conversation_id?: string };
```

`apps/web/src/lib/api.ts` — add `TabSuggestion` to the big type import; in `chat`'s response type add `tab_suggestions?: TabSuggestion[]`; after `tabQuestionScreen`:

```ts
  /** Sends a tab's suggestion, as edited (409 `TAB_PROMPT_CHANGED` when the tab's prompt changed). */
  sendTabSuggestion: (id: string, text: string) => request<{ tab_suggestion: TabSuggestion }>('POST', `/chat/tab-suggestions/${encodeURIComponent(id)}/send`, { text }),
  /** "Dispensar": closes the card; the tab is not touched. */
  dismissTabSuggestion: (id: string) => request<{ tab_suggestion: TabSuggestion }>('POST', `/chat/tab-suggestions/${encodeURIComponent(id)}/dismiss`, {}),
```

`apps/web/src/lib/chat-timeline.ts`:

```ts
import type { ChatAction, ChatMessage, TabQuestion, TabSuggestion } from './types';

export type ChatEntry =
  | { kind: 'message'; at: string; message: ChatMessage }
  | { kind: 'action'; at: string; action: ChatAction }
  | { kind: 'tab_question'; at: string; question: TabQuestion }
  | { kind: 'tab_suggestion'; at: string; suggestion: TabSuggestion };
```

signature `export function chatTimeline(messages: ChatMessage[], actions: ChatAction[], tabQuestions: TabQuestion[] = [], tabSuggestions: TabSuggestion[] = []): ChatEntry[]`; after `visibleQuestions`:

```ts
  const visibleSuggestions = oldestMessageAt === null ? tabSuggestions : tabSuggestions.filter((s) => s.created_at >= oldestMessageAt);
```

and in `entries`, after the questions:

```ts
    ...visibleSuggestions.map((suggestion): ChatEntry => ({ kind: 'tab_suggestion', at: suggestion.created_at, suggestion })),
```

(The sort's comment becomes "A card (a gate card, a tab's question or suggestion) reads after the message of the same instant".)

Create `apps/web/src/components/chat/tab-suggestion-text.ts`:

```ts
import type { TabSuggestion } from '../../lib/types';

/** What `409 TAB_PROMPT_CHANGED` reads as on a suggestion card. */
export const SUGGESTION_CHANGED_TEXT = 'A sugestão mudou na aba';

/** Why the text did not reach the tab, by the code the server stored. */
const FAILURE_TEXT: Record<string, string> = {
  MACHINE_OFFLINE: 'a máquina está offline',
  AGENT_OUTDATED: 'o agente da máquina está desatualizado',
};

export const suggestionTitle = (s: TabSuggestion): string => (s.tab_name ? `«${s.tab_name}» sugere:` : 'Uma aba sugere:');

export function suggestionStatusLabel(s: TabSuggestion): string {
  switch (s.status) {
    case 'open':
      return '';
    case 'answered':
      return 'Enviada';
    case 'dismissed':
      return 'Dispensada';
    case 'answered_in_tab':
      return 'Respondida na aba';
    case 'expired':
      return 'Expirada';
    case 'failed':
      return `Falhou — ${FAILURE_TEXT[s.error_code ?? ''] ?? 'não foi possível digitar na aba'}`;
  }
}

/** Every event carries the whole card: replace it by id, or append it. */
export function upsertTabSuggestion(list: TabSuggestion[], s: TabSuggestion): TabSuggestion[] {
  return list.some((x) => x.id === s.id) ? list.map((x) => (x.id === s.id ? s : x)) : [...list, s];
}
```

Create `apps/web/src/components/chat/TabSuggestionCard.tsx`:

```tsx
import { useState } from 'react';
import type { TabSuggestion } from '../../lib/types';
import { suggestionStatusLabel, suggestionTitle } from './tab-suggestion-text';

export interface TabSuggestionCardProps {
  suggestion: TabSuggestion;
  /** This card's send or dismiss is in flight: every control is disabled. */
  busy: boolean;
  /** Why the last send or dismiss did not go through (pt-BR). */
  error?: string | null;
  onSend: (text: string) => void;
  onDismiss: () => void;
}

/**
 * Claude Code's dimmed next prompt in a tab, inline in the thread (spec 2026-09-25 tab suggestions §6.4):
 * the text editable, Enviar / Dispensar. Presentational: the requests live in `ChatPanel`. Plain text only.
 */
export function TabSuggestionCard({ suggestion, busy, error, onSend, onDismiss }: TabSuggestionCardProps) {
  const [text, setText] = useState(suggestion.payload.text);
  const open = suggestion.status === 'open';
  const trimmed = text.trim();
  return (
    <li className="rounded-xl border border-accent/40 bg-bg-2 px-4 py-3 text-sm">
      <p className="font-medium text-fg">{suggestionTitle(suggestion)}</p>
      {open ? (
        <>
          <label className="mt-2 block text-xs text-fg-dim">
            Texto da sugestão
            <input type="text" className="input mt-1" maxLength={2000} value={text} disabled={busy} onChange={(e) => setText(e.target.value)} />
          </label>
          <div className="mt-2 flex gap-2">
            <button type="button" className="btn-primary" disabled={busy || !trimmed} onClick={() => onSend(trimmed)}>
              Enviar
            </button>
            <button type="button" className="btn-ghost" disabled={busy} onClick={onDismiss}>
              Dispensar
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="mt-1 whitespace-pre-wrap text-fg">{suggestion.answer?.text ?? suggestion.payload.text}</p>
          <p className="mt-1 text-xs text-fg-dim">{suggestionStatusLabel(suggestion)}</p>
        </>
      )}
      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
    </li>
  );
}
```

`apps/web/src/components/chat/ChatPanel.tsx`:

- imports: `import { TabSuggestionCard } from './TabSuggestionCard';`, `import { SUGGESTION_CHANGED_TEXT, upsertTabSuggestion } from './tab-suggestion-text';`, and `TabSuggestion` in the `../../lib/types` import.
- state, after `questionErrors`:

```tsx
  /** The tabs' suggestions of this conversation (spec 2026-09-25 tab suggestions §6.4), from `GET /api/chat` and their two events. */
  const [tabSuggestions, setTabSuggestions] = useState<TabSuggestion[]>([]);
  const [busySuggestionId, setBusySuggestionId] = useState<string | null>(null);
  const [suggestionErrors, setSuggestionErrors] = useState<Record<string, string>>({});
```

- `load`: destructure `tab_suggestions` too and `setTabSuggestions(tab_suggestions ?? []);` after `setTabQuestions(…)`.
- `onEvent`, after the `tab_question*` branch:

```tsx
      else if (e.type === 'tab_suggestion' || e.type === 'tab_suggestion_closed') setTabSuggestions((prev) => upsertTabSuggestion(prev, e.suggestion));
```

- after `loadTabQuestionScreen`:

```tsx
  /** Enviar / Dispensar on a suggestion card: one click, no confirmation, no model turn. */
  const actOnSuggestion = async (id: string, act: () => Promise<{ tab_suggestion: TabSuggestion }>, fallback: string) => {
    setBusySuggestionId(id);
    setSuggestionErrors(({ [id]: _dropped, ...rest }) => rest);
    try {
      const { tab_suggestion } = await act();
      setTabSuggestions((prev) => upsertTabSuggestion(prev, tab_suggestion));
    } catch (e) {
      const text = e instanceof ApiError && e.code === 'TAB_PROMPT_CHANGED' ? SUGGESTION_CHANGED_TEXT : e instanceof ApiError ? e.message : fallback;
      setSuggestionErrors((prev) => ({ ...prev, [id]: text }));
    } finally {
      setBusySuggestionId(null);
    }
  };
```

- `timeline`: `useMemo(() => chatTimeline(messages, actions, tabQuestions, tabSuggestions), [messages, actions, tabQuestions, tabSuggestions])`.
- reset handler, after `setQuestionErrors({});`: `setTabSuggestions([]); setSuggestionErrors({});`.
- in `timeline.map`, before the `tab_question` branch:

```tsx
          if (entry.kind === 'tab_suggestion') {
            const s = entry.suggestion;
            return (
              <TabSuggestionCard
                key={`s:${s.id}`}
                suggestion={s}
                busy={busySuggestionId === s.id}
                error={suggestionErrors[s.id]}
                onSend={(text) => void actOnSuggestion(s.id, () => api.sendTabSuggestion(s.id, text), 'Não foi possível enviar')}
                onDismiss={() => void actOnSuggestion(s.id, () => api.dismissTabSuggestion(s.id), 'Não foi possível dispensar')}
              />
            );
          }
```

- [ ] **Step 4: Run tests and the build**

Run: `NODE 'npm test -w @termhub/web && npm run build -w @termhub/web'`
Expected: PASS, build OK.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/types.ts apps/web/src/lib/api.ts apps/web/src/lib/chat-timeline.ts apps/web/src/lib/chat-timeline.test.ts apps/web/src/components/chat/tab-suggestion-text.ts apps/web/src/components/chat/TabSuggestionCard.tsx apps/web/src/components/chat/TabSuggestionCard.test.tsx apps/web/src/components/chat/ChatPanel.tsx apps/web/src/components/chat/ChatPanel.test.tsx
git commit -F - <<'MSG'
Web: suggestion cards in the chat

«tab» sugere: with the text editable, Enviar and Dispensar, in the
thread by created_at; the card follows its two live events and says
how it ended.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
MSG
```

---

### Task 7: App mobile: contrato/cliente, mock, reducer, timeline, store, card, tela

**Files:**
- Modify: `packages/mobile-api/src/chat.ts` (`tabSuggestionSendBody`)
- Modify: `apps/mobile/src/services/api/contract/local.ts`; Test: `apps/mobile/src/services/api/contract/local.test.ts`
- Modify: `apps/mobile/src/services/api/types.ts`, `apps/mobile/src/services/api/client.ts`
- Modify: `apps/mobile/src/services/api/mock/state.ts`, `apps/mobile/src/services/api/mock/handlers/chat.ts`; Test: `apps/mobile/src/services/api/mock/chat.e2e.test.ts`
- Modify: `apps/mobile/src/features/chat/model/types.ts`, `model/events.ts`, `model/timeline.ts`, `model/messages.ts`; Create: `model/tab-suggestion-text.ts`
- Test: `apps/mobile/src/features/chat/model/events.test.ts`, `model/timeline.test.ts`
- Modify: `apps/mobile/src/features/chat/viewmodel/createChatStore.ts`; Test: `viewmodel/createChatStore.test.ts`
- Create: `apps/mobile/src/features/chat/view/tab-suggestion-card.tsx`; Modify: `view/conversation-screen.tsx`; Test: `view/conversation-screen.test.tsx`

**Interfaces:**
- Consumes: `tabSuggestionSchema` and the two events (Task 4), the mobile routes (Task 5).
- Produces: `tabSuggestionSendBody = z.object({ text: z.string().trim().min(1).max(2000) })`; `TTabSuggestion`, `TTabSuggestionSendBody`; `chatResponse.tab_suggestions` (default `[]`); `MobileApi.sendTabSuggestion(auth, suggestionId, body): Promise<void>`, `MobileApi.dismissTabSuggestion(auth, suggestionId): Promise<void>`; `TabSuggestion` (model type); `EventSlice.tabSuggestions`, `upsertTabSuggestion`; `chatTimeline(messages, actions, tabQuestions = [], tabSuggestions = [])`; store `busySuggestionId`, `sendTabSuggestion(id, text)`, `dismissTabSuggestion(id)`; `CHAT_MSG.tabSuggestionChanged = 'A sugestão mudou na aba'`; `TabSuggestionCard` (testID `tab-suggestion-<id>`).

- [ ] **Step 1: Write the failing tests**

`apps/mobile/src/services/api/contract/local.test.ts` — the fixture gains `tab_suggestions: []` (`const fixture = { conversation, messages: [], actions: [], grants: [], tab_questions: [], tab_suggestions: [], host: readyHost };`) and append inside `describe('chatResponse', …)`:

```ts
  it('defaults tab_suggestions to empty when an older server sends none', () => {
    const { tab_suggestions: _tabSuggestions, ...withoutTabSuggestions } = fixture;
    expect(chatResponse.parse(withoutTabSuggestions)).toEqual(fixture);
  });
```

`apps/mobile/src/features/chat/model/events.test.ts` — `empty` gains `tabSuggestions: []`; import `TabSuggestion` from `./types`; append:

```ts
it('tab suggestion events upsert the card by id and never ask for a re-read', () => {
  const s = { id: 's1', tab_id: 't1', tab_name: 'api', kind: 'suggestion', payload: { text: 'commit it' }, status: 'open', answer: null, error_code: null, created_at: at, answered_at: null, closed_at: null } as TabSuggestion;
  const opened = applyEvent(empty, { type: 'tab_suggestion', ...base, suggestion: s });
  expect(opened).toEqual({ slice: { ...empty, tabSuggestions: [s] }, reread: false });
  const sent = { ...s, status: 'answered', answer: { text: 'commit it' } } as TabSuggestion;
  expect(applyEvent(opened.slice, { type: 'tab_suggestion_closed', ...base, suggestion: sent }).slice.tabSuggestions).toEqual([sent]);
});
```

`apps/mobile/src/features/chat/model/timeline.test.ts` — import `TabSuggestion`; inside `describe('chatTimeline', …)` append:

```ts
  it('places a tab suggestion by created_at, after the message of the same instant, inside the message window', () => {
    const s = { id: 's1', tab_id: 't1', tab_name: 'api', kind: 'suggestion', payload: { text: 'commit it' }, status: 'open', answer: null, error_code: null, created_at: T1, answered_at: null, closed_at: null } as TabSuggestion;
    const entries = chatTimeline([message({ id: 'm1', created_at: T0 }), message({ id: 'm2', created_at: T1 })], [], [], [s, { ...s, id: 's0', created_at: '2025-12-31T23:59:00.000Z' } as TabSuggestion]);
    expect(entries.map((e) => (e.kind === 'tab_suggestion' ? e.suggestion.id : e.kind))).toEqual(['message', 'message', 's1']);
  });
```

`apps/mobile/src/services/api/mock/chat.e2e.test.ts` — append:

```ts
it('a message containing sugestão raises a tab suggestion; sending it once works, twice is 409; dismissing is idempotent', async () => {
  const clock = { value: START };
  const { api, auth } = await enrol(clock);
  const collected = collectEvents(api, auth);
  await jest.advanceTimersByTimeAsync(0);

  await api.sendMessage(auth, { text: 'alguma sugestão?', project_id: 'p-termhub' });
  await jest.advanceTimersByTimeAsync(5000);
  const opened = collected.events.find((e): e is Extract<TChatEvent, { type: 'tab_suggestion' }> => e.type === 'tab_suggestion');
  expect(opened?.suggestion).toMatchObject({ kind: 'suggestion', status: 'open', tab_name: 'api', payload: { text: 'commit it' } });
  const id = opened!.suggestion.id;
  expect((await api.chat(auth, 'p-termhub')).tab_suggestions.map((s) => s.id)).toContain(id);
  expect((await api.chat(auth, 'p-termhub')).tab_questions.map((q) => q.id)).not.toContain(id);

  await api.sendTabSuggestion(auth, id, { text: 'commit it and push' });
  await jest.advanceTimersByTimeAsync(0);
  expect(collected.events.some((e) => e.type === 'tab_suggestion_closed' && e.suggestion.id === id && e.suggestion.status === 'answered')).toBe(true);
  await expect(api.sendTabSuggestion(auth, id, { text: 'commit it' })).rejects.toMatchObject({ status: 409, code: 'TAB_PROMPT_CHANGED' });
  await api.dismissTabSuggestion(auth, id); // already sent: stays sent, no error
  expect((await api.chat(auth, 'p-termhub')).tab_suggestions.find((s) => s.id === id)).toMatchObject({ status: 'answered', answer: { text: 'commit it and push' } });
  await expect(api.dismissTabSuggestion(auth, 'nope')).rejects.toMatchObject({ status: 404 });
  collected.close();
});
```

`apps/mobile/src/features/chat/viewmodel/createChatStore.test.ts` — the persisted-keys expectation (line ~405) becomes `['actions', 'conversation', 'grants', 'host', 'messages', 'tabQuestions', 'tabSuggestions']`; append:

```ts
it('sendTabSuggestion sends over the mock and the card reads as sent; a second send reads "A sugestão mudou na aba"', async () => {
  const { chat } = await setup();
  await openAndConnect(chat, 'p-termhub');
  await chat.getState().send('alguma sugestão?');
  await jest.advanceTimersByTimeAsync(5000);
  const s = slot(chat, 'p-termhub').tabSuggestions.find((x) => x.status === 'open')!;
  expect(s).toMatchObject({ kind: 'suggestion', tab_name: 'api', payload: { text: 'commit it' } });

  await chat.getState().sendTabSuggestion(s.id, 'commit it and push');
  await jest.advanceTimersByTimeAsync(0);
  await flush();
  expect(slot(chat, 'p-termhub').tabSuggestions.find((x) => x.id === s.id)).toMatchObject({ status: 'answered', answer: { text: 'commit it and push' } });
  expect(chat.getState().busySuggestionId).toBeNull();

  await chat.getState().sendTabSuggestion(s.id, 'commit it');
  expect(chat.getState().error).toBe('A sugestão mudou na aba');
});

it('dismissTabSuggestion closes the card as dismissed', async () => {
  const { chat } = await setup();
  await openAndConnect(chat, 'p-termhub');
  await chat.getState().send('alguma sugestão?');
  await jest.advanceTimersByTimeAsync(5000);
  const s = slot(chat, 'p-termhub').tabSuggestions.find((x) => x.status === 'open')!;
  await chat.getState().dismissTabSuggestion(s.id);
  await jest.advanceTimersByTimeAsync(0);
  await flush();
  expect(slot(chat, 'p-termhub').tabSuggestions.find((x) => x.id === s.id)?.status).toBe('dismissed');
});
```

`apps/mobile/src/features/chat/view/conversation-screen.test.tsx` — import `TTabSuggestion` with the other contract types; extend `stubAction`'s union to `'decide' | 'reset' | 'setHost' | 'revokeGrant' | 'answerTabQuestion' | 'sendTabSuggestion' | 'dismissTabSuggestion'`; in `afterEach`'s `setState` add `sendTabSuggestion: realActions.sendTabSuggestion, dismissTabSuggestion: realActions.dismissTabSuggestion,`; and inside `describe('Conversa', …)` append:

```tsx
  const OPEN_SUGGESTION = { id: 's1', tab_id: 't-api', tab_name: 'api', kind: 'suggestion', payload: { text: 'commit it' }, status: 'open', answer: null, error_code: null, created_at: new Date().toISOString(), answered_at: null, closed_at: null } as TTabSuggestion;

  /** Serves the open project's `GET chat` with these tab suggestions. */
  function serveSuggestions(suggestions: TTabSuggestion[]) {
    const real = stores.api.chat.bind(stores.api);
    jest.spyOn(stores.api, 'chat').mockImplementation(async (auth, projectId) => {
      const res = await real(auth, projectId);
      return projectId === 'p-termhub' ? { ...res, tab_suggestions: suggestions } : res;
    });
  }

  it("renders a tab's suggestion; Enviar sends the edited text, Dispensar dismisses", async () => {
    serveSuggestions([OPEN_SUGGESTION]);
    const sendSuggestion = stubAction('sendTabSuggestion');
    const dismissSuggestion = stubAction('dismissTabSuggestion');
    await render(<ConversationScreen />);
    expect(await screen.findByText('«api» sugere:', undefined, LOAD)).toBeTruthy();
    await fireEvent.changeText(screen.getByLabelText('Texto da sugestão'), '  commit it and push ');
    // Scoped to the card: the composer has its own "Enviar" button on screen at the same time.
    await fireEvent.press(within(screen.getByTestId('tab-suggestion-s1')).getByRole('button', { name: 'Enviar' }));
    expect(sendSuggestion).toHaveBeenCalledWith('s1', 'commit it and push');
    await fireEvent.press(screen.getByRole('button', { name: 'Dispensar' }));
    expect(dismissSuggestion).toHaveBeenCalledWith('s1');
  });

  it.each([
    [{ ...OPEN_SUGGESTION, status: 'answered', answer: { text: 'commit it and push' } } as TTabSuggestion, ['commit it and push', 'Enviada']],
    [{ ...OPEN_SUGGESTION, status: 'dismissed' } as TTabSuggestion, ['Dispensada']],
    [{ ...OPEN_SUGGESTION, status: 'answered_in_tab' } as TTabSuggestion, ['Respondida na aba']],
  ])('a closed suggestion is read-only and says how it ended (%#)', async (s, texts) => {
    serveSuggestions([s]);
    await render(<ConversationScreen />);
    for (const t of texts) expect(await screen.findByText(t, undefined, LOAD)).toBeTruthy();
    expect(screen.queryByLabelText('Texto da sugestão')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Dispensar' })).toBeNull();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `NODE 'npm run build -w @termhub/mobile-api && npm test -w @termhub/mobile -- src/services/api src/features/chat'`
Expected: FAIL — `tab_suggestions` is not in `chatResponse`; `api.sendTabSuggestion` is not a function; `applyEvent` ignores `tab_suggestion`; no card on screen.

- [ ] **Step 3: Contract, client, mock**

`packages/mobile-api/src/chat.ts` — append:

```ts
/** `POST chat/tab-suggestions/:id/send`: the text to type, as edited. The server is the judge of the rest
 * (one line, no control characters, no leading "!" or "/"). No PIN (spec 2026-09-25 tab suggestions §2). */
export const tabSuggestionSendBody = z.object({ text: z.string().trim().min(1).max(2000) });
```

Rebuild: `NODE 'npm test -w @termhub/mobile-api && npm run build -w @termhub/mobile-api'`.

`apps/mobile/src/services/api/contract/local.ts` — import `tabSuggestionSchema` and `tabSuggestionSendBody` from `@termhub/mobile-api`; in `chatResponse` after `tab_questions`: `tab_suggestions: z.array(tabSuggestionSchema).default([]),`; types after `TTabQuestionScreenResponse`:

```ts
export type TTabSuggestion = z.infer<typeof tabSuggestionSchema>;
export type TTabSuggestionSendBody = z.infer<typeof tabSuggestionSendBody>;
```

`apps/mobile/src/services/api/types.ts` — import `TTabSuggestionSendBody`; after `tabQuestionScreen`:

```ts
  /** Sends a tab's suggestion, as edited — no PIN. 409 `TAB_PROMPT_CHANGED` when the tab's prompt changed, 404 unknown. */
  sendTabSuggestion(auth: Auth, suggestionId: string, body: TTabSuggestionSendBody): Promise<void>;
  /** "Dispensar": closes the card, the tab is not touched. Idempotent; 404 unknown. */
  dismissTabSuggestion(auth: Auth, suggestionId: string): Promise<void>;
```

`apps/mobile/src/services/api/client.ts` — import `type TTabSuggestionSendBody`; after `tabQuestionScreen`:

```ts
    sendTabSuggestion: (a: Auth, id: string, body: TTabSuggestionSendBody) =>
      empty('POST', `/api/m/v1/chat/tab-suggestions/${encodeURIComponent(id)}/send`, { token: a.accessToken, body }),
    dismissTabSuggestion: (a: Auth, id: string) => empty('POST', `/api/m/v1/chat/tab-suggestions/${encodeURIComponent(id)}/dismiss`, { token: a.accessToken, body: {} }),
```

`apps/mobile/src/services/api/mock/state.ts` — import `TTabSuggestion`; after `MockTabQuestion`:

```ts
/** A tab's suggestion (spec 2026-09-25 tab suggestions): the wire shape plus the conversation it was pushed into. */
export type MockTabSuggestion = TTabSuggestion & { conversation_id: string };
```

in `MockState` after `tabQuestions`: `/** Oldest first; closed rows stay (a second send is a 409, as on the server). */ tabSuggestions: MockTabSuggestion[];`, and `tabSuggestions: [],` in `createMockState`.

`apps/mobile/src/services/api/mock/handlers/chat.ts` — import `tabSuggestionSendBody`, `type TTabSuggestion` from `../../contract` and `type MockTabSuggestion` from `../state`. After `tabQuestionScreenText`:

```ts
// --- tab suggestions (spec 2026-09-25 tab suggestions §6) -------------------------------------------

function tabSuggestionView(s: MockTabSuggestion): TTabSuggestion {
  const { conversation_id: _conversation, ...view } = s;
  return view as TTabSuggestion;
}

/** The canned suggestion a `sugest…` message makes the tab `api` show. */
function createTabSuggestion(state: MockState, now: number, conversationId: string): MockTabSuggestion {
  const suggestion: MockTabSuggestion = { id: randomId(10), conversation_id: conversationId, tab_id: 't-api', tab_name: 'api', kind: 'suggestion', payload: { text: 'commit it' }, status: 'open', answer: null, error_code: null, created_at: new Date(now).toISOString(), answered_at: null, closed_at: null };
  state.tabSuggestions.push(suggestion);
  return suggestion;
}
```

`AnswerOutcome.kind` gains `'tab_suggestion'`; in `pickAnswer`, after the `permiss` line:

```ts
  if (/sugest/.test(text)) return { kind: 'tab_suggestion', text: 'A aba api sugere um próximo passo — veja o card.' };
```

in the run, after the `tab_question`/`tab_permission` block:

```ts
      if (outcome.kind === 'tab_suggestion') {
        const suggestion = createTabSuggestion(o.state, o.now(), o.conversationId);
        broadcast(o.state, { type: 'tab_suggestion', user_id: USER_ID, conversation_id: o.conversationId, suggestion: tabSuggestionView(suggestion) });
      }
```

in `GET /api/m/v1/chat`'s body after `tab_questions`: `tab_suggestions: state.tabSuggestions.filter((s) => s.conversation_id === conversation.id).map(tabSuggestionView),`; and after the `tab-questions/:id/screen` route:

```ts
  /** Sends a tab's suggestion (no PIN): 404 unknown, 409 once it is not open. */
  router.route('POST', '/api/m/v1/chat/tab-suggestions/:id/send', (ctx) => {
    verifyAuth(state, { headers: ctx.headers, htm: 'POST', htu: ctx.htu, now: ctx.now() });
    const suggestion = state.tabSuggestions.find((s) => s.id === ctx.params.id);
    if (!suggestion) throw new WireError(404, 'NOT_FOUND', 'Sugestão não encontrada');
    if (suggestion.status !== 'open') throw new WireError(409, 'TAB_PROMPT_CHANGED', 'A sugestão mudou na aba');
    const body = tabSuggestionSendBody.parse(ctx.body);
    Object.assign(suggestion, { status: 'answered', answer: { text: body.text }, answered_at: new Date(ctx.now()).toISOString() });
    const view = tabSuggestionView(suggestion);
    broadcast(state, { type: 'tab_suggestion_closed', user_id: USER_ID, conversation_id: suggestion.conversation_id, suggestion: view });
    return { status: 200, body: { tab_suggestion: view } };
  });

  /** "Dispensar": idempotent — a suggestion that is not open any more comes back as it is. */
  router.route('POST', '/api/m/v1/chat/tab-suggestions/:id/dismiss', (ctx) => {
    verifyAuth(state, { headers: ctx.headers, htm: 'POST', htu: ctx.htu, now: ctx.now() });
    const suggestion = state.tabSuggestions.find((s) => s.id === ctx.params.id);
    if (!suggestion) throw new WireError(404, 'NOT_FOUND', 'Sugestão não encontrada');
    if (suggestion.status === 'open') {
      Object.assign(suggestion, { status: 'dismissed', closed_at: new Date(ctx.now()).toISOString() });
      broadcast(state, { type: 'tab_suggestion_closed', user_id: USER_ID, conversation_id: suggestion.conversation_id, suggestion: tabSuggestionView(suggestion) });
    }
    return { status: 200, body: { tab_suggestion: tabSuggestionView(suggestion) } };
  });
```

- [ ] **Step 4: Model, store, card, screen**

`apps/mobile/src/features/chat/model/types.ts` — add `TTabSuggestion` to the contract import and:

```ts
/** Claude Code's dimmed next prompt in a tab (spec 2026-09-25 tab suggestions). */
export type TabSuggestion = TTabSuggestion;
```

`apps/mobile/src/features/chat/model/messages.ts` — add `tabSuggestionChanged: 'A sugestão mudou na aba',`.

`apps/mobile/src/features/chat/model/tab-suggestion-text.ts` (new; no `SUGGESTION_CHANGED_TEXT` here: the store says it through `CHAT_MSG.tabSuggestionChanged`):

```ts
// Copied from apps/web/src/components/chat/tab-suggestion-text.ts — keep the two in step (same pt-BR copy).
import type { TabSuggestion } from './types';

/** Why the text did not reach the tab, by the code the server stored. */
const FAILURE_TEXT: Record<string, string> = {
  MACHINE_OFFLINE: 'a máquina está offline',
  AGENT_OUTDATED: 'o agente da máquina está desatualizado',
};

export const suggestionTitle = (s: TabSuggestion): string => (s.tab_name ? `«${s.tab_name}» sugere:` : 'Uma aba sugere:');

export function suggestionStatusLabel(s: TabSuggestion): string {
  switch (s.status) {
    case 'open':
      return '';
    case 'answered':
      return 'Enviada';
    case 'dismissed':
      return 'Dispensada';
    case 'answered_in_tab':
      return 'Respondida na aba';
    case 'expired':
      return 'Expirada';
    case 'failed':
      return `Falhou — ${FAILURE_TEXT[s.error_code ?? ''] ?? 'não foi possível digitar na aba'}`;
  }
}

/** Every event carries the whole card: replace it by id, or append it. */
export function upsertTabSuggestion(list: TabSuggestion[], s: TabSuggestion): TabSuggestion[] {
  return list.some((x) => x.id === s.id) ? list.map((x) => (x.id === s.id ? s : x)) : [...list, s];
}
```

`apps/mobile/src/features/chat/model/events.ts` — import `TabSuggestion` and `upsertTabSuggestion` (`import { upsertTabSuggestion } from './tab-suggestion-text';`); `EventSlice` gains:

```ts
  /** The tabs' suggestions pushed into this conversation (spec 2026-09-25 tab suggestions §6.4). */
  tabSuggestions: TabSuggestion[];
```

and `applyEvent` gains, after the `tab_question*` case:

```ts
    case 'tab_suggestion':
    case 'tab_suggestion_closed':
      return { slice: { ...slice, tabSuggestions: upsertTabSuggestion(slice.tabSuggestions, e.suggestion) }, reread: false };
```

`apps/mobile/src/features/chat/model/timeline.ts` (the copy of the web's module, kept line for line):

```ts
import type { ChatAction, ChatMessage, TabQuestion, TabSuggestion } from './types';

export type ChatEntry =
  | { kind: 'message'; at: string; message: ChatMessage }
  | { kind: 'action'; at: string; action: ChatAction }
  | { kind: 'tab_question'; at: string; question: TabQuestion }
  | { kind: 'tab_suggestion'; at: string; suggestion: TabSuggestion };
```

signature `export function chatTimeline(messages: ChatMessage[], actions: ChatAction[], tabQuestions: TabQuestion[] = [], tabSuggestions: TabSuggestion[] = []): ChatEntry[]`; after `visibleQuestions`:

```ts
  const visibleSuggestions = oldestMessageAt === null ? tabSuggestions : tabSuggestions.filter((s) => s.created_at >= oldestMessageAt);
```

and in `entries`, after the questions:

```ts
    ...visibleSuggestions.map((suggestion): ChatEntry => ({ kind: 'tab_suggestion', at: suggestion.created_at, suggestion })),
```

`apps/mobile/src/features/chat/viewmodel/createChatStore.ts`:

- `ConversationSlot` gains `/** The tabs' suggestions pushed into this conversation. */ tabSuggestions: TabSuggestion[];` (import `TabSuggestion` from `../model/types`).
- `ChatState` gains:

```ts
  /** The tab suggestion whose send or dismiss is in flight. */
  busySuggestionId: string | null;
  /** Sends a tab's suggestion, as edited — no PIN. A suggestion the tab moved past (409) says so and re-reads. */
  sendTabSuggestion(suggestionId: string, text: string): Promise<void>;
  /** "Dispensar": the card closes; the tab is not touched. */
  dismissTabSuggestion(suggestionId: string): Promise<void>;
```

- `PersistedSlot` picks `'tabSuggestions'` too; `initialData` gets `busySuggestionId: null`; `emptySlot` gets `tabSuggestions: []`.
- `reread`'s patch: `tabSuggestions: res.tab_suggestions,` after `tabQuestions`.
- `onEvent`: `before` includes `tabSuggestions: current.tabSuggestions`, and `patchSlot` writes `tabSuggestions: slice.tabSuggestions` too.
- before `return {` of the store body:

```ts
        /** Enviar / Dispensar share one flow: one at a time, the event brings the card, a 409 re-reads. */
        const actOnSuggestion = async (suggestionId: string, call: () => Promise<void>): Promise<void> => {
          const projectId = get().activeProject;
          if (projectId === undefined || get().busySuggestionId !== null) return;
          const key = keyOf(projectId);
          const gen = generation;
          set({ busySuggestionId: suggestionId, error: null });
          try {
            await call();
            // The `tab_suggestion_closed` event brings the card; the re-read covers a socket that is down.
            if (gen === generation) void reread(key);
          } catch (e) {
            if (gen !== generation) return;
            if (isApiError(e, 'TAB_PROMPT_CHANGED')) {
              set({ error: CHAT_MSG.tabSuggestionChanged });
              void reread(key); // show how it ended
            } else {
              fail(gen, e);
            }
          } finally {
            if (gen === generation) set({ busySuggestionId: null });
          }
        };
```

- in the returned object, after `loadTabQuestionScreen`:

```ts
          sendTabSuggestion(suggestionId, text) {
            return actOnSuggestion(suggestionId, () => api.sendTabSuggestion(session().auth(), suggestionId, { text }));
          },

          dismissTabSuggestion(suggestionId) {
            return actOnSuggestion(suggestionId, () => api.dismissTabSuggestion(session().auth(), suggestionId));
          },
```

- `close()` sets `busySuggestionId: null` too; `reset()`'s patch adds `tabSuggestions: []`; `partialize` writes `tabSuggestions: c.tabSuggestions`.

Create `apps/mobile/src/features/chat/view/tab-suggestion-card.tsx`:

```tsx
import { memo, useState } from 'react';
import { TextInput, View } from 'react-native';
import { AppText, Button } from '@/ui';
import { suggestionStatusLabel, suggestionTitle } from '../model/tab-suggestion-text';
import type { TabSuggestion } from '../model/types';

type Props = {
  suggestion: TabSuggestion;
  /** A send or dismiss (this card's or another's) is in flight. */
  busy: boolean;
  onSend(suggestionId: string, text: string): void;
  onDismiss(suggestionId: string): void;
};

const INPUT = 'rounded-xl border border-app-border bg-app-surface px-4 py-3 text-base text-app-text placeholder:text-app-muted';

/** Claude Code's dimmed next prompt in a tab (spec 2026-09-25 tab suggestions §6.4), the web card's twin:
 * the text editable, Enviar / Dispensar — no PIN. Memoised: `onSend` and `onDismiss` are stable. */
export const TabSuggestionCard = memo(function TabSuggestionCard({ suggestion, busy, onSend, onDismiss }: Props) {
  const [text, setText] = useState(suggestion.payload.text);
  const open = suggestion.status === 'open';
  const trimmed = text.trim();
  return (
    // The testID tells this card's "Enviar" from the composer's, both on screen at once.
    <View testID={`tab-suggestion-${suggestion.id}`} className="gap-3 rounded-2xl border border-app-accent bg-app-surface2 p-4">
      <AppText variant="label">{suggestionTitle(suggestion)}</AppText>
      {open ? (
        <View className="gap-2">
          <TextInput accessibilityLabel="Texto da sugestão" value={text} maxLength={2000} editable={!busy} onChangeText={setText} className={INPUT} />
          <View className="flex-row gap-2">
            <View className="flex-1">
              <Button label="Enviar" onPress={() => onSend(suggestion.id, trimmed)} disabled={busy || !trimmed} />
            </View>
            <View className="flex-1">
              <Button label="Dispensar" variant="secondary" onPress={() => onDismiss(suggestion.id)} disabled={busy} />
            </View>
          </View>
        </View>
      ) : (
        <View className="gap-1">
          <AppText>{suggestion.answer?.text ?? suggestion.payload.text}</AppText>
          <AppText variant="muted">{suggestionStatusLabel(suggestion)}</AppText>
        </View>
      )}
    </View>
  );
});
```

`apps/mobile/src/features/chat/view/conversation-screen.tsx`:

- `import { TabSuggestionCard } from './tab-suggestion-card';`
- `entryKey`: `entry.kind === 'message' ? \`m:${entry.message.id}\` : entry.kind === 'action' ? \`a:${entry.action.id}\` : entry.kind === 'tab_suggestion' ? \`s:${entry.suggestion.id}\` : \`q:${entry.question.id}\``
- selectors: `const busySuggestionId = useChatStore((s) => s.busySuggestionId); const sendTabSuggestion = useChatStore((s) => s.sendTabSuggestion); const dismissTabSuggestion = useChatStore((s) => s.dismissTabSuggestion);`
- `const tabSuggestions = slot?.tabSuggestions;`; `extra` includes `busySuggestionId` (in the object and the deps); callbacks:

```tsx
  const onSendSuggestion = useCallback((id: string, text: string) => void sendTabSuggestion(id, text), [sendTabSuggestion]);
  const onDismissSuggestion = useCallback((id: string) => void dismissTabSuggestion(id), [dismissTabSuggestion]);
```

- `entries`: `chatTimeline(messages ?? [], actions ?? [], tabQuestions ?? [], tabSuggestions ?? []).reverse()` with `tabSuggestions` in the deps.
- `renderItem`: first branch

```tsx
              item.kind === 'tab_suggestion' ? (
                <TabSuggestionCard suggestion={item.suggestion} busy={busySuggestionId !== null} onSend={onSendSuggestion} onDismiss={onDismissSuggestion} />
              ) : item.kind === 'tab_question' ? (
```

- [ ] **Step 5: Run tests and the typecheck**

Run: `NODE 'npm run build -w @termhub/mobile-api && npm test -w @termhub/mobile && npm run typecheck -w @termhub/mobile'`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/mobile-api/src/chat.ts apps/mobile/src/services/api/contract/local.ts apps/mobile/src/services/api/contract/local.test.ts apps/mobile/src/services/api/types.ts apps/mobile/src/services/api/client.ts apps/mobile/src/services/api/mock/state.ts apps/mobile/src/services/api/mock/handlers/chat.ts apps/mobile/src/services/api/mock/chat.e2e.test.ts apps/mobile/src/features/chat/model/types.ts apps/mobile/src/features/chat/model/messages.ts apps/mobile/src/features/chat/model/tab-suggestion-text.ts apps/mobile/src/features/chat/model/events.ts apps/mobile/src/features/chat/model/events.test.ts apps/mobile/src/features/chat/model/timeline.ts apps/mobile/src/features/chat/model/timeline.test.ts apps/mobile/src/features/chat/viewmodel/createChatStore.ts apps/mobile/src/features/chat/viewmodel/createChatStore.test.ts apps/mobile/src/features/chat/view/tab-suggestion-card.tsx apps/mobile/src/features/chat/view/conversation-screen.tsx apps/mobile/src/features/chat/view/conversation-screen.test.tsx
git commit -F - <<'MSG'
Mobile: suggestion cards in the chat

The app's twin of the web card: «tab» sugere: with the text editable,
Enviar and Dispensar, no PIN; the store follows the two events and
re-reads on a 409. The mock raises one on "sugestão".

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
MSG
```

---

### Task 8: E2E no jarvis + verificação final

**Files:**
- Possibly modify (only if Part A/B show the real screen differs from the fixtures): `apps/server/src/terminal/ansi.ts`, `apps/server/src/terminal/ansi.test.ts` (add the real capture as a fixture under `apps/server/src/chat/fixtures/tab-suggestions/`).
- Possibly modify (only if Step 7 shows the suggestion arrives later than 3 s): `apps/server/src/chat/tab-suggestions.ts` (`SUGGESTION_DELAY_MS`), its test, and the spec §6.1.
- Scratch only (never committed): everything under `$E2E`.

**Interfaces:**
- Consumes: the whole feature (Tasks 1–7), the built `@termhub/machine-ops` (`HOOK_SCRIPT`).
- Produces: confirmation against real Claude Code that a suggestion becomes a card, that Enviar types it, that typed text never becomes a card, and that the logs hold no terminal text.

**Safety, before anything:** every tmux command below is either `env -u TMUX tmux -L th-e2e …` (a server named `th-e2e`) or `env -u TMUX tmux -S "$E2E/tmux/tmux-$(id -u)/default" …` (the socket of the dev server's own isolated `TMUX_TMPDIR` — the server's local-machine tmux calls use a bare `tmux`, so its whole process runs with `TMUX` unset and `TMUX_TMPDIR=$E2E/tmux`). Never run a bare `tmux` here, never `kill-server` without `-L th-e2e` / `-S $E2E/…`, never write `~/.termhub/*` or `~/.claude/settings.json` (jarvis is itself a hooked machine). The only container this task creates and removes is `th-sugg-e2e-db`; remove nothing else (not `th-tabq-db`, which is shared). The Claude sessions below also load your user settings, whose real termhub hook posts to production with an unknown session name: production answers `202 unknown_session` and stores nothing — harmless. `npx tsx` runs on the host (Node 24 is installed on jarvis since 2026-09-18); the canonical checks stay in Docker.

#### Part A — the parser against a live screen (no server)

- [ ] **Step 1: A Claude session on `-L th-e2e`, a styled capture.**
  ```bash
  cd ~/termhub-wt-dim-suggestion
  export E2E=/tmp/claude-1000/th-e2e-sugg && rm -rf "$E2E" && mkdir -p "$E2E/work"
  T() { env -u TMUX tmux -L th-e2e "$@"; }
  T new-session -d -s th-e2e-s -x 160 -y 50 -c "$E2E/work" claude
  sleep 5; T capture-pane -p -t th-e2e-s | tail -20   # a trust prompt for the folder? answer it:
  T send-keys -t th-e2e-s Enter
  say() { T send-keys -t th-e2e-s -l -- "$1"; sleep 0.3; T send-keys -t th-e2e-s Enter; }
  say 'Create a file notes.txt with the line hello, then tell me the next step would be to commit it.'
  sleep 25
  T capture-pane -p -e -S -15 -t '=th-e2e-s:' > "$E2E/live.ansi"
  cat > "$E2E/read.ts" <<'TS'
  import { readFileSync } from 'node:fs';
  import { promptSuggestion, renderStyled } from '/home/pedrogoiania/termhub-wt-dim-suggestion/apps/server/src/terminal/ansi.ts';
  const ansi = readFileSync(process.argv[2]!, 'utf8');
  console.log(JSON.stringify({ suggestion: promptSuggestion(ansi), prompt: renderStyled(ansi).split('\n').filter((l) => l.trimStart().startsWith('❯')).at(-1) }));
  TS
  npx tsx "$E2E/read.ts" "$E2E/live.ansi"
  ```
  Expected: `{"suggestion":"<a non-empty suggestion>","prompt":"❯ ⟦<the same>⟧"}`. If Claude shows no suggestion this time (it does not always), `say` another small task and capture again. If the prompt line is dim but `suggestion` is `null`, save `live.ansi` as a new fixture, add a failing `ansi.test.ts` case for it, fix `promptSuggestion`, re-run `NODE 'npm test -w @termhub/server -- src/terminal/ansi.test.ts'`.

- [ ] **Step 2: Typed text is not a suggestion.** `T send-keys -t th-e2e-s -l -- 'roda a migration'; sleep 1; T capture-pane -p -e -S -15 -t '=th-e2e-s:' > "$E2E/typed.ansi"; npx tsx "$E2E/read.ts" "$E2E/typed.ansi"` → `"suggestion":null` and a prompt line without `⟦`. Then `T kill-server`.

#### Part B — the whole route against a dev server

- [ ] **Step 3: Hook script, a throwaway database and a seeded tab.**
  ```bash
  mkdir -p "$E2E/home/.termhub/bin"
  NODE 'npm run build -w @termhub/machine-ops'
  node -e "import('$PWD/packages/machine-ops/dist/index.js').then((m) => require('node:fs').writeFileSync('$E2E/home/.termhub/bin/termhub-hook', m.HOOK_SCRIPT, { mode: 0o755 }))"
  docker run -d --name th-sugg-e2e-db -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=termhub -p 127.0.0.1:55433:5432 postgres:16-alpine
  export DB=postgresql://postgres:postgres@127.0.0.1:55433/termhub
  sleep 3; (cd apps/server && DATABASE_URL=$DB npx prisma migrate deploy)
  DATABASE_URL=$DB npx tsx apps/server/src/cli/create-user.ts --email e2e@test.local --name E2E --password e2e-pass-123
  cat > "$E2E/seed.ts" <<'TS'
  import { closePrisma, getPrisma } from '/home/pedrogoiania/termhub-wt-dim-suggestion/apps/server/src/db/prisma.ts';
  import { createRepositories } from '/home/pedrogoiania/termhub-wt-dim-suggestion/apps/server/src/db/repositories/index.ts';
  import { newHookToken } from '/home/pedrogoiania/termhub-wt-dim-suggestion/apps/server/src/monitor/token.ts';
  const repos = createRepositories(getPrisma());
  const user = (await repos.users.findByEmail('e2e@test.local'))!;
  const machine = await repos.machines.create({ name: 'th-e2e', type: 'local', owner_id: user.id });
  const project = await repos.projects.create({ owner_id: user.id, key: 'EZS', name: 'e2e' });
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
  printf "TERMHUB_HOOK_URL='http://127.0.0.1:3999/api/hooks/events'\nTERMHUB_HOOK_TOKEN='%s'\n" "$TOKEN" > "$E2E/home/.termhub/hook.env"
  HOOK="env HOME=$E2E/home $E2E/home/.termhub/bin/termhub-hook claude"
  cat > "$E2E/settings.json" <<JSON
  {"hooks":{
   "SessionStart":[{"hooks":[{"type":"command","command":"$HOOK","timeout":10}]}],
   "UserPromptSubmit":[{"hooks":[{"type":"command","command":"$HOOK","timeout":10}]}],
   "PreToolUse":[{"matcher":"*","hooks":[{"type":"command","command":"$HOOK","timeout":10}]}],
   "PermissionRequest":[{"matcher":"*","hooks":[{"type":"command","command":"$HOOK","timeout":10}]}],
   "Notification":[{"hooks":[{"type":"command","command":"$HOOK","timeout":10}]}],
   "Stop":[{"hooks":[{"type":"command","command":"$HOOK","timeout":10}]}],
   "SessionEnd":[{"hooks":[{"type":"command","command":"$HOOK","timeout":10}]}]}}
  JSON
  ```

- [ ] **Step 4: The dev server, on an isolated tmux socket dir, and the tab's Claude.**
  ```bash
  mkdir -p "$E2E/tmux" && chmod 700 "$E2E/tmux"
  (cd apps/server && env -u TMUX TMUX_TMPDIR="$E2E/tmux" DATABASE_URL=$DB AUTH_MODE=disabled PORT=3999 HOST=127.0.0.1 PUBLIC_URL=http://127.0.0.1:3999 npx tsx src/index.ts > "$E2E/server.log" 2>&1 & echo $! > "$E2E/server.pid")
  sleep 5; curl -s http://127.0.0.1:3999/api/health   # {"ok":true}
  TB() { env -u TMUX tmux -S "$E2E/tmux/tmux-$(id -u)/default" "$@"; }
  TB new-session -d -s "$SESSION" -x 160 -y 50 -c "$E2E/work" "claude --settings $E2E/settings.json"
  sleep 5; TB send-keys -t "$SESSION" Enter   # the folder trust prompt, if shown
  curl -s "http://127.0.0.1:3999/api/chat?project=$PROJECT" > /dev/null   # creates the project's conversation
  sayB() { TB send-keys -t "$SESSION" -l -- "$1"; sleep 0.3; TB send-keys -t "$SESSION" Enter; }
  sugg() { curl -s "http://127.0.0.1:3999/api/chat?project=$PROJECT" | node -pe 'const r = JSON.parse(require("fs").readFileSync(0)); JSON.stringify({ questions: r.tab_questions.length, suggestions: r.tab_suggestions.map(({ id, status, payload, answer, closed_at }) => ({ id, status, text: payload.text, sent: answer?.text ?? null, closed_at })) })'; }
  sendS() { curl -s -w ' %{http_code}\n' -X POST "http://127.0.0.1:3999/api/chat/tab-suggestions/$1/send" -H 'content-type: application/json' -d "$2"; }
  dismissS() { curl -s -w ' %{http_code}\n' -X POST "http://127.0.0.1:3999/api/chat/tab-suggestions/$1/dismiss" -H 'content-type: application/json' -d '{}'; }
  ```
  (`AUTH_MODE=disabled` makes every request the first owner — the user created above — and skips CSRF: dev only, on 127.0.0.1.)

- [ ] **Step 5: A real suggestion becomes a card.** `sayB 'Create a file notes.txt with the line hello, then tell me the next step would be to commit it.'`; wait ~25 s (the turn, then 3 s); `sugg` → `questions: 0` and one suggestion `status: "open"` with the text Claude shows dimmed (`TB capture-pane -p -t "$SESSION" | tail -6` shows it after `❯`). If no card appears but the screen shows a dimmed suggestion: `grep 'tab suggestion' "$E2E/server.log"` — a `tab suggestion check failed` names the code; a suggestion drawn later than 3 s after `Stop` means `SUGGESTION_DELAY_MS` is too short (raise it, update its test and spec §6.1, commit "Tab suggestions: wait for Claude Code to draw the suggestion").

- [ ] **Step 6: Enviar, the double click, the close.** `S=<its id>`; `sendS $S '{"text":"commit it"}'` → `200`, `"status":"answered"`; `TB capture-pane -p -t "$SESSION" | tail -15` → the prompt was submitted and Claude works on it (it may ask a permission for git — answer it in the tab: `TB send-keys -t "$SESSION" Escape`). `sendS $S '{"text":"commit it"}'` → `409` `TAB_PROMPT_CHANGED`. After Claude's next hook event, `sugg` shows it `answered` with `closed_at` set.

- [ ] **Step 7: Typed text never becomes a card; a stale card closes.** `sayB 'Count from 1 to 40, one number per line.'` and at once, while it works, `TB send-keys -t "$SESSION" -l -- 'roda a migration'` (no Enter). After the turn ends and 5 s more, `sugg` → no new open suggestion. Clear the typed text (`TB send-keys -t "$SESSION" C-u`; if it stays, `BSpace` ×16). Then get a fresh open suggestion (`sayB 'Say only: ok. Then suggest I run the tests.'`, wait, `sugg`), type over it in the tab without Enter (`TB send-keys -t "$SESSION" -l -- 'outra coisa'`), and `sendS <id> '{"text":"x"}'` → `409` `TAB_PROMPT_CHANGED`; `sugg` → that one `answered_in_tab`. Nothing was typed by the route (`TB capture-pane` shows only `outra coisa`). Clear it again.

- [ ] **Step 8: Dispensar.** Get a fresh open suggestion (as in Step 7); `dismissS <id>` → `200`, `"status":"dismissed"`; `TB capture-pane -p -t "$SESSION" | tail -6` → the tab still shows the dimmed suggestion (untouched); `dismissS <id>` again → `200`, still `dismissed`.

- [ ] **Step 9: Nothing leaked into the log.** `grep -c -e 'commit it' -e 'roda a migration' -e 'outra coisa' -e 'notes.txt' -e 'Count from' "$E2E/server.log"` → `0`.

- [ ] **Step 10: Close Part B.** `kill "$(cat "$E2E/server.pid")"; TB kill-server; docker rm -f th-sugg-e2e-db; rm -rf "$E2E"`. If Part A or B forced a change, run the touched tests with `NODE` and commit it (English subject, co-author line).

#### Final verification

- [ ] **Step 11: Everything, as CI and CLAUDE.md run it.**
  ```bash
  NODE 'cd apps/server && npx prisma migrate deploy && npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code && cd ../.. && TERMHUB_DB_TESTS=1 npm test'
  NODE 'npm run typecheck -w @termhub/mobile && npm run typecheck -w @termhub/agent'
  docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:22 \
    sh -c 'npm run typecheck -w @termhub/server && npm run build -w @termhub/web && npm run build -w @termhub/landing'
  rm -rf .npm
  git status   # clean: only the commits of Tasks 1–8
  ```
  Expected: every workspace's tests pass (`npm test` runs agent-protocol, machine-ops, claude-cli, mobile-api, server, web, mobile, agent), the migration diff is empty (no migration in this card), every typecheck and build passes. Leave `th-tabq-db` running (shared).

- [ ] **Step 12: After the merge (controller).** The push to `main` deploys; confirm it as CLAUDE.md says (the active color healthy, the two local-proxy curls). `@termhub/agent` 0.5.2 is published by the "Publish @termhub/agent" workflow (filter by that workflow name, not `gh run list --limit 1`); confirm the artifact, not the number: `npm pack @termhub/agent@0.5.2 && tar -xOf termhub-agent-0.5.2.tgz package/dist/*.js | grep -c 'escapes'` → ≥ 1. Agent machines with `agent_auto_update` pick it up within the hour; the rest use the update button in Máquinas — until then they return plain text and get no suggestion cards (by design). SSH/local machines get styled captures at once.

---

## Self-review (writing-plans checklist)

**Spec coverage.** §1 problem → Tasks 3 and 4; §2 decisions: fix → Tasks 1–3; concierge behaviour and old agents → Task 3 (description + prompt, `styled: false`); suggestion card, no push, sending → Tasks 4–7; other captures unchanged → Task 3 (`{ plain: true }`) and nothing else touches `captureScreen`. §3 captured behaviour → Task 1 fixtures, Task 8 Part A. §4 styled capture (server + agent 0.5.2, `styled`, `renderStyled`, `promptSuggestion`) → Tasks 1–2. §5 concierge fix → Task 3. §6.1 storage/lifecycle (kind, payload rules, trigger, delay, cancel, owner rule, unstyled → nothing, queue, closing, dismissed) → Task 4. §6.2 API (GET separation, events + contract + parity, send, dismiss, 409 + close, guards, logs) → Tasks 4–5. §6.3 concierge context → Task 4. §6.4 clients → Tasks 6–7. §7 testing → each task's tests; e2e → Task 8. §8 out of scope → untouched.

**Spec/code mismatches found, and how this plan resolves them (the implementer keeps these unless the controller says otherwise):**
- §2 says TER-56's live check stays plain, but that check and the permission excerpt go through `readScreen`, which §5 makes styled → `readScreen(…, { plain: true })` for both (Task 3).
- §4 "the result carries `styled`": the agent side needs a signal → `tmux.capture`'s result gains an optional `escapes: true` (Task 2) instead of comparing agent versions.
- §6.1 "reuse `tab_questions`" collides with TER-56 code in four places: (a) `publishTabQuestions` would announce closed suggestion rows as `tab_question_closed` (every close path uses it) → it routes suggestion rows to `tab_suggestion*` (Task 4); (b) the permission queue's "newest row" lookup in `open()` would treat a suggestion as the newest row and end a queue → it skips `kind = 'suggestion'` (Task 4, db test); (c) `answerTabQuestion` / `tabQuestionScreen` would accept a suggestion id (and `checkChoiceAnswer` would crash on `payload.questions`) → 404 through `isQuestionRow` (Task 4); (d) widening `TabQuestion.kind` breaks the mobile route's `beforeSend` typing → `QuestionRow`.
- `closeForTab` / `closeIn` already close suggestion rows on the tab's next closing event, and `findOpenForTab` already gives "the tab's latest" across kinds — both reused as they are.
- §6.2 lists the send guards as "one line, no control chars, ≤ 2000, not starting with `!`"; TER-56's deny text also refuses a leading `/` (a slash command at Claude's prompt) → both refused (Task 5).
- Spec is silent on: sending's failure after the claim (→ `failed` + 502, like TER-56); dismissing an already-closed suggestion (→ idempotent 200, no event); the dismiss grant (→ `chat:create`, no `terminals:write`: the tab is not touched); copy for `expired`/`failed` and the field label (→ TER-56's "Expirada", "Falhou — …"; "Texto da sugestão", "Uma aba sugere:").
- "Any hook event meanwhile" is applied literally: the cancel runs for every event with a known tab, before interpretation (even an ignored one).
- `listByConversation`'s 200-row window is now shared by questions and suggestions (no change: the same window rule as messages).

**Placeholders:** none — every code step carries its code; Task 8's conditional edits name the exact rule, file and test to change.

**Type consistency:** `renderStyled` / `promptSuggestion` (Task 1) → `readScreen` (Task 3), `readSuggestion` (Task 4); `StyledCapture` / `captureStyledScreen` (Task 2) → Tasks 3–5; `TabRowKind`, `TabRowPayload`, `TabRowAnswer`, `'dismissed'`, `dismiss()` (Task 4) → Task 5; `publishTabQuestions` keeps its signature; bus `suggestion: TabQuestionView` ↔ `tabSuggestionSchema` (parity test) ↔ web `TabSuggestion` ↔ mobile `TTabSuggestion` / `TabSuggestion` (same field names); `{ tab_suggestion }` route response ↔ `api.sendTabSuggestion` / `dismissTabSuggestion`; `chatTimeline(…, tabSuggestions)` and `upsertTabSuggestion` have the same signature on web and mobile; store `sendTabSuggestion(id, text)` ↔ card `onSend(id, text)`.
