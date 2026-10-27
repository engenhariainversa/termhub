-- TER-1121: the project health watcher's alerts (stalled work it saw, one row per project, signal and subject).
-- A new table: additive and backward compatible, the previous release never reads it.

-- CreateTable
CREATE TABLE "project_health_alerts" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "signal" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "since_at" TIMESTAMPTZ NOT NULL,
    "first_seen_at" TIMESTAMPTZ NOT NULL,
    "last_seen_at" TIMESTAMPTZ NOT NULL,
    "opened_at" TIMESTAMPTZ,
    "woken_at" TIMESTAMPTZ,
    "noticed_at" TIMESTAMPTZ,
    "resolved_at" TIMESTAMPTZ,

    CONSTRAINT "project_health_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "project_health_alerts_project_id_signal_subject_key" ON "project_health_alerts"("project_id", "signal", "subject");

-- CreateIndex
CREATE INDEX "project_health_alerts_project_id_resolved_at_idx" ON "project_health_alerts"("project_id", "resolved_at");

-- AddForeignKey
ALTER TABLE "project_health_alerts" ADD CONSTRAINT "project_health_alerts_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
