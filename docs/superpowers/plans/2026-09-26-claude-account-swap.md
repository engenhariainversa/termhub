# Claude Account Swap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a Claude session in a termhub tab stops on a usage limit, swap the tab to another Claude account of the same machine and resume the same session — on a button, or automatically when the machine opts in.

**Architecture:** The Claude `StopFailure` hook (already forwarded by termhub's hook script once subscribed) tells the server a tab hit `rate_limit` and carries the session id and transcript path, which the server stores on the tab. A swap picks the account with the most room (usage API), symlinks the transcript into that account's config dir on the machine (shell script from `@termhub/machine-ops`, run by a new agent RPC or `runOnMachine`), exits the waiting Claude and types `CLAUDE_CONFIG_DIR=<dir> claude --resume <id> '<prompt>'`.

**Tech Stack:** TypeScript, Fastify, Prisma/Postgres, zod, Vitest, React; POSIX sh on the machines.

**Spec:** `docs/superpowers/specs/2026-09-26-claude-account-swap-design.md`

## Global Constraints

- UI copy in pt-BR; code, comments, commits in English (CLAUDE.md).
- Routes never import Prisma; go through `apps/server/src/db/repositories`. Every request input validated with zod.
- Tabs/machines/accounts in routes are loaded through `scoped(repos, request)`; never `repos.*.findById` in a handler for those kinds.
- Anything executed on a machine: `runOnMachine` (local/ssh) or an agent RPC; every user/hook-provided value `shellQuote`d.
- Terminal content is never logged; log ids and sizes only.
- Migration is additive and backward compatible (old container keeps running during deploy).
- No permission-bypass flag on any `claude` command line, ever.
- `SWAP_MAX_UTILIZATION = 90`; `AUTO_SWAP_COOLDOWN_MS = 10 * 60_000`; `EXIT_WAIT_MS = 15_000`; `EXIT_FORCE_WAIT_MS = 10_000`; `CLAUDE_LINK_MIN_AGENT_VERSION = '0.6.0'`.
- `RESUME_PROMPT = 'A conta anterior atingiu o limite de uso. Continue a tarefa de onde parou.'`
- Agent version bump `0.5.2 → 0.6.0` (CI publishes on merge; never `npm publish` by hand).
- Verification runs in Docker (no Node on the host): `sh /tmp/claude-1000/-home-pedrogoiania-termhub/d3a57fd1-0b28-49f8-97b6-cb74d48f86ab/scratchpad/check.sh '<cmds>'` runs `<cmds>` in `node:20` at the worktree root (`/w`) with a throwaway Postgres (`th-ter55-db`, `DATABASE_URL` and `TERMHUB_DB_TESTS=1` set). Before server tests after a package change: `npm run build:packages >/dev/null && npm run prisma:generate >/dev/null`.

## Review Focus

1. A tab whose agent was started by hand (unknown `ai_account_id`): the swap must never "swap" to the account it is already on → the link script's `same_account` makes the swap move to the next candidate (Task 5 test).
2. A second swap of the same session (A→B, later B→A): the transcript path reported by B is the symlink; re-linking into A finds A's real file, which `-ef` the source → `linked`, not `conflict` (Task 1 test).
3. The Claude that is waiting on the limit already exited (state `idle`) before the swap: no `Escape`/`/exit` is typed into the shell (Task 5 test).
4. Malformed or hostile `session_id`/`transcript_path` in a hook payload (quotes, `..`, newline, a path not ending in `/projects/<slug>/<id>.jsonl`): never stored (Task 3 test).
5. Two exhausted accounts: the automatic swap must not ping-pong — cooldown per tab, and a failed automatic swap leaves the tab showing the limit (Task 6 test).

---

### Task 1: machine-ops — `StopFailure` hook and the transcript link script

**Files:**
- Modify: `packages/machine-ops/src/hooks.ts` (the `CLAUDE_HOOK_EVENTS` line)
- Modify: `packages/machine-ops/src/hooks.test.ts`
- Create: `packages/machine-ops/src/claude-session.ts`
- Create: `packages/machine-ops/src/claude-session.test.ts`
- Modify: `packages/machine-ops/src/index.ts`

**Interfaces:**
- Produces:
  - `CLAUDE_LINK_STATUSES: readonly ['linked','same_account','no_transcript','no_config_dir','conflict']`, `type ClaudeLinkStatus`
  - `CLAUDE_SESSION_ID_RE: RegExp` (lowercase UUID)
  - `isClaudeSessionId(v: unknown): v is string`
  - `isClaudeTranscriptPath(path: unknown, sessionId: string): path is string`
  - `claudeLinkScript(transcriptPath: string, sessionId: string, configDir: string | null): string`
  - `parseClaudeLinkStatus(stdout: string): ClaudeLinkStatus | null`

- [ ] **Step 1: Failing tests.** In `hooks.test.ts` add:

```ts
it('subscribes to StopFailure (usage limits end a turn with it)', () => {
  expect(CLAUDE_HOOK_EVENTS).toContain('StopFailure');
});
```

Create `claude-session.test.ts`:

```ts
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readlinkSync, lstatSync, writeFileSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeLinkScript, isClaudeSessionId, isClaudeTranscriptPath, parseClaudeLinkStatus } from './claude-session.js';

const SID = '6d127d73-4bd0-42d6-b4a6-d96899507e62';
const SLUG = '-home-p-proj';

function home() {
  const h = mkdtempSync(path.join(tmpdir(), 'th-link-'));
  const a = path.join(h, '.claude_a');
  mkdirSync(path.join(a, 'projects', SLUG), { recursive: true });
  const src = path.join(a, 'projects', SLUG, `${SID}.jsonl`);
  writeFileSync(src, '{"type":"user"}\n');
  mkdirSync(path.join(h, '.claude'), { recursive: true });
  return { h, a, src };
}
const run = (h: string, script: string) => execFileSync('/bin/sh', ['-c', script], { env: { HOME: h, PATH: process.env.PATH }, encoding: 'utf8' }).trim();

describe('isClaudeSessionId / isClaudeTranscriptPath', () => {
  it('accepts a lowercase uuid only', () => {
    expect(isClaudeSessionId(SID)).toBe(true);
    expect(isClaudeSessionId(SID.toUpperCase())).toBe(false);
    expect(isClaudeSessionId(`${SID}'`)).toBe(false);
    expect(isClaudeSessionId(42)).toBe(false);
  });
  it('accepts <abs dir>/projects/<slug>/<id>.jsonl only', () => {
    expect(isClaudeTranscriptPath(`/home/p/.claude/projects/${SLUG}/${SID}.jsonl`, SID)).toBe(true);
    expect(isClaudeTranscriptPath(`~/.claude/projects/${SLUG}/${SID}.jsonl`, SID)).toBe(false);
    expect(isClaudeTranscriptPath(`/home/p/.claude/projects/${SLUG}/other.jsonl`, SID)).toBe(false);
    expect(isClaudeTranscriptPath(`/home/p/.claude/projects/../x/${SID}.jsonl`, SID)).toBe(false);
    expect(isClaudeTranscriptPath(`/home/p/.claude/projects/a\nb/${SID}.jsonl`, SID)).toBe(false);
    expect(isClaudeTranscriptPath(`/home/p/projects/${SLUG}/${SID}.jsonl`.repeat(200), SID)).toBe(false);
  });
});

