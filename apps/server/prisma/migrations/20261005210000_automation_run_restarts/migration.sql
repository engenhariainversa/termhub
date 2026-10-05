-- How many times the follower restarted a run's agent after it exited (spec D15: once, then blocked).
ALTER TABLE "automation_runs" ADD COLUMN "restart_count" INTEGER NOT NULL DEFAULT 0;
