-- TER-1086: "Permitir sempre nesta pasta" for share_file, per user + machine + folder, until revoked.
-- Additive and backward compatible: a new table the previous release never reads.
CREATE TABLE "chat_file_grants" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "machine_id" TEXT NOT NULL,
    "folder" TEXT NOT NULL,
    "conversation_id" TEXT,
    "source_action_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),
    "revoked_by" TEXT,
    CONSTRAINT "chat_file_grants_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "chat_file_grants_user_id_machine_id_idx" ON "chat_file_grants"("user_id", "machine_id");
-- One active grant per user + machine + folder. Partial (Prisma cannot express it): a revoked row never
-- blocks granting again; `grant()` revokes the previous active row in the same transaction.
CREATE UNIQUE INDEX "chat_file_grants_one_active" ON "chat_file_grants"("user_id", "machine_id", "folder") WHERE "revoked_at" IS NULL;
ALTER TABLE "chat_file_grants" ADD CONSTRAINT "chat_file_grants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "chat_file_grants" ADD CONSTRAINT "chat_file_grants_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "chat_file_grants" ADD CONSTRAINT "chat_file_grants_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "chat_conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