describe('claudeLinkScript', () => {
  it('links the transcript into the default account (null config dir = ~/.claude)', () => {
    const { h, src } = home();
    expect(run(h, claudeLinkScript(src, SID, null))).toBe('linked');
    const t = path.join(h, '.claude', 'projects', SLUG, `${SID}.jsonl`);
    expect(lstatSync(t).isSymbolicLink()).toBe(true);
    expect(readlinkSync(t)).toBe(src);
  });
  it('expands ~/ in the target dir on the machine', () => {
    const { h, src } = home();
    mkdirSync(path.join(h, '.claude_b'));
    expect(run(h, claudeLinkScript(src, SID, '~/.claude_b'))).toBe('linked');
    expect(readFileSync(path.join(h, '.claude_b', 'projects', SLUG, `${SID}.jsonl`), 'utf8')).toContain('user');
  });
  it('links the session directory too when it exists', () => {
    const { h, a, src } = home();
    mkdirSync(path.join(a, 'projects', SLUG, SID));
    run(h, claudeLinkScript(src, SID, null));
    expect(lstatSync(path.join(h, '.claude', 'projects', SLUG, SID)).isSymbolicLink()).toBe(true);
  });
  it('is idempotent', () => {
    const { h, src } = home();
    run(h, claudeLinkScript(src, SID, null));
    expect(run(h, claudeLinkScript(src, SID, null))).toBe('linked');
  });
  it('answers same_account when the target is the source dir', () => {
    const { h, a, src } = home();
    expect(run(h, claudeLinkScript(src, SID, a))).toBe('same_account');
  });
  it('answers no_transcript / no_config_dir', () => {
    const { h, src } = home();
    expect(run(h, claudeLinkScript(src.replace('.jsonl', 'x.jsonl'), SID, null))).toBe('no_transcript');
    expect(run(h, claudeLinkScript(src, SID, '~/.nope'))).toBe('no_config_dir');
  });
  it('never overwrites a different file (conflict)', () => {
    const { h, src } = home();
    const dir = path.join(h, '.claude', 'projects', SLUG);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${SID}.jsonl`), 'other');
    expect(run(h, claudeLinkScript(src, SID, null))).toBe('conflict');
    expect(readFileSync(path.join(dir, `${SID}.jsonl`), 'utf8')).toBe('other');
  });
  it('swapping back (B → A) through B\'s symlink is linked, not a conflict', () => {
    const { h, a, src } = home();
    run(h, claudeLinkScript(src, SID, null));
    const viaB = path.join(h, '.claude', 'projects', SLUG, `${SID}.jsonl`);
    expect(run(h, claudeLinkScript(viaB, SID, a))).toBe('linked');
  });
  it('keeps hostile values inert', () => {
    const { h } = home();
    const evil = `/tmp/$(touch ${h}/pwned)/projects/x/${SID}.jsonl`;
    expect(run(h, claudeLinkScript(evil, SID, "~/'; touch pwned2; '"))).toBe('no_transcript');
    expect(() => lstatSync(path.join(h, 'pwned'))).toThrow();
  });
});

describe('parseClaudeLinkStatus', () => {
  it('reads the last known word', () => {
    expect(parseClaudeLinkStatus('linked\n')).toBe('linked');
    expect(parseClaudeLinkStatus('noise\nsame_account')).toBe('same_account');
    expect(parseClaudeLinkStatus('whatever')).toBeNull();
  });
});
```

(`symlinkSync` import is unused unless you need it — drop it if the linter complains.)

- [ ] **Step 2: Run, expect FAIL** — `sh $CHECK 'npx -w @termhub/machine-ops vitest run src/claude-session.test.ts src/hooks.test.ts'` → module not found / `StopFailure` missing.

- [ ] **Step 3: Implement.** In `hooks.ts`:

```ts
export const CLAUDE_HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'Notification', 'Stop', 'StopFailure', 'SessionEnd'] as const;
```

(Update the doc comment above to mention `StopFailure`: an API error — usage limit, auth — ended the turn.) `StopFailure` is not a tool event: no matcher.

Create `claude-session.ts`:

```ts
import { configDirPrefix } from './ai-credentials.js';
import { shellQuote } from './shell.js';

/**
 * Moving a Claude Code session to another account of the same machine (spec 2026-09-26 account swap).
 * A session lives in `<config dir>/projects/<cwd slug>/<session id>.jsonl` (plus an optional
 * `<session id>/` directory); `claude --resume <id>` only finds sessions under its own config dir, so
 * the transcript is symlinked into the target account — both accounts then write the same file.
 */
export const CLAUDE_LINK_STATUSES = ['linked', 'same_account', 'no_transcript', 'no_config_dir', 'conflict'] as const;
export type ClaudeLinkStatus = (typeof CLAUDE_LINK_STATUSES)[number];

export const CLAUDE_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TRANSCRIPT_MAX = 1024;

export function isClaudeSessionId(v: unknown): v is string {
  return typeof v === 'string' && CLAUDE_SESSION_ID_RE.test(v);
}

/** An absolute `<dir>/projects/<slug>/<sessionId>.jsonl`, no `..` segment, no control character. */
export function isClaudeTranscriptPath(p: unknown, sessionId: string): p is string {
  if (typeof p !== 'string' || p.length > TRANSCRIPT_MAX || !p.startsWith('/')) return false;
  if (/[\0-\x1f\x7f]/.test(p)) return false;
  const parts = p.split('/');
  if (parts.some((s) => s === '..' || s === '.')) return false;
  const n = parts.length;
  return n >= 5 && parts[n - 1] === `${sessionId}.jsonl` && parts[n - 2] !== '' && parts[n - 3] === 'projects';
}

/**
 * Prints one of CLAUDE_LINK_STATUSES and exits 0. Never overwrites or deletes anything: an entry that
 * already is the same file (`-ef`, e.g. swapping back through the other account's symlink) is fine,
 * anything else is `conflict`. The source's own config dir is compared with the target by physical
 * path, so an account registered as `~/x` and a transcript under `/home/me/x` are the same account.
 */
export function claudeLinkScript(transcriptPath: string, sessionId: string, configDir: string | null): string {
  return [
    configDirPrefix(configDir, '.claude'),
    `SRC=${shellQuote(transcriptPath)}; SID=${shellQuote(sessionId)}`,
    '[ -f "$SRC" ] || { echo no_transcript; exit 0; }',
    'SLUGDIR=$(dirname "$SRC"); SLUG=$(basename "$SLUGDIR"); SRCROOT=$(dirname "$(dirname "$SLUGDIR")")',
    '[ -d "$D" ] || { echo no_config_dir; exit 0; }',
    'if [ "$(cd "$SRCROOT" && pwd -P)" = "$(cd "$D" && pwd -P)" ]; then echo same_account; exit 0; fi',
    'mkdir -p "$D/projects/$SLUG" 2>/dev/null || { echo no_config_dir; exit 0; }',
    'T="$D/projects/$SLUG/$SID.jsonl"',
    'if [ -e "$T" ] || [ -L "$T" ]; then [ "$T" -ef "$SRC" ] || { echo conflict; exit 0; }; else ln -s "$SRC" "$T" 2>/dev/null || { echo conflict; exit 0; }; fi',
    'if [ -d "$SLUGDIR/$SID" ] && [ ! -e "$D/projects/$SLUG/$SID" ] && [ ! -L "$D/projects/$SLUG/$SID" ]; then ln -s "$SLUGDIR/$SID" "$D/projects/$SLUG/$SID" 2>/dev/null; fi',
    'echo linked',
  ].join('\n');
}

export function parseClaudeLinkStatus(stdout: string): ClaudeLinkStatus | null {
  const words = stdout.split(/\s+/).filter(Boolean);
  for (let i = words.length - 1; i >= 0; i--) {
    if ((CLAUDE_LINK_STATUSES as readonly string[]).includes(words[i])) return words[i] as ClaudeLinkStatus;
  }
  return null;
}
```

Add `export * from './claude-session.js';` to `index.ts`. Check `configDirPrefix` handles `~/'; touch…` safely (it `shellQuote`s the raw value, then expands `~/` in a `case`): the hostile test proves it.

- [ ] **Step 4: Run, expect PASS** — same command, plus the whole package: `npx -w @termhub/machine-ops vitest run`.
- [ ] **Step 5: Commit** — `git add packages/machine-ops && git commit -m "machine-ops: StopFailure hook and Claude transcript link script"`

---

### Task 2: agent RPC `claude.linkSession` + agent 0.6.0

**Files:**
- Modify: `packages/agent-protocol/src/rpc.ts` (next to `'ai.credential'`)
- Modify: `packages/agent-protocol/src/*.test.ts` (the existing rpc schema test file, if any — add a parse case)
- Create: `apps/agent/src/rpc/claude.ts`, `apps/agent/src/rpc/claude.test.ts`
- Modify: `apps/agent/src/rpc/index.ts`
- Modify: `apps/agent/package.json` (`"version": "0.6.0"`) and the `apps/agent` entry in `package-lock.json`

**Interfaces:**
- Consumes: `claudeLinkScript`, `parseClaudeLinkStatus`, `CLAUDE_LINK_STATUSES` (Task 1).
- Produces: RPC `'claude.linkSession'` params `{ transcript_path: string; session_id: string; config_dir: string | null }` → `{ status: ClaudeLinkStatus }`, timeout 10 s.

- [ ] **Step 1: Failing test** `apps/agent/src/rpc/claude.test.ts` (mirror `ai.test.ts` for how `sh` from `../exec.js` is mocked):

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
const sh = vi.fn();
vi.mock('../exec.js', async (orig) => ({ ...(await orig<typeof import('../exec.js')>()), sh: (s: string) => sh(s) }));
const { linkSession } = await import('./claude.js');

const params = { transcript_path: '/h/.claude_a/projects/-p/6d127d73-4bd0-42d6-b4a6-d96899507e62.jsonl', session_id: '6d127d73-4bd0-42d6-b4a6-d96899507e62', config_dir: '~/.claude_b' };

describe('claude.linkSession', () => {
  beforeEach(() => sh.mockReset());
  it('runs the link script and answers its status', async () => {
    sh.mockResolvedValue({ code: 0, stdout: 'linked\n', stderr: '', timedOut: false });
    await expect(linkSession(params)).resolves.toEqual({ status: 'linked' });
    expect(sh.mock.calls[0][0]).toContain("SRC='/h/.claude_a/projects/-p/6d127d73-4bd0-42d6-b4a6-d96899507e62.jsonl'");
  });
  it('fails on a timeout or an unreadable answer', async () => {
    sh.mockResolvedValue({ code: 0, stdout: '', stderr: '', timedOut: true });
    await expect(linkSession(params)).rejects.toMatchObject({ code: 'timeout' });
    sh.mockResolvedValue({ code: 0, stdout: '???', stderr: '', timedOut: false });
    await expect(linkSession(params)).rejects.toMatchObject({ code: 'internal' });
  });
});
```

(Check `RpcFailure`'s field name in `apps/agent/src/exec.ts`; use it in `toMatchObject`.)

- [ ] **Step 2: Run, expect FAIL** — `npm run build:packages >/dev/null && npx -w @termhub/agent vitest run src/rpc/claude.test.ts`.
- [ ] **Step 3: Implement.** In `rpc.ts`, after `'ai.credential'`:

```ts
  /** Symlinks a Claude Code transcript into another account's config dir so `claude --resume` finds it there (since agent 0.6.0). */
  'claude.linkSession': def(
    z.object({ transcript_path: machinePath, session_id: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/), config_dir: machinePath.nullable() }),
    z.object({ status: z.enum(['linked', 'same_account', 'no_transcript', 'no_config_dir', 'conflict']) }),
    10_000,
  ),
```

`apps/agent/src/rpc/claude.ts`:

```ts
import type { RpcParams, RpcResult } from '@termhub/agent-protocol';
import { claudeLinkScript, parseClaudeLinkStatus } from '@termhub/machine-ops';
import { RpcFailure, sh } from '../exec.js';

/** Makes a Claude session resumable under another account of this machine (spec 2026-09-26 account swap). */
export async function linkSession(params: RpcParams<'claude.linkSession'>): Promise<RpcResult<'claude.linkSession'>> {
  let script: string;
  try {
    script = claudeLinkScript(params.transcript_path, params.session_id, params.config_dir);
  } catch (err) {
    throw new RpcFailure('invalid', err instanceof Error ? err.message : 'invalid config dir');
  }
  const r = await sh(script);
  if (r.timedOut) throw new RpcFailure('timeout', 'claude.linkSession timed out');
  const status = parseClaudeLinkStatus(r.stdout);
  if (r.code !== 0 || !status) throw new RpcFailure('internal', `claude.linkSession exited with code ${r.code}`);
  return { status };
}
```

Register `'claude.linkSession': claude.linkSession` in `apps/agent/src/rpc/index.ts` (same style as `ai`). If a dispatch/index test enumerates every RPC method, add it there. Bump `apps/agent/package.json` to `0.6.0` and the matching `"apps/agent"` `version` in `package-lock.json`.

- [ ] **Step 4: Run, expect PASS** — `npm run build:packages >/dev/null && npm test -w @termhub/agent-protocol && npm test -w @termhub/agent && npm run typecheck -w @termhub/agent`.
- [ ] **Step 5: Commit** — `"Agent: claude.linkSession RPC (0.6.0)"`.

---

### Task 3: data — tab agent fields, machine `claude_auto_swap`

**Files:**
- Modify: `apps/server/prisma/schema.prisma` (`model Tab`, `model Machine`, `model AiAccount` back-relation)
- Create: `apps/server/prisma/migrations/20260926060000_claude_account_swap/migration.sql`
- Modify: `apps/server/src/db/repositories/types.ts` (`Tab`, `mapTab`, `Machine`, `mapMachine`)
- Modify: `apps/server/src/db/repositories/tabs.ts` (new `setAgentFields`)
- Modify: `apps/server/src/db/repositories/machines.ts` (`MachineInput.claude_auto_swap`, `update`)
- Modify: `apps/server/src/routes/machines.ts` (`machineBody.claude_auto_swap`)
- Test: `apps/server/src/db/repositories/tabs.db.test.ts`, `apps/server/src/db/repositories/machines.db.test.ts`, `apps/server/src/routes/machines.test.ts`
- Fix fixtures: every test that builds a full `Tab` or `Machine` literal without a cast (typecheck tells you).

**Interfaces:**
- Produces:
  - `Tab.agent_session_id: string | null`, `Tab.agent_transcript_path: string | null`, `Tab.ai_account_id: string | null`, `Tab.rate_limited_at: string | null`
  - `Machine.claude_auto_swap: boolean`
  - `TabsRepository.setAgentFields(id: string, patch: { agent_session_id?: string | null; agent_transcript_path?: string | null; ai_account_id?: string | null; rate_limited_at?: Date | null }): Promise<Tab | undefined>` (undefined = tab gone)

- [ ] **Step 1: Schema.** In `model Tab` add (after `activityVerb`):

```prisma
  /// Claude Code session last reported by a hook of this tab (uuid) and its transcript on the machine;
  /// used to resume it under another account (spec 2026-09-26 account swap). Metadata only.
  agentSessionId      String?   @map("agent_session_id")
  agentTranscriptPath String?   @map("agent_transcript_path")
  /// The AI account termhub started this tab's agent with (start_agent or a swap); null = unknown.
  aiAccountId         String?   @map("ai_account_id")
  /// When the tab's Claude stopped on a usage limit (StopFailure rate_limit); cleared when it runs again.
  rateLimitedAt       DateTime? @map("rate_limited_at")
  aiAccount           AiAccount? @relation(fields: [aiAccountId], references: [id], onDelete: SetNull)
```

and `@@index([aiAccountId])`. In `model AiAccount` add `tabs Tab[]`. In `model Machine` add after `agentAutoUpdate`:

```prisma
  /// Swap a tab's Claude to another account of this machine by itself when it hits a usage limit (opt-in).
  claudeAutoSwap  Boolean  @default(false) @map("claude_auto_swap")
```

- [ ] **Step 2: Migration.** Generate it against the throwaway DB so it matches Prisma exactly: `sh $CHECK 'cd apps/server && npx prisma migrate dev --create-only --name claude_account_swap --skip-generate'`, then rename the folder to `20260926060000_claude_account_swap` if needed. Expected SQL (verify it is only additive):

```sql
ALTER TABLE "machines" ADD COLUMN "claude_auto_swap" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "tabs" ADD COLUMN "agent_session_id" TEXT, ADD COLUMN "agent_transcript_path" TEXT, ADD COLUMN "ai_account_id" TEXT, ADD COLUMN "rate_limited_at" TIMESTAMP(3);
CREATE INDEX "tabs_ai_account_id_idx" ON "tabs"("ai_account_id");
ALTER TABLE "tabs" ADD CONSTRAINT "tabs_ai_account_id_fkey" FOREIGN KEY ("ai_account_id") REFERENCES "ai_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
```

Then `npm run prisma:generate`.

- [ ] **Step 3: Failing DB tests.** In `tabs.db.test.ts` (follow its setup helpers for a machine/project/tab; for the account use `repos.aiAccounts.create`):

```ts
it('setAgentFields stores and clears the agent session, account and limit', async () => {
  const at = new Date('2026-09-26T05:00:00Z');
  const t = await repos.tabs.setAgentFields(tab.id, { agent_session_id: SID, agent_transcript_path: `/h/.claude/projects/-p/${SID}.jsonl`, ai_account_id: account.id, rate_limited_at: at });
  expect(t).toMatchObject({ agent_session_id: SID, ai_account_id: account.id, rate_limited_at: at.toISOString() });
  const cleared = await repos.tabs.setAgentFields(tab.id, { rate_limited_at: null });
  expect(cleared).toMatchObject({ agent_session_id: SID, rate_limited_at: null });
});
it('setAgentFields on a missing tab answers undefined', async () => {
  expect(await repos.tabs.setAgentFields('nope', { rate_limited_at: null })).toBeUndefined();
});
it('deleting the account keeps the tab and forgets the account', async () => {
  await repos.tabs.setAgentFields(tab.id, { ai_account_id: account.id });
  await repos.aiAccounts.delete(account.id);
  expect((await repos.tabs.findById(tab.id))?.ai_account_id).toBeNull();
});
```

In `machines.db.test.ts`: `update(id, { claude_auto_swap: true })` then `findById` → `claude_auto_swap: true`; a later `update(id, { name: 'x' })` keeps it `true`. In `routes/machines.test.ts`: PATCH `{ claude_auto_swap: true }` reaches `repos.machines.update` with `claude_auto_swap: true`; PATCH `{ claude_auto_swap: 'yes' }` → 400.

- [ ] **Step 4: Run, expect FAIL.**
- [ ] **Step 5: Implement.** `types.ts`: add the four `Tab` fields with doc comments; in `mapTab`: `agent_session_id: t.agentSessionId, agent_transcript_path: t.agentTranscriptPath, ai_account_id: t.aiAccountId, rate_limited_at: iso(t.rateLimitedAt)`. `Machine.claude_auto_swap: boolean` + `claude_auto_swap: m.claudeAutoSwap`. `tabs.ts`:

```ts
  /**
   * The tab's agent bookkeeping (spec 2026-09-26 account swap): its Claude session and transcript,
   * the account termhub started it with, and when it hit a usage limit. Only the given keys change;
   * a tab that is gone answers undefined.
   */
  async setAgentFields(
    id: string,
    patch: { agent_session_id?: string | null; agent_transcript_path?: string | null; ai_account_id?: string | null; rate_limited_at?: Date | null },
  ): Promise<Tab | undefined> {
    const data = {
      ...(patch.agent_session_id !== undefined ? { agentSessionId: patch.agent_session_id } : {}),
      ...(patch.agent_transcript_path !== undefined ? { agentTranscriptPath: patch.agent_transcript_path } : {}),
      ...(patch.ai_account_id !== undefined ? { aiAccountId: patch.ai_account_id } : {}),
      ...(patch.rate_limited_at !== undefined ? { rateLimitedAt: patch.rate_limited_at } : {}),
    };
    const [t] = await this.db.tab.updateManyAndReturn({ where: { id }, data });
    return t ? mapTab(t) : undefined;
  }
```

`machines.ts`: `claude_auto_swap?: boolean` in `MachineInput`; in `update` data `claudeAutoSwap: next.claude_auto_swap ?? false`. `routes/machines.ts` `machineBody`: `claude_auto_swap: z.boolean().optional()`. Fix fixtures that fail typecheck by adding the new fields (`null` / `false`).

- [ ] **Step 6: Run, expect PASS** — `npm run prisma:generate >/dev/null && (cd apps/server && npx prisma migrate deploy) && npm run typecheck -w @termhub/server && npx -w @termhub/server vitest run src/db/repositories/tabs.db.test.ts src/db/repositories/machines.db.test.ts src/routes/machines.test.ts`.
- [ ] **Step 7: Commit** — `"Tabs remember their Claude session and account; machines get claude_auto_swap"`.

---

### Task 4: monitor — interpret `StopFailure`, note the session on the tab

**Files:**
- Modify: `apps/server/src/monitor/state.ts` (`interpretClaude`, new `claudeSessionOf`)
- Modify: `apps/server/src/monitor/ingest.ts`
- Test: `apps/server/src/monitor/state.test.ts`, `apps/server/src/monitor/ingest.test.ts`

**Interfaces:**
- Consumes: `isClaudeSessionId`, `isClaudeTranscriptPath` (Task 1); `TabsRepository.setAgentFields` (Task 3).
- Produces:
  - `RATE_LIMIT_TEXT = 'Limite de uso da conta atingido'` (exported from `state.ts`)
  - `isRateLimit(i: Interpreted | null): boolean` — `meta.event === 'StopFailure' && meta.error === 'rate_limit'`
  - `claudeSessionOf(ev: unknown): { session_id: string; transcript_path: string } | null`
  - ingest calls `autoSwapOnLimit(repos, log, tab)` from `../control/account-swap.js` on a rate limit (the function arrives in Task 6; in this task create `apps/server/src/control/account-swap.ts` exporting only `export function autoSwapOnLimit(_repos: Repositories, _log: FastifyBaseLogger, _tab: Tab): void {}` so the import resolves — Task 5/6 fill it in).

- [ ] **Step 1: Failing tests.** `state.test.ts`:

```ts
describe('claude StopFailure', () => {
  it('a usage limit waits for the person, with the CLI line', () => {
    const i = interpretHookEvent('claude', { hook_event_name: 'StopFailure', error: 'rate_limit', last_assistant_message: "You've hit your weekly limit · resets 1pm" });
    expect(i).toMatchObject({ kind: 'waiting_input', text: "Limite de uso da conta atingido — You've hit your weekly limit · resets 1pm", meta: { event: 'StopFailure', error: 'rate_limit' } });
    expect(isRateLimit(i)).toBe(true);
  });
  it('a usage limit without a message still says so', () => {
    expect(interpretHookEvent('claude', { hook_event_name: 'StopFailure', error: 'rate_limit' })).toMatchObject({ text: 'Limite de uso da conta atingido' });
  });
  it('any other API error is an error state', () => {
    const i = interpretHookEvent('claude', { hook_event_name: 'StopFailure', error: 'authentication_failed' });
    expect(i).toMatchObject({ kind: 'error', text: 'Erro da API do Claude (authentication_failed)', meta: { event: 'StopFailure', error: 'authentication_failed' } });
    expect(isRateLimit(i)).toBe(false);
  });
  it('an unknown error value is not echoed', () => {
    expect(interpretHookEvent('claude', { hook_event_name: 'StopFailure', error: 'x"; rm' })).toMatchObject({ kind: 'error', text: 'Erro da API do Claude (unknown)' });
  });
});
describe('claudeSessionOf', () => {
  const SID = '6d127d73-4bd0-42d6-b4a6-d96899507e62';
  it('reads a valid pair', () => {
    expect(claudeSessionOf({ session_id: SID, transcript_path: `/h/.claude/projects/-p/${SID}.jsonl` })).toEqual({ session_id: SID, transcript_path: `/h/.claude/projects/-p/${SID}.jsonl` });
  });
  it('drops malformed ones', () => {
    expect(claudeSessionOf({ session_id: SID })).toBeNull();
    expect(claudeSessionOf({ session_id: 'x', transcript_path: '/h/.claude/projects/-p/x.jsonl' })).toBeNull();
    expect(claudeSessionOf({ session_id: SID, transcript_path: `/h/../projects/-p/${SID}.jsonl` })).toBeNull();
    expect(claudeSessionOf(null)).toBeNull();
  });
});
```

`ingest.test.ts` — extend `repos()` with `setAgentFields: vi.fn(async (_id, patch) => tab({ ...current, ...patch, rate_limited_at: patch.rate_limited_at === undefined ? current.rate_limited_at : patch.rate_limited_at && patch.rate_limited_at.toISOString() }))` and mock `../control/account-swap.js` (`autoSwapOnLimit: vi.fn()`). Tests:
  - a `SessionStart` with a valid `session_id`/`transcript_path` calls `setAgentFields('t1', { agent_session_id, agent_transcript_path })`; the same pair again (tab already has it) does not call it;
  - a malformed pair never calls it;
  - `StopFailure`/`rate_limit` calls it with `rate_limited_at: expect.any(Date)` and calls `autoSwapOnLimit` with the updated tab;
  - `UserPromptSubmit` on a tab with `rate_limited_at` set calls it with `rate_limited_at: null`; on a tab without it, no call;
  - `StopFailure` with another error does not set `rate_limited_at` nor call `autoSwapOnLimit`.
  Add the four new `Tab` fields (null) to the `tab()` fixture.

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** In `state.ts`:

```ts
import { isClaudeSessionId, isClaudeTranscriptPath } from '@termhub/machine-ops';

export const RATE_LIMIT_TEXT = 'Limite de uso da conta atingido';
/** Claude Code's StopFailure matcher values (hooks docs); anything else is reported as "unknown". */
const CLAUDE_API_ERRORS = new Set(['rate_limit', 'overloaded', 'authentication_failed', 'oauth_org_not_allowed', 'account_on_hold', 'verification_required', 'billing_error', 'invalid_request', 'model_not_found', 'server_error', 'max_output_tokens', 'cloud_credential_error', 'unknown']);

export const isRateLimit = (i: Interpreted | null): boolean => !!i && i.meta.event === 'StopFailure' && i.meta.error === 'rate_limit';

/** The Claude session a hook payload belongs to, when both ids are well-formed (never stored otherwise). */
export function claudeSessionOf(ev: unknown): { session_id: string; transcript_path: string } | null {
  if (!isObj(ev) || !isClaudeSessionId(ev.session_id)) return null;
  const sid = ev.session_id;
  return isClaudeTranscriptPath(ev.transcript_path, sid) ? { session_id: sid, transcript_path: ev.transcript_path } : null;
}
```

and in `interpretClaude`, before `SessionEnd`:

```ts
    case 'StopFailure': {
      // An API error ended the turn (spec 2026-09-26 account swap). On a usage limit Claude Code does
      // not exit: it waits for the reset, so the tab waits for the person (or the automatic swap).
      const raw = str(ev.error);
      const error = raw && CLAUDE_API_ERRORS.has(raw) ? raw : 'unknown';
      if (error === 'rate_limit') {
        const line = str(ev.last_assistant_message);
        return { kind: 'waiting_input', text: cap(line ? `${RATE_LIMIT_TEXT} — ${line}` : RATE_LIMIT_TEXT), meta: { event: name, error } };
      }
      return { kind: 'error', text: `Erro da API do Claude (${error})`, meta: { event: name, error } };
    }
```

(`isObj` / `str` / `cap` already exist in the file; move `claudeSessionOf` below them.) In `ingest.ts`, right after `cancelTabSuggestion(tab.id)`:

```ts
  let current = tab;
  const interpreted = interpretHookEvent(input.tool, input.event);
  if (input.tool === 'claude') current = await noteClaudeSession(repos, current, input.event, interpreted);
  if (!interpreted) return { ok: false, reason: 'ignored' };
  const updated = await recordInterpretation(repos, log, current, input.tool, interpreted);
```

(the rest uses `updated` as today), then after the suggestion scheduling:

```ts
  if (isRateLimit(interpreted)) autoSwapOnLimit(repos, log, updated);
```

and the helper:

```ts
/** Events that mean the tab's Claude is running again: a usage limit it was stuck on is over. */
const RUNNING_AGAIN = new Set(['SessionStart', 'UserPromptSubmit', 'PreToolUse']);

/**
 * The tab's Claude bookkeeping (spec 2026-09-26 account swap): the session it runs (a `/clear` starts a
 * new one) and whether it is stuck on a usage limit. One write, only when something changed.
 */
async function noteClaudeSession(repos: Repositories, tab: Tab, event: unknown, interpreted: Interpreted | null): Promise<Tab> {
  const patch: Parameters<Repositories['tabs']['setAgentFields']>[1] = {};
  const session = claudeSessionOf(event);
  if (session && (session.session_id !== tab.agent_session_id || session.transcript_path !== tab.agent_transcript_path)) {
    patch.agent_session_id = session.session_id;
    patch.agent_transcript_path = session.transcript_path;
  }
  const name = interpreted?.meta.event;
  if (isRateLimit(interpreted)) patch.rate_limited_at = new Date();
  else if (tab.rate_limited_at && typeof name === 'string' && RUNNING_AGAIN.has(name)) patch.rate_limited_at = null;
  if (Object.keys(patch).length === 0) return tab;
  return (await repos.tabs.setAgentFields(tab.id, patch)) ?? tab;
}
```

(`interpreted.meta.event` for `PreToolUse` is `'PreToolUse'` — see `interpretClaude`.)

- [ ] **Step 4: Run, expect PASS** — `npx -w @termhub/server vitest run src/monitor` and typecheck.
- [ ] **Step 5: Commit** — `"Monitor: StopFailure usage limits and the tab's Claude session"`.

---

### Task 5: the swap — link on the machine, rank, exit, resume, record

**Files:**
- Create: `apps/server/src/ai/claude-session.ts`, `apps/server/src/ai/claude-session.test.ts`
- Modify: `apps/server/src/control/agents.ts` (export `resumeLine`, `RESUME_PROMPT`; `startAgent` records `ai_account_id`)
- Modify: `apps/server/src/control/agents.test.ts`
- Modify: `apps/server/src/control/account-swap.ts` (from the Task 4 stub), Create: `apps/server/src/control/account-swap.test.ts`

**Interfaces:**
- Consumes: `claudeLinkScript`, `parseClaudeLinkStatus`, `ClaudeLinkStatus` (Task 1); RPC `claude.linkSession` (Task 2); `setAgentFields`, `Tab`/`Machine` fields (Task 3); `applyState` (`monitor/ingest.ts`); `getAccountUsage` (`ai/index.ts`); `sendKeyToSession`, `sendTextToSession` (`terminal/session-ops.ts`); `monitorBus`; `agents.isOnline`.
- Produces:
  - `linkClaudeSession(machine: Machine, input: { transcriptPath: string; sessionId: string; configDir: string | null }): Promise<ClaudeLinkStatus>` (throws `ControlError('LINK_FAILED', …)`; `HttpError` 409 `AGENT_OUTDATED` from `requireAgentVersion`)
  - `CLAUDE_LINK_MIN_AGENT_VERSION = '0.6.0'`
  - `resumeLine(configDir: string | null, sessionId: string, prompt: string): string`, `RESUME_PROMPT`
  - `peakUtilization(u: AiAccountUsage): number | null`
  - `rankCandidates(accounts: AiAccount[], usage: Map<string, AiAccountUsage>, opts: { explicit: boolean }): AiAccount[]`
  - `swapAccount(repos: Repositories, log: FastifyBaseLogger, tab: Tab, machine: Machine, opts: { accountId?: string; auto: boolean }): Promise<SwapResult>` with `SwapResult = { from: { id: string; label: string } | null; to: { id: string; label: string } }`
  - constants `SWAP_MAX_UTILIZATION`, `EXIT_WAIT_MS`, `EXIT_FORCE_WAIT_MS`

- [ ] **Step 1: Failing tests.**

`ai/claude-session.test.ts` — mock `../agent/registry.js` (`agents.rpc`, `agents.info` → `{ agent_version: '0.6.0' }`) and `../terminal/machine-exec.js` (`runOnMachine`):
  - agent machine: calls `agents.rpc(m.id, 'claude.linkSession', { transcript_path, session_id, config_dir })` and returns its `status`;
  - agent machine with `agents.info` → `{ agent_version: '0.5.2' }`: rejects with status 409 / code `AGENT_OUTDATED`, no rpc;
  - ssh machine: `runOnMachine(machine, { file: '/bin/sh', args: ['-c', script] }, script, 10000)` where `script === claudeLinkScript(...)`, stdout `'linked\n'` → `'linked'`;
  - ssh answer with `timedOut: true` or unparsable stdout → `ControlError` code `LINK_FAILED`.

`control/agents.test.ts` additions:

```ts
describe('resumeLine', () => {
  const SID = '6d127d73-4bd0-42d6-b4a6-d96899507e62';
  it('resumes the session under the account, prompt quoted', () => {
    expect(resumeLine('~/.claude_b', SID, RESUME_PROMPT)).toBe(`CLAUDE_CONFIG_DIR="$HOME"/'.claude_b' claude --resume ${SID} 'A conta anterior atingiu o limite de uso. Continue a tarefa de onde parou.'`);
  });
  it('no env for the default account', () => {
    expect(resumeLine(null, SID, 'x')).toBe(`claude --resume ${SID} 'x'`);
  });
  it('refuses a session id that is not a uuid', () => {
    expect(() => resumeLine(null, "x'; rm -rf ~", 'x')).toThrow(ControlError);
  });
});
```

and in the `startAgent` suite: after a successful start, `repos.tabs.setAgentFields` was called with `(tab_id, { ai_account_id: 'a1' })` (add `tabs: { setAgentFields: vi.fn(async () => undefined) }` to the fake repos); a failing `setAgentFields` does not fail `startAgent`.

`control/account-swap.test.ts` — mock `../ai/index.js` (`getAccountUsage`), `../ai/claude-session.js` (`linkClaudeSession`), `../terminal/session-ops.js` (`sendKeyToSession`, `sendTextToSession`), `../agent/registry.js` (`agents.isOnline` → true), `../monitor/ingest.js` (`applyState` → returns the tab). Use a real `monitorBus` to deliver `idle`: have `sendTextToSession` for `'/exit'` publish `{ tab: { ...tab, state: 'idle' }, … }` on the bus. Use `vi.useFakeTimers()` for the timeout cases. Fixtures: machine `m1` (`agent`, capabilities `['tmux','claude']`, owner `u1`), accounts `a1` (`~/.claude_a`), `a2` (`~/.claude_b`), `a3` (default dir, `config_dir: null`), `c1` (`chatgpt`), `x1` (other machine); tab `t1` with `tmux_session 'th-t1'`, `agent_session_id SID`, `agent_transcript_path`, `ai_account_id 'a1'`, `state 'waiting_input'`, `rate_limited_at` set. Tests:

```ts
it('ranks by peak utilization, drops ≥ 90 %, unknown last', () => {
  const u = (id: string, windows: number[] | null) => [id, windows ? { account_id: id, ok: true, windows: windows.map((w, i) => ({ key: `k${i}`, label: '', utilization: w, resets_at: null })) } : { account_id: id, ok: false, windows: [] }] as const;
  const usage = new Map([u('a2', [10, 60]), u('a3', [5, 20]), u('a4', [95, 1]), u('a5', null)]) as never;
  const accs = ['a2', 'a3', 'a4', 'a5'].map((id) => account({ id, machine_id: 'm1' }));
  expect(rankCandidates(accs, usage, { explicit: false }).map((a) => a.id)).toEqual(['a3', 'a2', 'a5']);
  expect(rankCandidates(accs, usage, { explicit: true }).map((a) => a.id)).toEqual(['a3', 'a2', 'a4', 'a5']);
});
it('swaps to the best account: link, Escape, /exit, wait idle, resume, record', async () => { /* expect link(a3 first), then sendKey Escape, sendText '/exit' true, sendText resumeLine(null, SID, RESUME_PROMPT) true; setAgentFields(t1,{ai_account_id:'a3',rate_limited_at:null}); applyState(..., 'claude', { kind:'working', text:'Conta trocada: a1 → a3', meta:{event:'AccountSwap', from:'a1', to:'a3', auto:false} }); result { from:{id:'a1',label:'a1'}, to:{id:'a3',label:'a3'} } */ });
it('same_account or conflict moves on to the next candidate', async () => { /* link: a3 → 'same_account', a2 → 'linked' → to a2 */ });
it('NO_CANDIDATE when nothing links, and nothing was typed', async () => { /* all 'same_account' → rejects code NO_CANDIDATE; sendKey/sendText never called */ });
it('does not type into the shell when the Claude already exited (idle)', async () => { /* tab.state 'idle' → no Escape, no /exit; resume typed */ });
it('forces with C-c twice after EXIT_WAIT_MS, EXIT_TIMEOUT after EXIT_FORCE_WAIT_MS', async () => { /* no idle ever → advance timers; C-c sent twice; rejects EXIT_TIMEOUT; resume never typed */ });
it('an explicit account must be a Claude account of the tab machine', async () => { /* accountId 'c1' → PROVIDER_UNSUPPORTED; 'x1' → ACCOUNT_OTHER_MACHINE; 'a1' (current) → SAME_ACCOUNT */ });
it('NO_SESSION without a known session; SWAP_IN_PROGRESS on a concurrent call; MACHINE_OFFLINE; TOOL_MISSING', async () => { /* … */ });
it('auto text says so', async () => { /* opts.auto true → text 'Conta trocada automaticamente: a1 → a3', meta.auto true */ });
```

Write every placeholder comment above as real assertions (the comment says exactly what to assert).

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement `ai/claude-session.ts`:**

```ts
import { claudeLinkScript, parseClaudeLinkStatus, type ClaudeLinkStatus } from '@termhub/machine-ops';
import { agentRpc, requireAgentVersion } from '../agent/errors.js';
import { ControlError } from '../control/context.js';
import type { Machine } from '../db/repositories/types.js';
import { runOnMachine } from '../terminal/machine-exec.js';

/** The agent release that answers claude.linkSession. */
export const CLAUDE_LINK_MIN_AGENT_VERSION = '0.6.0';

/** Makes a Claude session resumable under another account of the machine (see machine-ops claude-session.ts). */
export async function linkClaudeSession(machine: Machine, input: { transcriptPath: string; sessionId: string; configDir: string | null }): Promise<ClaudeLinkStatus> {
  if (machine.type === 'agent') {
    requireAgentVersion(machine, CLAUDE_LINK_MIN_AGENT_VERSION);
    const { status } = await agentRpc(machine, 'claude.linkSession', { transcript_path: input.transcriptPath, session_id: input.sessionId, config_dir: input.configDir });
    return status;
  }
  const script = claudeLinkScript(input.transcriptPath, input.sessionId, input.configDir);
  const r = await runOnMachine(machine, { file: '/bin/sh', args: ['-c', script] }, script, 10_000);
  const status = r.timedOut ? null : parseClaudeLinkStatus(r.stdout);
  if (!status) throw new ControlError('LINK_FAILED', 'Não foi possível preparar a sessão na outra conta desta máquina');
  return status;
}
```

(If importing `ControlError` from `control/` into `ai/` creates a cycle, it does not: `control/context.ts` imports only auth/repos.)

In `control/agents.ts`:

```ts
/** What the resumed session is told first (spec 2026-09-26 account swap). */
export const RESUME_PROMPT = 'A conta anterior atingiu o limite de uso. Continue a tarefa de onde parou.';

/** The line that resumes a Claude session under another account; the id is a uuid, checked here too. */
export function resumeLine(configDir: string | null, sessionId: string, prompt: string): string {
  if (!isClaudeSessionId(sessionId)) throw new ControlError('NO_SESSION', 'A sessão do Claude desta aba não é válida');
  const env = configDir ? `CLAUDE_CONFIG_DIR=${configDirArg(configDir)} ` : '';
  return `${env}claude --resume ${sessionId} ${shellQuote(checkPrompt(prompt))}`;
}
```

(import `isClaudeSessionId` from `@termhub/machine-ops`). In `startAgent`, after the `sendTextToSession` try-block:

```ts
  // which account runs this tab: a later swap must not pick it again (spec 2026-09-26 account swap)
  await ctx.repos.tabs.setAgentFields(tab.tab_id, { ai_account_id: account.id }).catch(() => undefined);
```

`control/account-swap.ts`:

```ts
import type { FastifyBaseLogger } from 'fastify';
import { agents } from '../agent/registry.js';
import { linkClaudeSession } from '../ai/claude-session.js';
import { getAccountUsage } from '../ai/index.js';
import type { AiAccountUsage } from '../ai/types.js';
import type { Repositories } from '../db/repositories/index.js';
import type { AiAccount, Machine, Tab } from '../db/repositories/types.js';
import { monitorBus } from '../monitor/bus.js';
import { applyState } from '../monitor/ingest.js';
import { sendKeyToSession, sendTextToSession } from '../terminal/session-ops.js';
import { RESUME_PROMPT, resumeLine } from './agents.js';
import { ControlError } from './context.js';
import { offline } from './screen.js';

export const SWAP_MAX_UTILIZATION = 90;
export const EXIT_WAIT_MS = 15_000;
export const EXIT_FORCE_WAIT_MS = 10_000;

export interface SwapResult {
  from: { id: string; label: string } | null;
  to: { id: string; label: string };
}

/** The fullest window of the account, 0..100; null when the usage could not be read. */
export function peakUtilization(u: AiAccountUsage | undefined): number | null {
  if (!u || !u.ok || u.windows.length === 0) return null;
  return Math.max(...u.windows.map((w) => w.utilization));
}

/**
 * Most room first (lowest peak); accounts at SWAP_MAX_UTILIZATION or more are dropped unless the person
 * picked one; unknown usage goes last. Stable: ties keep the list order.
 */
export function rankCandidates(accounts: AiAccount[], usage: Map<string, AiAccountUsage>, opts: { explicit: boolean }): AiAccount[] {
  const scored = accounts.map((a, i) => ({ a, i, peak: peakUtilization(usage.get(a.id)) }));
  return scored
    .filter((s) => opts.explicit || s.peak === null || s.peak < SWAP_MAX_UTILIZATION)
    .sort((x, y) => (x.peak === null ? 1 : 0) - (y.peak === null ? 1 : 0) || (x.peak ?? 0) - (y.peak ?? 0) || x.i - y.i)
    .map((s) => s.a);
}

const swapping = new Set<string>();

/** Resolves true once the tab reports `idle` (Claude's SessionEnd), false after `ms`. */
function waitUntilIdle(repos: Repositories, tabId: string, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: boolean) => {
      if (done) return;
      done = true;
      unsubscribe();
      clearTimeout(timer);
      resolve(v);
    };
    const unsubscribe = monitorBus.subscribe((c) => {
      if (c.tab.id === tabId && c.tab.state === 'idle') finish(true);
    });
    const timer = setTimeout(() => finish(false), ms);
    // it may have gone idle between the caller's read and the subscription
    void repos.tabs.findById(tabId).then((t) => t?.state === 'idle' && finish(true), () => undefined);
  });
}

