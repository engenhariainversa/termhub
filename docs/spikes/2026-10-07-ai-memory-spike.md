# Spike TER-1008: ai-memory as shared memory for Claude Code, Codex and Gemini CLI

Status: **WIP**. Setup is done on hulk; the measured runs have not started yet.

## Setup done (hulk, 2026-10-07)

Everything lives under `~/spikes/ai-memory` on hulk. Nothing touches the termhub server.

- ai-memory **2.6.0**, macOS aarch64 release tarball (sha256 checked against the release file:
  `3c23c80b…bff9`). Data dir `~/spikes/ai-memory/data` (`AI_MEMORY_DATA_DIR`), not the default
  `~/Library/Application Support/ai-memory`.
- Server: `ai-memory serve --transport http`, run with `nohup` (no launchd) on `127.0.0.1:49374`,
  with no auth because it is loopback only. No LLM provider is configured (zero-LLM mode), so the
  auto-improve scheduler does not start.
- Test repo: a local clone of termhub at `~/spikes/ai-memory/termhub`. It is not the maintainer's
  checkout at `/Volumes/Extra/projects/8020/termhub`.
- **Claude Code**: hooks with `install-hooks --scope project`, which writes
  `termhub/.claude/settings.local.json`; MCP through a project `.mcp.json`. Project-scoped only.
- **Codex 0.159.2**: an isolated `CODEX_HOME=~/spikes/ai-memory/codex-home` (`auth.json` is a
  symlink to `~/.codex/auth.json`), holding `config.toml` (MCP) and `hooks.json`. The global
  `~/.codex` is untouched. Codex asks to trust new hooks on first start.
- **Gemini CLI**: MCP and hooks in the project's `termhub/.gemini/settings.json`.
  `npx @google/gemini-cli mcp list` reports `ai-memory … Connected`. **Blocker**: Gemini CLI on
  hulk is set to `gemini-api-key` and no key is available, so no model run is possible.
- **Antigravity CLI (`agy` 1.2.7)**, Google's CLI that is logged in on hulk, is used as the Google
  harness. Its config is **global only**: ai-memory added an `ai-memory` entry to
  `~/.gemini/config/mcp_config.json` (backups next to the file and in
  `~/spikes/ai-memory/backup/`) and created `~/.gemini/config/hooks.json` with
  `--capture-mode allowlist`. Only repos that have a `.ai-memory.toml` marker (just the test clone)
  emit events.

## Findings so far

- Zero-LLM by default. The only outbound traffic so far is a one-time download of a local
  embedding model (~87 MB) at the first `serve`. After that the server listens only on loopback
  (`lsof` shows LISTEN 127.0.0.1:49374 and nothing else).
- Gemini CLI **does** have hooks in 2.6.0 (`install-hooks --agent gemini-cli`). The card's
  assumption that Codex and Gemini have no hooks is out of date; Codex has hooks too.
- The wiki is **one git repo for every project** (`data/wiki/.git`), with auto-commits and no
  remote push. "One memory per project in a private repo" therefore needs one data dir (and
  server) per project, or one private remote for the whole wiki.
- `_rules/` pages exist and are injected at SessionStart with an authority boost. This supports the
  proposed bridge (termhub's current rules written as `_rules` pages).
- 23 MCP tools are registered; their context cost is not measured yet.

## Next steps

1. Token baseline: `claude -p "responda ok" --output-format json` with and without
   `--mcp-config .mcp.json` (`--strict-mcp-config`); the same for `codex exec --json` with and
   without the isolated `CODEX_HOME`.
2. Real chain on the clone: Claude (hooks) investigates something (e.g. the agent drain on SIGTERM)
   → check what was captured (`ai-memory search`, wiki/sessions) → Codex and `agy -p` are asked a
   related question with no hint. Does the SessionStart injection deliver it? Repeat with an
   explicit `memory_write_page` under `_rules/`.
3. Privacy: `lsof` during the runs, and confirm that nothing goes to app.termhub.dev.
4. Report, go/no-go, and integration cards in epic TER-1007 if go.
5. Cleanup on hulk: stop the server (`pkill -f 'ai-memory serve'`), restore
   `~/.gemini/config/mcp_config.json` from the backup, and remove `~/.gemini/config/hooks.json`.
