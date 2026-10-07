-- TER-742: the versions of the Terms of Use and of the Privacy Policy, and who accepted which. New tables only:
-- the previous release never reads them, and they ship empty, so nothing changes until a version is registered.
-- Acceptances go with their user; a version that was accepted cannot be deleted (the evidence stays).

-- CreateTable
CREATE TABLE "legal_document_versions" (
    "id" TEXT NOT NULL,
    "document" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "effective_at" TIMESTAMPTZ NOT NULL,
    "url" TEXT NOT NULL,
    "requires_acceptance" BOOLEAN NOT NULL DEFAULT true,
    "summary" TEXT,
    "notice_sent_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "legal_document_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "legal_acceptances" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "version_id" TEXT NOT NULL,
    "accepted_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip" TEXT,
    "user_agent" TEXT,
    "channel" TEXT NOT NULL,

    CONSTRAINT "legal_acceptances_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "legal_document_versions_document_version_key" ON "legal_document_versions"("document", "version");

-- CreateIndex
CREATE INDEX "legal_acceptances_user_id_version_id_idx" ON "legal_acceptances"("user_id", "version_id");

-- CreateIndex
CREATE INDEX "legal_acceptances_version_id_idx" ON "legal_acceptances"("version_id");

-- AddForeignKey
ALTER TABLE "legal_acceptances" ADD CONSTRAINT "legal_acceptances_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "legal_acceptances" ADD CONSTRAINT "legal_acceptances_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "legal_document_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
