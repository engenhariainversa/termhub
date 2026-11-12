-- TER-1164: what the chat must not do on its own (flag chat_open_permissions). A new table the previous
-- release never reads, so the migration is backward compatible.
CREATE TABLE "chat_blocks" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "project_id" TEXT,
  "kind" TEXT NOT NULL,
  "words" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "effect" TEXT NOT NULL DEFAULT 'ask',
  "conversation_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revoked_at" TIMESTAMP(3),
  "revoked_by" TEXT,
  CONSTRAINT "chat_blocks_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "chat_blocks_user_id_revoked_at_idx" ON "chat_blocks"("user_id", "revoked_at");

ALTER TABLE "chat_blocks" ADD CONSTRAINT "chat_blocks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "chat_blocks" ADD CONSTRAINT "chat_blocks_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
