-- The release workflows' runs on a merged PR's commit (agentic board D22), as [{ workflow, state, url, version }].
ALTER TABLE "task_pull_requests" ADD COLUMN "release_runs" JSONB NOT NULL DEFAULT '[]';
