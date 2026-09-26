# Concierge Always Free Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The person can message the concierge at any time. A message sent while a turn or a background
subagent is running is injected into the live CLI session (or queued, on an old agent) instead of
being refused. Delegated work is forced into background subagents, whose results reach the chat as
new messages.

**Architecture:** A chat run on a stream-capable agent is one long-lived `claude -p` process with
`--input-format stream-json --replay-user-messages`. The server writes one JSON line per message and
matches each answer to its message through the replayed `uuid`. A `PreToolUse` hook shipped in the
agent refuses foreground subagents, and an orchestrator prompt tells the concierge how to delegate.
Old agents keep the one-shot run and get a server-side queue.

**Tech Stack:** TypeScript (Node 20/22), Fastify, zod, vitest, React (web), Expo/jest (mobile),
Claude Code CLI 2.1.283 stream-json.

**Spec:** `docs/superpowers/specs/2026-09-26-concierge-always-free-design.md`

## Global Constraints

- Commit messages, docs and code comments are in English. UI copy stays in pt-BR.
- Address workspaces by package name (`-w @termhub/server`), never by path.
- This host has no Node: run every npm command through Docker:
  `docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:20 sh -c '<cmd>'`,
  then `rm -rf .npm`. Never reuse or touch a production container name. Throwaway containers are
  unnamed (`--rm`) or `th-*`.
- Terminal content, prompts and tokens are never logged. Log only metadata (ids, sizes).
- The one-shot argv (no `stream_input`) must stay byte-for-byte what it is today. Old agents must see
  exactly the open frame they see today.
- `DISALLOWED_TOOLS` stays `Bash,Read,Write,Edit,WebFetch,WebSearch`.
- No push, no merge, no deploy, no `npm publish`.
- The agent version goes from `0.5.2` to `0.6.0`, in `apps/agent/package.json` and
  `apps/agent/src/version.ts` (`version.test.ts` checks they match).
- The worktree is `/home/pedrogoiania/termhub-wt-concierge-always-free`, branch
  `feat/concierge-always-free`. Commit there only.
- If `node_modules` is missing in the worktree, run
  `npm ci --ignore-scripts=false` through the Docker command above once, before the first test.

## Review Focus

1. **A message typed in the gap after the server ended the input but before the process exited.** It
   must be answered by the next process, not lost and not failed. Test: Task 6
   ("a message that finds the input closed is queued and answered by the next process").
2. **Two messages injected back to back while a turn is running.** Each gets its own answer, in
   order, and neither answer contains the other's text. Test: Task 5
   ("two injected turns get one answer each, in the order of their replays").
3. **The process dies (deploy, laptop sleeps) with an injected turn open.** That turn is stored with
   an error code and its `done` settles, so the web POST returns. Test: Task 5
   ("a stream that ends with turns open fails each one").
4. **A subagent's own tool calls and text.** They never show as the concierge's actions or text.
   Test: Task 3 (subagent frames ignored), and in the real fixture in Task 5.
5. **An old agent (no `claude.stream_input`).** It gets the same argv, the same open frame and no
   orchestrator prompt, and a second message is queued. Test: Task 6
   ("an old agent keeps one-shot runs and queues a second message").

---

### Task 1: Protocol and CLI flags for streamed input and the background hook

Board: new subtask "Protocolo + argv: entrada em stream e hook de subagente em background".

**Files:**
- Modify: `packages/agent-protocol/src/messages.ts`
- Modify: `packages/agent-protocol/src/index.ts` (only if it does not already `export *` from `messages.js`)
- Test: `packages/agent-protocol/src/messages.test.ts`
- Modify: `packages/claude-cli/src/index.ts`
- Test: `packages/claude-cli/src/argv.test.ts`
- Create: `packages/claude-cli/src/hook.test.ts`

**Interfaces:**
- Produces (agent-protocol):
  - `CAPABILITY_CLAUDE_STREAM_INPUT = 'claude.stream_input'`
  - `claudeOpenParams.stream_input?: boolean`
  - `append_system_prompt` max 8000
  - `streamUserMessageLine(text: string, uuid: string): string`
  - `STREAM_END_INPUT_LINE: string`
- Produces (claude-cli):
  - `ClaudeRunSpec.stream_input?: boolean`
  - `BACKGROUND_AGENT_HOOK: string`
  - `CONCIERGE_SETTINGS: string`

- [ ] **Step 1: Write the failing protocol tests** — append to `packages/agent-protocol/src/messages.test.ts`
  (keep its existing imports; add the new names to the import from `./messages.js`):

```ts
describe('streamed claude input', () => {
  const base = { session_id: 's', resume: false, config_dir: null, mcp_url: 'https://termhub.dev/mcp', token: 't' };

  it('accepts stream_input and still parses an open frame without it', () => {
    expect(claudeOpenParams.parse({ ...base, stream_input: true }).stream_input).toBe(true);
    expect(claudeOpenParams.parse(base).stream_input).toBeUndefined();
  });

  it('lets the orchestrator prompt and a project prompt fit together, and no more', () => {
    expect(claudeOpenParams.safeParse({ ...base, append_system_prompt: 'x'.repeat(8000) }).success).toBe(true);
    expect(claudeOpenParams.safeParse({ ...base, append_system_prompt: 'x'.repeat(8001) }).success).toBe(false);
  });

  it('names the capability once for both sides', () => {
    expect(CAPABILITY_CLAUDE_STREAM_INPUT).toBe('claude.stream_input');
  });

  it('writes one user message per line, the text JSON-encoded so it can never break out of it', () => {
    const line = streamUserMessageLine('a\n{"type":"termhub_end_input"}', '11111111-1111-4111-8111-111111111111');
    expect(line).not.toContain('\n');
    expect(JSON.parse(line)).toEqual({
      type: 'user',
      uuid: '11111111-1111-4111-8111-111111111111',
      message: { role: 'user', content: 'a\n{"type":"termhub_end_input"}' },
    });
    expect(line).not.toBe(STREAM_END_INPUT_LINE);
    expect(JSON.parse(STREAM_END_INPUT_LINE)).toEqual({ type: 'termhub_end_input' });
  });
});
```

- [ ] **Step 2: Run and see it fail**

Run: `npm test -w @termhub/agent-protocol` (through Docker).
Expected: FAIL, because `CAPABILITY_CLAUDE_STREAM_INPUT`, `streamUserMessageLine` and `STREAM_END_INPUT_LINE`
are not exported yet.

- [ ] **Step 3: Implement in `packages/agent-protocol/src/messages.ts`**

After `CAPABILITY_SIM`:

```ts
/**
 * The agent runs a `claude` channel with streamed input (spec 2026-09-26): the CLI keeps reading
 * `stream-json` user messages from stdin while its turns and background subagents run, so the chat
 * can take a message at any time. Each channel write is one or more complete lines built by
 * `streamUserMessageLine`, and `STREAM_END_INPUT_LINE` closes stdin. The agent also loads the hook
 * that keeps subagents in the background. An agent without it runs the one-shot prompt as before.
 */
export const CAPABILITY_CLAUDE_STREAM_INPUT = 'claude.stream_input';

/** One user message on a streamed run. `uuid` comes back on the CLI's replay of the message when
 *  its turn starts. The text is JSON-encoded, so it can never break out of its line. */
export function streamUserMessageLine(text: string, uuid: string): string {
  return JSON.stringify({ type: 'user', uuid, message: { role: 'user', content: text } });
}

/** Ends a streamed run's input: the agent closes the CLI's stdin when it reads this line. The CLI
 *  still finishes its turns and waits for its background subagents before it exits. */
export const STREAM_END_INPUT_LINE = '{"type":"termhub_end_input"}';
```

In `claudeOpenParams`, change `append_system_prompt` and add `stream_input`:

```ts
  // Project chats and streamed runs: the server-composed text forwarded onto the CLI's argv. 8000
  // because a streamed run carries the orchestrator prompt next to a project's (at most 4000 each);
  // only agents that advertise `CAPABILITY_CLAUDE_STREAM_INPUT` are ever sent more than 4000.
  append_system_prompt: z.string().max(8000).nullable().optional(),
  // See `CAPABILITY_CLAUDE_STREAM_INPUT`. Absent on every one-shot run, whose open frame must not change.
  stream_input: z.boolean().optional(),
```

Keep the existing comment line about project chats above `append_system_prompt`, merged into the
comment above. Check `packages/agent-protocol/src/index.ts` re-exports `messages.js` (`export *`);
if it lists names instead, add the three new ones.

- [ ] **Step 4: Run the protocol tests**

Run: `npm test -w @termhub/agent-protocol`. Expected: PASS.

- [ ] **Step 5: Write the failing claude-cli tests**

Append to `packages/claude-cli/src/argv.test.ts`, inside `describe('buildClaudeArgs', …)`, and add
`CONCIERGE_SETTINGS` to the import:

```ts
  it('streams input, replays messages and loads the background hook only when asked', () => {
    const args = buildClaudeArgs({ ...spec, stream_input: true });
    const i = args.indexOf('--disallowed-tools');
    expect(args.slice(i + 2, i + 7)).toEqual(['--input-format', 'stream-json', '--replay-user-messages', '--settings', CONCIERGE_SETTINGS]);
    // The one-shot argv is exactly what it always was.
    expect(buildClaudeArgs({ ...spec, stream_input: false })).toEqual(buildClaudeArgs(spec));
    expect(buildClaudeArgs(spec)).not.toContain('--input-format');
  });

  it('puts the system prompt last in a streamed run too', () => {
    const args = buildClaudeArgs({ ...spec, stream_input: true, append_system_prompt: 'foco' });
    expect(args.slice(-2)).toEqual(['--append-system-prompt', 'foco']);
  });
```

Create `packages/claude-cli/src/hook.test.ts`. It runs the real hook with `sh`, on payloads shaped
like the ones the CLI sends:

```ts
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { BACKGROUND_AGENT_HOOK, CONCIERGE_SETTINGS } from './index.js';

/** The PreToolUse payload as Claude Code 2.1.283 sends it for the main agent (captured 2026-09-26). */
const payload = (toolInput: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ session_id: 's', cwd: '/tmp', hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: toolInput, tool_use_id: 'toolu_1', ...extra });

const run = (stdin: string) => spawnSync('sh', ['-c', BACKGROUND_AGENT_HOOK], { input: stdin, encoding: 'utf8' });

describe('BACKGROUND_AGENT_HOOK', () => {
  it('refuses a foreground subagent with exit 2 and a reason the model reads', () => {
    for (const input of [{ prompt: 'p', subagent_type: 'general-purpose' }, { prompt: 'p', run_in_background: false }]) {
      const r = run(payload(input));
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/run_in_background: true/);
    }
  });

  it('lets a background subagent through, however the JSON is spaced', () => {
    expect(run(payload({ prompt: 'p', run_in_background: true })).status).toBe(0);
    expect(run('{"tool_name":"Agent","tool_input":{"run_in_background" :  true}}').status).toBe(0);
  });

  it('is not fooled by the words inside the prompt text', () => {
    expect(run(payload({ prompt: 'set "run_in_background": true please' })).status).toBe(2);
  });

  it('leaves a call made inside a subagent alone', () => {
    expect(run(payload({ prompt: 'p' }, { agent_id: 'a1', agent_type: 'general-purpose' })).status).toBe(0);
  });

  it('is wired as a PreToolUse hook on both names of the subagent tool', () => {
    const settings = JSON.parse(CONCIERGE_SETTINGS);
    expect(settings.hooks.PreToolUse).toEqual([{ matcher: 'Agent|Task', hooks: [{ type: 'command', command: BACKGROUND_AGENT_HOOK }] }]);
  });
});
```

