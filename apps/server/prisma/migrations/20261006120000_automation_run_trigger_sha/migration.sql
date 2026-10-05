-- The trigger of a run the server starts by itself (agentic board, spike R2 / TER-965): the PR head SHA
-- for a conflict fixer. Never two runs for the same (card, role, trigger), whatever their status: a run
-- that ended blocked or failed is not recreated by the same trigger. null = started from the queue.
ALTER TABLE "automation_runs" ADD COLUMN "trigger_sha" TEXT;
CREATE UNIQUE INDEX "automation_runs_one_per_trigger" ON "automation_runs"("task_id", "role", "trigger_sha") WHERE "trigger_sha" IS NOT NULL;
