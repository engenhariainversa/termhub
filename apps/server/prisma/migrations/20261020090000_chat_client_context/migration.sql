-- TER-1088: "Contar ao chat de onde estou falando" — the concierge reads the client, device and whether the
-- person is on the same network as one of their machines. Additive and backward compatible: a column with
-- a default the previous release never reads.
ALTER TABLE "users" ADD COLUMN "chat_client_context" BOOLEAN NOT NULL DEFAULT true;