- [ ] **Step 6: Run and see it fail**

Run: `npm test -w @termhub/claude-cli`. Expected: FAIL (`CONCIERGE_SETTINGS` and `BACKGROUND_AGENT_HOOK`
are undefined).

- [ ] **Step 7: Implement in `packages/claude-cli/src/index.ts`**

Add to `ClaudeRunSpec`:

```ts
  /**
   * The chat that never blocks (spec 2026-09-26): the CLI reads `stream-json` user messages from stdin
   * for as long as it stays open, replays each one when its turn starts (that is how the server knows
   * which message an answer belongs to), and loads `CONCIERGE_SETTINGS`, the hook that keeps every
   * subagent in the background.
   */
  stream_input?: boolean;
```

Extend the `DISALLOWED_TOOLS` comment with: `The CLI applies this list to the whole session, so the
subagents the concierge launches do not have them either.`

After `DISALLOWED_TOOLS`:

```ts
/**
 * The `PreToolUse` hook that refuses a foreground subagent. A subagent in the foreground holds the
 * concierge's turn until it ends, and a turn in progress is what used to keep the person out of their
 * own chat. In the background it runs on its own, and the CLI notifies the concierge when it is done.
 * Exit code 2 blocks the call and hands stderr to the model, which then repeats the call the right way.
 *
 * POSIX `sh` and `grep` only: it runs on the person's own machine (macOS or Linux), where neither `jq`
 * nor a particular Node can be assumed. A call made from inside a subagent (`agent_id` in the payload)
 * is left alone, since that subagent is already off the concierge's turn. The pattern only matches
 * the payload's own key: inside a JSON string the quotes are escaped and never match.
 */
export const BACKGROUND_AGENT_HOOK =
  `input=$(cat); case "$input" in *'"agent_id"'*) exit 0;; esac; ` +
  `printf '%s' "$input" | grep -Eq '"run_in_background"[[:space:]]*:[[:space:]]*true' && exit 0; ` +
  `echo 'No chat do termhub todo subagente roda em segundo plano: repita esta chamada do Agent com run_in_background: true.' >&2; exit 2`;

/** The settings a streamed chat run loads with `--settings`: the hook above, on the subagent tool
 *  under both of its names (`Task` on older CLIs). The CLI merges them with the account's own. */
export const CONCIERGE_SETTINGS = JSON.stringify({
  hooks: { PreToolUse: [{ matcher: 'Agent|Task', hooks: [{ type: 'command', command: BACKGROUND_AGENT_HOOK }] }] },
});
```

In `buildClaudeArgs`, right after `'--disallowed-tools', DISALLOWED_TOOLS,`:

```ts
    ...(spec.stream_input ? ['--input-format', 'stream-json', '--replay-user-messages', '--settings', CONCIERGE_SETTINGS] : []),
```

- [ ] **Step 8: Run both packages' tests and typechecks**

Run: `npm test -w @termhub/agent-protocol && npm test -w @termhub/claude-cli && npm run typecheck -w @termhub/agent-protocol && npm run typecheck -w @termhub/claude-cli`.
Expected: all PASS.

- [ ] **Step 9: Build the two packages** (the agent and server tests import their `dist`)

Run: `npm run build -w @termhub/agent-protocol -w @termhub/claude-cli`.

- [ ] **Step 10: Commit**

```bash
git add packages/agent-protocol packages/claude-cli
git commit -m "Protocol: streamed claude input and the background-subagent hook"
```

(End every commit message body with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.)

---

### Task 2: Agent runs a streamed claude channel (0.6.0)

Board: new subtask "Agente 0.6.0: canal claude com entrada em stream".

**Files:**
- Modify: `apps/agent/src/claude/run.ts`
- Modify: `apps/agent/src/run.ts` (the `CAPABILITIES` list)
- Modify: `apps/agent/package.json`, `apps/agent/src/version.ts` (0.6.0)
- Test: `apps/agent/src/claude/run.test.ts`

**Interfaces:**
- Consumes: Task 1 (`CAPABILITY_CLAUDE_STREAM_INPUT`, `STREAM_END_INPUT_LINE`,
  `claudeOpenParams.stream_input`, `ClaudeRunSpec.stream_input`).
- Produces: an agent that advertises `claude.stream_input`. In a `stream_input` open:
  - every complete line of channel data is written to the CLI's stdin;
  - `STREAM_END_INPUT_LINE` closes stdin;
  - the run timeout is 60 min unless `deps.timeoutMs` is set.

- [ ] **Step 1: Write the failing tests** — append inside `describe('createClaudeManager', …)` in
  `apps/agent/src/claude/run.test.ts`, and add `CAPABILITY_CLAUDE_STREAM_INPUT, STREAM_END_INPUT_LINE`
  to the `@termhub/agent-protocol` import:

```ts
  it('declares the streamed-input capability', () => {
    expect(CAPABILITIES).toContain(CAPABILITY_CLAUDE_STREAM_INPUT);
  });

  it('in a streamed run keeps stdin open across writes, line by line, until the end-of-input line', async () => {
    const { bin, out, runs } = fakeCli(RECORDER);
    const { socket, sendControl } = makeSocket();
    const log = vi.fn();
    const claude = createClaudeManager({ log, env: pathEnv(bin), tmpDir: runs });

    await claude.open(1, { ...baseParams, stream_input: true }, socket);
    // The first message, then a second one split across two frames, then the end.
    claude.write(1, Buffer.from('{"type":"user","n":1}\n'));
    claude.write(1, Buffer.from('{"type":"user",'));
    claude.write(1, Buffer.from('"n":2}\n'));
    await sleep(100);
    // stdin is still open: the recorder is still in `cat`, so it has not printed its result.
    expect(controlOf(sendControl, 'closed')).toBeUndefined();
    claude.write(1, Buffer.from(`${STREAM_END_INPUT_LINE}\n`));
    await waitForClosed(sendControl);

    expect(readFileSync(join(out, 'stdin'), 'utf8')).toBe('{"type":"user","n":1}\n{"type":"user","n":2}\n');
    const argv = argvOf(out);
    expect(argv).toEqual(buildClaudeArgs({ session_id: baseParams.session_id, resume: false, mcp_config_path: argv[argv.indexOf('--mcp-config') + 1], model: null, stream_input: true }));
    // Nothing of what the lines said reaches a log.
    expect(JSON.stringify(log.mock.calls)).not.toContain('"n":2');
  });

  it('drops what arrives after the end-of-input line, logging only its size', async () => {
    const { bin, out, runs } = fakeCli(RECORDER);
    const { socket, sendControl } = makeSocket();
    const log = vi.fn();
    const claude = createClaudeManager({ log, env: pathEnv(bin), tmpDir: runs });

    await claude.open(1, { ...baseParams, stream_input: true }, socket);
    claude.write(1, Buffer.from(`{"a":1}\n${STREAM_END_INPUT_LINE}\n{"late":true}\n`));
    expect(claude.write(1, Buffer.from('{"later":true}\n'))).toBe(true);
    await waitForClosed(sendControl);

    expect(readFileSync(join(out, 'stdin'), 'utf8')).toBe('{"a":1}\n');
    expect(JSON.stringify(log.mock.calls)).not.toContain('late');
  });

  it('keeps the one-shot run exactly as it was when stream_input is absent', async () => {
    const { bin, out, runs } = fakeCli(RECORDER);
    const { socket, sendControl } = makeSocket();
    const claude = createClaudeManager({ log: vi.fn(), env: pathEnv(bin), tmpDir: runs });

    await claude.open(1, baseParams, socket);
    claude.write(1, Buffer.from('linha sem quebra'));
    await waitForClosed(sendControl);
    expect(readFileSync(join(out, 'stdin'), 'utf8')).toBe('linha sem quebra');
    expect(argvOf(out)).not.toContain('--input-format');
  });
```

- [ ] **Step 2: Run and see them fail**

Run: `npm test -w @termhub/agent -- src/claude/run.test.ts`. Expected: FAIL. The capability is
missing, and stdin closes on the first write.

- [ ] **Step 3: Implement in `apps/agent/src/claude/run.ts`**

- Import `STREAM_END_INPUT_LINE` from `@termhub/agent-protocol`.
- Constants, next to `DEFAULT_TIMEOUT_MS`:

```ts
/** A streamed run hosts the chat's background subagents, which can take far longer than one answer. */
const STREAM_TIMEOUT_MS = 60 * 60 * 1000;
/** Input not yet framed into a line: a server that never sends a newline cannot grow this for ever. */
const MAX_PENDING_INPUT_BYTES = 256 * 1024;
```

- Extend `interface Run`:

```ts
  /** Streamed input (`stream_input`): stdin stays open and takes one line per message. */
  stream: boolean;
  /** Bytes after the last newline of a streamed run's input. */
  inputTail: string;
  /** The end-of-input line arrived: stdin is closed, and anything after it is dropped. */
  inputEnded: boolean;
```

- In `open`:
  - `const stream = params.stream_input === true;`
  - pass `stream_input: stream` to `buildClaudeArgs`;
  - timer: `deps.timeoutMs ?? (stream ? STREAM_TIMEOUT_MS : DEFAULT_TIMEOUT_MS)` (both in the
    `setTimeout` and in its log line);
  - log line: `deps.log('claude run starting', { ch, resume: params.resume, model: params.model ?? null, stream });`;
  - in the `run` object: `stream, inputTail: '', inputEnded: false,`.
- Replace `write`:

```ts
    write(ch: number, data: Buffer): boolean {
      const run = runs.get(ch);
      if (!run) return false; // not one of ours: the caller routes the frame to the pty manager
      if (!run.stream) {
        if (run.promptSent) {
          // The size, never the content: this is the prompt.
          deps.log('extra data on a claude channel ignored', { ch, bytes: data.length });
          return true;
        }
        run.promptSent = true;
        run.promptArrived();
        // The prompt goes in on stdin and nowhere else: argv is visible to every process on this
        // machine, and a prompt beginning with `-` would be read as a flag there. It arrives as one
        // frame and is the CLI's whole input, so stdin closes with it — `claude -p` waits for EOF.
        run.child.stdin?.end(data);
        return true;
      }
      // Streamed input: every complete line is one message for the CLI, written as it arrives; the
      // end-of-input line closes stdin. The CLI then finishes its turns and background subagents.
      run.promptSent = true;
      run.promptArrived();
      if (run.inputEnded) {
        deps.log('claude input after its end ignored', { ch, bytes: data.length });
        return true;
      }
      run.inputTail += data.toString('utf8');
      for (;;) {
        const nl = run.inputTail.indexOf('\n');
        if (nl === -1) break;
        const line = run.inputTail.slice(0, nl);
        run.inputTail = run.inputTail.slice(nl + 1);
        if (line === STREAM_END_INPUT_LINE) {
          run.inputEnded = true;
          if (run.inputTail.length > 0) deps.log('claude input after its end ignored', { ch, bytes: Buffer.byteLength(run.inputTail, 'utf8') });
          run.inputTail = '';
          run.child.stdin?.end();
          return true;
        }
        if (line.trim()) run.child.stdin?.write(`${line}\n`);
      }
      if (Buffer.byteLength(run.inputTail, 'utf8') > MAX_PENDING_INPUT_BYTES) {
        deps.log('claude input line too large, dropped', { ch, bytes: Buffer.byteLength(run.inputTail, 'utf8') });
        run.inputTail = '';
      }
      return true;
    },
```

- Update the `ClaudeManager.write` doc in `apps/agent/src/dispatch.ts`: `The prompt (a one-shot run)
  or the next lines of input (a streamed run), as channel data.`
