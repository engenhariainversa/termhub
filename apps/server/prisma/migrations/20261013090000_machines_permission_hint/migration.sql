-- TER-614: a machine can opt in to permission hints (an excerpt of the command or file a Claude
-- permission card approves). Additive and backward compatible: the previous release does not read the
-- column, and every existing machine stays opted out.

-- AlterTable
ALTER TABLE "machines" ADD COLUMN "permission_hint" BOOLEAN NOT NULL DEFAULT false;
