/**
 * TER-1099: runs the watches. Every sweep (and right after a bus reports a change to a watched tab or
 * machine) it evaluates the open watches against their targets' state, writes what they caught as fires —
 * once per event, whichever colour sees it first (`ChatWatchesRepository.fire`) — and delivers the pending
 * fires: one wake turn per chat scope, with every event that scope has waiting. Everything it needs lives
 * in the database, so a restart or a deploy loses nothing: the next process's first sweep catches what
 * changed meanwhile and delivers what was not delivered.
 *
 * A wake goes through `ChatService.wake`: a conversation in the middle of a turn gets it injected or queued
 * for its next one. A delivery that cannot start (the chat's host is away) is handed back and retried with
 * a growing pause; after `UNDELIVERED_MAX_MS` it is dropped. Logs carry ids and codes only.
 */
import type { FastifyBaseLogger } from 'fastify';
import type { Repositories } from '../../db/repositories/index.js';
import type { ChatWatch, ChatWatchFire } from '../../db/repositories/chat-watches.js';
import { currentRulesBlock } from '../../memory/current-rules.js';
import { failureLabel, type ChatService } from '../service.js';
import { cooldownOf, evaluateReminder, evaluateWatch, expiredEvaluation, type Evaluation, type WatchProbe } from './evaluate.js';
import { WATCH_LIMITS, type WatchKind } from './kinds.js';
import { watchWakeText } from './text.js';
import { publishWatches } from './view.js';

type Log = Pick<FastifyBaseLogger, 'info' | 'warn'>;

export const SWEEP_MS = 20_000;
/** A fire nobody could deliver for a day is given up on: what it said is stale by then. */
export const UNDELIVERED_MAX_MS = 24 * 3600_000;
/** Closed watches are kept this long, then purged with their fires. */
export const CLOSED_KEPT_MS = 30 * 24 * 3600_000;
const RETRY_FIRST_MS = 60_000;
const RETRY_MAX_MS = 15 * 60_000;
const HOUR_MS = 3600_000;

export interface WatchEngineDeps {
  /** `tabs` lets the published list carry a watched tab's state now (TER-1115). */
  repos: Pick<Repositories, 'chatWatches' | 'users' | 'chat' | 'memoryItems'> & Partial<Pick<Repositories, 'tabs'>>;
  chat: Pick<ChatService, 'wake'>;
  probe: WatchProbe;
  log: Log;
  /** False while this colour drains: it neither fires nor delivers (the new colour does). */
  active?: () => boolean;
  now?: () => Date;
  wakesPerHour?: number;
  /** Tells the scope's screens their list changed; `publishWatches` by default. */
  publish?: (userId: string, projectId: string | null) => Promise<void>;
}

export interface WatchEngine {
  /** Expires, evaluates every open watch, then delivers. */
  sweep(): Promise<void>;
  /** A bus said this target changed: its watches are evaluated now, then delivered. Fire-and-forget. */
  nudge(kind: WatchKind, targetId: string): void;
  /** Only delivers what is pending (tests, and after `watch` registered one already in its state). */
  deliver(): Promise<void>;
  /** TER-1100: the soonest time an open reminder is due, as the last pass saw it (ms), or null. */
  nextReminderAt(): number | null;
}

const scopeKey = (userId: string, projectId: string | null) => `${userId}:${projectId ?? ''}`;

