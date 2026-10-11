-- When the chat was woken for a run whose tab keeps stopping after resume_max resumes (agentic board, D15):
-- one wake per run, claimed here so both colours and a restart agree. null = not woken.
ALTER TABLE "automation_runs" ADD COLUMN "woken_at" TIMESTAMPTZ;
