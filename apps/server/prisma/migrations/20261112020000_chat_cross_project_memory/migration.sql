-- "Usar o que já decidi em outros projetos" (TER-1169), on by default. A new column with a default is
-- backward compatible: the release still serving during the switch never reads or writes it.
ALTER TABLE "users" ADD COLUMN "chat_cross_project_memory" BOOLEAN NOT NULL DEFAULT true;
