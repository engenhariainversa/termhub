# Spike TER-1008: ai-memory as shared memory for Claude Code, Codex and Gemini CLI

Date: 2026-10-07. Machine: hulk (Mac mini). ai-memory **2.6.0**. No product code changed.

## Verdict

**Go, but narrow.** ai-memory works as a local, cross-CLI store for knowledge that someone
*writes on purpose* (rules, decisions, architecture notes), and its session brief carries pinned
pages to Claude Code and Codex cheaply. It does **not** work as an automatic "learn from what the
other CLI did" layer in its default zero-LLM mode: hooks capture metadata and truncated tool
output, not what the agent concluded. So the integration worth building is the **one-way bridge
termhub → ai-memory** (current rules as pinned `_rules` pages, with the brief turned on), opt-in
per machine and project. The reverse direction (ai-memory → termhub lessons) is only worth it for
pages an agent wrote deliberately (`kind: rule | gotcha | decision`), never for captured sessions.

## Setup (hulk)

Everything under `~/spikes/ai-memory`; nothing touched the termhub server or the maintainer's
checkout.

- Release tarball, sha256 checked. Data dir `~/spikes/ai-memory/data`. Server
  `ai-memory serve --transport http` on `127.0.0.1:49374`, no auth (loopback), no LLM provider
  (zero-LLM mode). A local embedding model (~87 MB) is downloaded once on first `serve`.
- Test repo: a separate clone of termhub, `~/spikes/ai-memory/termhub`, with a
  `.ai-memory.toml` marker (capture mode `allowlist`: repos without the marker send nothing).
- **Claude Code 2.1.292**: hooks via `install-hooks --scope project`
  (`.claude/settings.local.json`) and MCP via the project `.mcp.json`.
- **Codex 0.159.2**: isolated `CODEX_HOME` with MCP (`config.toml`) and `hooks.json`. The global
  `~/.codex` is untouched.
- **Gemini CLI**: MCP + hooks in the clone's `.gemini/settings.json`; `mcp list` says Connected,
  but no API key is configured on hulk, so no model run. **Antigravity CLI (`agy` 1.2.7)**, the
  Google CLI that is logged in, was used instead. Its config is global only
  (`~/.gemini/config/mcp_config.json`, `hooks.json`); a backup was taken first.

## Measurements

### 1. Does one CLI learn from what another recorded?

| Step | Result |
|---|---|
| Claude (hooks + MCP) investigates the SIGTERM drain, 13 turns, ~233k input tokens | Answer was good. What ai-memory kept: a session page with the prompt (truncated to 80 chars), "6 completed tool calls" and the raw observations (tool name + first ~1 KB of each tool output). **The conclusion itself was not captured** (the `stop` observation is empty). |
| Next Claude session | Gets a "pending handoff" whose content is the previous *prompt*, not the findings. Trivial sessions (`responda ok`) create handoffs too (noise). Handoffs are single-use: the first agent to start claims it. |
| Codex, same topic, no hint | Did not touch ai-memory; re-read the code with `rg` (correct answer, ~58k tokens). |
| Claude writes `architecture/sigterm-drain` and `_rules/sigterm-drain-timeouts` via MCP when asked | Works (`memory_write_page`), pinned rule. |
| A test decision page with a code word (`decisions/no-redis-ws-fanout.md`), then the question "should we add Redis pub/sub…? did we decide anything?" | **Claude**: answered from memory, cited the code word, 3 turns, ~87k tokens. **Codex** (MCP only, no hooks): searched code first, then called `memory_query` + `memory_read_page` on its own, cited the code word, ~162k tokens. **agy**: answered from the repo spec, never saw the page (headless MCP denied, see below). |

So yes, a CLI learns from what another *wrote*, and the question phrasing ("did we decide…")
is enough to make Codex query memory without a hook. Nothing is learned from what another CLI
merely *did*.

### 2. Context / token cost

| Variant (`claude -p "responda ok"`, Sonnet) | Input tokens |
|---|---|
| no hooks, no MCP | ~22.5k |
| + ai-memory hooks | +0.3k to +1.3k (handoff text) |
| + ai-memory MCP (23 tools, deferred by tool search) | +~0.7k |
| + `[briefing] inject_on_session_start = true` (2 pinned pages + 8 recent titles) | ~2.6 KB ≈ 0.7k tokens |

