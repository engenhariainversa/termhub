-- Tokens and cost per tab (agentic board, spec D23, preflight F-29). `tab_usage` holds where the next read
-- of a tab's Claude Code transcript starts (session and byte offset); `tab_usage_days` holds the counts per
-- tab and day (in the project owner's zone at write time) and their API-equivalent cost estimate. Counts
-- only, never transcript content. New tables and an index only: the previous release never reads them.

CREATE TABLE "tab_usage" (
    "tab_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "transcript_offset" BIGINT NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tab_usage_pkey" PRIMARY KEY ("tab_id")
);

CREATE TABLE "tab_usage_days" (
    "tab_id" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "project_id" TEXT NOT NULL,
    "task_id" TEXT,
    "account_id" TEXT,
    "model" TEXT,
    "input_tokens" BIGINT NOT NULL DEFAULT 0,
    "output_tokens" BIGINT NOT NULL DEFAULT 0,
    "cache_read_tokens" BIGINT NOT NULL DEFAULT 0,
    "cache_write_tokens" BIGINT NOT NULL DEFAULT 0,
    "cost_usd_estimate" DECIMAL(14,6),
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tab_usage_days_pkey" PRIMARY KEY ("tab_id","day")
);

CREATE INDEX "tab_usage_days_project_id_day_idx" ON "tab_usage_days"("project_id", "day");
CREATE INDEX "tab_usage_days_task_id_idx" ON "tab_usage_days"("task_id");

ALTER TABLE "tab_usage_days" ADD CONSTRAINT "tab_usage_days_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tab_usage_days" ADD CONSTRAINT "tab_usage_days_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The metering looks up a tab's run on every Stop of an automatic tab.
CREATE INDEX "automation_runs_tab_id_idx" ON "automation_runs"("tab_id");
