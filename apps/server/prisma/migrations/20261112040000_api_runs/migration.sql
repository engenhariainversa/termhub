-- TER-1176: the personal runs API (behind the runs_api flag). Additive only: two new tables, no column of an
-- existing table changes, so the release still serving during the switch neither reads nor writes them.
-- CreateTable
CREATE TABLE "api_runs" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "token_id" TEXT,
    "project_id" TEXT NOT NULL,
    "machine_id" TEXT,
    "account_id" TEXT,
    "provider" TEXT,
    "model" TEXT,
    "capabilities" TEXT[],
    "status" TEXT NOT NULL DEFAULT 'queued',
    "workspace" JSONB,
    "result" TEXT,
    "usage" JSONB,
    "error_code" TEXT,
    "error_message" TEXT,
    "idempotency_key" TEXT,
    "timeout_ms" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(3),
    "ended_at" TIMESTAMP(3),

    CONSTRAINT "api_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_run_events" (
    "run_id" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_run_events_pkey" PRIMARY KEY ("run_id","seq")
);

-- CreateIndex
CREATE INDEX "api_runs_user_id_created_at_idx" ON "api_runs"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "api_runs_token_id_status_idx" ON "api_runs"("token_id", "status");

-- CreateIndex
CREATE INDEX "api_runs_user_id_status_idx" ON "api_runs"("user_id", "status");

-- CreateIndex
CREATE INDEX "api_runs_project_id_created_at_idx" ON "api_runs"("project_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "api_runs_user_id_idempotency_key_key" ON "api_runs"("user_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "api_run_events_at_idx" ON "api_run_events"("at");

-- AddForeignKey
ALTER TABLE "api_runs" ADD CONSTRAINT "api_runs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_runs" ADD CONSTRAINT "api_runs_token_id_fkey" FOREIGN KEY ("token_id") REFERENCES "api_tokens"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_runs" ADD CONSTRAINT "api_runs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_runs" ADD CONSTRAINT "api_runs_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_runs" ADD CONSTRAINT "api_runs_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "ai_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_run_events" ADD CONSTRAINT "api_run_events_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "api_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- The `runs` resource (Progresso's "Runs da API" and /api/v1/runs) goes to every role that may create
-- API tokens today, which is what lets a person make a `runs` token; admins bypass the matrix. Inert while
-- the runs_api flag is off: the routes answer 404 before any grant is read.
INSERT INTO "permissions" ("id", "resource", "action", "role_id")
SELECT 'perm_' || r."id" || '_runs_' || a, 'runs', a, r."id"
FROM "roles" r
JOIN "permissions" p ON p."role_id" = r."id" AND p."resource" = 'api_tokens' AND p."action" = 'create',
     unnest(ARRAY['create','read','update','delete']) AS a
ON CONFLICT DO NOTHING;