/**
 * Moves the tab's Claude session to another Claude account of the same machine and resumes it there
 * (spec 2026-09-26 account swap §4.4). Nothing on the machine changes before an account is linked;
 * nothing is overwritten or deleted. Logs ids only.
 */
export async function swapAccount(repos: Repositories, log: FastifyBaseLogger, tab: Tab, machine: Machine, opts: { accountId?: string; auto: boolean }): Promise<SwapResult> {
  if (tab.kind !== 'terminal' || !tab.tmux_session) throw new ControlError('NOT_A_TERMINAL', 'Esta aba não é um terminal');
  const session = tab.tmux_session;
  if (!tab.agent_session_id || !tab.agent_transcript_path) {
    throw new ControlError('NO_SESSION', 'O termhub não sabe qual sessão do Claude roda nesta aba (os hooks da máquina estão instalados?)');
  }
  if (machine.type === 'agent' && !agents.isOnline(machine.id)) throw offline();
  if (!machine.capabilities.includes('claude')) throw new ControlError('TOOL_MISSING', `claude não foi detectado em ${machine.name}`);
  if (swapping.has(tab.id)) throw new ControlError('SWAP_IN_PROGRESS', 'Já existe uma troca de conta em andamento nesta aba');
  swapping.add(tab.id);
  try {
    const all = (await repos.aiAccounts.list(machine.owner_id)).filter((a) => a.machine_id === machine.id && a.provider === 'claude');
    const from = all.find((a) => a.id === tab.ai_account_id) ?? null;
    let pool: AiAccount[];
    if (opts.accountId) {
      const chosen = (await repos.aiAccounts.list(machine.owner_id)).find((a) => a.id === opts.accountId);
      if (!chosen) throw new ControlError('ACCOUNT_NOT_FOUND', 'Conta não encontrada');
      if (chosen.machine_id !== machine.id) throw new ControlError('ACCOUNT_OTHER_MACHINE', `A conta "${chosen.label}" é de outra máquina`);
      if (chosen.provider !== 'claude') throw new ControlError('PROVIDER_UNSUPPORTED', 'Só contas do Claude podem assumir esta sessão');
      if (chosen.id === tab.ai_account_id) throw new ControlError('SAME_ACCOUNT', 'Esta aba já roda nessa conta');
      pool = [chosen];
    } else {
      pool = all.filter((a) => a.id !== tab.ai_account_id);
    }
    const usage = new Map<string, AiAccountUsage>();
    await Promise.all(pool.map(async (a) => usage.set(a.id, await getAccountUsage(a, machine, true).catch(() => ({ account_id: a.id, ok: false, windows: [] }) as unknown as AiAccountUsage))));
    const ranked = rankCandidates(pool, usage, { explicit: !!opts.accountId });

    let to: AiAccount | null = null;
    for (const candidate of ranked) {
      const status = await linkClaudeSession(machine, { transcriptPath: tab.agent_transcript_path, sessionId: tab.agent_session_id, configDir: candidate.config_dir });
      log.info({ tabId: tab.id, machineId: machine.id, accountId: candidate.id, status }, 'account swap: link');
      if (status === 'linked') {
        to = candidate;
        break;
      }
    }
    if (!to) throw new ControlError('NO_CANDIDATE', 'Nenhuma outra conta do Claude desta máquina tem limite disponível');

    // Claude waits for the reset on a usage limit (it does not exit): cancel that wait and leave.
    const current = (await repos.tabs.findById(tab.id)) ?? tab;
    if (current.state !== 'idle') {
      await sendKeyToSession(machine, session, 'Escape');
      await sendTextToSession(machine, session, '/exit', true);
      if (!(await waitUntilIdle(repos, tab.id, EXIT_WAIT_MS))) {
        await sendKeyToSession(machine, session, 'C-c');
        await sendKeyToSession(machine, session, 'C-c');
        if (!(await waitUntilIdle(repos, tab.id, EXIT_FORCE_WAIT_MS))) throw new ControlError('EXIT_TIMEOUT', 'O Claude desta aba não encerrou; veja a tela e tente de novo');
      }
    }
    await sendTextToSession(machine, session, resumeLine(to.config_dir, tab.agent_session_id, RESUME_PROMPT), true);

    const updated = (await repos.tabs.setAgentFields(tab.id, { ai_account_id: to.id, rate_limited_at: null })) ?? tab;
    const text = `${opts.auto ? 'Conta trocada automaticamente' : 'Conta trocada'}: ${from?.label ?? 'conta desconhecida'} → ${to.label}`;
    await applyState(repos, log, updated, 'claude', { kind: 'working', text, meta: { event: 'AccountSwap', from: from?.id ?? null, to: to.id, auto: opts.auto } });
    log.info({ tabId: tab.id, machineId: machine.id, from: from?.id ?? null, to: to.id, auto: opts.auto }, 'account swap: done');
    return { from: from && { id: from.id, label: from.label }, to: { id: to.id, label: to.label } };
  } finally {
    swapping.delete(tab.id);
  }
}

