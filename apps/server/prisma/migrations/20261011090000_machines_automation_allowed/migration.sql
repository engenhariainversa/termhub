-- TER-969 (R6): a machine can opt out of automatic work. Additive and backward compatible: the previous
-- release does not read the column, and every existing machine keeps accepting automatic runs.

-- AlterTable
ALTER TABLE "machines" ADD COLUMN "automation_allowed" BOOLEAN NOT NULL DEFAULT true;
