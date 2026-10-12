-- AlterTable
ALTER TABLE "machines" ADD COLUMN     "ai_memory_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "ai_memory_url" TEXT;