export function autoSwapOnLimit(_repos: Repositories, _log: FastifyBaseLogger, _tab: Tab): void {
  // Task 6
}
```

Adjust to the real `AiAccountUsage` shape in `apps/server/src/ai/types.ts` (fields `ok`, `windows[].utilization`) and the real `Interpreted` type (import it from `monitor/state.ts` if `applyState` needs it). If `sendTextToSession` refuses `/exit` for a reason, read `session-ops.ts` before changing anything.

- [ ] **Step 4: Run, expect PASS** — `npx -w @termhub/server vitest run src/ai src/control` + typecheck.
- [ ] **Step 5: Commit** — `"Server: swap a tab's Claude session to another account"`.

---

### Task 6: triggers — route, automatic swap

**Files:**
- Modify: `apps/server/src/routes/tabs.ts` (+ `routes/tabs.test.ts`)
- Modify: `apps/server/src/control/account-swap.ts` (`autoSwapOnLimit`) (+ `account-swap.test.ts`)

**Interfaces:**
- Consumes: `swapAccount`, `SwapResult` (Task 5); `Machine.claude_auto_swap` (Task 3); `applyState`.
- Produces: `POST /api/tabs/:id/account-swap` body `{ account_id?: string }` → `200 { from, to }`; errors `409 { message }` for every `ControlError`; `AUTO_SWAP_COOLDOWN_MS`, `AUTO_SWAP_DELAY_MS = 3000`; `autoSwapOnLimit(repos, log, tab): void` (never throws, never awaited).

- [ ] **Step 1: Failing tests.**
  `routes/tabs.test.ts` (follow its app/auth fixtures; mock `../control/account-swap.js`):
  - POST with `{}` calls `swapAccount(repos, log, tab, machine, { accountId: undefined, auto: false })` and answers the result;
  - `{ account_id: 42 }` → 400;
  - a tab outside the scope → 404, `swapAccount` not called;
  - `swapAccount` rejecting `new ControlError('NO_CANDIDATE', 'msg')` → 409 with `message: 'msg'`;
  - a role without `terminals:update` → 403.
  `account-swap.test.ts`:
  - machine with `claude_auto_swap: false` → no swap;
  - enabled → after `AUTO_SWAP_DELAY_MS` a swap with `auto: true` runs (fake timers; spy the module's own swap by checking `linkClaudeSession` was called);
  - a second `autoSwapOnLimit` for the same tab within `AUTO_SWAP_COOLDOWN_MS` does nothing; after it, it swaps again;
  - a failing swap records `applyState(…, { kind: 'waiting_input', text: 'Troca automática falhou: <msg>', meta: { event: 'AccountSwapFailed', error: <code> } })` and does not throw.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** In `routes/tabs.ts`:

```ts
const swapBody = z.object({ account_id: z.string().min(1).max(64).optional() }).default({});

  /**
   * Moves the tab's Claude session to another Claude account of its machine and resumes it there
   * (spec 2026-09-26 account swap). Without account_id, the account with the most room is chosen.
   */
  app.post('/:id/account-swap', { config: { action: 'update' } }, async (request) => {
    const { id } = idParam.parse(request.params);
    const body = swapBody.parse(request.body ?? {});
    const { tab, machine } = await scoped(repos, request).tab(id);
    try {
      return await swapAccount(repos, request.log, tab, machine, { accountId: body.account_id, auto: false });
    } catch (e) {
      if (e instanceof ControlError) throw conflict(e.message);
      throw e;
    }
  });
