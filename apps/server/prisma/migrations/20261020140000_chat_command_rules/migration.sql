-- TER-1081: the command allow list of the chat's run_command. A new table the previous release never
-- reads, so the migration is backward compatible.
CREATE TABLE "chat_command_rules" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "project_id" TEXT,
  "words" TEXT[],
  "match" TEXT NOT NULL,
  "machine_ids" TEXT[],
  "conversation_id" TEXT,
  "source_action_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMP(3),
  "revoked_at" TIMESTAMP(3),
  "revoked_by" TEXT,
  CONSTRAINT "chat_command_rules_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "chat_command_rules_user_id_revoked_at_idx" ON "chat_command_rules"("user_id", "revoked_at");

ALTER TABLE "chat_command_rules" ADD CONSTRAINT "chat_command_rules_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "chat_command_rules" ADD CONSTRAINT "chat_command_rules_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "chat_command_rules" ADD CONSTRAINT "chat_command_rules_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "chat_conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
