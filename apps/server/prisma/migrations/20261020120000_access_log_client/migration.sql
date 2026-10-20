-- TER-1092: the client, its system and the response time of each access record, for admin troubleshooting.
-- Nullable additions only: the previous release keeps writing rows without them.
ALTER TABLE "access_logs" ADD COLUMN "client" TEXT;
ALTER TABLE "access_logs" ADD COLUMN "os" TEXT;
ALTER TABLE "access_logs" ADD COLUMN "duration_ms" INTEGER;
