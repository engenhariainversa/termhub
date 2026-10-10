-- TER-1024: a tab card keeps the name its tab had when it was asked, so a closed tab's card still says
-- which tab it was. Additive and backward compatible: the previous release does not read the column.

-- AlterTable
ALTER TABLE "chat_actions" ADD COLUMN "tab_name" TEXT;
