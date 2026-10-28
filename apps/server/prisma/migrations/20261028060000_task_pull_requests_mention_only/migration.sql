-- TER-1136: a card a PR only cites in passing no longer holds its merge for a person. Additive: the previous
-- release never reads the column, and its rows keep false (a link, as before) until the next sync rewrites them.
ALTER TABLE "task_pull_requests" ADD COLUMN "mention_only" BOOLEAN NOT NULL DEFAULT false;
