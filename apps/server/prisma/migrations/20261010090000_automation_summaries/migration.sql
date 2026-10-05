-- One daily summary of the automatic work per user and day (the claim of the 5-minute timer: whichever
-- colour inserts the row sends the summary, the other finds it taken). New table only: the previous release
-- never reads it. Rows go with their user.
CREATE TABLE "automation_summaries" (
    "user_id" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "sent_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "automation_summaries_pkey" PRIMARY KEY ("user_id","day")
);

ALTER TABLE "automation_summaries" ADD CONSTRAINT "automation_summaries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
