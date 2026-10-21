-- TER-1101: the concierge's notices outside the chat (push with levels) and the person's rules for them.
-- A new table and a nullable column: additive and backward compatible, the previous release never reads them.

-- AlterTable
ALTER TABLE "users" ADD COLUMN "concierge_push" JSONB;

-- CreateTable
CREATE TABLE "concierge_notices" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "project_id" TEXT,
    "message_id" TEXT,
    "level" TEXT NOT NULL,
    "headline" TEXT NOT NULL,
    "watch_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ready_at" TIMESTAMP(3),
    "sent_at" TIMESTAMP(3),

    CONSTRAINT "concierge_notices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "concierge_notices_status_user_id_idx" ON "concierge_notices"("status", "user_id");

-- CreateIndex
CREATE INDEX "concierge_notices_conversation_id_sent_at_idx" ON "concierge_notices"("conversation_id", "sent_at");

-- AddForeignKey
ALTER TABLE "concierge_notices" ADD CONSTRAINT "concierge_notices_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "concierge_notices" ADD CONSTRAINT "concierge_notices_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "chat_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
