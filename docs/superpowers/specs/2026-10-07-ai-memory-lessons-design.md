# Deliberate ai-memory pages as unverified lessons — design

Card: **TER-1021** (epic TER-1007). Origin: spike TER-1008 (`docs/spikes/2026-10-07-ai-memory-spike.md`).
Builds on the failure lessons (`2026-09-27-failure-lessons-design.md`): `lesson` items, the "Lições"
list on the Memória screen, Verificar / Esquecer.

## What it does

A project can opt in (Configurações do projeto → "Lições do ai-memory", off by default). On every docs
pass of the memory sweeper (every 30 minutes, and once right after the option is turned on), each
machine linked to the project is asked for the project's **deliberate** ai-memory pages, the ones in
`_rules/`, `gotchas/` and `decisions/`. Each becomes a `lesson` item, trust `derived`, **not verified**,
with its origin (machine and page path). The person verifies it or discards it ("Esquecer") on the
Memória screen, web and app.

## Decisions

| # | Topic | Decision |
|---|---|---|
| D1 | What is read | Only `<wiki>/[<workspace>/]<project>/{_rules,gotchas,decisions}/*.md`, not recursively. `sessions/`, observations (SQLite), handoffs, `notes/`, `concepts/` and anything else are never read: the machine script only walks those three directories, the server parser drops any other path, and a page whose front matter has `session_id` or `consolidated: true` (text derived from captured sessions) is refused. A front matter `kind` other than `rule`/`gotcha`/`decision` is refused too. |
| D2 | Not our own rules | `_rules/termhub-*.md` are skipped: that is where TER-1019 publishes termhub's current rules, so importing them back would loop. |
| D3 | Where the wiki is | `data_dir` from `ai-memory status --json` when the binary is on `PATH`, else `$AI_MEMORY_DATA_DIR`, `$XDG_DATA_HOME/ai-memory` (`~/.local/share/ai-memory`) or `~/Library/Application Support/ai-memory`, the first with a `wiki/` dir. No wiki: nothing is read, nothing is deleted. |
| D4 | Which ai-memory project | `project = "…"` in the checkout's `.ai-memory.toml`, else the main repository root's directory name (ai-memory's `repo-root` strategy, so worktrees map to the same project), else the cwd's basename. |
| D5 | Transport | A new agent RPC `aimemory.pages` (agent 0.22.0, version-gated like `docs.scan`); the same `@termhub/machine-ops` script through `runOnMachine` on ssh/local machines, the cwd `shellQuote`d. Caps: 50 pages, 64 KiB per page, 600 KiB per call (one control frame). |
| D6 | Storage | `source_id` `<link id>:ai-memory/<path>`, `source_hash` = the page's sha256, `meta.origin = 'ai-memory'` with `machine_id`, `machine_name` and `ai_memory_kind`. An unchanged page is not rewritten; a changed one drops its verification (verification is keyed on `source_hash`); a page gone from the wiki is deleted; an unlinked machine's pages go with `deleteDocsNotInLinks`. |
| D7 | Turning it off | The next docs pass removes the project's ai-memory lessons (verified ones included). |
| D8 | Esquecer | Hides the lesson (`hidden_hash`), like a file lesson; the page stays on the machine and comes back, unverified, only if it changes. |
| D9 | Older app builds | The lessons list keeps `origin` within `file` / `note` (the app's contract is a closed enum) and carries the real origin in a new `ai_memory: { machine_name, kind }` field. `search_memory` (read by models, not by the app) answers `origin: 'ai-memory'` and `machine`. |

## Not in this card

- A per-machine data dir setting: TER-1018 (ai-memory opt-in per machine) is where a configured data dir
  would come from; until then D3's discovery is used.
- Writing to ai-memory (TER-1019) and wiring MCP/hooks in runs (TER-1020).

## Impact on other users

Opt-in per project, off by default. Without it nothing is read from any machine and nothing changes on
the Memória screen. With it, only pages someone wrote on purpose reach the server; terminal content and
captured sessions never leave the machine. Machines need agent 0.22.0 for the import (older agents are
skipped until they update).
