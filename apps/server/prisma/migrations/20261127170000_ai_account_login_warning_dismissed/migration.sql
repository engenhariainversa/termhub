-- TER-1212: the person can dismiss an AI account's "login expired" banner.
-- A nullable column only: the release still serving during the switch never reads it.

-- AlterTable
ALTER TABLE "ai_accounts" ADD COLUMN "login_warning_dismissed_at" TIMESTAMPTZ;
