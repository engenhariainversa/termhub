# Claude account swap on usage limit — design (TER-55)

Status: approved for implementation (decisions taken autonomously on 2026-09-26, see §9).

## 1. Problem

On 2026-09-25 the tab `chat-permissoes` (TER-2) lost its Claude session: the account hit its weekly
limit, Claude Code ended up back at the shell, and the person had to switch accounts by hand and
resume. termhub already knows every Claude account of a machine (`ai_accounts.config_dir`) and their
5h/7d usage, but a tab knows neither which Claude session it runs nor which account it runs it on,
and nothing reacts to the limit.

Goal: when a Claude session in a tab stops because of a usage limit, termhub offers to switch that
tab to another Claude account of the same machine that still has room and resume the **same**
session there, keeping its context. It does so on a button first; an opt-in per machine makes it
automatic.

## 2. Spike findings (verified on jarvis, Claude Code 2.1.283)

1. **What the limit looks like.** The API error is written to the transcript as an `assistant`
   message with `isApiErrorMessage: true`, `error: "rate_limit"` and text such as
   `You've hit your weekly limit · resets 1pm (America/Sao_Paulo)`. Claude Code then does **not**
   exit: it shows `Usage limit reached · continuing automatically at 1pm · esc or type to cancel`
   and waits. (On 2026-09-25 it only exited four minutes later, which cancelled the auto-continue.)
2. **Detection hook.** Claude Code has a `StopFailure` hook: "Fires instead of Stop when an API error
   (rate limit, auth failure, etc.) ended the turn. Fire-and-forget — hook output and exit codes are
   ignored." Its matcher field is `error`, with values `rate_limit`, `overloaded`,
   `authentication_failed`, `billing_error`, `server_error`, … Like every hook it receives
   `session_id`, `transcript_path` and `cwd`. termhub's hook script already forwards any event it
   does not reduce, so subscribing to `StopFailure` is enough to learn about the limit.
3. **Where a session lives.** `$CLAUDE_CONFIG_DIR/projects/<cwd slug>/<session id>.jsonl` (plus an
   optional `<session id>/` directory for subagents and tool results). The default account (no
   `CLAUDE_CONFIG_DIR`) uses `~/.claude/projects`.
4. **Resuming under another account works through a symlink.** Probe: session created under
   `~/.claude_pedrogoiania`; `CLAUDE_CONFIG_DIR=~/.claude claude -p --resume <id>` answered
   `No conversation found with session ID`. After
   `ln -s <A>/projects/<slug>/<id>.jsonl <B>/projects/<slug>/<id>.jsonl`, the same command resumed
   with the context (it recalled a codeword from the first turn) and appended to the shared file.
5. **What termhub has today.** `ai_accounts` per machine with `config_dir`; usage per account from
   the OAuth usage API (`apps/server/src/ai`, 5 min cache); Claude hooks feeding tab state
   (`monitor/state.ts`); `start_agent` launches `CLAUDE_CONFIG_DIR=… claude '<prompt>'` in a new tab.
   Missing: the tab's Claude session id / transcript path, the tab's account, any `--resume`, any
   account selection.

## 3. Scope

In:
- Claude Code only, accounts of the tab's own machine only, the swap happens in the same tab (same
  tmux session).
- Detection of the usage limit through `StopFailure`.
- A "Trocar conta e retomar" button on a limited tab (manual swap), and an opt-in automatic swap per
  machine (`claude_auto_swap`, off by default).
- A history entry on the tab for every swap, and the tab's state text telling what happened.

Out (candidate follow-up cards, §10): Codex/other providers, moving a session to another machine,
swapping before the limit (proactive, from usage %), an MCP tool for the swap, mobile UI, returning to
the original account after its reset.

## 4. Design

### 4.1 Data (one additive migration, backward compatible)

`tabs`:
- `agent_session_id text null` — the Claude session id last reported by a hook of this tab.
- `agent_transcript_path text null` — its transcript path on the machine (absolute).
- `ai_account_id text null` → `ai_accounts(id)` `on delete set null` — the account the tab's agent was
  started with by termhub (`start_agent` or a swap). null = unknown (started by hand).
- `rate_limited_at timestamptz null` — set when a `StopFailure` with `error = rate_limit` arrives,
  cleared by the next event that means the agent is running again (`SessionStart`,
  `UserPromptSubmit`, `PreToolUse`, or a normal `Stop`).

`machines`:
- `claude_auto_swap boolean not null default false`.

The old container ignores the new columns; nothing is renamed or dropped.

### 4.2 Hooks

- `CLAUDE_HOOK_EVENTS` gains `StopFailure` (no matcher: every API error comes in; only
  `rate_limit` triggers the swap). The hook script needs no change: the event goes out as-is.
- Agent machines get it when `@termhub/agent` is updated (its `heal` re-merges the entries on every
  connect) — so this change bumps the agent's version. Local/ssh machines get it by reinstalling the
  hooks from Máquinas.