- In `apps/agent/src/run.ts`: add `CAPABILITY_CLAUDE_STREAM_INPUT` to the import and to
  `CAPABILITIES`.
- Bump the version to `0.6.0` in `apps/agent/package.json` and `apps/agent/src/version.ts`.

- [ ] **Step 4: Run the agent suite and typecheck**

Run: `npm test -w @termhub/agent && npm run typecheck -w @termhub/agent`. Expected: PASS, including
`version.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add apps/agent
git commit -m "Agent: stream a claude channel's input line by line (0.6.0)"
```

---

### Task 3: Server stream frames for turns, background tasks and subagents

Board: new subtask "Servidor: frames de turno, background e subagente no stream".

**Files:**
- Modify: `apps/server/src/chat/stream.ts`
- Modify: `apps/server/src/chat/service.ts` (only the move of `ChatErrorCode`/`codeForReason`)
- Test: `apps/server/src/chat/stream.test.ts`
- Fixture (already committed with this plan): `apps/server/src/chat/fixtures/stream-background.ndjson`.
  This is a real run of Claude Code 2.1.283 in stream mode:
  1. message `11111111-…` launches a background subagent;
  2. message `22222222-…` is injected while the subagent runs and answered `Paris`;
  3. the notification turn answers `O subagente terminou: texto sobre faróis pronto.`

**Interfaces:**
- Produces:
  - `ChatFrame` gains `{ type: 'turn_started'; uuid: string }` and `{ type: 'background'; count: number }`;
  - the `error` frame gains `turn_ended?: boolean`;
  - `stream.ts` exports `type ChatErrorCode` and `codeForReason(reason?: ChatFailureReason): ChatErrorCode`,
    moved from `service.ts`, which re-exports the type (`export type { ChatErrorCode } from './stream.js';`)
    so every current importer keeps compiling.

- [ ] **Step 1: Write the failing tests** — append to `apps/server/src/chat/stream.test.ts`:

```ts
const backgroundFixture = readFileSync(join(import.meta.dirname, 'fixtures/stream-background.ndjson'), 'utf8').split('\n').filter(Boolean);

it('reads a streamed run: turns start on their replay, background tasks are counted, subagent frames are ignored', () => {
  const frames = backgroundFixture.map(parseFrame).filter((f) => f !== null);
  expect(frames.filter((f) => f!.type === 'turn_started')).toEqual([
    { type: 'turn_started', uuid: '11111111-1111-4111-8111-111111111111' },
    { type: 'turn_started', uuid: '22222222-2222-4222-8222-222222222222' },
  ]);
  expect(frames.filter((f) => f!.type === 'background').map((f) => (f as { count: number }).count)).toEqual([1, 0]);
  expect(frames.filter((f) => f!.type === 'done')).toHaveLength(3);
  // The concierge's own call to Agent is an action; the subagent's own frames are nobody's.
  const actions = frames.filter((f) => f!.type === 'action') as { tool: string }[];
  expect(actions.map((a) => a.tool)).toEqual(['Agent']);
  const text = frames.filter((f) => f!.type === 'text').map((f) => (f as { delta: string }).delta).join('');
  expect(text).toContain('Paris');
  expect(text).not.toMatch(/lighthouse/i);
});

it('ignores any frame that belongs to a subagent', () => {
  expect(parseFrame(JSON.stringify({ type: 'assistant', parent_tool_use_id: 'toolu_1', message: { content: [{ type: 'tool_use', id: 'x', name: 'mcp__termhub__list_tabs', input: {} }] } }))).toBeNull();
  expect(parseFrame(JSON.stringify({ type: 'stream_event', parent_tool_use_id: 'toolu_1', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'oi' } } }))).toBeNull();
});

it('marks a failed result as the end of one turn, not of the run', () => {
  expect(parseFrame(JSON.stringify({ type: 'result', is_error: true, session_id: 's1' }))).toEqual({ type: 'error', message: 'run ended with is_error', reason: 'run_failed', session_id: 's1', turn_ended: true });
  expect(parseFrame(JSON.stringify({ type: 'termhub_error', code: 1, reason: 'missing_session' }))).toMatchObject({ type: 'error', reason: 'missing_session' });
  expect(parseFrame(JSON.stringify({ type: 'termhub_error', code: 1, reason: 'missing_session' }))).not.toHaveProperty('turn_ended');
});

it('reads a replay without a uuid as nothing', () => {
  expect(parseFrame(JSON.stringify({ type: 'user', isReplay: true, message: { role: 'user', content: 'oi' } }))).toBeNull();
});
```

- [ ] **Step 2: Run and see them fail**

Run: `npm test -w @termhub/server -- src/chat/stream.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement in `apps/server/src/chat/stream.ts`**

- Extend `ChatFrame`:

```ts
  /** A message written to a streamed run started its turn: the CLI replays it (`isReplay`) with the
   *  `uuid` the server gave it, which is how an answer is matched to its question. */
  | { type: 'turn_started'; uuid: string }
  /** How many background subagents the session has now (`background_tasks_changed`). */
  | { type: 'background'; count: number }
```

  and add `turn_ended?: boolean` to the `error` member, documented as: `true for a turn that failed
  inside a run that goes on (a result with is_error); absent when the run itself ended`.
- In `parseFrame`, right after `const f = parsed as Record<string, unknown>;`:

```ts
  // A subagent's own frames (its text, its tool calls) are its business: the person hears what the
  // concierge relays, not the subagent's raw work. Its launch and its notification are the
  // concierge's own frames and still go through.
  if (typeof f.parent_tool_use_id === 'string') return null;
```

- In the `user` branch, before reading `content`:

```ts
    if (f.isReplay === true) return typeof f.uuid === 'string' ? { type: 'turn_started', uuid: f.uuid } : null;
```

- Before the `result` branch:

```ts
  if (type === 'system' && f.subtype === 'background_tasks_changed') return { type: 'background', count: Array.isArray(f.tasks) ? f.tasks.length : 0 };
```

- In the `is_error` return, add `turn_ended: true`.
- Move from `service.ts` into `stream.ts` (below `ChatFailureReason`), unchanged, with their doc
  comments: `export type ChatErrorCode = …` and `codeForReason` (now `export const`). In
  `service.ts`, delete them, import `codeForReason, type ChatErrorCode` from `./stream.js`, and add
  `export type { ChatErrorCode } from './stream.js';`.

- [ ] **Step 4: Run the chat tests and typecheck**

Run: `npm test -w @termhub/server -- src/chat && npm run typecheck -w @termhub/server`. Expected: PASS.
The old `finishRun` ignores the two new frame types, since it has no branch for them.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/chat/stream.ts apps/server/src/chat/stream.test.ts apps/server/src/chat/service.ts apps/server/src/chat/fixtures/stream-background.ndjson
git commit -m "Chat stream: read turn replays and background tasks, ignore subagent frames"
```

---

### Task 4: `agentRunner` returns a writable run stream

Board: new subtask "Servidor: runner com escrita no canal (RunStream)".

**Files:**
- Modify: `apps/server/src/chat/service.ts` (types `RunStream`, `RunnerClient`, `RunnerInput`)
- Modify: `apps/server/src/chat/agent-runner.ts`
- Test: `apps/server/src/chat/agent-runner.test.ts`

**Interfaces:**
- Produces (in `service.ts`):

```ts
/** What a runner yields: the CLI's stdout, a line at a time — and, for a streamed run, a way to write
 *  more input. `write` takes one line (no newline), answers false once the run can take no more, and
 *  buffers lines written before the channel is open. A one-shot runner does not have it. */
export interface RunStream extends AsyncIterable<string> {
  write?(line: string): boolean;
}
export interface RunnerClient {
  run(input: RunnerInput): RunStream;
}
```

  and `RunnerInput.stream_input?: boolean` (doc: `A streamed run (spec 2026-09-26): text is the first
  input lines, newline-terminated, and the channel stays open for more`).
- `agentRunner(...).run(input)` returns a `RunStream` with `write`. It puts `stream_input: true` in the
  open params only when `input.stream_input` is set. Its default deadline is 61 min for a streamed run
  and 11 min otherwise; `opts.deadlineMs` overrides both.

- [ ] **Step 1: Write the failing tests** — append to `apps/server/src/chat/agent-runner.test.ts`
  (reuse `fakeHost`, `collect` and `input`, and the `state.config.mcpUrl` setup the neighbouring
  tests use in their `beforeEach`):

```ts
it('streams: writes before the open are buffered, then framed in order, and refused once the channel ended', async () => {
  const h = fakeHost({ capabilities: ['pty', 'claude', 'claude.stream_input'] });
  const stream = agentRunner('m1', { host: h.host }).run({ ...input, text: '{"a":1}\n', stream_input: true });
  expect(stream.write?.('{"b":2}')).toBe(true);
  const run = collect(stream);
  await h.opened;
  expect(stream.write?.('{"c":3}')).toBe(true);
  expect(h.seen.writes.map((b) => b.toString('utf8'))).toEqual(['{"a":1}\n', '{"b":2}\n', '{"c":3}\n']);
  expect(h.seen.params[0]).toMatchObject({ stream_input: true });
  h.exit(0);
  await run.done;
  expect(stream.write?.('{"d":4}')).toBe(false);
});

it('leaves the open frame of a one-shot run exactly as it was', async () => {
  const h = fakeHost();
  const run = collect(agentRunner('m1', { host: h.host }).run(input));
  await h.opened;
  expect(h.seen.params[0]).not.toHaveProperty('stream_input');
  h.exit(0);
  await run.done;
});

it('refuses writes to a run that never opened (machine offline)', async () => {
  const h = fakeHost({ capabilities: null });
  const stream = agentRunner('m1', { host: h.host }).run({ ...input, stream_input: true });
  await collect(stream).done;
  expect(stream.write?.('{"a":1}')).toBe(false);
});
```

- [ ] **Step 2: Run and see them fail**

Run: `npm test -w @termhub/server -- src/chat/agent-runner.test.ts`. Expected: FAIL (`write` undefined).

- [ ] **Step 3: Implement**

In `service.ts`, add `RunStream`, change `RunnerClient.run`'s return type to it, and add
`stream_input` to `RunnerInput` (see Interfaces).

In `agent-runner.ts`:

- Constant: `const STREAM_RUN_DEADLINE_MS = 61 * 60_000;` with the comment `One minute past the
  agent's own 60-minute kill of a streamed run (apps/agent/src/claude/run.ts).`
- Import `type RunStream` from `./service.js`.
- Add the link type and change `agentRunner`:

```ts
/** What `write` and the run share: the open channel, the lines written before it opened, and
 *  whether the run is over. */
interface InputLink {
  channel: AgentChannel | null;
  pending: string[];
  ended: boolean;
}

export function agentRunner(machineId: string, opts: { host?: ClaudeChannelHost; deadlineMs?: number } = {}): RunnerClient {
  const host = opts.host ?? agents;
  return {
    run: (input: RunnerInput): RunStream => {
      const mcpUrl = config.mcpUrl;
      if (!mcpUrl) throw new HttpError(503, 'O chat não está configurado neste servidor', 'CONCIERGE_DISABLED');
      const link: InputLink = { channel: null, pending: [], ended: false };
      const deadline = opts.deadlineMs ?? (input.stream_input ? STREAM_RUN_DEADLINE_MS : RUN_DEADLINE_MS);
      const lines = runOnAgent(machineId, host, input, mcpUrl, deadline, link);
      return Object.assign(lines, {
        write: (line: string): boolean => {
          if (link.ended) return false;
          const data = `${line}\n`;
          if (link.channel) link.channel.write(Buffer.from(data, 'utf8'));
          else link.pending.push(data);
          return true;
        },
      });
    },
  };
}
```

  Keep the existing comment block about `mcpUrl` inside `run`.
