-- TER-1120: a red base branch that holds ready PRs is escalated once per base head (both colours read it), and
-- a base workflow cancelled before any job got a runner is reported once per run. Partial and on expressions,
-- so they are not in schema.prisma (see the AutomationEvent model). Additive: the previous release never writes
-- an `escalated` event with reason `merge_base_red` nor the `workflow_no_runner` kind.
CREATE UNIQUE INDEX "automation_events_base_red_once" ON "automation_events"("project_id", ("payload"->>'base_sha'))
    WHERE "kind" = 'escalated' AND "payload"->>'reason' = 'merge_base_red';

CREATE UNIQUE INDEX "automation_events_no_runner_once" ON "automation_events"("project_id", ("payload"->>'run_id'))
    WHERE "kind" = 'workflow_no_runner';
