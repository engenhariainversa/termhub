-- TER-1070 (spec 2026-10-07 multi-repo R8): the repositories a card touches, by key. Additive only: the
-- release still serving during the switch neither reads nor writes it, and the rows it creates get the
-- default, which means "the project's single repository".
ALTER TABLE "tasks" ADD COLUMN "repo_keys" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