- `runOnAgent` takes `link: InputLink` as its last parameter. Wrap its whole body in
  `try { … } finally { link.ended = true; link.channel = null; }`. The body's inner `finally` (clear
  the deadline, close the channel) stays, nested inside. Every early `return` (host gone, too old,
  failed open) then also marks the link ended.
- In the open params: `...(input.stream_input ? { stream_input: true } : {}),`.
- After `channel.write(Buffer.from(input.text, 'utf8'));`:

```ts
    // Lines written while the channel was being opened, in the order they were written; from here on
    // `write` frames them straight onto the channel.
    link.channel = channel;
    for (const data of link.pending.splice(0)) channel.write(Buffer.from(data, 'utf8'));
```

- In `runner.ts`, `httpRunner.run` already returns an async generator, which satisfies `RunStream`
  (no `write`). No change there.

- [ ] **Step 4: Run and typecheck**

Run: `npm test -w @termhub/server -- src/chat && npm run typecheck -w @termhub/server`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/chat/agent-runner.ts apps/server/src/chat/agent-runner.test.ts apps/server/src/chat/service.ts
git commit -m "Chat runner: write more input into a streamed run"
```

---

### Task 5: The live-run driver and the orchestrator prompt

Board: TER-62, retitled "Servidor: driver de turnos do processo vivo + prompt de orquestrador
(subagentes sempre em background)".

**Files:**
- Create: `apps/server/src/chat/live-run.ts`
- Create: `apps/server/src/chat/live-run.test.ts`
- Create: `apps/server/src/chat/concierge-prompt.ts`
- Create: `apps/server/src/chat/concierge-prompt.test.ts`

**Interfaces:**
- Consumes:
  - `RunStream` (Task 4);
  - `parseFrame`, `codeForReason`, `ChatErrorCode` (Task 3);
  - `streamUserMessageLine`, `STREAM_END_INPUT_LINE` (Task 1);
  - `chatBus`;
  - `ChatRepository` methods `addMessage`, `updateMessage`, `deleteMessage`, `setCliSession`.
- Produces:

```ts
// live-run.ts
export interface LiveTurn {
  /** The uuid written with the message; the CLI replays it when this turn starts. */
  uuid: string;
  /** Written to the CLI: the person's text, with any tab-question context in front. */
  text: string;
  question: ChatMessage;
  answer: ChatMessage;
  /** Settles `done` of the `StartedRun` this turn was handed back as. */
  settle: { resolve(m: ChatMessage): void; reject(e: unknown): void };
}
export class LiveRun {
  constructor(deps: { userId: string; conversationId: string; sessionId: string | null; chat: Pick<ChatRepository, 'addMessage' | 'updateMessage' | 'deleteMessage' | 'setCliSession'> });
  readonly accepting: boolean;   // getter: input still open
  readonly endedTurns: number;   // getter: turns stored so far
  readonly sessionId: string | null; // getter
  add(turn: LiveTurn): boolean;  // false: input closed, the caller must queue it
  initialText(): string;         // every turn waiting, one line each, newline-terminated
  consume(stream: RunStream): Promise<{ code: ChatErrorCode; missingSession: boolean }>;
  restart(): Promise<void>;      // fresh session after missing_session: turns back to waiting, text dropped
  failOpen(code: ChatErrorCode): Promise<void>;
  abandon(err: unknown): Promise<void>; // setup failure: delete answers, reject every open turn
}
// concierge-prompt.ts
export const ORCHESTRATOR_PROMPT: string;
export function streamedSystemPrompt(projectPrompt: string | null): string;
```

- [ ] **Step 1: Write the failing prompt test** — `apps/server/src/chat/concierge-prompt.test.ts`:

```ts
import { expect, it } from 'vitest';
import { ORCHESTRATOR_PROMPT, streamedSystemPrompt } from './concierge-prompt.js';

it('tells the concierge to delegate in the background and stay free', () => {
  expect(ORCHESTRATOR_PROMPT).toContain('run_in_background: true');
  expect(ORCHESTRATOR_PROMPT).toMatch(/end your turn/i);
});

it('goes first, with the project prompt after it, and fits the protocol cap with the longest project prompt', () => {
  expect(streamedSystemPrompt(null)).toBe(ORCHESTRATOR_PROMPT);
  expect(streamedSystemPrompt('projeto')).toBe(`${ORCHESTRATOR_PROMPT}\n\nprojeto`);
  expect(streamedSystemPrompt('x'.repeat(4000)).length).toBeLessThanOrEqual(8000);
});
```

- [ ] **Step 2: Implement `apps/server/src/chat/concierge-prompt.ts`**

```ts
/**
 * What a streamed chat run is told about how to work (spec 2026-09-26 §6). Only stream-capable agents
 * get it: on an old agent a background subagent still holds the whole run, and telling the concierge
 * otherwise would be a lie. The hook in `@termhub/claude-cli` enforces the one rule that matters most
 * (no foreground subagent); this text is the rest.
 */
export const ORCHESTRATOR_PROMPT = [
  'You orchestrate this termhub chat. The person must be able to talk to you at any moment, so never do long work inside your own turn.',
  '- Delegate anything that is more than a quick lookup or a single tool call (investigating, driving terminals, waiting on an agent, several cards) to a subagent: call the Agent tool with run_in_background: true. A foreground subagent is refused.',
  '- Right after launching it, say in one or two sentences what you delegated and end your turn. Do not wait for it, poll it or sleep.',
  '- When a subagent finishes you are notified: relay its result to the person, short and in their language.',
  '- Messages can arrive while subagents run: answer them right away. To change a delegated task, launch a new subagent with the correction.',
  '- Subagents use the same termhub tools and the same confirmation gate: when one stops waiting for the person to confirm an action in the chat, tell them.',
  '- Answer quick questions (one read, a status) yourself, without a subagent.',
].join('\n');

/** The `append_system_prompt` of a streamed run: the orchestrator's rules, then the project's focus. */
export function streamedSystemPrompt(projectPrompt: string | null): string {
  return projectPrompt ? `${ORCHESTRATOR_PROMPT}\n\n${projectPrompt}` : ORCHESTRATOR_PROMPT;
}
```

- [ ] **Step 3: Write the failing driver tests** — `apps/server/src/chat/live-run.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { STREAM_END_INPUT_LINE } from '@termhub/agent-protocol';
import { beforeEach, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../db/repositories/chat.js';
import { chatBus, type ChatEvent } from './bus.js';
import { LiveRun, type LiveTurn } from './live-run.js';
import type { RunStream } from './service.js';

const fixture = readFileSync(join(import.meta.dirname, 'fixtures/stream-background.ndjson'), 'utf8').split('\n').filter(Boolean);
const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';

function harness(sessionId: string | null = null) {
  const rows: ChatMessage[] = [];
  let n = 0;
  const chat = {
    addMessage: vi.fn(async (m: { conversation_id: string; role: 'user' | 'assistant'; text: string }) => {
      const row = { id: `m${++n}`, conversation_id: m.conversation_id, role: m.role, text: m.text, usage: null, error_code: null, created_at: '' } as unknown as ChatMessage;
      rows.push(row);
      return row;
    }),
    updateMessage: vi.fn(async (id: string, p: { text?: string; usage?: unknown; error_code?: string | null }) => {
      const row = rows.find((r) => r.id === id)!;
      Object.assign(row, p.text === undefined ? {} : { text: p.text }, p.error_code === undefined ? {} : { error_code: p.error_code });
      return { ...row };
    }),
    deleteMessage: vi.fn(async (id: string) => void rows.splice(rows.findIndex((r) => r.id === id), 1)),
    setCliSession: vi.fn(async () => undefined),
  };
  const live = new LiveRun({ userId: 'u1', conversationId: 'c1', sessionId, chat });
  const events: ChatEvent[] = [];
  const off = chatBus.subscribe((e) => events.push(e));
  /** A turn as the service builds it: question and empty answer already stored. */
  const turn = async (uuid: string, text: string) => {
    const question = await chat.addMessage({ conversation_id: 'c1', role: 'user', text });
    const answer = await chat.addMessage({ conversation_id: 'c1', role: 'assistant', text: '' });
    let resolve!: (m: ChatMessage) => void;
    let reject!: (e: unknown) => void;
    const done = new Promise<ChatMessage>((res, rej) => ((resolve = res), (reject = rej)));
    const t: LiveTurn = { uuid, text, question, answer, settle: { resolve, reject } };
    return { t, done };
  };
  return { live, chat, rows, events, off, turn };
}

/** A hand-driven stream: `push` a CLI line, `end()` the process; `written` is what the driver wrote. */
function manualStream() {
  const queue: string[] = [];
  let ended = false;
  let wake: (() => void) | null = null;
  const written: string[] = [];
  const stream: RunStream = {
    write: (line) => (ended ? false : (written.push(line), true)),
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (queue.length) yield queue.shift()!;
        if (ended) return;
        await new Promise<void>((r) => (wake = r));
      }
    },
  };
  const poke = () => { const w = wake; wake = null; w?.(); };
  return { stream, written, push: (l: string) => (queue.push(l), poke()), end: () => ((ended = true), poke()) };
}

const replay = (uuid: string) => JSON.stringify({ type: 'user', isReplay: true, uuid, message: { role: 'user', content: 'x' } });
const delta = (text: string) => JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
const result = (session = 's1') => JSON.stringify({ type: 'result', session_id: session, usage: { input_tokens: 1 } });
const background = (count: number) => JSON.stringify({ type: 'system', subtype: 'background_tasks_changed', tasks: Array.from({ length: count }, (_, i) => ({ task_id: `t${i}` })) });
const settle = () => new Promise((r) => setTimeout(r, 10));

let h: ReturnType<typeof harness>;
beforeEach(() => {
  h?.off();
  h = harness();
});

it('answers a message injected while a background subagent runs, and gives the notification its own message (real run)', async () => {
  const one = await h.turn(U1, 'dispara');
  expect(h.live.add(one.t)).toBe(true);
  const s = manualStream();
  const consumed = h.live.consume(s.stream);
  const two = await h.turn(U2, 'capital?');
  for (const line of fixture) {
    s.push(line);
    await settle();
    // Inject the second message right after the first turn's result, as the recording did.
    if (JSON.parse(line).type === 'result' && !s.written.length) expect(h.live.add(two.t)).toBe(true);
  }
  s.end();
  expect(await consumed).toEqual({ code: null, missingSession: false });

  expect((await one.done).text).toBe('Disparei um subagente.');
  expect((await two.done).text).toBe('Paris');
  const assistants = h.rows.filter((r) => r.role === 'assistant');
  expect(assistants.map((r) => r.text)).toEqual(['Disparei um subagente.', 'Paris', 'O subagente terminou: texto sobre faróis pronto.']);
  expect(assistants.every((r) => !/lighthouse/i.test(r.text))).toBe(true);
  // The injected line, then the end of input once the notification turn left nothing running.
  expect(JSON.parse(s.written[0])).toMatchObject({ type: 'user', uuid: U2 });
  expect(s.written.at(-1)).toBe(STREAM_END_INPUT_LINE);
  expect(h.events.filter((e) => e.type === 'run_finished')).toHaveLength(3);
});

