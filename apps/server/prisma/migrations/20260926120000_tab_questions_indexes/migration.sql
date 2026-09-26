-- Additive only (spec 2026-09-26 §4.3): the previous release keeps working while this one migrates.

-- The newest row of a tab: the permission queue rule in `open` and `findOpenForTab`.
CREATE INDEX "tab_questions_tab_id_created_at_idx" ON "tab_questions"("tab_id", "created_at");

-- The per-event pre-check of `closeForTab` ("is this tab in a permission queue?"). Partial, so it lives
-- only here, with a `///` note on the model — the same pattern as `chat_grants_one_active_per_tab`.
CREATE INDEX "tab_questions_queued_tab_id_idx" ON "tab_questions"("tab_id") WHERE "error_code" = 'QUEUED';
