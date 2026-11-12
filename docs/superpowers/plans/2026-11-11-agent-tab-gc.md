# Agent tab GC (TER-1171) — implementation plan

Spec: `docs/superpowers/specs/2026-11-11-agent-tab-gc-design.md`. PR 1 covers tasks 1–8; PR 2 tasks 9–12.

## PR 1 — server

1. **Flags.** `tab_gc` and `tab_gc_live` in `FEATURE_FLAGS` (default off); web `FeatureFlagKey`, `FLAG_COPY`
   (pt-BR via `tk`, en/es catalogs), mobile `meResponse.features` defaulted to `false`;
   `docs/feature-flags.md` section.
2. **Migration** (additive, old release unaffected): `tabs.gc_pinned boolean not null default false`,
   `tabs.gc_warned_at`, `tabs.gc_warned_state_at`, `tabs.gc_reset_at` (timestamps, null);
   `users.tab_gc jsonb`, `machines.tab_gc jsonb`; table `tab_gc_archive` (id, project_id → projects cascade,
   task_id → tasks set null, tab_id (no FK), tab_name, machine_id (no FK), machine_name, tool, state, reason,
   agent_session_id, cwd, last_answer text, last_answer_at, collected_at; index (project_id, collected_at)).
   Repository methods: `tabs.listAgentTabsForGc()`, `tabs.setGcMark/clearGcMark/resetGc`,
   `tabGcArchive.create/listByProject`, mapping in `types.ts`. Add `tab_gc` to `setupSchema` (all fields
   optional, defaulted to `{}`), with the same zod object (`tabGcConfigSchema`) for user and machine.
3. **Config resolution** `monitor/tab-gc/config.ts`: `resolveGcConfig(user, project, machine)` per the spec
   (enabled AND, numbers machine → project → user → default; `idle_tab_close_hours` as machine X).
   Tests: each level, off anywhere wins, legacy machine hours, bounds.
4. **Classification** `monitor/tab-gc/classify.ts`: pure `classifyTab(facts, config, now)`.
   Table test state × card × run × time → keep/candidate/remove with reasons, plus edge cases:
   `waiting_background` (finished with subagents in background), pinned, offline machine, session gone vs
   unknown, rate limited, card in doing, error before/after Y, `gc_reset_at` restarting the clock, recent
   monitor event after `state_at`.
5. **Sweep** `monitor/tab-gc/sweep.ts`: reuse `quiet()` and `roomShort` from `idle-tabs.ts` (exported, not
   copied). Per owner: flag check once per sweep (`isEnabled('tab_gc'|'tab_gc_live', { userId: owner })`).
   Per machine: one `probeTmuxSessions`, agent-tab count for the cap. Grace steps (mark → keep/clear →
   collect), archive + `tab_collected`, `close_tab` forced as owner. Dry run: events with `dry_run: true`,
   `gc_reset_at` = now on a would-be collection, nothing else written. Event kinds `tab_gc_warned`,
   `tab_gc_kept`, `tab_collected` in `AutomationEventKind`, feed text in `progress/aggregate.ts` (+ i18n).
   Tests: grace (warn → close after 30 min; activity during grace keeps; manter resets), dry run writes
   no marks and closes nothing, idempotent second sweep, session gone removed at once (live) / reported once
   (dry run), cap oldest first and at most 3 per sweep, offline machine untouched, flag off untouched.
6. **TER-1138 hand-off**: `sweepIdleTabs` skips tabs whose project owner has `tab_gc_live` on. Test.
7. **MCP**: `list_gc_candidates` (read, `terminals:read`) and `run_gc` (`terminals:write`; `dry_run`
   default true; `dry_run: false` refused with `TAB_GC_NOT_LIVE` unless `tab_gc_live`), scoped through
   `scoped(...)`. Chat gate: `run_gc` with `dry_run: false` classified as `close_tab`; `list_gc_candidates`
   read-only. Tests in `tools.test.ts` / `tools-schema.test.ts` style. Concierge prompt untouched.
8. **Wiring and checks**: start the sweep in `app.ts` next to the idle sweep; `npm run i18n:check`;
   typecheck/build in `node:22`; server tests for the touched files.

## PR 2 — web and health

9. Tab badge "fecha em N min" + "Manter" (route `POST /api/tabs/:id/gc/keep`), "Fixar" toggle
   (`PATCH /api/tabs/:id` `gc_pinned`), both through `scoped(...)`.
10. Settings: user (Conta → Abas), project (Setup → Abas de agente), machine (Máquinas → Geral, replacing the
    TER-1138 switch's copy), with zod-validated routes.
11. Health: a `tab_gc` line (finished with card in doing; warned tabs) in `get_project_health` and the daily
    summary; chat line on `tab_gc_warned`.
12. Card history: collected tabs (archive) listed on the card.

## Rebase points

Before each PR: `git fetch && git rebase origin/main` — #572 (TER-1168) touches `health/*`, `mcp/tools.ts`,
`setup/schema.ts`; TER-1169/1170 touch memory and the dispatcher.
