-- TER-1115: what the person reads of a watch ("Te aviso quando a aba OPM-568 parar"), written by the concierge
-- apart from its own note, and the last event it caught (the strip says "terminou às 14:32"). Nullable columns
-- only: the previous release neither reads nor writes them.
ALTER TABLE "chat_watches" ADD COLUMN "summary" TEXT;
ALTER TABLE "chat_watches" ADD COLUMN "last_event" TEXT;