### 4.3 Interpreting events (`monitor/state.ts`, `monitor/ingest.ts`)

- `StopFailure`:
  - `error = rate_limit` → state `waiting_input` (so it "needs you": orange dot, toast, needs-you
    list), text `Limite de uso da conta atingido` + ` — <last_assistant_message>` when the payload
    carries it (capped), meta `{ event: 'StopFailure', error: 'rate_limit' }`, and the tab's
    `rate_limited_at` is set.
  - any other error → state `error`, text `Erro da API do Claude (<error>)`, meta with the error.
- Every Claude event that carries a well-formed `session_id` (UUID) and `transcript_path` (absolute,
  ending in `/projects/<slug>/<session_id>.jsonl`, no newline or NUL) updates `agent_session_id` /
  `agent_transcript_path` when they changed (a `/clear` starts a new session id). Malformed values
  are ignored, never stored.
- `SessionStart`, `UserPromptSubmit`, `PreToolUse` and a normal `Stop` (a turn that ended proves the
  account works again; Claude's own auto-continue after the reset may produce only that) clear
  `rate_limited_at` when it is set.
- The transcript path is metadata (like a tab id); its content is never read by the server.

### 4.4 The swap (`apps/server/src/control/account-swap.ts`)

`swapAccount(deps, tab, { accountId?, auto })`:

1. **Preconditions.** The tab has `agent_session_id` and `agent_transcript_path`
   (`NO_SESSION` otherwise); its machine is online and supports `claude`; no other swap is running
   for this tab (in-memory lock, `SWAP_IN_PROGRESS`).
2. **Candidates.** Claude accounts of the tab's machine (scoped to the machine's owner), minus the
   tab's `ai_account_id`. With `accountId` given, only that one (it must be a Claude account on the
   same machine: `ACCOUNT_OTHER_MACHINE` / `PROVIDER_UNSUPPORTED`).
3. **Ranking.** For each candidate, `getAccountUsage(account, machine, refresh = true)`. Score = the
   highest `utilization` among its windows. Accounts with a score ≥ `SWAP_MAX_UTILIZATION` (90) are
   dropped; accounts whose usage could not be read rank after all known ones; ties keep list order.
   An explicit `accountId` skips the threshold (the person chose).
4. **Link (on the machine, via `runOnMachine`, before touching the agent).** A shell script, every
   value `shellQuote`d (config dirs through the same `~`-aware quoting as `launchLine`), that:
   - checks the transcript file exists (`NO_TRANSCRIPT`);
   - derives the source config dir from the path and compares it with the target dir by physical
     path — same dir means the candidate *is* the current account (`SAME_ACCOUNT`: skip to the next
     candidate; this is how an unknown `ai_account_id` is handled);
   - checks the target dir exists (`NO_CONFIG_DIR`);
   - `mkdir -p <target>/projects/<slug>` and `ln -s` the `.jsonl` (and the `<id>/` directory when it
     exists); an existing entry that is already the same file (`-ef`) is fine, anything else is
     `LINK_CONFLICT` and nothing is overwritten.
   The first candidate whose link succeeds is the chosen account; none → `NO_CANDIDATE` (the tab is
   left exactly as it was).
5. **Stop the waiting Claude.** Send `Escape` (cancels the auto-continue), pause 400 ms
   (`ESCAPE_PAUSE_MS`: sent back to back, `\x1b/` can be read as Alt+/), then type `/exit` + Enter;
   wait until the tab's state becomes `idle` (the `SessionEnd` hook) — up to 15 s; if not, send
   `C-c` twice and wait 10 s more; still not idle → `EXIT_TIMEOUT` (the link stays, harmless). Once
   idle, pause 1 s (`RESUME_SETTLE_MS`) so the shell takes the tty back. A tab already idle before
   the swap (Claude had exited) gets no keys and no pause.
6. **Record.** Before anything is typed: `tabs.ai_account_id = chosen`, `rate_limited_at = null`
   (so the resumed session's first hooks, or a fast new `StopFailure`, land after this write), then a
   tab event (state `waiting_input`, text `Conta trocada: <de> → <para>. Se o Claude pedir para
   confiar na pasta, confirme na aba.` or `Conta trocada automaticamente: …`, meta
   `{ event: 'AccountSwap', from, to, auto }`), published on the monitor bus like any state change.
   Workspace trust is stored per account, so the resumed Claude may show its trust dialog; termhub
   never answers it. The resumed session's own `SessionStart` (Claude runs hooks only once the folder
   is trusted) moves the tab to `working`, so the "needs you" state only lasts when the person must act.
   Logs carry ids only.
7. **Resume.** Type `resumeLine(configDir, sessionId, RESUME_PROMPT)` =
   `CLAUDE_CONFIG_DIR=<dir> claude --resume <id> '<prompt>'` (no env for the default account; no
   permission-bypass flag, ever). `RESUME_PROMPT` =
   `A conta anterior atingiu o limite de uso. Continue a tarefa de onde parou.` A failure typing it
   is returned as an error; the tab already names the new account, where the linked session lives.

