-- TER-1099: the concierge's watches ("me avise quando…") and the events they caught. New tables only:
-- additive and backward compatible, the previous release never reads them.

-- CreateTable
CREATE TABLE "chat_watches" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "project_id" TEXT,
    "conversation_id" TEXT,
    "kind" TEXT NOT NULL,
    "target_id" TEXT,
    "params" JSONB NOT NULL,
    "baseline" JSONB NOT NULL,
    "label" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "recurring" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'open',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "closed_at" TIMESTAMP(3),
    "last_fired_at" TIMESTAMP(3),
    "fire_count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "chat_watches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_watch_fires" (
    "id" TEXT NOT NULL,
    "watch_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "project_id" TEXT,
    "event_key" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimed_at" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "delivered_at" TIMESTAMP(3),
    "dropped_at" TIMESTAMP(3),

    CONSTRAINT "chat_watch_fires_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "chat_watches_status_kind_idx" ON "chat_watches"("status", "kind");

-- CreateIndex
CREATE INDEX "chat_watches_user_id_project_id_status_idx" ON "chat_watches"("user_id", "project_id", "status");

-- CreateIndex
CREATE INDEX "chat_watch_fires_delivered_at_dropped_at_idx" ON "chat_watch_fires"("delivered_at", "dropped_at");

-- CreateIndex
CREATE INDEX "chat_watch_fires_user_id_delivered_at_idx" ON "chat_watch_fires"("user_id", "delivered_at");

-- CreateIndex
CREATE UNIQUE INDEX "chat_watch_fires_watch_id_event_key_key" ON "chat_watch_fires"("watch_id", "event_key");

-- AddForeignKey
ALTER TABLE "chat_watches" ADD CONSTRAINT "chat_watches_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_watches" ADD CONSTRAINT "chat_watches_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_watch_fires" ADD CONSTRAINT "chat_watch_fires_watch_id_fkey" FOREIGN KEY ("watch_id") REFERENCES "chat_watches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
