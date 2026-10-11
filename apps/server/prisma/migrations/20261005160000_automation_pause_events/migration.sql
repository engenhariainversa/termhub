-- Agentic board (TER-893): the pause switch (per user and per project), the user's time zone for the
-- daily summary, and the automation event log. Additive only: the previous release ignores all of it.
ALTER TABLE "users" ADD COLUMN "automation_paused_at" TIMESTAMPTZ,
ADD COLUMN "time_zone" TEXT;

ALTER TABLE "projects" ADD COLUMN "automation_paused_at" TIMESTAMPTZ;

CREATE TABLE "automation_events" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "task_id" TEXT,
    "run_id" TEXT,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "automation_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "automation_events_project_created_idx" ON "automation_events"("project_id", "created_at" DESC);

ALTER TABLE "automation_events" ADD CONSTRAINT "automation_events_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "automation_events" ADD CONSTRAINT "automation_events_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;