Result: `{ from: {id,label}|null, to: {id,label} }`.

### 4.5 Triggers

- **Manual:** `POST /api/tabs/:id/account-swap` `{ account_id?: string }` (zod), under
  `terminals` with action `update`, the tab loaded through `scoped(repos, request).tab(id)`.
  Errors map to 409 (`SWAP_IN_PROGRESS`, `NO_SESSION`, `NO_CANDIDATE`, `EXIT_TIMEOUT`, …) with the
  pt-BR message.
- **Automatic:** in `ingestHookEvent`, after the state is recorded, a `StopFailure`/`rate_limit` on a
  tab whose machine has `claude_auto_swap = true` starts `swapAccount(…, { auto: true })` in the
  background (never awaited by the hook request; failures are recorded as a tab event with state
  `waiting_input` and text `Troca automática falhou: <motivo>` so the person still sees the limit).
  At most one automatic swap per tab every 10 minutes (in memory), so two exhausted accounts can
  never ping-pong. It starts 3 s after the hook, and only if the tab, re-read then, still carries the
  same `rate_limited_at` (a manual swap in between cleared it; a newer limit has its own call); a
  swap already running on the tab (`SWAP_IN_PROGRESS`) is skipped silently, not recorded.
- `start_agent` stores the account it launched with in `tabs.ai_account_id`.

### 4.6 Web

- Tab type gets `rate_limited_at`, `ai_account_id`, `agent_session_id` (read-only).
- `TerminalsView`: when the focused tab has `rate_limited_at` and is not `working`, a slim banner
  above the terminal: `Limite de uso da conta atingido.` + button `Trocar conta e retomar` (calls the
  route; shows the error message on failure; disabled while running). Shown only with
  `terminals:update`.
- `AiAccountsView`: under the list, `Troca automática` — one checkbox per machine that has two or
  more Claude accounts: `Trocar de conta sozinho quando o Claude atingir o limite em <máquina>`
  (PATCH `/api/machines/:id` `{ claude_auto_swap }`, needs `machines:update`).

## 5. Error handling

Every step before (5) leaves the tab untouched. Failures come back as `ControlError`-style codes with
pt-BR messages. A swap never overwrites an existing transcript, never deletes anything, and never
runs a destructive command on the machine.

## 6. Security

- The transcript path and session id come from the machine's hook (authenticated by the machine's
  hook token) and are validated by pattern before being stored; they are still `shellQuote`d when
  used.
- No terminal content is logged or stored; the state text is the CLI's own error line (capped), as
  with `Stop`.
- The swap acts only on a tab in the caller's scope and only with accounts of that tab's machine.

## 7. Testing

- `machine-ops`: `StopFailure` is in the merged settings; the link script (`accountLinkScript`) run
  against a temp HOME with real files: link created, `SAME_ACCOUNT`, `LINK_CONFLICT`, idempotent
  re-link, `<id>/` directory linked.
- `server/monitor`: `interpretClaude` for `StopFailure` (rate limit / other); ingest stores session id
  and transcript path, sets and clears `rate_limited_at`, ignores malformed values (DB tests).
- `server/control/account-swap`: ranking (threshold, unknown usage last, explicit account), link
  outcomes → next candidate, exit sequence and timeout, resume line, record — with fakes for
  machine exec, tmux and usage.
- Routes: `POST /tabs/:id/account-swap` (scope, zod, error mapping), `PATCH /machines/:id`
  `claude_auto_swap`.
- Auto trigger: only when enabled, cooldown respected, failure recorded.
- Web: banner visibility and click, auto-swap checkbox.

## 8. Rollout

Additive migration; agent version bump (published by CI on merge); nothing changes for a machine
until its hooks include `StopFailure` and it has two Claude accounts registered. On jarvis this means
registering the second login (`~/.claude` vs `~/.claude_pedrogoiania`) in Configurações → Contas.

## 9. Decisions taken (2026-09-26, autonomous — Pedro asked for no questions)

1. Manual button now, automatic swap behind a per-machine flag, off by default (option C).
2. Detection by the `StopFailure` hook, not screen parsing.
3. Resume by symlinking the transcript into the target account, not copying (both accounts keep
   writing the same file; the swap is cheap and reversible).
4. Same machine, same tab, Claude only.
5. Limited tab = `waiting_input` (needs you) + `rate_limited_at`; no new `TabState` value (an old
   container could not read one).
6. Selection: lowest peak utilization below 90 %, unknown usage last, current account excluded (by id
   or by physical config dir).
7. The flag lives on the machine because accounts are per machine.
8. At most one automatic swap per tab per 10 minutes.

## 10. Follow-up cards (proposed)

- Proactive swap when a working tab's account crosses a usage threshold (between turns).
- MCP tool `swap_account` (orchestrating agents recovering their own tabs).
- Swap button in the mobile app and in the needs-you list.
- Same flow for Codex (`CODEX_HOME`, `codex resume`).
- Offer to go back to the original account after its reset.
