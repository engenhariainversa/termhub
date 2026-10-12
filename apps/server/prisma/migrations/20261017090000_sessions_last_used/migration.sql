-- TER-580: web sessions record their last use (idle timeout) and where they were opened (the
-- sessions list in Settings). Additive and backward compatible: the previous release does not read
-- the columns, and existing sessions count as used now.

-- AlterTable
ALTER TABLE "sessions" ADD COLUMN "last_used_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN "ip" TEXT,
ADD COLUMN "user_agent" TEXT;
