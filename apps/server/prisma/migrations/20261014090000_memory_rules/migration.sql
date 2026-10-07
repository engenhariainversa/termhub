-- TER-1010: current rules (regras vigentes) and the proposals for them. A new table only: additive and
-- backward compatible, the previous release never reads it, and nobody has a rule until they approve one.

-- CreateTable
CREATE TABLE "memory_rules" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "project_id" TEXT,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "policy" JSONB,
    "source_refs" JSONB NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "note_id" TEXT,
    "decided_at" TIMESTAMP(3),
    "decided_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "memory_rules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "memory_rules_owner_id_status_idx" ON "memory_rules"("owner_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "memory_rules_owner_id_fingerprint_key" ON "memory_rules"("owner_id", "fingerprint");

-- AddForeignKey
ALTER TABLE "memory_rules" ADD CONSTRAINT "memory_rules_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_rules" ADD CONSTRAINT "memory_rules_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
