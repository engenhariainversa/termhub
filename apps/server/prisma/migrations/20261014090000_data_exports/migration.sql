-- "Exportar meus dados" (TER-741, LGPD art. 18): one row per export request. The job builds the zip on
-- the chat-files volume, e-mails a link to Perfil and removes the file 7 days after it is ready.
-- A new table only: the release still serving during the switch never reads it.
CREATE TABLE "data_exports" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "bytes" BIGINT,
    "error_code" TEXT,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "downloaded_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "data_exports_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "data_exports_user_id_created_at_idx" ON "data_exports"("user_id", "created_at");
CREATE INDEX "data_exports_status_idx" ON "data_exports"("status");

ALTER TABLE "data_exports" ADD CONSTRAINT "data_exports_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
