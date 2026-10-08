-- TER-1006: a decision carries its trust. Only the person's own click on a card is `person`; an answer
-- the countdown sent (`answered_via` 'auto', or 'automation' for the option a run picked) is `derived`
-- and never backs another automatic answer (concierge memory spec D2/D11). Additive and backward
-- compatible: the previous release does not read the column, and its inserts get the default.

-- AlterTable
ALTER TABLE "chat_decisions" ADD COLUMN "trust" TEXT NOT NULL DEFAULT 'person';

-- The decisions the backfill already made out of automatic answers: they were never the person's.
UPDATE "chat_decisions" d SET "trust" = 'derived'
FROM "tab_questions" q
WHERE d."tab_question_id" = q."id" AND q."answered_via" IS NOT NULL AND q."answered_via" <> 'card';

-- A project note's section that is only a heading (`## Lições` once its lesson blocks are taken out) is
-- no longer indexed: drop the chunks already stored. The next re-index of the note rewrites its chunks.
DELETE FROM "memory_items" m
WHERE m."kind" = 'project_note'
  AND NOT EXISTS (
    SELECT 1 FROM regexp_split_to_table(m."text", E'\n') AS l(line)
    WHERE btrim(l.line) <> '' AND btrim(l.line) !~ '^#{1,3}\s+.+$'
  );