it('two injected turns get one answer each, in the order of their replays', async () => {
  const a = await h.turn(U1, 'a');
  const b = await h.turn(U2, 'b');
  h.live.add(a.t);
  const s = manualStream();
  const consumed = h.live.consume(s.stream);
  h.live.add(b.t);
  s.push(replay(U1)); s.push(delta('resposta A')); s.push(result());
  s.push(replay(U2)); s.push(delta('resposta B')); s.push(result());
  await settle();
  s.end();
  await consumed;
  expect((await a.done).text).toBe('resposta A');
  expect((await b.done).text).toBe('resposta B');
});

it('keeps the input open while a subagent runs and ends it once nothing is left', async () => {
  const a = await h.turn(U1, 'a');
  h.live.add(a.t);
  const s = manualStream();
  const consumed = h.live.consume(s.stream);
  s.push(replay(U1)); s.push(background(1)); s.push(delta('disparei')); s.push(result());
  await settle();
  expect(h.live.accepting).toBe(true);
  expect(s.written).toEqual([]);
  s.push(background(0));
  await settle();
  expect(h.live.accepting).toBe(false);
  expect(s.written).toEqual([STREAM_END_INPUT_LINE]);
  expect(h.live.add((await h.turn(U2, 'tarde')).t)).toBe(false);
  s.end();
  await consumed;
});

it('a stream that ends with turns open fails each one', async () => {
  const a = await h.turn(U1, 'a');
  const b = await h.turn(U2, 'b');
  h.live.add(a.t);
  const s = manualStream();
  const consumed = h.live.consume(s.stream);
  h.live.add(b.t);
  s.push(replay(U1)); s.push(delta('pela metade'));
  s.push(JSON.stringify({ type: 'termhub_error', code: null, reason: 'host_gone' }));
  s.end();
  const outcome = await consumed;
  expect(outcome.code).toBe('HOST_GONE');
  await h.live.failOpen(outcome.code);
  expect(await a.done).toMatchObject({ text: 'pela metade', error_code: 'HOST_GONE' });
  expect(await b.done).toMatchObject({ text: '', error_code: 'HOST_GONE' });
});

it('fails only the turn whose result is an error, and goes on', async () => {
  const a = await h.turn(U1, 'a');
  const b = await h.turn(U2, 'b');
  h.live.add(a.t);
  const s = manualStream();
  const consumed = h.live.consume(s.stream);
  h.live.add(b.t);
  s.push(replay(U1)); s.push(JSON.stringify({ type: 'result', is_error: true, session_id: 's1' }));
  s.push(replay(U2)); s.push(delta('ok')); s.push(result());
  await settle();
  s.end();
  await consumed;
  expect((await a.done).error_code).toBe('RUN_FAILED');
  expect(await b.done).toMatchObject({ text: 'ok', error_code: null });
});

it('stores the session the CLI reports, once', async () => {
  const a = await h.turn(U1, 'a');
  h.live.add(a.t);
  const s = manualStream();
  const consumed = h.live.consume(s.stream);
  s.push(replay(U1)); s.push(result('sess-9')); s.push(result('sess-9'));
  await settle();
  s.end();
  await consumed;
  expect(h.chat.setCliSession).toHaveBeenCalledTimes(1);
  expect(h.chat.setCliSession).toHaveBeenCalledWith('c1', 'sess-9');
  expect(h.live.sessionId).toBe('sess-9');
});

it('writes every waiting turn as the first input, one line each', async () => {
  h.live.add((await h.turn(U1, 'a')).t);
  h.live.add((await h.turn(U2, 'b')).t);
  const lines = h.live.initialText().split('\n');
  expect(lines.at(-1)).toBe('');
  expect(lines.slice(0, -1).map((l) => JSON.parse(l).uuid)).toEqual([U1, U2]);
});

it('restart puts the open turns back and drops their partial text', async () => {
  const a = await h.turn(U1, 'a');
  h.live.add(a.t);
  const s = manualStream();
  const consumed = h.live.consume(s.stream);
  s.push(replay(U1)); s.push(delta('perdido'));
  s.push(JSON.stringify({ type: 'termhub_error', code: 1, reason: 'missing_session' }));
  s.end();
  expect(await consumed).toEqual({ code: 'MISSING_SESSION', missingSession: true });
  await h.live.restart();
  expect(h.events.some((e) => e.type === 'reset' && e.message_id === a.t.answer.id)).toBe(true);
  expect(h.live.accepting).toBe(true);
  expect(JSON.parse(h.live.initialText().trim()).uuid).toBe(U1);
  const s2 = manualStream();
  const again = h.live.consume(s2.stream);
  s2.push(replay(U1)); s2.push(delta('de novo')); s2.push(result());
  await settle();
  s2.end();
  await again;
  expect((await a.done).text).toBe('de novo');
});

it('abandon deletes every open answer and rejects every open turn', async () => {
  const a = await h.turn(U1, 'a');
  h.live.add(a.t);
  const err = new Error('setup');
  await h.live.abandon(err);
  await expect(a.done).rejects.toBe(err);
  expect(h.rows.map((r) => r.role)).toEqual(['user']);
});
```

- [ ] **Step 4: Run and see them fail**

Run: `npm test -w @termhub/server -- src/chat/live-run.test.ts src/chat/concierge-prompt.test.ts`.
Expected: `concierge-prompt` passes, `live-run` fails (module missing).

- [ ] **Step 5: Implement `apps/server/src/chat/live-run.ts`**

```ts
import { STREAM_END_INPUT_LINE, streamUserMessageLine } from '@termhub/agent-protocol';
import type { ChatMessage, ChatRepository } from '../db/repositories/chat.js';
import { chatBus } from './bus.js';
import type { RunStream } from './service.js';
import { codeForReason, parseFrame, type ChatErrorCode } from './stream.js';

/** One message of the person's in a streamed run, from the moment it is written until it is answered. */
export interface LiveTurn {
  /** The uuid written with the message; the CLI replays it when this turn starts. */
  uuid: string;
  /** Written to the CLI: the person's text, with any tab-question context in front. */
  text: string;
  question: ChatMessage;
  answer: ChatMessage;
  /** Settles `done` of the `StartedRun` this turn was handed back as. */
  settle: { resolve(m: ChatMessage): void; reject(e: unknown): void };
}

/** A turn being answered: the person's, or one the CLI started on its own (a subagent's notification). */
interface Answering {
  turn: LiveTurn | null;
  answer: ChatMessage;
  collected: string;
  usage: unknown;
}

export interface LiveRunDeps {
  userId: string;
  conversationId: string;
  /** The CLI session this run resumes (or will name), updated from the CLI's own frames. */
  sessionId: string | null;
  chat: Pick<ChatRepository, 'addMessage' | 'updateMessage' | 'deleteMessage' | 'setCliSession'>;
}

/**
 * One long-lived `claude` process of a conversation, with streamed input (spec 2026-09-26 §5.7): turns
 * go in as lines, answers come back matched by the replayed uuid, a turn the CLI starts on its own gets
 * a message of its own, and the input ends once nothing is running. It never takes the conversation's
 * lock nor mints a token — `ChatService` does, and owns this object for as long as the process lives.
 */
export class LiveRun {
  private waiting: LiveTurn[] = [];
  private current: Answering | null = null;
  private background = 0;
  private stream: RunStream | null = null;
  private inputOpen = true;
  private ended = 0;
  private session: string | null;

  constructor(private deps: LiveRunDeps) {
    this.session = deps.sessionId;
  }

  /** Whether a message can still be injected into this process. */
  get accepting(): boolean {
    return this.inputOpen;
  }
  get endedTurns(): number {
    return this.ended;
  }
  get sessionId(): string | null {
    return this.session;
  }

  /** Takes a turn: written now to the live process, or kept for `initialText` before it starts. False
   *  when the input is closed (or the channel refused the line): the caller queues it for the next run. */
  add(turn: LiveTurn): boolean {
    if (!this.inputOpen) return false;
    this.waiting.push(turn);
    if (this.stream?.write && !this.stream.write(streamUserMessageLine(turn.text, turn.uuid))) {
      this.waiting.pop();
      return false;
    }
    return true;
  }

  /** The first input of a process: every turn not yet answered, one line each. */
  initialText(): string {
    return this.waiting.map((t) => `${streamUserMessageLine(t.text, t.uuid)}\n`).join('');
  }

  /** Reads one process to its end. Throws what the stream throws (a setup failure is the caller's). */
  async consume(stream: RunStream): Promise<{ code: ChatErrorCode; missingSession: boolean }> {
    this.stream = stream;
    let code: ChatErrorCode = null;
    let missingSession = false;
    try {
      for await (const line of stream) {
        const frame = parseFrame(line);
        if (!frame) continue;
        if (frame.type === 'turn_started') {
          const i = this.waiting.findIndex((t) => t.uuid === frame.uuid);
          if (i === -1) continue;
          // A turn that never saw its result (it should not happen) is stored as it stands.
          if (this.current) await this.finish(this.current, null);
          const [turn] = this.waiting.splice(i, 1);
          this.current = { turn, answer: turn.answer, collected: '', usage: null };
        } else if (frame.type === 'text') {
          const a = await this.answering();
          a.collected += frame.delta;
          chatBus.publish({ type: 'delta', user_id: this.deps.userId, conversation_id: this.deps.conversationId, message_id: a.answer.id, delta: frame.delta });
        } else if (frame.type === 'action') {
          const a = await this.answering();
          chatBus.publish({ type: 'action', user_id: this.deps.userId, conversation_id: this.deps.conversationId, message_id: a.answer.id, tool: frame.tool, tool_use_id: frame.tool_use_id, args: frame.args });
        } else if (frame.type === 'action_result') {
          if (this.current) chatBus.publish({ type: 'action_result', user_id: this.deps.userId, conversation_id: this.deps.conversationId, message_id: this.current.answer.id, tool_use_id: frame.tool_use_id, ok: frame.ok });
        } else if (frame.type === 'done') {
          await this.saveSession(frame.session_id);
          if (this.current) {
            this.current.usage = frame.usage ?? null;
            await this.finish(this.current, null);
          }
          this.endInputIfIdle();
        } else if (frame.type === 'error') {
          await this.saveSession(frame.session_id);
          if (frame.turn_ended) {
            if (this.current) await this.finish(this.current, 'RUN_FAILED');
            this.endInputIfIdle();
          } else {
            code = codeForReason(frame.reason);
            if (frame.reason === 'missing_session') missingSession = true;
          }
        } else if (frame.type === 'background') {
          this.background = frame.count;
          this.endInputIfIdle();
        }
      }
    } finally {
      this.stream = null;
      this.inputOpen = false;
    }
    return { code, missingSession };
  }

  /** A fresh session after `missing_session`: every open turn waits again, its partial text dropped. */
  async restart(): Promise<void> {
    if (this.current?.turn) this.waiting.unshift(this.current.turn);
    this.current = null;
    for (const t of this.waiting) chatBus.publish({ type: 'reset', user_id: this.deps.userId, conversation_id: this.deps.conversationId, message_id: t.answer.id });
    this.background = 0;
    this.inputOpen = true;
    this.session = null;
    await this.deps.chat.setCliSession(this.deps.conversationId, null);
  }

  /** The process is over: every turn still open is stored with `code`. */
  async failOpen(code: ChatErrorCode): Promise<void> {
    this.inputOpen = false;
    if (this.current) await this.finish(this.current, code);
    for (const t of this.waiting.splice(0)) await this.finish({ turn: t, answer: t.answer, collected: '', usage: null }, code);
  }

