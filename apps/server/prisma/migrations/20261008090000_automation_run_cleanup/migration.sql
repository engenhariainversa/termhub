-- Worktree and tab cleanup after a merge (agentic board, spec §7, TER-871): `cleanup_state` is NULL until
-- the card's PR merges (or its card is deleted), then 'due' until the worktree is removed ('done'), kept
-- because it is dirty ('kept') or given up after `cleanup_attempts` tries ('gave_up'). Additive and nullable:
-- the previous release never reads them.
ALTER TABLE "automation_runs" ADD COLUMN "cleanup_state" TEXT;
ALTER TABLE "automation_runs" ADD COLUMN "cleanup_attempts" INTEGER NOT NULL DEFAULT 0;
