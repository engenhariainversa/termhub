-- TER-1021: per-project opt-in to import deliberate ai-memory pages as unverified lessons.
-- Additive with a default: the previous release never reads it.
ALTER TABLE "projects" ADD COLUMN "ai_memory_lessons" BOOLEAN NOT NULL DEFAULT false;
