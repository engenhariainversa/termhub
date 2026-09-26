-- AlterTable
ALTER TABLE "machines" ADD COLUMN     "claude_auto_swap" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "tabs" ADD COLUMN     "agent_session_id" TEXT,
ADD COLUMN     "agent_transcript_path" TEXT,
ADD COLUMN     "ai_account_id" TEXT,
ADD COLUMN     "rate_limited_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "tabs_ai_account_id_idx" ON "tabs"("ai_account_id");

-- AddForeignKey
ALTER TABLE "tabs" ADD CONSTRAINT "tabs_ai_account_id_fkey" FOREIGN KEY ("ai_account_id") REFERENCES "ai_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
