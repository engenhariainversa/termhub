-- TER-1013: the person corrects the memory on the Memória screen without deleting anything. A decision or
-- a concierge note can be "Desatualizada" (expires_at set to now), "Errada" (wrong_at) or "Substituída
-- por…" (superseded_at on the old row, its ref in `supersedes` on the row that replaces it). Additive and
-- backward compatible: the previous release does not read these columns, and every row starts current.
-- `IF NOT EXISTS` because sibling cards of the same epic (TER-1014 expires_at, TER-1015 supersedes /
-- superseded_at) add the same columns: whichever migration runs first creates them. Named `…090001` so
-- it sorts after TER-1015's `20261013090000_memory_supersedes`, whose plain ADD COLUMN must run first.

-- AlterTable
ALTER TABLE "chat_decisions" ADD COLUMN IF NOT EXISTS "expires_at" TIMESTAMP(3);
ALTER TABLE "chat_decisions" ADD COLUMN IF NOT EXISTS "wrong_at" TIMESTAMP(3);
ALTER TABLE "chat_decisions" ADD COLUMN IF NOT EXISTS "superseded_at" TIMESTAMP(3);
ALTER TABLE "chat_decisions" ADD COLUMN IF NOT EXISTS "supersedes" TEXT;

-- AlterTable
ALTER TABLE "memory_items" ADD COLUMN IF NOT EXISTS "expires_at" TIMESTAMP(3);
ALTER TABLE "memory_items" ADD COLUMN IF NOT EXISTS "wrong_at" TIMESTAMP(3);
ALTER TABLE "memory_items" ADD COLUMN IF NOT EXISTS "superseded_at" TIMESTAMP(3);
ALTER TABLE "memory_items" ADD COLUMN IF NOT EXISTS "supersedes" TEXT;
