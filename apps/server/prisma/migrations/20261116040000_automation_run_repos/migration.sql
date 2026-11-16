-- TER-1066 (spec 2026-10-07 multi-repo R11, §4): the repositories a run works on, one row per repository.
-- A new table only: the release still serving during the switch never reads it.

-- CreateTable
CREATE TABLE "automation_run_repos" (
    "run_id" TEXT NOT NULL,
    "repository_id" TEXT NOT NULL,
    "branch" TEXT NOT NULL,
    "base" TEXT NOT NULL,
    "worktree_path" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'ready',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "automation_run_repos_pkey" PRIMARY KEY ("run_id","repository_id")
);

-- CreateIndex
CREATE INDEX "automation_run_repos_repository_id_idx" ON "automation_run_repos"("repository_id");

-- AddForeignKey
ALTER TABLE "automation_run_repos" ADD CONSTRAINT "automation_run_repos_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "automation_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_run_repos" ADD CONSTRAINT "automation_run_repos_repository_id_fkey" FOREIGN KEY ("repository_id") REFERENCES "project_repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;
