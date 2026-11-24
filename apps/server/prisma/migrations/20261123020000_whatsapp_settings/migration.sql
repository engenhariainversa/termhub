-- TER-1201: the person's own Evolution API setup (Configurações → WhatsApp).
-- A new table only: the release still serving during the switch never reads it.

-- CreateTable
CREATE TABLE "whatsapp_settings" (
    "user_id" TEXT NOT NULL,
    "server_url" TEXT NOT NULL,
    "instance" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "api_key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "notify_needs_you" BOOLEAN NOT NULL DEFAULT true,
    "notify_done" BOOLEAN NOT NULL DEFAULT true,
    "last_sent_at" TIMESTAMPTZ,
    "last_error" TEXT,
    "last_error_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "whatsapp_settings_pkey" PRIMARY KEY ("user_id")
);

-- AddForeignKey
ALTER TABLE "whatsapp_settings" ADD CONSTRAINT "whatsapp_settings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