  /** Nothing ran and nothing will (a setup failure): the answers go, every open turn rejects. */
  async abandon(err: unknown): Promise<void> {
    this.inputOpen = false;
    const open = [...(this.current?.turn ? [this.current.turn] : []), ...this.waiting.splice(0)];
    this.current = null;
    for (const t of open) {
      await this.deps.chat.deleteMessage(t.answer.id);
      // Re-publishing the question makes every open screen re-read, which is how they learn the
      // answer row is gone (the bus has no "removed" event).
      chatBus.publish({ type: 'message', user_id: this.deps.userId, conversation_id: this.deps.conversationId, message: t.question });
      t.settle.reject(err);
    }
  }

  /** The turn frames belong to; a turn the CLI started on its own gets a new assistant message. */
  private async answering(): Promise<Answering> {
    if (this.current) return this.current;
    const answer = await this.deps.chat.addMessage({ conversation_id: this.deps.conversationId, role: 'assistant', text: '' });
    chatBus.publish({ type: 'message', user_id: this.deps.userId, conversation_id: this.deps.conversationId, message: answer });
    this.current = { turn: null, answer, collected: '', usage: null };
    return this.current;
  }

  private async finish(a: Answering, code: ChatErrorCode): Promise<void> {
    if (this.current === a) this.current = null;
    const final = await this.deps.chat.updateMessage(a.answer.id, { text: a.collected, usage: a.usage, error_code: code });
    this.ended += 1;
    chatBus.publish({ type: 'message', user_id: this.deps.userId, conversation_id: this.deps.conversationId, message: final });
    chatBus.publish({ type: 'run_finished', user_id: this.deps.userId, conversation_id: this.deps.conversationId, message_id: final.id, ok: code === null, error_code: code });
    a.turn?.settle.resolve(final);
  }

  private async saveSession(sessionId: string | undefined): Promise<void> {
    if (!sessionId || sessionId === this.session) return;
    this.session = sessionId;
    await this.deps.chat.setCliSession(this.deps.conversationId, sessionId);
  }

  /** Nothing to answer and nothing in the background: end the input. The CLI still runs whatever it
   *  has (a notification turn that is on its way), and a message that comes later goes to the next run. */
  private endInputIfIdle(): void {
    if (!this.inputOpen || this.current || this.waiting.length > 0 || this.background > 0) return;
    this.inputOpen = false;
    this.stream?.write?.(STREAM_END_INPUT_LINE);
  }
}
```

Check the repository's real method signatures (`apps/server/src/db/repositories/chat.ts`):
`addMessage({ conversation_id, role, text })`, `updateMessage(id, { text, usage, error_code })`,
`deleteMessage(id)`, `setCliSession(id, sessionId | null)`. Match them exactly. If `updateMessage`'s
`error_code` type is narrower than `ChatErrorCode`, pass it the same way `finishRun` does today.

- [ ] **Step 6: Run the driver tests**

Run: `npm test -w @termhub/server -- src/chat/live-run.test.ts src/chat/concierge-prompt.test.ts`.
Expected: PASS. If the real-fixture test's injection timing needs a tweak, keep what it asserts:
- three assistant rows with those texts;
- no lighthouse text;
- the injected line was written;
- the input ended last.

- [ ] **Step 7: Typecheck and commit**

```bash
npm run typecheck -w @termhub/server   # through Docker
git add apps/server/src/chat/live-run.ts apps/server/src/chat/live-run.test.ts apps/server/src/chat/concierge-prompt.ts apps/server/src/chat/concierge-prompt.test.ts
git commit -m "Chat: drive a live claude process turn by turn, with the orchestrator prompt"
```

---

### Task 6: `ChatService` injects into a live run, or queues

Board: TER-61 ("Fila de mensagens por conversa: aceitar envio enquanto o concierge trabalha e
entregar como mensagem enfileirada/interrupção").

**Files:**
- Modify: `apps/server/src/chat/service.ts`
- Test: `apps/server/src/chat/service.test.ts`

**Interfaces:**
- Consumes: `LiveRun`, `LiveTurn` (Task 5), `streamedSystemPrompt` (Task 5),
  `CAPABILITY_CLAUDE_STREAM_INPUT` (Task 1), `RunStream` (Task 4).
- Produces: `start`/`send`/`sendIn` never answer 409 `CHAT_BUSY` to a message the person typed.
  Decisions still do when the run cannot take input.

- [ ] **Step 1: Update the test harness** in `service.test.ts`'s `build()`:
  - Give `runner.run` a `write`. When the source is a function, delegate to it; otherwise wrap the
    array. Keep the returned object an async iterable.
  - Add an option `streaming?: boolean`. When true, the agent's capabilities also include
    `'claude.stream_input'`.

```ts
  const agents = {
    capabilities: vi.fn(() => (opts.host && 'capabilities' in opts.host ? (opts.host.capabilities ?? null) : ['pty', 'claude', 'claude.system_prompt', ...(opts.streaming ? ['claude.stream_input'] : [])])),
    info: vi.fn(() => ({ agent_version: '0.5.0' })),
  };
```

  and extend the `opts` type with `streaming?: boolean`.
- Add a streamed-runner helper to the test file:

```ts
/** A streamed run driven by hand, like the agent's channel: `push` a CLI line, `end()` the process.
 *  `written` holds every line the service wrote after the first input (which is `input.text`). */
function liveRunner() {
  const runs: { input: RunnerInput; written: string[]; push(l: string): void; end(): void }[] = [];
  const run = vi.fn((input: RunnerInput) => {
    const queue: string[] = [];
    const written: string[] = [];
    let ended = false;
    let wake: (() => void) | null = null;
    const poke = () => { const w = wake; wake = null; w?.(); };
    runs.push({ input, written, push: (l) => (queue.push(l), poke()), end: () => ((ended = true), poke()) });
    return {
      write: (line: string) => (ended ? false : (written.push(line), true)),
      async *[Symbol.asyncIterator]() {
        for (;;) {
          while (queue.length) yield queue.shift()!;
          if (ended) return;
          await new Promise<void>((r) => (wake = r));
        }
      },
    };
  });
  return { run, runs };
}
/** The i-th process: runs start after the token is minted, a few awaits after `start` resolves. */
async function runAt(lr: ReturnType<typeof liveRunner>, i: number) {
  await vi.waitFor(() => expect(lr.runs.length).toBeGreaterThan(i));
  return lr.runs[i];
}
const replayOf = (line: string) => JSON.stringify({ type: 'user', isReplay: true, uuid: JSON.parse(line).uuid, message: { role: 'user', content: 'x' } });
```

  Import `RunnerInput` from `./service.js`. To use it: `const lr = liveRunner(); vi.mocked(runner.run).mockImplementation(lr.run);`.

- [ ] **Step 2: Write the failing tests** (append; `delta`, `done`, `settled` already exist in the file):

```ts
describe('a chat that never blocks', () => {
  it('injects a message typed while a streamed run is busy, and answers it in the same process', async () => {
    const { service, runner, messages } = build([], { streaming: true });
    const lr = liveRunner();
    vi.mocked(runner.run).mockImplementation(lr.run);

    const first = await service.start(user, 'dispara um subagente');
    const run = await runAt(lr, 0);
    expect(run.input.stream_input).toBe(true);
    const firstLine = run.input.text.trim();
    run.push(replayOf(firstLine));
    run.push(JSON.stringify({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 't1' }] }));
    run.push(delta('Disparei.'));
    run.push(done());
    expect((await first.done).text).toBe('Disparei.');

    const second = await service.start(user, 'e a capital da França?');
    expect(lr.runs).toHaveLength(1); // no second process
    const injected = lr.runs[0].written.at(-1)!;
    expect(JSON.parse(injected).message.content).toContain('e a capital da França?');
    run.push(replayOf(injected));
    run.push(delta('Paris'));
    run.push(done());
    expect((await second.done).text).toBe('Paris');

    // The subagent's notification turn becomes a message of its own; then the input ends.
    run.push(JSON.stringify({ type: 'system', subtype: 'background_tasks_changed', tasks: [] }));
    run.push(delta('O subagente terminou.'));
    run.push(done());
    await settled();
    expect(run.written.at(-1)).toBe('{"type":"termhub_end_input"}');
    run.end();
    await settled();
    expect(messages.filter((m) => m.role === 'assistant').map((m) => m.text)).toEqual(['Disparei.', 'Paris', 'O subagente terminou.']);
  });

  it('sends the orchestrator prompt only to a streamed run, in front of the project prompt', async () => {
    const { service, runner } = build([], { streaming: true });
    const lr = liveRunner();
    vi.mocked(runner.run).mockImplementation(lr.run);
    const started = await service.start(user, 'oi', { projectId: 'p1' });
    await runAt(lr, 0);
    const prompt = lr.runs[0].input.append_system_prompt!;
    expect(prompt.startsWith(ORCHESTRATOR_PROMPT)).toBe(true);
    expect(prompt).toContain('You are the termhub chat for the project');
    lr.runs[0].push(replayOf(lr.runs[0].input.text.trim()));
    lr.runs[0].push(done());
    await started.done;
    lr.runs[0].end();
  });

  it('an old agent keeps one-shot runs and queues a second message', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { service, runner, messages } = build([]);
    vi.mocked(runner.run)
      .mockImplementationOnce(() => (async function* () { await gate; yield delta('um'); yield done(); })())
      .mockImplementationOnce(() => (async function* () { yield delta('dois'); yield done(); })());

    const first = await service.start(user, 'primeira');
    const second = await service.start(user, 'segunda'); // no 409
    expect(messages.map((m) => [m.role, m.text])).toEqual([['user', 'primeira'], ['assistant', ''], ['user', 'segunda'], ['assistant', '']]);
    expect(runner.run).toHaveBeenCalledTimes(1);
    const input = vi.mocked(runner.run).mock.calls[0][0];
    expect(input).not.toHaveProperty('stream_input');
    expect(input.append_system_prompt ?? null).toBeNull();

    release();
    expect((await first.done).text).toBe('um');
    expect((await second.done).text).toBe('dois');
    expect(vi.mocked(runner.run).mock.calls[1][0].text).toBe('segunda');
  });

  it('a message that finds the input closed is queued and answered by the next process', async () => {
    const { service, runner } = build([], { streaming: true });
    const lr = liveRunner();
    vi.mocked(runner.run).mockImplementation(lr.run);
    const first = await service.start(user, 'um');
    const run = await runAt(lr, 0);
    run.push(replayOf(run.input.text.trim()));
    run.push(delta('ok'));
    run.push(done()); // nothing in the background: the input ends here
    await first.done;
    await settled();
    expect(run.written.at(-1)).toBe('{"type":"termhub_end_input"}');

    const late = await service.start(user, 'dois'); // the process has not exited yet
    expect(lr.runs).toHaveLength(1);
    run.end();
    await vi.waitFor(() => expect(lr.runs).toHaveLength(2));
    const next = lr.runs[1];
    expect(next.input.resume).toBe(true); // the session of the first process
    next.push(replayOf(next.input.text.trim()));
    next.push(delta('segunda resposta'));
    next.push(done());
    expect((await late.done).text).toBe('segunda resposta');
    next.end();
  });

  it('injects an approved decision into a live run', async () => {
    const { service, runner, chatActions } = build([], { streaming: true });
    const lr = liveRunner();
    vi.mocked(runner.run).mockImplementation(lr.run);
    const first = await service.start(user, 'um');
    const run = await runAt(lr, 0);
    run.push(replayOf(run.input.text.trim()));
    run.push(JSON.stringify({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 't1' }] }));
    run.push(done());
    await first.done;

    const resumed = service.resumeAfterDecision(user, action());
    await vi.waitFor(() => expect(run.written.length).toBe(1));
    expect(chatActions.markInjected).toHaveBeenCalledWith('a1');
    expect(JSON.parse(run.written[0]).message.content).toMatch(/^O usuário autorizou:/);
    run.push(replayOf(run.written[0]));
    run.push(delta('feito'));
    run.push(done());
    expect((await resumed).text).toBe('feito');
    run.end();
  });

  it('a setup failure rejects the first message and removes its answer, as before', async () => {
    const { service, runner, messages } = build([], { streaming: true });
    vi.mocked(runner.run).mockImplementationOnce(() => {
      throw new HttpError(503, 'O chat não está configurado neste servidor', 'CONCIERGE_DISABLED');
    });
    await expect(service.send(user, 'oi')).rejects.toMatchObject({ code: 'CONCIERGE_DISABLED' });
    expect(messages.map((m) => m.role)).toEqual(['user']);
  });

  it('retries a streamed run once on a fresh session when the resumed one is missing', async () => {
    const { service, runner, conversation } = build([], { streaming: true });
    conversation.cli_session_id = '3f1e9b1e-0000-4000-8000-000000000009';
    const lr = liveRunner();
    vi.mocked(runner.run).mockImplementation(lr.run);
    const started = await service.start(user, 'oi');
    await runAt(lr, 0);
    lr.runs[0].push(JSON.stringify({ type: 'termhub_error', code: 1, reason: 'missing_session' }));
    lr.runs[0].end();
    await vi.waitFor(() => expect(lr.runs).toHaveLength(2));
    expect(lr.runs[1].input.resume).toBe(false);
    lr.runs[1].push(replayOf(lr.runs[1].input.text.trim()));
    lr.runs[1].push(delta('novo'));
    lr.runs[1].push(done());
    expect((await started.done).text).toBe('novo');
    lr.runs[1].end();
  });
});
```

  Import `ORCHESTRATOR_PROMPT` from `./concierge-prompt.js` at the top of the test file.

- [ ] **Step 3: Update the existing tests that pinned the old refusal**
  - `'rejects start itself when a run is already in flight'` (in the `start` describe): rename it
    `'queues a message sent while a one-shot run is in flight'`. Instead of expecting 409, assert
    that `start` resolves and that `messages` has four rows after it, then
    `release(); await first.done;`.
  - `'resumeAfterDecision answers busy when a run is already in flight…'` stays as it is: the default
    build has no streaming capability, so a decision still answers 409.
  - Search the file for any other `CHAT_BUSY` expectation on `send`/`start`, and change it to the
    queued behaviour the same way. The `reset` 409 stays.

- [ ] **Step 4: Run and see the new tests fail**

Run: `npm test -w @termhub/server -- src/chat/service.test.ts`. Expected: the new describe fails, and
the renamed queue test fails.

- [ ] **Step 5: Implement in `service.ts`**

Imports:

```ts
import { CAPABILITY_CLAUDE_STREAM_INPUT, CAPABILITY_CLAUDE_SYSTEM_PROMPT } from '@termhub/agent-protocol';
import { streamedSystemPrompt } from './concierge-prompt.js';
import { LiveRun, type LiveTurn } from './live-run.js';
```

Module-level helpers (next to `isSetupFailure`):

```ts
/** A message stored while its conversation's process could not take it; it runs when the lock frees.
 *  `runText` is set when its tab-question context was already read (and stamped) for it. */
