-- TER-1038: when the concierge's CLI session was last compacted (manual "Compactar" or the CLI's own
-- auto-compact), and the context limit a person chose for the chat meter (null = the model's window).
-- Two nullable columns: the previous release never reads them, so it stays compatible while both colors run.
ALTER TABLE "chat_conversations" ADD COLUMN "context_compacted_at" TIMESTAMPTZ;
ALTER TABLE "users" ADD COLUMN "chat_context_limit" INTEGER;
