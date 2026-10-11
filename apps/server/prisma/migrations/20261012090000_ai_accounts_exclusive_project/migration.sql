-- TER-990: an AI account can be exclusive to one project (a client's or a company's account). Additive and
-- backward compatible: the previous release does not read the column, and no account starts exclusive.

-- AlterTable
ALTER TABLE "ai_accounts" ADD COLUMN "exclusive_project_id" TEXT;

-- CreateIndex
CREATE INDEX "ai_accounts_exclusive_project_id_idx" ON "ai_accounts"("exclusive_project_id");

-- AddForeignKey
ALTER TABLE "ai_accounts" ADD CONSTRAINT "ai_accounts_exclusive_project_id_fkey" FOREIGN KEY ("exclusive_project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;
