-- TER-735: a machine can turn off the AI usage query (termhub then never reads the AI CLI credential on
-- it). Additive and backward compatible: the previous release does not read the column, and every
-- existing machine keeps today's behavior (query on).

-- AlterTable
ALTER TABLE "machines" ADD COLUMN "ai_usage_query" BOOLEAN NOT NULL DEFAULT true;
