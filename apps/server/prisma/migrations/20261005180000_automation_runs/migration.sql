-- Agentic board (TER-861): the automatic runs, one active run per card, and the AI accounts at their
-- usage limit. Additive only: the previous release ignores both tables.
CREATE TABLE "automation_runs" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "task_id" TEXT,
    "role" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "waiting_reason" TEXT,
    "tab_id" TEXT,
    "machine_id" TEXT,
    "account_id" TEXT,
    "branch" TEXT,
    "worktree_path" TEXT,
    "resume_count" INTEGER NOT NULL DEFAULT 0,
    "fix_count" INTEGER NOT NULL DEFAULT 0,
    "claimed_by" TEXT NOT NULL,
    "heartbeat_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ,
    "ended_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "automation_runs_pkey" PRIMARY KEY ("id")
);

-- The claim guard across both colours during a deploy: a second active run on the same card is a
-- unique violation. Partial, so it is not in schema.prisma (see the AutomationRun model).
CREATE UNIQUE INDEX "automation_runs_one_active_per_task" ON "automation_runs"("task_id")
    WHERE "status" IN ('queued', 'starting', 'running', 'waiting');

CREATE INDEX "automation_runs_project_status_idx" ON "automation_runs"("project_id", "status");

ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Deleting a card keeps its runs (task_id becomes NULL); the dispatcher's sweep cancels the active ones.
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "ai_account_exhaustions" (
    "account_id" TEXT NOT NULL,
    "until" TIMESTAMPTZ NOT NULL,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_account_exhaustions_pkey" PRIMARY KEY ("account_id")
);

ALTER TABLE "ai_account_exhaustions" ADD CONSTRAINT "ai_account_exhaustions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "ai_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
