-- TER-1080: the machine's network (IPs, MACs, default interface) as its agent last reported it, kept for
-- when the machine is asleep so another one can wake it (Wake-on-LAN). Additive and backward compatible:
-- nullable columns the previous release never reads.
ALTER TABLE "machines" ADD COLUMN "network" JSONB;
ALTER TABLE "machines" ADD COLUMN "network_updated_at" TIMESTAMPTZ;
