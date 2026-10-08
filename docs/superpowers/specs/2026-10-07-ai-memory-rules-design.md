# Current rules as pinned ai-memory pages (TER-1019)

Epic TER-1007, after the ai-memory spike (TER-1008, `docs/spikes/2026-10-07-ai-memory-spike.md`).
The project's current rules (`currentRules`, TER-1011) reach Claude Code and Codex in any session on the
machine, inside termhub or not, through the ai-memory session brief.

## Measured on ai-memory 2.6.0 (hulk)

- `write-page`, `read-page` and `delete-page` go through the local ai-memory **server**
  (`AI_MEMORY_SERVER_URL`, default `http://127.0.0.1:49374`); with no server they exit 1.
- The ai-memory project is resolved from the cwd (the nearest `.ai-memory.toml` marker, else the
  directory's basename), so the commands run with the checkout as cwd.
- `write-page --path _rules/x.md --kind rule --pinned --title T -t termhub --body -` creates or replaces
  the page. `delete-page --path _rules/x.md` exits 0 also when the page is already gone.
- The session-start hook returns an empty brief unless the marker has
  `[briefing] inject_on_session_start = true`; with it, every pinned `_rules/` page is in the brief
  (title + body).

## Opt-in

- **Project:** `setup.ai_memory.publish_rules` (default `false`), "Publicar regras vigentes no
  ai-memory" in the project settings.
- **Machine:** TER-1018 (per-machine "Usar ai-memory nesta máquina" and server URL) is not merged yet.
  Until it is, a machine takes part only when the person already set ai-memory up for that checkout:
  the `ai-memory` binary is on the PATH **and** the checkout has a `.ai-memory.toml` marker. termhub
  never creates the marker (it turns on capture for the repo). The server URL comes from one seam,
  `aiMemoryServerUrl(machine)`, that returns the default loopback URL today and TER-1018's setting
  later; TER-1018 also adds its own "on" flag to that seam.

## What is published

- Only `currentRules(project.owner_id, project.id)`: the owner's own current decisions for the project
  and their account-wide ones. Nothing from conversations, nothing of other users.
- One page per rule, newest first, at most `AI_MEMORY_RULES_MAX` (8) so the brief stays near the
  spike's ~0.7k tokens: `_rules/termhub-<title-slug>-<note id>.md`, title = the rule's question,
  body = the decision plus a source line (`Regra vigente do termhub (note:<id>)…`), each clipped.
- A rule that is no longer current (superseded, wrong, expired, removed), or past the cap, or the whole
  set when the option is turned off, is deleted with `delete-page`.

## How

- Table `ai_memory_pages` (`project_id`, `machine_id`, `cwd`, `path`, `hash`, `published_at`; unique per
  project+machine+cwd+path; cascades): what termhub wrote in each checkout, so it knows what to delete
  (also after an unlink or a cwd change) and skips unchanged pages. Migration is additive.
- `syncAiMemoryRules(projectId)` diffs the wanted pages against that table per linked machine (and per
  machine that still has rows but is no longer linked) and, only when something changed, runs one
  script in the checkout: check binary and marker, make sure `[briefing] inject_on_session_start =
  true` (edits the marker in place, only when there are writes), then `write-page` / `delete-page` for
  each change, reporting `ok write|delete <path>` lines. Rows follow what succeeded.
- ssh/local machines run the script (`@termhub/machine-ops`) through `runOnMachineWithInput`, every
  value `shellQuote`d; agent machines through a new `ai_memory.rules.sync` RPC (agent bump).
- Triggers: a sweeper tick (catches expiry) and a nudge after each rule change (record_decision, the
  Memória marks, saving the project setup). Runs are serialised per project.
- Logs carry ids, counts and codes only, never a rule's text.

## Impact on other users

Opt-in per project (off by default), and only on machines where the person already runs ai-memory for
that checkout. Someone who does not turn it on notices nothing; turning it off removes the pages
termhub wrote.