export function createWatchEngine(deps: WatchEngineDeps): WatchEngine {
  const now = deps.now ?? (() => new Date());
  const active = deps.active ?? (() => true);
  const wakesPerHour = deps.wakesPerHour ?? WATCH_LIMITS.wakesPerHour;
  const publish = deps.publish ?? ((userId: string, projectId: string | null) => publishWatches(deps.repos, userId, projectId));
  let soonestReminder: number | null = null;
  /** Per chat scope: when a failed delivery may be tried again, and the pause after the next failure. */
  const retry = new Map<string, { at: number; pause: number }>();
  // One pass at a time in this process: a nudge during a sweep runs after it.
  let chain: Promise<void> = Promise.resolve();
  const serial = (fn: () => Promise<void>): Promise<void> => {
    const next = chain.then(fn).catch((err: unknown) => deps.log.warn({ code: failureLabel(err) }, 'chat watches: pass failed'));
    chain = next;
    return next;
  };

  /** Writes what one watch caught (or its silent baseline update); answers whether it fired. */
  async function apply(w: ChatWatch, ev: Evaluation): Promise<boolean> {
    if (ev.events.length === 0) {
      await deps.repos.chatWatches.updateBaseline(w.id, ev.baseline);
      return false;
    }
    const born = await deps.repos.chatWatches.fire(w, { events: ev.events, baseline: ev.baseline, close: ev.close, cooldownMs: ev.close === 'expired' || ev.close === 'gone' ? undefined : cooldownOf(w) }, now());
    if (born > 0) deps.log.info({ watchId: w.id, kind: w.kind, events: ev.events.map((e) => e.event) }, 'chat watch fired');
    return born > 0;
  }

  async function check(watches: ChatWatch[]): Promise<Set<string>> {
    const changed = new Map<string, { userId: string; projectId: string | null }>();
    for (const w of watches) {
      try {
        const expired = Date.parse(w.expires_at) <= now().getTime();
        // A reminder whose time passed while the server was down still fires (late) before it can expire.
        const ev = w.kind === 'reminder' ? (evaluateReminder(w, now()) ?? (expired ? expiredEvaluation(w) : null)) : expired ? expiredEvaluation(w) : await evaluateWatch(deps.probe, w, now());
        if (ev && (await apply(w, ev))) changed.set(scopeKey(w.user_id, w.project_id), { userId: w.user_id, projectId: w.project_id });
      } catch (err) {
        deps.log.warn({ watchId: w.id, code: failureLabel(err) }, 'chat watch: evaluation failed');
      }
    }
    for (const s of changed.values()) await publish(s.userId, s.projectId);
    return new Set(changed.keys());
  }

  async function deliverScope(userId: string, projectId: string | null, fires: ChatWatchFire[]): Promise<void> {
    const key = scopeKey(userId, projectId);
    const t = now().getTime();
    const wait = retry.get(key);
    if (wait && wait.at > t) return;
    if ((await deps.repos.chatWatches.countWakesSince(userId, projectId, new Date(t - HOUR_MS))) >= wakesPerHour) return;
    const won = new Set(await deps.repos.chatWatches.claimFires(fires.map((f) => f.id), now()));
    const mine = fires.filter((f) => won.has(f.id));
    if (mine.length === 0) return;
    const ids = mine.map((f) => f.id);
    try {
      const user = await deps.repos.users.findById(userId);
      if (!user) {
        await deps.repos.chatWatches.releaseFires(ids);
        return;
      }
      const watches = new Map<string, ChatWatch>();
      for (const f of mine) if (!watches.has(f.watch_id)) {
        const w = await deps.repos.chatWatches.findById(f.watch_id);
        if (w) watches.set(w.id, w);
      }
      const items = mine.flatMap((fire) => { const watch = watches.get(fire.watch_id); return watch ? [{ watch, fire }] : []; });
      const conversation = projectId ? await deps.repos.chat.getOrCreateForProject(userId, projectId) : await deps.repos.chat.getOrCreateForUser(userId);
      const rules = projectId ? await currentRulesBlock(deps.repos, userId, projectId) : null;
      const started = await deps.chat.wake(user, conversation.id, watchWakeText(items, rules));
      await deps.repos.chatWatches.markDelivered(ids, now());
      retry.delete(key);
      deps.log.info({ conversationId: conversation.id, fires: ids.length }, 'chat watches: delivered');
      // `done` settles later and may still reject (a setup failure mid-run): only ever logged, by code.
      started.done.catch((err: unknown) => deps.log.warn({ conversationId: conversation.id, code: failureLabel(err) }, 'chat watches: wake run failed'));
    } catch (err) {
      await deps.repos.chatWatches.releaseFires(ids).catch(() => undefined);
      const pause = Math.min(RETRY_MAX_MS, wait ? wait.pause * 2 : RETRY_FIRST_MS);
      retry.set(key, { at: now().getTime() + pause, pause });
      deps.log.warn({ fires: ids.length, code: failureLabel(err) }, 'chat watches: delivery failed, will retry');
    }
  }

  /**
   * TER-1101: a periodic summary (a reminder with `stop_with`) ends with the job it follows: once that watch
   * is no longer open, the reminder is closed before it can wake the chat again. Answers what stays open.
   */
  async function stopSummaries(open: ChatWatch[]): Promise<ChatWatch[]> {
    const openIds = new Set(open.map((w) => w.id));
    const stopped = new Set<string>();
    for (const w of open) {
      const job = w.kind === 'reminder' ? w.params.stop_with : undefined;
      if (!job || openIds.has(job)) continue;
      try {
        if ((await deps.repos.chatWatches.findById(job))?.status === 'open') continue;
        if (!(await deps.repos.chatWatches.cancel(w.id, w.user_id, now()))) continue;
        stopped.add(w.id);
        deps.log.info({ watchId: w.id, stopWith: job }, 'chat watches: summary stopped with its job');
        await publish(w.user_id, w.project_id);
      } catch (err) {
        deps.log.warn({ watchId: w.id, code: failureLabel(err) }, 'chat watches: stopping a summary failed');
      }
    }
    return stopped.size ? open.filter((w) => !stopped.has(w.id)) : open;
  }

  async function deliverPending(): Promise<void> {
    await deps.repos.chatWatches.dropUndeliveredBefore(new Date(now().getTime() - UNDELIVERED_MAX_MS), now());
    const pending = await deps.repos.chatWatches.listPendingFires(now());
    const byScope = new Map<string, ChatWatchFire[]>();
    for (const f of pending) {
      const k = scopeKey(f.user_id, f.project_id);
      byScope.set(k, [...(byScope.get(k) ?? []), f]);
    }
    for (const fires of byScope.values()) await deliverScope(fires[0].user_id, fires[0].project_id, fires);
  }

  return {
    sweep: () =>
      serial(async () => {
        if (!active()) return;
        const open = await stopSummaries(await deps.repos.chatWatches.listAllOpen());
        await check(open);
        soonestReminder = soonestDue(open, now().getTime());
        await deliverPending();
      }),
    nudge(kind, targetId) {
      void serial(async () => {
        if (!active()) return;
        const watches = await deps.repos.chatWatches.listAllOpen({ kind, targetId });
        const fired = await check(watches);
        // TER-1115: a watched tab changed state without firing (it went back to work, or stopped in a way
        // the watch did not ask about): its screens still show the state now.
        if (kind === 'tab') {
          const quiet = new Map(watches.filter((w) => !fired.has(scopeKey(w.user_id, w.project_id))).map((w) => [scopeKey(w.user_id, w.project_id), w]));
          for (const w of quiet.values()) await publish(w.user_id, w.project_id);
        }
        if (fired.size) await deliverPending();
      });
    },
    deliver: () =>
      serial(async () => {
        if (active()) await deliverPending();
      }),
    nextReminderAt: () => soonestReminder,
  };
}

