-- TER-1076 (spec 2026-10-07 multi-repo §4): the git repositories found in a project's folder, and where each
-- one sits on each machine. Written by discovery; the person's overrides stay in the setup JSON.
-- Two new tables only: the release still serving during the switch never reads them.

-- CreateTable
CREATE TABLE "project_repositories" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ok',
    "discovered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_repositories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_repository_checkouts" (
    "repository_id" TEXT NOT NULL,
    "machine_id" TEXT NOT NULL,
    "dir" TEXT NOT NULL,
    "default_branch" TEXT,
    "has_commits" BOOLEAN NOT NULL DEFAULT false,
    "seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "missing_at" TIMESTAMP(3),

    CONSTRAINT "project_repository_checkouts_pkey" PRIMARY KEY ("repository_id","machine_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "project_repositories_project_id_full_name_key" ON "project_repositories"("project_id", "full_name");

-- CreateIndex
CREATE UNIQUE INDEX "project_repositories_project_id_key_key" ON "project_repositories"("project_id", "key");

-- CreateIndex
CREATE INDEX "project_repository_checkouts_machine_id_idx" ON "project_repository_checkouts"("machine_id");

-- AddForeignKey
ALTER TABLE "project_repositories" ADD CONSTRAINT "project_repositories_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_repository_checkouts" ADD CONSTRAINT "project_repository_checkouts_repository_id_fkey" FOREIGN KEY ("repository_id") REFERENCES "project_repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_repository_checkouts" ADD CONSTRAINT "project_repository_checkouts_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE CASCADE ON UPDATE CASCADE;
