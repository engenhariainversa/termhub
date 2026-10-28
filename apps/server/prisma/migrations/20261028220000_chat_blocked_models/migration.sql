ALTER TABLE "users" ADD COLUMN "chat_blocked_models" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "chat_conversations" ADD COLUMN "last_model" TEXT;