/** The soonest still-ahead time among the open reminders' `next` (a fired one moved on already). */
function soonestDue(watches: ChatWatch[], after: number): number | null {
  let soonest: number | null = null;
  for (const w of watches) {
    if (w.kind !== 'reminder' || typeof w.baseline.next !== 'string') continue;
    const at = Date.parse(w.baseline.next);
    if (at > after && (soonest === null || at < soonest)) soonest = at;
  }
  return soonest;
}

export interface StartWatchesDeps extends Omit<WatchEngineDeps, 'probe'> {
  probe: WatchProbe;
  /** The in-process signals that something watched changed: tabs (state, closed) and agents (online, offline). */
  buses: {
    onTab(listener: (tabId: string) => void): () => void;
    onMachine(listener: (machineId: string) => void): () => void;
  };
  /** The sweep's period; `SWEEP_MS` by default (tests shorten it). */
  sweepMs?: number;
}

/**
 * Starts the engine: a sweep every `SWEEP_MS` (the first shortly after boot, which reconciles what changed
 * while no process was watching), a nudge on every tab or agent change, and an hourly purge of closed
 * watches. Both colours run it; the database decides which one fires and delivers. Returns the stop.
 */
export function startWatchEngine(deps: StartWatchesDeps): { engine: WatchEngine; stop: () => void } {
  const engine = createWatchEngine(deps);
  const period = deps.sweepMs ?? SWEEP_MS;
  // TER-1100: a reminder due before the next sweep gets its own sweep at its time, so "em 5 min" is not up
  // to a sweep late. A reminder created between sweeps is caught by the next one (within `period`).
  let precise: ReturnType<typeof setTimeout> | null = null;
  const sweep = async () => {
    await engine.sweep();
    const at = engine.nextReminderAt();
    if (precise) clearTimeout(precise);
    precise = null;
    if (at !== null && at - Date.now() < period) {
      precise = setTimeout(() => void engine.sweep(), Math.max(0, at - Date.now()) + 50);
      precise.unref();
    }
  };
  const timer = setInterval(() => void sweep(), period);
  const first = setTimeout(() => void sweep(), 5_000);
  const purge = setInterval(() => {
    void deps.repos.chatWatches.purgeClosedBefore(new Date(Date.now() - CLOSED_KEPT_MS)).catch((err: unknown) => deps.log.warn({ code: failureLabel(err) }, 'chat watches: purge failed'));
  }, HOUR_MS);
  timer.unref();
  first.unref();
  purge.unref();
  const offTab = deps.buses.onTab((tabId) => engine.nudge('tab', tabId));
  const offMachine = deps.buses.onMachine((machineId) => engine.nudge('machine', machineId));
  return {
    engine,
    stop() {
      clearInterval(timer);
      clearTimeout(first);
      if (precise) clearTimeout(precise);
      clearInterval(purge);
      offTab();
      offMachine();
    },
  };
}
