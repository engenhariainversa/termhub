-- TER-1019: the current rules termhub published as pinned ai-memory pages, per project, machine and
-- checkout. Additive: a new table the previous release never reads.

-- CreateTable
CREATE TABLE "ai_memory_pages" (
    "project_id" TEXT NOT NULL,
    "machine_id" TEXT NOT NULL,
    "cwd" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "published_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_memory_pages_pkey" PRIMARY KEY ("project_id","machine_id","cwd","path")
);

-- CreateIndex
CREATE INDEX "ai_memory_pages_machine_id_idx" ON "ai_memory_pages"("machine_id");

-- AddForeignKey
ALTER TABLE "ai_memory_pages" ADD CONSTRAINT "ai_memory_pages_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_memory_pages" ADD CONSTRAINT "ai_memory_pages_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE CASCADE ON UPDATE CASCADE;