```

(`conflict` is already imported; import `ControlError` and `swapAccount`.) In `account-swap.ts` replace the stub:

```ts
export const AUTO_SWAP_COOLDOWN_MS = 10 * 60_000;
/** Claude Code draws its "waiting for the reset" prompt right after the hook: let it settle first. */
export const AUTO_SWAP_DELAY_MS = 3_000;
const lastAuto = new Map<string, number>();

/**
 * A tab hit a usage limit: when its machine opted in, swap it by itself — at most once per tab per
 * AUTO_SWAP_COOLDOWN_MS, so two exhausted accounts never ping-pong. Fire-and-forget; a failure is
 * written on the tab (the person still sees the limit) and never thrown.
 */
export function autoSwapOnLimit(repos: Repositories, log: FastifyBaseLogger, tab: Tab): void {
  void (async () => {
    const machine = await repos.machines.findById(tab.machine_id);
    if (!machine?.claude_auto_swap) return;
    const now = Date.now();
    const last = lastAuto.get(tab.id);
    if (last !== undefined && now - last < AUTO_SWAP_COOLDOWN_MS) {
      log.info({ tabId: tab.id, machineId: machine.id }, 'account swap: auto skipped (cooldown)');
      return;
    }
    lastAuto.set(tab.id, now);
    await new Promise((r) => setTimeout(r, AUTO_SWAP_DELAY_MS));
    try {
      await swapAccount(repos, log, tab, machine, { auto: true });
    } catch (e) {
      const code = e instanceof ControlError ? e.code : 'INTERNAL';
      const message = e instanceof Error ? e.message : 'erro desconhecido';
      log.warn({ tabId: tab.id, machineId: machine.id, code }, 'account swap: auto failed');
      const current = (await repos.tabs.findById(tab.id)) ?? tab;
      await applyState(repos, log, current, 'claude', { kind: 'waiting_input', text: `Troca automática falhou: ${message}`, meta: { event: 'AccountSwapFailed', error: code } });
    }
  })().catch((e) => log.error({ tabId: tab.id, err: e instanceof Error ? e.message : 'unknown' }, 'account swap: auto crashed'));
}
```

- [ ] **Step 4: Run, expect PASS** — `npx -w @termhub/server vitest run src/routes/tabs.test.ts src/control src/monitor` + typecheck.
- [ ] **Step 5: Commit** — `"Account swap: route and opt-in automatic swap"`.

---

### Task 7: web — banner and automatic-swap setting

**Files:**
- Modify: `apps/web/src/lib/types.ts` (`Tab`, `Machine`)
- Modify: `apps/web/src/lib/api.ts` (`tabs.swapAccount`)
- Create: `apps/web/src/components/RateLimitBanner.tsx`, `apps/web/src/components/RateLimitBanner.test.tsx`
- Modify: `apps/web/src/components/TerminalsView.tsx` (render the banner under `TabBar`)
- Create: `apps/web/src/components/AutoSwapSettings.tsx`, `apps/web/src/components/AutoSwapSettings.test.tsx`
- Modify: `apps/web/src/components/AiAccountsView.tsx` (render `AutoSwapSettings` under the list)
- Fix: web test fixtures that build `Tab`/`Machine` literals (typecheck).

**Interfaces:**
- Consumes: route from Task 6; `Machine.claude_auto_swap` via `useData().updateMachine(id, { claude_auto_swap })`.
- Produces: `api.tabs.swapAccount(id: string, accountId?: string): Promise<{ from: { id: string; label: string } | null; to: { id: string; label: string } }>`; `<RateLimitBanner tab={Tab} canSwap={boolean} />`; `<AutoSwapSettings machines={Machine[]} accounts={AiAccount[]} />`.

- [ ] **Step 1: Failing tests** (Testing Library, like `AgentUpdateCard.test.tsx`; mock `../lib/api`):

`RateLimitBanner.test.tsx`:
  - renders nothing when `rate_limited_at` is null, or when `state === 'working'`;
  - renders `Limite de uso da conta atingido.` and a `Trocar conta e retomar` button otherwise; no button when `canSwap` is false;
  - click calls `api.tabs.swapAccount('t1')`, disables the button while pending (`Trocando…`), then shows `Retomando em <to.label>…`;
  - a rejected call shows the `ApiError` message.

`AutoSwapSettings.test.tsx`:
  - lists only machines with ≥ 2 Claude accounts; renders nothing when none;
  - label `Trocar de conta sozinho quando o Claude atingir o limite em <nome>`; checked reflects `claude_auto_swap`;
  - toggling calls `updateMachine(id, { claude_auto_swap: true })`; an error reverts the box and shows the message.

- [ ] **Step 2: Run, expect FAIL** — `npx -w @termhub/web vitest run src/components/RateLimitBanner.test.tsx src/components/AutoSwapSettings.test.tsx`.
- [ ] **Step 3: Implement.** `types.ts` `Tab`: `ai_account_id: string | null; /** set while its Claude is stuck on a usage limit */ rate_limited_at: string | null;` `Machine`: `claude_auto_swap: boolean;`. `api.ts` in `tabs`:

```ts
    swapAccount: (id: string, accountId?: string) =>
      request<{ from: { id: string; label: string } | null; to: { id: string; label: string } }>('POST', `/tabs/${id}/account-swap`, accountId ? { account_id: accountId } : {}),
