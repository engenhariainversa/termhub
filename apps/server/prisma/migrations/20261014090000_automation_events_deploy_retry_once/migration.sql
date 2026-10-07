-- TER-1025: a deploy that failed on GitHub's side is run again at most once per attempt: one `deploy_retried`
-- event per card, merge SHA and attempt number, so two colours syncing the same failed deploy re-run it once.
-- Partial and on expressions, so it is not in schema.prisma (see the AutomationEvent model). Additive: the
-- previous release never writes this kind.
CREATE UNIQUE INDEX "automation_events_deploy_retry_once" ON "automation_events"("task_id", ("payload"->>'sha'), ("payload"->>'attempt'))
    WHERE "kind" = 'deploy_retried';
