-- TER-577: the security audit trail. Additive and backward compatible: the previous release neither reads
-- nor writes the table.

-- CreateTable
CREATE TABLE "security_events" (
    "id" TEXT NOT NULL,
    "actor_id" TEXT,
    "actor_email" TEXT,
    "view_as_id" TEXT,
    "action" TEXT NOT NULL,
    "target_type" TEXT,
    "target_id" TEXT,
    "target_label" TEXT,
    "ip" TEXT,
    "meta" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "security_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "security_events_created_at_idx" ON "security_events"("created_at");

-- CreateIndex
CREATE INDEX "security_events_action_created_at_idx" ON "security_events"("action", "created_at");

-- CreateIndex
CREATE INDEX "security_events_actor_id_created_at_idx" ON "security_events"("actor_id", "created_at");

-- Append-only: a row, once written, is never changed. Only the retention purge deletes rows.
-- Prisma's schema language has no triggers; `prisma migrate diff` does not compare them, so this is no drift.
CREATE FUNCTION "security_events_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'security_events is append-only';
END;
$$;

CREATE TRIGGER "security_events_no_update"
  BEFORE UPDATE ON "security_events"
  FOR EACH ROW EXECUTE FUNCTION "security_events_append_only"();
