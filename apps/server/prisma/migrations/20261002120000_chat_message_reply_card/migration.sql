-- TER-849: a message can answer a card of the thread (a gate action or a tab question) instead of a
-- message. No foreign key: the two kinds live in different tables, and the quote keeps its excerpt.
ALTER TABLE "chat_messages"
  ADD COLUMN "reply_to_card_kind" TEXT,
  ADD COLUMN "reply_to_card_id" TEXT;
