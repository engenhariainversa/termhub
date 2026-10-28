-- TER-1141: when the person last asked the concierge for a watch's status ("ping"), for the 30 s limit and the
-- chat's "status pedido às 14:32". Nullable column only: the previous release neither reads nor writes it.
ALTER TABLE "chat_watches" ADD COLUMN "last_pinged_at" TIMESTAMP(3);
