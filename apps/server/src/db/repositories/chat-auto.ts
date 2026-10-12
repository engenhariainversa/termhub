import type { PrismaClient } from '../prisma.js';
import { newId } from '../../lib/ids.js';

/** How the person's own act told us whether a precedent was right (TER-642): they answered on the card
 *  (`answer`), let the countdown run out in front of them (`accepted`), or stopped it (`cancelled`). */
export type AutoSampleSource = 'answer' | 'accepted' | 'cancelled';

/** One observation for calibrating a person's automatic-answer thresholds: the precedent's similarity
 *  to the question, and whether it agreed with what the person did. */
export interface AutoSample {
  user_id: string;
  tab_question_id: string;
  question_index: number;
  score: number;
  matched: boolean;
  source: AutoSampleSource;
}

/**
 * TER-642: what tunes automatic answers per person — the calibration samples (`chat_auto_samples`) and
 * which of their screens have termhub in focus (`chat_focus`). Every method is keyed by the user: one
 * person's rows never reach another's calibration or countdown.
 */
export class ChatAutoRepository {
  constructor(private db: PrismaClient) {}

  /**
   * One sample per question of a card: a later observation of the same question replaces the earlier
   * one (a countdown the person cancelled, then the answer they gave), and counts as new for the next
   * recalibration.
   */
  async recordSamples(samples: AutoSample[]): Promise<void> {
    for (const s of samples) {
      await this.db.$executeRaw`
        INSERT INTO "chat_auto_samples" ("id", "user_id", "tab_question_id", "question_index", "score", "matched", "source")
        VALUES (${newId()}, ${s.user_id}, ${s.tab_question_id}, ${s.question_index}, ${s.score}, ${s.matched}, ${s.source})
        ON CONFLICT ("tab_question_id", "question_index")
        DO UPDATE SET "score" = EXCLUDED."score", "matched" = EXCLUDED."matched", "source" = EXCLUDED."source", "created_at" = CURRENT_TIMESTAMP`;
    }
  }

  /** This person's newest samples, at most `limit`. */
  async recentSamples(userId: string, limit: number): Promise<AutoSample[]> {
    const rows = await this.db.chatAutoSample.findMany({ where: { userId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit });
    return rows.map((r) => ({ user_id: r.userId, tab_question_id: r.tabQuestionId, question_index: r.questionIndex, score: r.score, matched: r.matched, source: r.source as AutoSampleSource }));
  }

  countSamples(userId: string): Promise<number> {
    return this.db.chatAutoSample.count({ where: { userId } });
  }

  /** People with a sample newer than their last calibration (or never calibrated), at most `limit`. */
  async usersToCalibrate(limit: number): Promise<string[]> {
    const rows = await this.db.$queryRaw<{ user_id: string }[]>`
      SELECT s."user_id"
      FROM "chat_auto_samples" s JOIN "users" u ON u."id" = s."user_id"
      GROUP BY s."user_id", u."chat_auto_calibration"
      HAVING max(s."created_at") > COALESCE((u."chat_auto_calibration"->>'computed_at')::timestamptz AT TIME ZONE 'UTC', 'epoch'::timestamp)
      ORDER BY max(s."created_at") ASC
      LIMIT ${limit}`;
    return rows.map((r) => r.user_id);
  }

  /** A screen of this person says termhub is in focus: its heartbeat, stamped by the database's clock. */
  async touchFocus(userId: string, clientId: string): Promise<void> {
    await this.db.$executeRaw`
      INSERT INTO "chat_focus" ("user_id", "client_id", "seen_at") VALUES (${userId}, ${clientId}, CURRENT_TIMESTAMP)
      ON CONFLICT ("user_id", "client_id") DO UPDATE SET "seen_at" = CURRENT_TIMESTAMP`;
  }

  /** That screen lost focus (or went to the background). */
  async clearFocus(userId: string, clientId: string): Promise<void> {
    await this.db.chatFocus.deleteMany({ where: { userId, clientId } });
  }

  /** Which of these people have a screen whose heartbeat is at most `ttlMs` old, on the database's clock. */
  async focusedUsers(userIds: string[], ttlMs: number): Promise<Set<string>> {
    if (userIds.length === 0) return new Set();
    const rows = await this.db.$queryRaw<{ user_id: string }[]>`
      SELECT DISTINCT "user_id" FROM "chat_focus"
      WHERE "user_id" = ANY(${userIds}::text[]) AND "seen_at" > CURRENT_TIMESTAMP - ${ttlMs} * interval '1 millisecond'`;
    return new Set(rows.map((r) => r.user_id));
  }

  /** Heartbeats nobody refreshed for `olderThanMs`: closed browsers and killed apps. Resolves how many. */
  async purgeFocus(olderThanMs: number): Promise<number> {
    return this.db.$executeRaw`DELETE FROM "chat_focus" WHERE "seen_at" < CURRENT_TIMESTAMP - ${olderThanMs} * interval '1 millisecond'`;
  }
}
