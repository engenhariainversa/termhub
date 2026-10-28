-- TER-1134: a board column marked "aguardando" holds cards that wait on a person or a third party: the
-- health watcher and automatic work leave them alone. A new column with a default: additive and backward
-- compatible, the previous release never reads it.

-- AlterTable
ALTER TABLE "task_columns" ADD COLUMN "waiting" BOOLEAN NOT NULL DEFAULT false;
