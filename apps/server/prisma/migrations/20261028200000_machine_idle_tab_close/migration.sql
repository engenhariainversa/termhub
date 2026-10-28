-- TER-1138: close idle agent tabs after N hours, opt-in per machine (null = never)
ALTER TABLE "machines" ADD COLUMN "idle_tab_close_hours" INTEGER;
