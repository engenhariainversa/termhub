-- TER-1171: the agent tab garbage collector (monitor/tab-gc). Additive only: the release still serving during
-- the switch neither reads nor writes these columns, and the new nullable/defaulted ones need no backfill.
ALTER TABLE "tabs" ADD COLUMN "gc_pinned" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "tabs" ADD COLUMN "gc_warned_at" TIMESTAMP(3);
ALTER TABLE "tabs" ADD COLUMN "gc_warned_state_at" TIMESTAMP(3);
ALTER TABLE "tabs" ADD COLUMN "gc_reset_at" TIMESTAMP(3);

ALTER TABLE "users" ADD COLUMN "tab_gc" JSONB;
ALTER TABLE "machines" ADD COLUMN "tab_gc" JSONB;

CREATE TABLE "tab_gc_archive" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "task_id" TEXT,
    "tab_id" TEXT NOT NULL,
    "tab_name" TEXT NOT NULL,
    "machine_id" TEXT NOT NULL,
    "machine_name" TEXT NOT NULL,
    "tool" TEXT,
    "state" TEXT,
    "reason" TEXT NOT NULL,
    "agent_session_id" TEXT,
    "cwd" TEXT,
    "last_answer" TEXT,
    "last_answer_at" TIMESTAMPTZ,
    "collected_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tab_gc_archive_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "tab_gc_archive_project_id_collected_at_idx" ON "tab_gc_archive"("project_id", "collected_at" DESC);
CREATE INDEX "tab_gc_archive_task_id_idx" ON "tab_gc_archive"("task_id");

ALTER TABLE "tab_gc_archive" ADD CONSTRAINT "tab_gc_archive_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tab_gc_archive" ADD CONSTRAINT "tab_gc_archive_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;
