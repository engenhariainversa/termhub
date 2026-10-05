-- When the follower last typed into the run's tab (a resume, a restart, the resume after a usage reset).
-- Kept on the run, not in memory, so the colour that takes a run over does not type the same line again
-- into a tab whose state has not moved since. null = nothing typed yet (or a run from before this column).
ALTER TABLE "automation_runs" ADD COLUMN "last_typed_at" TIMESTAMPTZ;
