-- TER-1015: a decision recorded with record_decision can replace an older one. Additive and backward
-- compatible: the previous release neither reads nor writes these columns, and every existing row stays
-- current (superseded_at NULL) until a new decision replaces it.

-- AlterTable: the ref (`note:<id>` / `decision:<id>`) a note replaced, and when a note was replaced.
ALTER TABLE "memory_items" ADD COLUMN "supersedes" TEXT;
ALTER TABLE "memory_items" ADD COLUMN "superseded_at" TIMESTAMP(3);

-- AlterTable: when a decision answered on a card was replaced by a note.
ALTER TABLE "chat_decisions" ADD COLUMN "superseded_at" TIMESTAMP(3);