interface QueuedTurn {
  text: string;
  runText?: string;
  question: ChatMessage;
  answer: ChatMessage;
  settle: LiveTurn['settle'];
}

/** A `done` promise and the handles that settle it. */
function deferred(): { promise: Promise<ChatMessage>; settle: LiveTurn['settle'] } {
  let resolve!: (m: ChatMessage) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<ChatMessage>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, settle: { resolve, reject } };
}
```

Fields on `ChatService`:

```ts
  /** The live streamed process of a conversation, while it runs (spec 2026-09-26). */
  private live = new Map<string, LiveRun>();
  /** Messages typed while a process could not take them, answered by the next one. */
  private queued = new Map<string, QueuedTurn[]>();
```

Update the `running` doc: `One process per conversation: two claude processes on the same session
would race. A message that finds it held is injected into the live process or queued, never refused
(spec 2026-09-26); only a decision can still answer CHAT_BUSY.`

Add private helpers:

```ts
  /** Whether this host's agent runs a claude channel with streamed input. */
  private streams(machineId: string): boolean {
    return this.deps.agents.capabilities(machineId)?.includes(CAPABILITY_CLAUDE_STREAM_INPUT) ?? false;
  }

  /** Stores the question and its empty answer and tells every open screen. */
  private async storeTurn(user: User, conversationId: string, text: string): Promise<{ question: ChatMessage; answer: ChatMessage }> {
    const question = await this.deps.repos.chat.addMessage({ conversation_id: conversationId, role: 'user', text });
    chatBus.publish({ type: 'message', user_id: user.id, conversation_id: conversationId, message: question });
    const answer = await this.deps.repos.chat.addMessage({ conversation_id: conversationId, role: 'assistant', text: '' });
    chatBus.publish({ type: 'message', user_id: user.id, conversation_id: conversationId, message: answer });
    return { question, answer };
  }

  /** The text written to the CLI for a message: any tab-question context the model was not told yet, then the message. */
  private async runTextFor(user: User, conversationId: string, text: string): Promise<string> {
    const context = await this.tabQuestionContextFor(user, conversationId);
    return context ? `${context}\n\n${text}` : text;
  }

  private enqueue(conversationId: string, turn: QueuedTurn): void {
    const list = this.queued.get(conversationId) ?? [];
    list.push(turn);
    this.queued.set(conversationId, list);
  }

  /**
   * A message for a conversation whose process is running. Injected when that process still takes input,
   * so it is answered at once, even with subagents at work. Otherwise it is queued, shown right away,
   * and answered by the next process. A decision (`beforeRun`) is never queued here: it keeps its own
   * durable path (409 → queued note → `drainNextDecision`).
   */
  private async startWhileBusy(user: User, conversation: ChatConversation, text: string, opts?: { beforeRun?: () => Promise<void> }): Promise<StartedRun> {
    const live = this.live.get(conversation.id);
    if (!live?.accepting && opts?.beforeRun) throw new HttpError(409, 'O concierge ainda está respondendo a mensagem anterior', 'CHAT_BUSY');
    if (live?.accepting && opts?.beforeRun) await opts.beforeRun();
    const runText = live?.accepting ? await this.runTextFor(user, conversation.id, text) : undefined;
    const { question, answer } = await this.storeTurn(user, conversation.id, text);
    const d = deferred();
    const started = { conversation_id: conversation.id, user_message_id: question.id, assistant_message_id: answer.id, done: d.promise };
    // Re-checked after the awaits above: the process may have ended its input in between.
    if (runText !== undefined && live && this.live.get(conversation.id) === live && live.add({ uuid: randomUUID(), text: runText, question, answer, settle: d.settle })) return started;
    this.enqueue(conversation.id, { text, runText, question, answer, settle: d.settle });
    // The process may already be gone, with the lock released during the awaits above.
    if (!this.running.has(conversation.id)) void this.launchQueued(user, conversation.id);
    return started;
  }
```

In `startIn`:
- Replace the busy line
  `if (this.running.has(conversation.id)) throw new HttpError(409, …, 'CHAT_BUSY');` with
  `if (this.running.has(conversation.id)) return this.startWhileBusy(user, conversation, text, opts);`.
- Inside the `try`, replace everything from `const context = …` to the `return { … done }` with:

```ts
      const runText = await this.runTextFor(user, conversation.id, text);
      const { question, answer } = await this.storeTurn(user, conversation.id, text);
      const started = { conversation_id: conversation.id, user_message_id: question.id, assistant_message_id: answer.id };

      // Not awaited: this call resolves now, and the lock passes to the run, whose own `finally`
      // releases it whether or not anybody ever awaits `done`.
      if (this.streams(host.machine.id)) {
        const d = deferred();
        void this.runLive(user, conversation, runner, host.configDir, streamedSystemPrompt(appendSystemPrompt), [{ uuid: randomUUID(), text: runText, question, answer, settle: d.settle }]);
        handedOff = true;
        return { ...started, done: d.promise };
      }
      const done = this.finishRun(user, conversation, runText, question, answer, runner, host.configDir, appendSystemPrompt);
      handedOff = true;
      return { ...started, done };
```

  Keep the comment block that explains the tab-question context: move it onto `runTextFor`.

Add `runLive`:

```ts
  /**
   * A streamed run (spec 2026-09-26): one process that takes every message of the conversation while
   * it lives. Holds the lock `startIn` or `launchQueued` took and releases it in every path. One
   * retry on a fresh session when the resumed one is missing, exactly as `finishRun` does.
   */
  private async runLive(user: User, conversation: ChatConversation, runner: RunnerClient, configDir: string | null, appendSystemPrompt: string, turns: LiveTurn[]): Promise<void> {
    const live = new LiveRun({ userId: user.id, conversationId: conversation.id, sessionId: conversation.cli_session_id, chat: this.deps.repos.chat });
    for (const t of turns) live.add(t);
    this.live.set(conversation.id, live);
    try {
      let token: string;
      try {
        token = await mintConciergeToken(this.deps.repos, user.id, conversation.id, ['read', 'tasks', 'terminals'], { accountWide: conversation.project_id === null });
      } catch {
        await live.failOpen('TOKEN_FAILED');
        return;
      }
      for (let attempt = 0; ; attempt++) {
        const resume = live.sessionId !== null;
        const input: RunnerInput = {
          session_id: live.sessionId ?? randomUUID(),
          resume,
          text: live.initialText(),
          config_dir: configDir,
          model: conversation.model,
          token,
          append_system_prompt: appendSystemPrompt,
          stream_input: true,
        };
        let outcome: { code: ChatErrorCode; missingSession: boolean };
        try {
          outcome = await live.consume(runner.run(input));
        } catch (e) {
          if (isSetupFailure(e) && live.endedTurns === 0) {
            await live.abandon(e);
            this.publishSetupFailure(user, conversation.id);
            return;
          }
          outcome = { code: 'RUNNER_FAILED', missingSession: false };
        }
        if (resume && outcome.missingSession && live.endedTurns === 0 && attempt === 0) {
          await live.restart();
          continue;
        }
        await live.failOpen(outcome.code ?? 'RUNNER_FAILED');
        return;
      }
    } catch (err) {
      // A database failure mid-run must not leave `done` hanging for ever, nor escape as an unhandled
      // rejection: the open turns are failed as a runner failure, and only the label is logged.
      console.error('chat: live run failed', { conversation_id: conversation.id, error: failureLabel(err) });
      await live.failOpen('RUNNER_FAILED').catch(() => {});
    } finally {
      this.live.delete(conversation.id);
      this.releaseLock(user, conversation.id);
    }
  }
