-- TER-746: audit trail of the admin "view as" switch. Additive and backward compatible: the previous
-- release never reads or writes the table.

-- CreateTable
CREATE TABLE "view_as_audit" (
    "id" TEXT NOT NULL,
    "admin_id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "target_user_id" TEXT,
    "ip" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(3),

    CONSTRAINT "view_as_audit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "view_as_audit_admin_id_ended_at_idx" ON "view_as_audit"("admin_id", "ended_at");

-- CreateIndex
CREATE INDEX "view_as_audit_target_user_id_started_at_idx" ON "view_as_audit"("target_user_id", "started_at");

-- CreateIndex
CREATE INDEX "view_as_audit_started_at_idx" ON "view_as_audit"("started_at");
