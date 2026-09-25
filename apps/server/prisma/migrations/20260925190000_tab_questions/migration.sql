-- CreateTable
CREATE TABLE "tab_questions" (
    "id" TEXT NOT NULL,
    "tab_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "tool_use_id" TEXT,
    "status" TEXT NOT NULL,
    "answer" JSONB,
    "error_code" TEXT,
    "answered_by" TEXT,
    "answered_at" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),
    "injected_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tab_questions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tab_questions_tab_id_status_idx" ON "tab_questions"("tab_id", "status");

-- CreateIndex
CREATE INDEX "tab_questions_conversation_id_created_at_idx" ON "tab_questions"("conversation_id", "created_at");

-- AddForeignKey
ALTER TABLE "tab_questions" ADD CONSTRAINT "tab_questions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tab_questions" ADD CONSTRAINT "tab_questions_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "chat_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