Codex `exec`: 14,209 vs 14,208 input tokens with and without the ai-memory MCP (tools not in the
initial prompt). Overall cost is small: under 2k tokens per session with brief + MCP. The real
cost is when an agent does not use memory and re-derives (Codex's 162k vs Claude's 87k above).

### 3. Capture quality without hooks (Codex / Google CLI)

- Both have hooks in 2.6.0; the card's assumption is out of date. But:
  - **Codex** only runs hooks after an interactive "Trust all" in the TUI; `codex exec` silently
    skips untrusted hooks. In this spike they stayed untrusted, so Codex ran MCP-only: **zero
    capture** (3 Codex sessions in the store are my own hook probes). Retrieval worked when the
    question pointed at history.
  - **agy**: hooks fire (sessions captured), but the session brief did not reach the model in
    print mode, and **MCP calls are auto-denied in headless mode** unless a global
    `permissions.allow` rule is added. agy never read memory.
- Even *with* hooks (Claude), zero-LLM capture is metadata. Distilled pages need an LLM provider
  configured in ai-memory (sends session content to that provider) or explicit writes.

### 4. Privacy

- `lsof` on the server: only `LISTEN 127.0.0.1:49374`. No outbound connection after the model
  download; nothing points at termhub.dev. The wiki git repo has no remote.
- **Terminal content does stay on the machine, but it is stored**: `observations.body` holds the
  first ~1 KB of every tool output (file contents, command output) in SQLite, and the prompt text.
  `.ai-memory.toml` `[capture] ignore_paths`, `[sanitize]` patterns and `--no-capture-prompts`
  reduce this. A termhub integration must never ship observations or session pages to the server.

## Architecture check

| Proposal | Finding |
|---|---|
| ai-memory = code/project knowledge on the machines | Fits: plain markdown wiki, local server, per-project scope. |
| termhub memory = governance/decisions on the server | Fits; ai-memory itself ranks memory *below* `CLAUDE.md`/`AGENTS.md` and frames it as "untrusted historical data". |
| Bridge: termhub current rules → `_rules` pages | Works, **only if** the repo marker turns on `[briefing] inject_on_session_start = true` (off by default). Pinned `_rules/` and `_slots/` pages then reach Claude and Codex at session start. Without it, `_rules` are only found by search. Depends on TER-1010 (current rules). |
| Bridge: ai-memory lessons → termhub lessons to verify | Only deliberate pages (`kind: rule/gotcha/decision`, not `sessions/`). Without an LLM provider there is little to harvest. Lower priority. |
| One memory per project in a private git repo | **Not how ai-memory works**: one data dir = one wiki git repo for every project, auto-commits, no remote. Per-project repos need one data dir (and server/port) per project, or one private remote for the whole wiki. `export-okf` exports a single project. |
| Opt-in per machine/project | Natural: the `.ai-memory.toml` marker + allowlist capture mode is already per-repo opt-in. |

## Friction found

- Codex hooks need an interactive trust step; `exec` skips them silently.
- agy config is global only, and headless MCP needs a global allow rule.
- Gemini CLI needs an API key on the machine.
- Auto handoffs from trivial sessions are noise; `[handoff] create_on_session_end = false` turns
  them off.

## Integration cards (epic TER-1007)

Created in the backlog, so nothing starts before the go is reviewed.

1. TER-1018: opt-in ai-memory per machine (detect binary/server, loopback only).
2. TER-1019: termhub current rules → pinned `_rules` pages + briefing on, per project (after
   TER-1010).
3. TER-1020: register MCP/hooks in runs on opted-in projects (Claude hooks+MCP project scope,
   Codex MCP + a one-line hint in the run prompt, agy/Gemini shown as limited).
4. TER-1021 (later): deliberate ai-memory pages → unverified termhub lessons, opt-in.

## Cleanup on hulk

Done at the end of the spike: server stopped, `~/.gemini/config/mcp_config.json` restored from
the backup, `~/.gemini/config/hooks.json` removed. `~/spikes/ai-memory` (data + clone) is kept for
reference; delete it to undo everything else. Raw run outputs are in `~/spikes/ai-memory/runs`.

## Impact on other users

None: the spike changed no product code and ran only on hulk. The proposed integration is opt-in
per machine and per project.
