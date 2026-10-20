-- TER-642: automatic answers by similarity band, with thresholds per user.
-- Everything here is additive (nullable columns, new tables): the previous release never reads any of
-- it, so it stays compatible while both colors run.

-- The thresholds a person pinned by hand (null = calibrated from their own history, else the defaults),
-- and the last calibration: `{ high, low, samples, computed_at }`.
ALTER TABLE "users" ADD COLUMN "chat_auto_high" DOUBLE PRECISION;
ALTER TABLE "users" ADD COLUMN "chat_auto_low" DOUBLE PRECISION;
ALTER TABLE "users" ADD COLUMN "chat_auto_calibration" JSONB;

-- The best precedent memory found for each question when the card opened, whatever its score:
-- `{ items: [{ question_index, ref, similarity, selected, text? }] }`. What calibration compares the
-- person's own answer with.
ALTER TABLE "tab_questions" ADD COLUMN "precedent" JSONB;

-- One observation per question of a card: the precedent's score and whether it agreed with what the
-- person did (`answer`: they answered on the card; `accepted`: the countdown ran out in front of them;
-- `cancelled`: they stopped it). Never shared between users.
CREATE TABLE "chat_auto_samples" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "tab_question_id" TEXT NOT NULL,
    "question_index" INTEGER NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "matched" BOOLEAN NOT NULL,
    "source" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "chat_auto_samples_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "chat_auto_samples_tab_question_id_question_index_key" ON "chat_auto_samples"("tab_question_id", "question_index");
CREATE INDEX "chat_auto_samples_user_id_created_at_idx" ON "chat_auto_samples"("user_id", "created_at");
ALTER TABLE "chat_auto_samples" ADD CONSTRAINT "chat_auto_samples_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Which of a person's screens have termhub in focus right now (web: visible and focused; app: in the
-- foreground). A row is a heartbeat: a suggested answer's countdown only runs while one is fresh.
CREATE TABLE "chat_focus" (
    "user_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "chat_focus_pkey" PRIMARY KEY ("user_id", "client_id")
);
ALTER TABLE "chat_focus" ADD CONSTRAINT "chat_focus_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
