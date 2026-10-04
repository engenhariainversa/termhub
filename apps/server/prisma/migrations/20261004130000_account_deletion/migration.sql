-- Self-service account deletion (TER-720, TER-728). A request deactivates the account for 30 days
-- (deletion_requested_at / deletion_scheduled_at); signing in during that window can cancel it, and
-- a job deletes the account for good once deletion_scheduled_at has passed.
-- Nullable columns and a new table only: the release still serving during the switch never reads them.
ALTER TABLE "users" ADD COLUMN "deletion_requested_at" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN "deletion_scheduled_at" TIMESTAMP(3);
CREATE INDEX "users_deletion_scheduled_at_idx" ON "users"("deletion_scheduled_at");

-- A deletion asked from the public page (termhub.dev/excluir-conta): the e-mailed link's token,
-- hashed, single use and short-lived. No FK: a row for an unknown e-mail is never written, and the
-- rows of a deleted account go with it by e-mail.
CREATE TABLE "account_deletion_links" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "account_deletion_links_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "account_deletion_links_token_hash_key" ON "account_deletion_links"("token_hash");
CREATE INDEX "account_deletion_links_email_created_at_idx" ON "account_deletion_links"("email", "created_at");
CREATE INDEX "account_deletion_links_expires_at_idx" ON "account_deletion_links"("expires_at");
