-- TER-1191: where each API token came from, and the project/machine it acts for, so Settings → Tokens de API
-- can filter and page on the server and the retention purge can tell the system's tokens from a person's.
-- Additive only: three nullable columns, no default, no constraint. The release still serving during the
-- switch neither reads nor writes them; a row it mints keeps origin null and is classified the old way
-- (gated / chat_conversation_id / tab_id) wherever origin is read.
ALTER TABLE "api_tokens" ADD COLUMN "origin" TEXT;
ALTER TABLE "api_tokens" ADD COLUMN "project_id" TEXT;
ALTER TABLE "api_tokens" ADD COLUMN "machine_id" TEXT;

-- Backfill. Tab tokens: the tab's project and machine while the tab still exists.
UPDATE "api_tokens" a SET "origin" = 'tab', "project_id" = t."project_id", "machine_id" = t."machine_id"
  FROM "tabs" t WHERE a."tab_id" IS NOT NULL AND t."id" = a."tab_id";
UPDATE "api_tokens" SET "origin" = 'tab' WHERE "tab_id" IS NOT NULL AND "origin" IS NULL;

-- Concierge tokens: gated, tied to a conversation, or (before both existed) named by the concierge.
UPDATE "api_tokens" a SET "origin" = 'concierge', "project_id" = c."project_id", "machine_id" = c."machine_id"
  FROM "chat_conversations" c WHERE a."tab_id" IS NULL AND a."chat_conversation_id" = c."id";
UPDATE "api_tokens" SET "origin" = 'concierge'
  WHERE "origin" IS NULL AND "tab_id" IS NULL AND ("gated" OR "chat_conversation_id" IS NOT NULL OR "name" = 'concierge (automático)');

UPDATE "api_tokens" SET "origin" = 'person' WHERE "origin" IS NULL;

-- The screen's keyset page (newest first) and its filters.
CREATE INDEX "api_tokens_user_id_created_at_id_idx" ON "api_tokens"("user_id", "created_at" DESC, "id" DESC);
CREATE INDEX "api_tokens_user_id_origin_idx" ON "api_tokens"("user_id", "origin");
