-- When an imported ticket stopped coming back from its source (closed, or out of the filter) (TER-718).
-- A nullable column only: the release still serving during the switch never reads it.
ALTER TABLE "tickets" ADD COLUMN "left_source_at" TIMESTAMP(3);
