# ai-memory in termhub's runs (TER-1020)

Epic TER-1007, after the spike (TER-1008, `docs/spikes/2026-10-07-ai-memory-spike.md`), the per-machine
opt-in (TER-1018) and the `_rules` pages (TER-1019). The agents termhub starts use the machine's local
ai-memory when both the project and the machine opted in.

## Opt-in

- **Project:** `setup.ai_memory.use_in_runs` (default `false`), "Usar o ai-memory nas execuções do termhub"
  in the project settings, next to "Publicar regras vigentes no ai-memory".
- **Machine:** "Usar ai-memory nesta máquina" (`machines.ai_memory_enabled`, TER-1018). The MCP URL is the
  machine's ai-memory server URL plus `/mcp` (default `http://127.0.0.1:49374/mcp`).
- Either one off: the launch line, the tab's `mcp.json` and the worktree are exactly as before.

## What each CLI gets

| CLI | MCP | Hooks | Prompt |
|---|---|---|---|
| Claude Code | `ai_memory` server in the tab's `mcp.json` (so `--resume` / `--continue` keep it); inline `--mcp-config <json>` when the tab has no termhub MCP | automatic runs only: `ai-memory install-hooks --agent claude-code --scope project --no-capture-prompts --apply` in the run's worktree (`.claude/settings.local.json`) | unchanged (the session brief brings the pinned `_rules` pages) |
| Codex | `-c mcp_servers.ai_memory.url="…"` on the line | none: `codex exec` skips untrusted hooks and trusting them is an interactive "Trust all" in Codex; termhub does not try to get around it | one line: "Consulte memory_query (MCP ai_memory) antes de re-investigar algo que já pode ter sido decidido." |
| Antigravity / Gemini CLI | none | none | termhub does not start them; the settings text calls it "suporte limitado" (global-only config, API key) and termhub never edits the person's global config |

## The worktree prep (automatic Claude runs)

Typed before the CLI line (`sh -c <script> termhub-ai-memory <checkout> <server url> >/dev/null 2>&1 ;`),
so the run starts whether it worked or not:

1. No `ai-memory` on the PATH: nothing.
2. A run's worktree is a separate folder, and ai-memory resolves the project from the nearest
   `.ai-memory.toml` up the tree (else the folder's basename, here the card's). When the worktree has no
   marker and the project's checkout has an untracked one, the prep copies it with
   `project = "<checkout folder>"` added when it names none, so the run sees the same `_rules` pages.
   No marker anywhere: nothing (termhub never creates the marker, TER-1019).
3. The hooks through ai-memory's own installer, with `CLAUDE_CONFIG_DIR` pointed at a throwaway folder so
   an installer that ignored `--scope project` could still never write the person's `~/.claude`. Skipped
   when `.claude/settings.local.json` is tracked.
4. Files the prep created that git would show go to the repository's `info/exclude`, so the run never
   commits them.

A manual or `start_agent` tab runs in the project's own checkout: it gets the MCP only, and whatever hooks
the person set up there stay theirs.

`--no-capture-prompts` is always passed (prompts are not stored). `[handoff] create_on_session_end = false`
is suggested in the settings text, not written: the marker is the person's.

## Limits

- A Claude tab without the termhub tab MCP (no `MCP_URL`) gets ai-memory inline; a resume of that tab
  loses it. Codex's `resume --last` loses both MCPs, as before.
- The hook command strings are ai-memory's, not termhub's: if a future ai-memory changes the installer
  flags, the install fails silently and the run still has the MCP.

## Impact on other users

Opt-in per project and per machine, both off by default. Someone who turns neither on sees the same
launch lines and files as before. With both on, termhub writes only inside the run's worktree (and the
repository's `info/exclude`), never in a global CLI config.
