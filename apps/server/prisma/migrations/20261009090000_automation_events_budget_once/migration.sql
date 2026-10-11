-- One budget notice per project, kind and day (the claim of the once-a-day warning / hit line). Additive.
CREATE UNIQUE INDEX "automation_events_budget_once" ON "automation_events"("project_id", "kind", ("payload"->>'day'))
  WHERE "kind" IN ('budget_warning', 'budget_hit');
