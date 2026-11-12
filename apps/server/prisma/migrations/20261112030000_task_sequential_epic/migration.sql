-- An epic whose cards the automatic work takes one at a time, in board order (TER-1170).
-- A new column with a default is backward compatible: the release still serving during the switch never reads it.
ALTER TABLE "tasks" ADD COLUMN "sequential" BOOLEAN NOT NULL DEFAULT false;