```

`RateLimitBanner.tsx`:

```tsx
import { useState } from 'react';
import { api, ApiError } from '../lib/api';
import type { Tab } from '../lib/types';

/** Shown above a tab whose Claude stopped on a usage limit (spec 2026-09-26 account swap). */
export function RateLimitBanner({ tab, canSwap }: { tab: Pick<Tab, 'id' | 'state' | 'rate_limited_at'>; canSwap: boolean }) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!tab.rate_limited_at || tab.state === 'working') return null;
  const swap = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.tabs.swapAccount(tab.id);
      setDone(r.to.label);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Não foi possível trocar de conta');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div role="status" className="flex flex-wrap items-center gap-2 border-b border-warn/30 bg-warn/10 px-3 py-1 text-xs text-warn">
      <span>Limite de uso da conta atingido.</span>
      {done ? (
        <span>Retomando em {done}…</span>
      ) : (
        canSwap && (
          <button type="button" className="btn-secondary px-2 py-0.5 text-xs" disabled={busy} onClick={() => void swap()}>
            {busy ? 'Trocando…' : 'Trocar conta e retomar'}
          </button>
        )
      )}
      {error && <span className="text-danger">{error}</span>}
    </div>
  );
}
```

(Use whatever small-button class the codebase already uses — check `AgentUpdateCard.tsx`.) In `TerminalsView.tsx`, after `<TabBar … />`: find the focused tab's live row — `const { items } = useMonitor()` from `../lib/monitor`, `const live = items.find((i) => i.tab.id === focusedTabId)?.tab ?? (tabs ?? []).find((t) => t.id === focusedTabId)` — and render `{live && <RateLimitBanner tab={live} canSwap={can('terminals', 'update')} />}` (use the permission hook the file/`MainNav.tsx` already uses for `can`).

`AutoSwapSettings.tsx`: for each machine with ≥ 2 `provider === 'claude'` accounts, a checkbox row with the label above, optimistic toggle with revert on error (copy the pattern of `AgentUpdateCard.tsx` `setAuto`). Heading `Troca automática de conta`, hint `Quando uma aba do Claude atingir o limite de uso, o termhub retoma a mesma sessão em outra conta desta máquina.` Render it in `AiAccountsView.tsx` below the accounts list with the accounts it already loaded and `useData().machines`.

- [ ] **Step 4: Run, expect PASS** — `npm run build -w @termhub/web` (typecheck + build) and `npx -w @termhub/web vitest run`.
- [ ] **Step 5: Commit** — `"Web: swap-account banner and automatic swap setting"`.

---

### Task 8: whole-branch verification

- [ ] **Step 1:** Run the CI-equivalent in Docker: `npm run prisma:generate && npm run build:packages && npm test -w @termhub/agent && npm run typecheck -w @termhub/agent && npm test -w @termhub/agent-protocol && npm test -w @termhub/machine-ops && (cd apps/server && npx prisma migrate deploy) && npm test -w @termhub/server && npm run typecheck -w @termhub/server && npm run build -w @termhub/web && npm test -w @termhub/web && npm run build -w @termhub/landing`, plus the drift check `cd apps/server && npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url "$DATABASE_URL"_shadow --exit-code` (create the `termhub_shadow` DB in `th-ter55-db` first) — or reproduce the exact command the `deploy.yml` drift step uses.
- [ ] **Step 2:** Real-machine smoke on jarvis without touching production: in a scratch dir, with a fake transcript under a temp `CLAUDE_CONFIG_DIR`, run `claudeLinkScript` output via `sh -c` and confirm `claude --resume` finds it (the spike already proved the mechanism; this proves the generated script).
- [ ] **Step 3:** Commit any fixes; `rm -rf .npm`.
