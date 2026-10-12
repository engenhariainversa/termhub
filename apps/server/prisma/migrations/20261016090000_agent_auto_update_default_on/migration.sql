-- TER-1056: agents keep themselves up to date by default. New machines start with auto-update on, and
-- every agent machine that has it off today is switched on once (the person can turn it off again on
-- the machine screen). Only a default and a value change: the previous release reads the same column.
ALTER TABLE "machines" ALTER COLUMN "agent_auto_update" SET DEFAULT true;
UPDATE "machines" SET "agent_auto_update" = true WHERE "type" = 'agent' AND "agent_auto_update" = false;
