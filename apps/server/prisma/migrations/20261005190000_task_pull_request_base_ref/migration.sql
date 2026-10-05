-- Additive: the PR's base branch and its change level (agentic board). Old rows stay NULL until the next sync.
ALTER TABLE "task_pull_requests" ADD COLUMN "base_ref" TEXT,
ADD COLUMN "changed_level" TEXT;