```

  Before `runLive`'s first run, the session id is the conversation's (`live.sessionId`), so `resume`
  is true exactly when the conversation has one. A fresh session gets a new uuid, and the CLI reports
  it back in its frames.

Add `launchQueued`:

```ts
  /**
   * Runs what was queued while the conversation's process could not take it: every queued message on
   * a streamed host, the first one on an old agent (the rest wait for that run's own release). Never
   * throws: it is scheduled from a `finally`, like the decision drain.
   */
  private async launchQueued(user: User, conversationId: string): Promise<void> {
    const queue = this.queued.get(conversationId);
    if (!queue?.length || this.running.has(conversationId)) return;
    let locked = false;
    try {
      const conversation = await this.deps.repos.chat.findByIdForUser(conversationId, user.id);
      const host = conversation && conversation.archived_at === null ? await this.hostForConversation(user, conversation) : null;
      if (!conversation || !host || host.kind !== 'ready') {
        // No host that can run them (the machine went away, the conversation was archived): each
        // queued message gets its answer row closed with a reason, never a bubble waiting for ever.
        for (const q of queue.splice(0)) await this.closeQueued(user, conversationId, q, 'HOST_GONE');
        return;
      }
      const appendSystemPrompt = await this.promptFor(user, conversation);
      if (this.running.has(conversationId)) return; // someone else took the lock; their release drains
      const runner = this.deps.runnerFor(host.machine.id);
      this.running.add(conversationId);
      locked = true;
      const streamed = this.streams(host.machine.id);
      const taken = streamed ? queue.splice(0) : queue.splice(0, 1);
      const turns: LiveTurn[] = [];
      for (const q of taken) turns.push({ uuid: randomUUID(), text: q.runText ?? (await this.runTextFor(user, conversationId, q.text)), question: q.question, answer: q.answer, settle: q.settle });
      // From here the run owns the lock and releases it itself.
      locked = false;
      if (streamed) void this.runLive(user, conversation, runner, host.configDir, streamedSystemPrompt(appendSystemPrompt), turns);
      else this.finishRun(user, conversation, turns[0].text, turns[0].question, turns[0].answer, runner, host.configDir, appendSystemPrompt).then(turns[0].settle.resolve, turns[0].settle.reject);
    } catch (err) {
      console.error('chat: queued messages could not be started', { conversation_id: conversationId, error: failureLabel(err) });
      for (const q of (this.queued.get(conversationId) ?? []).splice(0)) await this.closeQueued(user, conversationId, q, 'RUNNER_FAILED').catch(() => {});
      if (locked) this.running.delete(conversationId);
    }
  }

  /** Closes a queued message that will not run: its answer row says why, and its `done` resolves. */
  private async closeQueued(user: User, conversationId: string, q: QueuedTurn, code: ChatErrorCode): Promise<void> {
    const final = await this.deps.repos.chat.updateMessage(q.answer.id, { text: '', usage: null, error_code: code });
    chatBus.publish({ type: 'message', user_id: user.id, conversation_id: conversationId, message: final });
    chatBus.publish({ type: 'run_finished', user_id: user.id, conversation_id: conversationId, message_id: final.id, ok: false, error_code: code });
    q.settle.resolve(final);
  }
```

  Messages already taken off the queue when the `catch` runs (a failed `runTextFor`) are the
  exception: `runTextFor` never throws (it catches its own failure), so none are lost there.

Change `releaseLock`:

```ts
  private releaseLock(user: User, conversationId: string): void {
    this.running.delete(conversationId);
    // Messages typed while the process could not take them come first: the person is waiting on
    // them. The decision drain runs once nothing is queued (its own comment below still applies).
    if (this.queued.get(conversationId)?.length) {
      void this.launchQueued(user, conversationId).catch(() => {});
      return;
    }
    void this.drainNextDecision(user, conversationId).catch(() => {});
  }
```

  Keep the existing long comment about the drain above its line.

In `finishRun`, the text parameter is already the run text. No other change. Legacy runs ignore
`turn_started`/`background`.

- [ ] **Step 6: Run the service suite**

Run: `npm test -w @termhub/server -- src/chat`. Expected: PASS. Fix any other test that pinned a 409
for a typed message (Step 3).

- [ ] **Step 7: Run the route tests that exercise send/start**

Run: `npm test -w @termhub/server -- src/routes/chat.test.ts src/routes/m-chat.test.ts`. Expected:
PASS. A route test that expected 409 `CHAT_BUSY` for a typed message now expects success. Change it
to assert the 201/202 answer.

- [ ] **Step 8: Typecheck and commit**

```bash
npm run typecheck -w @termhub/server   # through Docker
git add apps/server/src/chat/service.ts apps/server/src/chat/service.test.ts apps/server/src/routes
git commit -m "Chat: take messages while the concierge works, injected or queued"
```

---

### Task 7: Web and mobile never lock the box

Board: new subtask "Web + mobile: campo sempre habilitado com respostas pendentes" (TER-64/65 keep
the subagent panel; a note on each says what is left).

**Files:**
- Modify: `apps/web/src/components/chat/ChatComposer.tsx`
- Modify: `apps/web/src/components/chat/ChatPanel.tsx`
- Test: `apps/web/src/components/chat/ChatComposer.dictation.test.tsx`, `ChatComposer.test.tsx`,
  `ChatPanel.test.tsx`
- Test: `apps/mobile/src/features/chat/viewmodel/createChatStore.test.ts`

**Interfaces:**
- `ChatComposerProps` loses `sending`. Every caller and test stops passing it.

- [ ] **Step 1: Write the failing web test** — append to `ChatPanel.test.tsx`:

```ts
it('takes a second message while the first is still being answered, and shows both as pending', async () => {
  chatMock.mockResolvedValue({ conversation: { id: 'c1', ai_account_id: null }, messages: [], actions: [], host: READY });
  // The POST of a web send only answers when its answer is written: hold the first one open.
  let finishFirst!: () => void;
  sendMock.mockImplementationOnce(() => new Promise((r) => (finishFirst = () => r({ message: msg({ id: 'a1', role: 'assistant', text: 'um' }) }))));
  sendMock.mockResolvedValueOnce({ message: msg({ id: 'a2', role: 'assistant', text: 'dois' }) });
  render(
    <MemoryRouter>
      <ChatPanel />
    </MemoryRouter>,
  );
  await waitFor(() => expect(chatMock).toHaveBeenCalled());
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'primeira' } });
  fireEvent.click(screen.getByRole('button', { name: /enviar/i }));
  await waitFor(() => expect(sendMock).toHaveBeenCalledTimes(1));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'segunda' } });
  const button = screen.getByRole('button', { name: /enviar/i }) as HTMLButtonElement;
  expect(button.disabled).toBe(false);
  expect(screen.queryByText('aguarde a resposta terminar')).toBeNull();
  fireEvent.click(button);
  await waitFor(() => expect(sendMock).toHaveBeenCalledTimes(2));
  expect(sendMock).toHaveBeenLastCalledWith('segunda');
  finishFirst();
});

it('shows "pensando…" on every answer that has started, not only the newest', async () => {
  chatMock.mockResolvedValue({
    conversation: { id: 'c1', ai_account_id: null },
    messages: [msg({ id: 'q1', text: 'um' }), msg({ id: 'a1', role: 'assistant' }), msg({ id: 'q2', text: 'dois' }), msg({ id: 'a2', role: 'assistant' })],
    actions: [],
    host: READY,
  });
  streamMock.mockReturnValue({
    events: [
      { type: 'message', conversation_id: 'c1', message: msg({ id: 'a1', role: 'assistant' }) },
      { type: 'message', conversation_id: 'c1', message: msg({ id: 'a2', role: 'assistant' }) },
    ],
    connected: true,
  });
  render(
    <MemoryRouter>
      <ChatPanel />
    </MemoryRouter>,
  );
  await waitFor(() => expect(screen.getAllByText(/pensando/i)).toHaveLength(2));
});
```

  Check `ChatTurn` for the exact "pensando…" copy and match it in the regex.

- [ ] **Step 2: Run and see them fail**

Run: `npm test -w @termhub/web -- src/components/chat`. Expected: the two new tests fail.

- [ ] **Step 3: Implement**

`ChatComposer.tsx`:
- Remove `sending` from `ChatComposerProps` and from the destructuring.
- `disabled` for the send role: `blocked || !hasText || busy`.
- `statusText`: `blockedReason ? blockedReason : busy ? 'transcrevendo…' : ''`.
- Replace the comment above `statusText` with: `The host's own reason outranks everything: it is the
  one that is not going to resolve on its own. An answer being written never locks the box: a message
  typed meanwhile goes to the concierge at once (spec 2026-09-26).`
- Update the component doc (`the pending flag and any error live in ChatPage`): `any error lives in ChatPanel`.

`ChatPanel.tsx`:
- Replace `const [sending, setSending] = useState(false);` with:

```ts
  /** Sends whose POST is still open (it answers when that message's answer is written). Several can be
   *  in flight: the box never waits for an answer (spec 2026-09-26). */
  const [inFlight, setInFlight] = useState(0);
  const sending = inFlight > 0;
```

- In `send`: `if (!value) return;`, `setInFlight((n) => n + 1);` instead of `setSending(true)`, and
  `setInFlight((n) => n - 1);` in `finally`.
- `waiting` in the thread: `const waiting = empty && (live.started.has(m.id) || (sending && m.id === lastMessageId));`
- Stop passing `sending` to `ChatComposer`.
- Update the 409 comment in `send`'s `catch`: a typed message is no longer answered `CHAT_BUSY`, but
  a 503 still is, and a host problem still is.

Composer tests:
- Delete the test `'says why the send button is disabled while the answer is still streaming'`.
- Drop `sending` from the `renderComposer` helper, its option type and every `<ChatComposer … sending={…} />`
  in both composer test files.

- [ ] **Step 4: Write the mobile test** — append to `createChatStore.test.ts`, following the file's
  `jest.spyOn(api, 'sendMessage')` pattern and the setup that `'send answers at once…'` uses to open
  a project. Copy those setup lines, don't invent new ones:

```ts
it('a second send while the first answer is still being written goes through', async () => {
  // …same open/setup as 'send answers at once and the thread grows only through events'…
  const sent = jest.spyOn(api, 'sendMessage').mockResolvedValue({ conversation_id: 'c1', user_message_id: 'q', assistant_message_id: 'a' } as never);
  await expect(chat.getState().send('primeira')).resolves.toBe(true);
  // No run_finished yet: the first answer is still pending, and the box takes the next message.
  await expect(chat.getState().send('segunda')).resolves.toBe(true);
  expect(sent).toHaveBeenCalledTimes(2);
  expect(chat.getState().error).toBeNull();
});
```

- [ ] **Step 5: Run web and mobile suites**

Run: `npm test -w @termhub/web && npm test -w @termhub/mobile`. Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/chat apps/mobile/src/features/chat
git commit -m "Chat screens: never lock the box while an answer is being written"
```

---

### Task 8: Whole-branch verification

Board: new subtask "Verificação: suítes, typecheck e builds (Docker)".

- [ ] **Step 1: Full test suites**

Run (through Docker): `npm run build:packages && npm test`. Expected: every workspace passes. If a
suite fails for a reason unrelated to this branch (it also fails on `origin/main`), record that in
the card and move on. Do not fix unrelated code.

- [ ] **Step 2: The CLAUDE.md verification**

```bash
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:20 \
  sh -c 'npm run build:packages && npm run typecheck -w @termhub/server && npm run typecheck -w @termhub/agent && npm run build -w @termhub/web && npm run build -w @termhub/landing'
rm -rf .npm
```

Expected: exit 0.

- [ ] **Step 3: Live smoke of the argv against the real CLI (no server needed)**

Run the built argv through the real `claude` on jarvis, with a fake MCP config:
- first line: a message asking for a background subagent;
- then a second line;
- then the end line.

Check that three `result` frames come back, and that the hook refused a foreground `Agent` if the
model tried one:

```bash
node -e "const {buildClaudeArgs}=require('./packages/claude-cli/dist/index.js');console.log(JSON.stringify(buildClaudeArgs({session_id:require('crypto').randomUUID(),resume:false,mcp_config_path:'/dev/null',model:'haiku',stream_input:true})))"
```

Node is not on jarvis. Run this through Docker to print the argv, then call `claude` on the host with
those arguments, replacing `--mcp-config /dev/null --strict-mcp-config` with just
`--strict-mcp-config`. Record the outcome (pass or fail, and what was seen) in the TER-59 card.

- [ ] **Step 4: Commit any fix-ups**, and leave the branch unpushed.
