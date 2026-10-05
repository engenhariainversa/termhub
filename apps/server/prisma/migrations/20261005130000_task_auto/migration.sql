ALTER TABLE "tasks" ADD COLUMN "auto" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "tasks_project_id_auto_idx" ON "tasks" ("project_id") WHERE "auto";
