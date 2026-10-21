/**
 * TER-1101: sends the concierge's notices. A notice is written by `notify` while the answer is being
 * written; when that answer ends (`run_finished`) it points at it and may leave. Then, per conversation,
 * the person's rules (`rules.ts`) decide: send the ready notices as one push, drop a level the person
 * turned off, or wait (quiet hours, the grouping window, the hourly cap). A sweep looks again at what waits.
 *
 * Everything lives in the database, so a restart or a deploy loses nothing, and the claim (`claimSent`)
 * keeps both colours from sending the same notice twice. Logs carry ids, levels and counts only — never
 * the headline.
 */
import type { FastifyBaseLogger } from 'fastify';
import type { Repositories } from '../../db/repositories/index.js';
import type { ConciergeNotice } from '../../db/repositories/concierge-notices.js';
import { zoneOrUtc } from '../../lib/local-time.js';
import { failureLabel } from '../service.js';
import { NOTICE_LIMITS, planNotices, type PushLevel } from './rules.js';

type Log = Pick<FastifyBaseLogger, 'info' | 'warn'>;

export const NOTICE_SWEEP_MS = 30_000;
const HOUR_MS = 3600_000;

/** One push: the most urgent level of what leaves, the headline it shows, the message a tap opens. */
export interface OutgoingNotice {
  userId: string;
  conversationId: string;
  projectId: string | null;
  messageId: string | null;
  level: PushLevel;
  headline: string;
  /** How many notices this push carries (grouped). */
  count: number;
}

export interface NoticeDispatcherDeps {
  repos: Pick<Repositories, 'conciergeNotices' | 'users' | 'chat'>;
  /** The push to the phones and the browsers' notification. */
  send: (n: OutgoingNotice) => Promise<void>;
  log: Log;
  /** False while this colour drains: the new colour sends. */
  active?: () => boolean;
  now?: () => Date;
}

export interface NoticeDispatcher {
  /** Looks at every ready notice (or one person's) and sends, drops or leaves them waiting. */
  dispatch(userId?: string): Promise<void>;
  /** An answer of the conversation ended: the notices written during it point at it, then dispatch. Fire-and-forget. */
  answerDone(userId: string, conversationId: string, messageId: string | null): void;
}

/** What leaves for a group: needs_you wins; the latest notice of the winning level gives the headline and the message. */
export function outgoingOf(notices: ConciergeNotice[]): Omit<OutgoingNotice, 'messageId'> & { messageId: string | null } {
  const urgent = notices.filter((n) => n.level === 'needs_you');
  const pool = urgent.length ? urgent : notices;
  const lead = pool[pool.length - 1]!;
  return { userId: lead.user_id, conversationId: lead.conversation_id, projectId: lead.project_id, messageId: lead.message_id, level: lead.level, headline: lead.headline, count: notices.length };
}

export function createNoticeDispatcher(deps: NoticeDispatcherDeps): NoticeDispatcher {
  const now = deps.now ?? (() => new Date());
  const active = deps.active ?? (() => true);
  const { repos, log } = deps;
  // One pass at a time in this process: a run's end during a sweep is looked at after it.
  let chain: Promise<void> = Promise.resolve();
  const serial = (fn: () => Promise<void>): Promise<void> => {
    const next = chain.then(fn).catch((err: unknown) => log.warn({ code: failureLabel(err) }, 'concierge notices: pass failed'));
    chain = next;
    return next;
  };

  async function conversation(userId: string, notices: ConciergeNotice[], zone: string, at: Date): Promise<void> {
    const settings = await repos.users.conciergePush(userId);
    const conversationId = notices[0]!.conversation_id;
    const plan = planNotices(notices, settings, zone, await repos.conciergeNotices.sentSince(conversationId, new Date(at.getTime() - HOUR_MS)), at);
    if (plan.drop.length) {
      await repos.conciergeNotices.drop(plan.drop.map((n) => n.id), 'level_off');
      log.info({ conversationId, dropped: plan.drop.length }, 'concierge notices: level off');
    }
    if (plan.kind === 'wait') await repos.conciergeNotices.noteHeld(notices.filter((n) => !plan.drop.includes(n)).map((n) => n.id), plan.reason);
    if (plan.kind !== 'send') return;
    const won = new Set(await repos.conciergeNotices.claimSent(plan.notices.map((n) => n.id), at));
    const mine = plan.notices.filter((n) => won.has(n.id));
    if (mine.length === 0) return;
    const out = outgoingOf(mine);
    // An answer that never said it ended (its run died): the conversation's newest answer is the best place.
    const messageId = out.messageId ?? (await repos.chat.latestAssistantMessageId(conversationId));
    try {
      await deps.send({ ...out, messageId });
      log.info({ conversationId, level: out.level, count: out.count }, 'concierge notices: sent');
    } catch (err) {
      log.warn({ conversationId, code: failureLabel(err) }, 'concierge notices: send failed');
    }
  }

  async function pass(userId?: string): Promise<void> {
    if (!active()) return;
    const at = now();
    const ready = await repos.conciergeNotices.listReady(at, NOTICE_LIMITS.readyAfterMs, userId ? { userId } : {});
    const byUser = new Map<string, Map<string, ConciergeNotice[]>>();
    for (const n of ready) {
      const convs = byUser.get(n.user_id) ?? new Map<string, ConciergeNotice[]>();
      convs.set(n.conversation_id, [...(convs.get(n.conversation_id) ?? []), n]);
      byUser.set(n.user_id, convs);
    }
    for (const [user, convs] of byUser) {
      const zone = zoneOrUtc(await repos.users.timeZone(user));
      for (const notices of convs.values()) {
        try {
          await conversation(user, notices, zone, at);
        } catch (err) {
          log.warn({ conversationId: notices[0]!.conversation_id, code: failureLabel(err) }, 'concierge notices: conversation failed');
        }
      }
    }
  }

  return {
    dispatch: (userId) => serial(() => pass(userId)),
    answerDone(userId, conversationId, messageId) {
      void serial(async () => {
        if (messageId && (await repos.conciergeNotices.markReady(conversationId, messageId, now())) === 0) return;
        await pass(userId);
      });
    },
  };
}

export interface StartNoticesDeps extends NoticeDispatcherDeps {
  /** The bus that says an answer ended (`run_finished`). */
  onAnswerDone: (listener: (userId: string, conversationId: string, messageId: string | null) => void) => () => void;
  sweepMs?: number;
}

/** Starts the dispatcher: on every answer's end, a sweep every `NOTICE_SWEEP_MS`, and an hourly clean-up. */
export function startNoticeDispatcher(deps: StartNoticesDeps): { dispatcher: NoticeDispatcher; stop: () => void } {
  const dispatcher = createNoticeDispatcher(deps);
  const off = deps.onAnswerDone((userId, conversationId, messageId) => dispatcher.answerDone(userId, conversationId, messageId));
  const timer = setInterval(() => void dispatcher.dispatch(), deps.sweepMs ?? NOTICE_SWEEP_MS);
  const clean = setInterval(() => {
    const at = Date.now();
    void deps.repos.conciergeNotices
      .dropStaleBefore(new Date(at - NOTICE_LIMITS.staleAfterMs))
      .then(() => deps.repos.conciergeNotices.purgeBefore(new Date(at - NOTICE_LIMITS.keptMs)))
      .catch((err: unknown) => deps.log.warn({ code: failureLabel(err) }, 'concierge notices: clean-up failed'));
  }, HOUR_MS);
  timer.unref();
  clean.unref();
  return {
    dispatcher,
    stop() {
      off();
      clearInterval(timer);
      clearInterval(clean);
    },
  };
}
