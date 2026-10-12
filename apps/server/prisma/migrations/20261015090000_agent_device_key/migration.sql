-- TER-1017: single-use pairing token + Ed25519 device key for agents. Additive and backward compatible:
-- the previous release never reads these columns and keeps authenticating agents by agent_token_hash,
-- which existing machines keep until they are paired again.

-- AlterTable
ALTER TABLE "machines" ADD COLUMN "agent_pairing_hash" TEXT,
ADD COLUMN "agent_pairing_expires_at" TIMESTAMP(3),
ADD COLUMN "agent_public_key" TEXT,
ADD COLUMN "agent_paired_at" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "machines_agent_pairing_hash_key" ON "machines"("agent_pairing_hash");
