-- TER-1014: a decision holds in a scope (conversation, project or user) and may expire. Additive and
-- backward compatible: the previous release does not read the columns; its card answers get the
-- default `user` scope (what they always were), its notes a null scope that is read as `project` when
-- the note has a project and `user` otherwise. Nothing expires unless written with `expires_at`.

-- AlterTable
ALTER TABLE "chat_decisions" ADD COLUMN "scope" TEXT NOT NULL DEFAULT 'user',
ADD COLUMN "expires_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "memory_items" ADD COLUMN "scope" TEXT,
ADD COLUMN "conversation_id" TEXT,
ADD COLUMN "expires_at" TIMESTAMP(3);
