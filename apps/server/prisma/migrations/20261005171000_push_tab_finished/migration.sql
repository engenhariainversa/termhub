-- Opt-in push when a tab finishes its turn (TER-925). A new column with a default: the previous
-- release never reads it, so it stays compatible while both colors run.
ALTER TABLE "users" ADD COLUMN "push_tab_finished" BOOLEAN NOT NULL DEFAULT false;
