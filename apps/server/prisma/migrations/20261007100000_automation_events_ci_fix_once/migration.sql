-- The red-CI loop's claim (agentic board D21, F-27): one `ci_fix_requested` event per card, PR and head SHA,
-- so two colours syncing the same red head ask for one fix (or escalate once). Partial and on expressions,
-- so it is not in schema.prisma (see the AutomationEvent model). Additive: the previous release never writes
-- this kind.
CREATE UNIQUE INDEX "automation_events_ci_fix_once" ON "automation_events"("task_id", ("payload"->>'pr'), ("payload"->>'sha'))
    WHERE "kind" = 'ci_fix_requested';
