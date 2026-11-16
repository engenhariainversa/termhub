-- TER-1068 (spec 2026-10-07 multi-repo R9 b): one `repo_unknown` event per card, so two colours ticking at
-- once wake the project's chat about a card with no repository only once. Partial, so it is not in
-- schema.prisma (see the AutomationEvent model). Additive: the previous release never writes this kind.
CREATE UNIQUE INDEX "automation_events_repo_unknown_once" ON "automation_events"("task_id")
    WHERE "kind" = 'repo_unknown';
