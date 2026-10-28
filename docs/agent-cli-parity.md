# Agent CLI parity

What each agent-tab feature does in each CLI termhub users run: Claude Code, Codex, Cursor CLI and Gemini CLI.
The rule (CLAUDE.md, "Every agent CLI termhub supports"): a feature that involves the tab's agent covers all four,
or its PR says why not and opens a card for the rest. Keep this table current when a feature changes it.

First written for TER-1122 (2026-10-27) from a read of the code on `main` plus that branch. ✅ works · ⚠️ partial ·
❌ missing · — does not apply. Paths are under `apps/server/src/` unless they name a package or another app.

| Feature | Claude Code | Codex | Cursor | Gemini | Where | Card |
|---|---|---|---|---|---|---|
| Folder trust dialog answered in the project's folder, else `trust_prompt` + push + chat woken | ✅ | ✅ | ✅ (after its `sessionStart`, or by the sweep) | ✅ (by the sweep of tabs with no state) | `monitor/trust-dialogs.ts`, `monitor/folder-trust.ts` | TER-1117, TER-1122; real Cursor/Gemini captures: TER-1131 |
| `start_agent` / "Iniciar sessão" | ✅ | ✅ | ❌ not an account provider | ❌ `PROVIDER_UNSUPPORTED` | `control/agents.ts` `LAUNCH` | TER-1124 (Gemini), TER-1125 (Cursor) |
| AI account | ✅ | ✅ | ❌ no account type | ⚠️ registered and usage read; cannot be listed in a project or started | `routes/ai-accounts.ts`, `ai/project-accounts.ts` | TER-1124, TER-1125 |
| Project AI Setup through MCP (`get_project_ai_setup`, `set_project_ai_setup`, `unstick_project_chat`) | ✅ accounts, model, the project chat's account | ✅ accounts and model (the chat runs on Claude only) | ❌ not an account provider | ❌ cannot be listed in a project | `control/project-ai.ts` | TER-1147; TER-1124, TER-1125 |
| Tab conversation / history | ✅ | ✅ | ❌ screen only | ❌ and it reads as a Claude tab with no session | `tab-chat/reader.ts` `transcriptToolOf` | TER-1130 (Cursor), TER-1124 (Gemini) |
| State and "pensando…" | ✅ state, activity, verb | ⚠️ state and activity, no verb; only with its hooks trusted | ⚠️ state from hooks, no activity | ❌ | `monitor/state.ts` | |
| Question and permission cards | ✅ | ✅ (hooks trusted) | ❌ Cursor has no approval hook | ❌ | `monitor/state.ts`, `chat/tab-question-keys.ts` | |
| Hooks install / status | ✅ every account's config dir | ⚠️ only `~/.codex`, not an account's own `CODEX_HOME` | ✅ `~/.cursor/hooks.json` | ❌ | `monitor/machine-hooks.ts`, `packages/machine-ops/src/hooks.ts` | TER-1127 (Codex), TER-1124 (Gemini) |
| Login expiring warning (TER-1079) | ✅ | ❌ | ❌ | ❌ | `ai/login-expiry.ts` | TER-1128 (Codex) |
| Login again from the screen (TER-1047/1078) | ✅ | ✅ | ❌ | ❌ | `ai/login.ts` `AI_LOGIN_PROVIDERS` | |
| Model per project (TER-1097) | ✅ aliases and ids | ⚠️ free id only | ❌ | ❌ | `setup/schema.ts` `models` | |
| ai-memory (TER-1020) | ✅ | ⚠️ MCP and hint, no run prep | ❌ | ❌ | `memory/ai-memory-runs.ts` | |
| Command rules for `run_command` (TER-1081) | — | — | ⚠️ see the risk below | ⚠️ see the risk below | `chat/gate-runtime.ts` `commandRuleCovering` | TER-1123 |
| Automatic runs (guard, permission mode, follower) | ✅ | ❌ | ❌ | ❌ | `automation/placement.ts`, `packages/machine-ops/src/guard-script.ts` | TER-1129 |
| Attachments into the session (TER-1105) | ✅ | ✅ | ⚠️ path typed, no history | ⚠️ same | `routes/m-tabs.ts` | |
| Origin note on typed messages (TER-851) | ✅ | ❌ | ❌ | ❌ | `monitor/ingest.ts` `originNoteFor` | TER-952 (Codex) |
| Tab memory MCP (`termhub_tab`) | ✅ | ✅ | ❌ | ❌ | `control/agents.ts` `tabMcp` | |
| Stuck `working` read from the screen | ✅ | ⚠️ agent exited and trust dialog only | ❌ left out of the sweep | ❌ | `db/repositories/tabs.ts` `listStaleWorking` | TER-1126 (Cursor) |
| Agent exited → resume card | ✅ | ✅ `codex resume --last` | ❌ never seen; the line would be `claude --continue` | ❌ | `chat/agent-exited.ts` | TER-1126 (Cursor) |
| Account swap and usage-limit resume | ✅ | ❌ no limit detection | ❌ | ❌ | `control/account-swap.ts`, `monitor/state.ts` `isRateLimit` | TER-1128 (Codex) |
| Token metering on the board | ✅ | ⚠️ shows "—" | ❌ | ❌ | `automation/usage.ts` | TER-1128 (Codex) |
| Idle tabs closed by themselves (TER-1138) | ✅ state from hooks + screen at its prompt | ✅ state from hooks (trusted), last hook a turn end | ⚠️ state from hooks only, no screen check | ❌ reports no state, so never closed | `monitor/idle-tabs.ts` | TER-1124 (Gemini) |
| Suggested next prompt / permission mode toggle | ✅ | ⚠️ reply card instead; no mode toggle | ❌ | ❌ | `chat/tab-suggestions.ts`, `routes/m-tabs.ts` | |

Antigravity (`agy`) is like Gemini, minus the trust dialog (its screen has no rule yet): accounts and usage only.

## Risk found while auditing

`commandRuleCovering` (`chat/gate-runtime.ts`) treats a tab as a shell when its state is `null` or `idle` and
`claudeScreenState` does not recognise the screen. A Cursor tab right after `sessionStart` is `idle`, and a Gemini
tab never reports a state; neither screen is Claude's. A `run_command` covered by a rule could then be typed into
the agent as a prompt with no confirmation card. Read from the code, not reproduced: TER-1123.

Also seen: Codex can stop before its prompt on its own daemon and update dialogs, with no hook (TER-1132).
