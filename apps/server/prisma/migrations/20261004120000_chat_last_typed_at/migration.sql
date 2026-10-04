-- When the person last typed in a conversation (TER-530): a denial older than this no longer refuses
-- the same call by itself. A nullable column only: the release still serving during the switch never
-- reads nor writes it, and null means "nothing typed since the column existed".
ALTER TABLE "chat_conversations" ADD COLUMN "last_typed_at" TIMESTAMP(3);
