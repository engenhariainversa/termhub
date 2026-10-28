-- TER-1137: hourly memory quotas per project and per origin, with a queue instead of dropping a write.
-- A nullable column and a new table: additive and backward compatible, the previous release never reads them.

-- AlterTable
ALTER TABLE "memory_items" ADD COLUMN "written_by" TEXT;

-- CreateTable
CREATE TABLE "memory_write_queue" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "project_id" TEXT,
    "what" TEXT NOT NULL,
    "written_by" TEXT,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memory_write_queue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "memory_write_queue_bucket_idx" ON "memory_write_queue"("owner_id", "project_id", "what", "written_by", "created_at");

-- AddForeignKey
ALTER TABLE "memory_write_queue" ADD CONSTRAINT "memory_write_queue_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_write_queue" ADD CONSTRAINT "memory_write_queue_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
