-- TER-974: a tab's transcript cursor (`tab_usage`) goes with its tab. It had no foreign key, so a closed
-- tab, or every tab of a deleted account (users → projects → tabs cascade), left its row behind for good.
-- The per-day counts (`tab_usage_days`) keep outliving the tab: a card keeps its cost.
--
-- Backward compatible: the previous release only writes a cursor for a tab it is metering, which exists;
-- one deleted in the same instant makes that write fail, and the pass is simply not counted.

-- Cursors of tabs that are already gone.
DELETE FROM "tab_usage" u WHERE NOT EXISTS (SELECT 1 FROM "tabs" t WHERE t."id" = u."tab_id");

-- AddForeignKey
ALTER TABLE "tab_usage" ADD CONSTRAINT "tab_usage_tab_id_fkey" FOREIGN KEY ("tab_id") REFERENCES "tabs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
