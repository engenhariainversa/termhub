-- How many times the follower restarted a run's agent after it exited (spec D15: once, then blocked).
ALTER TABLE "automation_runs" ADD COLUMN "restart_count" INTEGER NOT NULL DEFAULT 0;
-- The allow list the run's agent was started with (preflight F-12): restarts and account swaps keep it
-- even when the project's setup changes mid-run. null = a run started before this column.
ALTER TABLE "automation_runs" ADD COLUMN "allowed_tools" JSONB;
