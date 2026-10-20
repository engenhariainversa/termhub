-- TER-1079: warn ahead of an AI account's CLI login expiring. Additive and backward compatible: nullable
-- columns the previous release never reads.

-- When the login expires, as read from the CLI's own notice, and when the person was warned about it.
ALTER TABLE "ai_accounts" ADD COLUMN "login_expires_at" TIMESTAMPTZ;
ALTER TABLE "ai_accounts" ADD COLUMN "login_expiry_warned_at" TIMESTAMPTZ;

-- How many days ahead the person is warned (0 = never); null = the default.
ALTER TABLE "users" ADD COLUMN "ai_login_warn_days" INTEGER;
