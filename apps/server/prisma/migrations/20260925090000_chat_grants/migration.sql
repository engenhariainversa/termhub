-- AlterTable
ALTER TABLE "chat_actions" ADD COLUMN "grant_id" TEXT;

-- CreateTable
CREATE TABLE "chat_grants" (
    "id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "tab_id" TEXT NOT NULL,
    "tool" TEXT NOT NULL,
    "source_action_id" TEXT,
    "granted_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "revoked_by" TEXT,

    CONSTRAINT "chat_grants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "chat_grants_conversation_id_idx" ON "chat_grants"("conversation_id");

-- One active grant per conversation + tab + tool. Partial, because a revoked grant must not stop the
-- same tab from being trusted again. An expired-but-unrevoked row still holds the slot: `grant()`
-- revokes it in the same transaction before inserting. Prisma cannot express this, so it lives here.
CREATE UNIQUE INDEX "chat_grants_one_active_per_tab" ON "chat_grants"("conversation_id", "tab_id", "tool")
    WHERE "revoked_at" IS NULL;

-- AddForeignKey
ALTER TABLE "chat_grants" ADD CONSTRAINT "chat_grants_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "chat_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
