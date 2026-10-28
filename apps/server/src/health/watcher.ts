/**
 * TER-1121: the project health watcher. Every `HEALTH_SWEEP_MS` it reads each active project (`snapshot.ts`),
 * asks which signs of stalled work it shows (`signals.ts`) and keeps one alert per sign and subject: a sign
 * past its minutes opens the alert, a sign no longer seen resolves it, and seeing it again later is a new
 * episode — except a flickering one (`FLAP_GRACE_MS`, an offline machine), which waits out a grace first. Each open episode reaches the person once:
 *
 * - `needs_you` signs (only the person can act) become a concierge notice (`notify` needs_you): it leaves as
 *   a push by the person's own rules — levels, quiet hours, grouping, the hourly cap (TER-1101);
 * - every open sign wakes the project's chat once, with the diagnosis and what unblocks it, so the concierge
 *   resolves what the person's rules allow and tells them about the rest.
 *
 * Both colours sweep; the claims in the database pick one, and a draining colour does nothing. Logs ids and
 * codes only.
 */
import type { FastifyBaseLogger } from 'fastify';
import { failureLabel, type ChatService } from '../chat/service.js';
import { HEALTH_ALERTS_KEPT_MS, type HealthAlert, type HealthAlertsRepository } from '../db/repositories/health-alerts.js';
import type { Repositories } from '../db/repositories/index.js';
import type { Project, User } from '../db/repositories/types.js';
import { localeOf } from '../i18n/index.js';
import { currentRulesBlock } from '../memory/current-rules.js';
import type { ProjectHealth, ProjectSetupData } from '../setup/schema.js';
import { FLAP_GRACE_MS, isDue, observe, type HealthSnapshot } from './signals.js';
import { buildSnapshot } from './snapshot.js';
import { healthWakeText, noticeHeadline } from './text.js';

type Log = Pick<FastifyBaseLogger, 'info' | 'warn'>;

export const HEALTH_SWEEP_MS = 5 * 60_000;
const FIRST_SWEEP_MS = 3 * 60_000;
/** A wake that could not start (the chat's host is away) waits this long, doubling up to `WAKE_RETRY_MAX_MS`. */
const WAKE_RETRY_FIRST_MS = 5 * 60_000;
const WAKE_RETRY_MAX_MS = 60 * 60_000;

export interface HealthWatcherDeps {
  repos: Repositories;
  chat: Pick<ChatService, 'wake'>;
  log: Log;
  /** False while this colour drains. */
  active?: () => boolean;
  now?: () => Date;
  /** The snapshot of one project; `buildSnapshot` by default (tests hand one in). */
  snapshot?: (project: Project, owner: User, setup: ProjectSetupData, now: Date) => Promise<HealthSnapshot>;
}

export interface HealthWatcher {
  sweep(): Promise<void>;
  /** One project: observe, open, resolve, then tell. Exposed for tests. */
  checkProject(project: Project): Promise<void>;
}

/**
 * Records what one snapshot shows: every sign seen, the ones past their minutes opened, the rest resolved.
 * Answers the project's open alerts afterwards.
 */
export async function reconcile(store: Pick<HealthAlertsRepository, 'listUnresolved' | 'seen' | 'open' | 'resolve' | 'note'>, projectId: string, snapshot: HealthSnapshot, config: ProjectHealth): Promise<HealthAlert[]> {
  const now = snapshot.now;
  const before = await store.listUnresolved(projectId);
  const running = new Map(before.map((a) => [`${a.signal}\n${a.subject}`, a]));
  const seenIds = new Set<string>();
  const open: HealthAlert[] = [];
  for (const o of observe(snapshot, config)) {
    let { detail, since } = o;
    const prev = running.get(`${o.signal}\n${o.subject}`);
    if (prev && FLAP_GRACE_MS[o.signal]) {
      // TER-1135: back from a flicker, it is the same episode — counted, and timed from its first drop
      const flaps = (typeof prev.detail.flaps === 'number' ? prev.detail.flaps : 0) + (prev.detail.back_at ? 1 : 0);
      if (flaps) (detail = { ...detail, flaps }), (since = null);
    }
    let alert = await store.seen(projectId, { signal: o.signal, subject: o.subject, level: o.level, detail, since }, now);
    seenIds.add(alert.id);
    if (!alert.opened_at && (o.now || isDue(o.signal, config, new Date(alert.since_at), now)) && (await store.open(alert.id, now))) alert = { ...alert, opened_at: now.toISOString() };
    if (alert.opened_at) open.push(alert);
  }
  const gone: string[] = [];
  for (const a of before) {
    if (seenIds.has(a.id)) continue;
    const grace = config.enabled && config.signals[a.signal].enabled ? FLAP_GRACE_MS[a.signal] : undefined;
    const back = typeof a.detail.back_at === 'string' ? Date.parse(a.detail.back_at) : NaN;
    // a flickering sign gone for now waits out its grace before the episode ends
    if (grace && Number.isNaN(back)) await store.note(a.id, { ...a.detail, back_at: now.toISOString() });
    else if (!grace || now.getTime() - back >= grace) gone.push(a.id);
  }
  await store.resolve(gone, now);
  return open;
}

export function createHealthWatcher(deps: HealthWatcherDeps): HealthWatcher {
  const now = deps.now ?? (() => new Date());
  const active = deps.active ?? (() => true);
  const snapshot = deps.snapshot ?? ((p, o, s, at) => buildSnapshot(deps.repos, p, o, s, at));
  const store = deps.repos.healthAlerts;
  /** Per project: when a failed wake may be tried again, and the pause after the next failure. */
  const retry = new Map<string, { at: number; pause: number }>();

  async function tell(project: Project, owner: User, all: HealthAlert[], wake: boolean): Promise<void> {
    // a sign another part of termhub already tells (a red base, TER-1120) stays on the panel only
    const open = all.filter((a) => !a.detail.told_elsewhere);
    if (!open.length) return;
    const at = now();
    const locale = localeOf(owner.locale);
    const conversation = (await deps.repos.chat.findLatestActiveForProject(project.id, owner.id)) ?? (await deps.repos.chat.getOrCreateForProject(owner.id, project.id));

    // the push first: once the woken answer ends, the notice points at it
    const noticed = new Set<string>();
    const toNotice = open.filter((a) => a.level === 'needs_you' && !a.noticed_at);
    if (toNotice.length) {
      const won = new Set(await store.claimNotice(toNotice.map((a) => a.id), at));
      const mine = toNotice.filter((a) => won.has(a.id));
      if (mine.length) {
        await deps.repos.conciergeNotices.create({ user_id: owner.id, conversation_id: conversation.id, project_id: project.id, level: 'needs_you', headline: noticeHeadline(mine, locale, at), watch_id: null }, at);
        for (const a of mine) noticed.add(a.id);
        deps.log.info({ projectId: project.id, alerts: mine.map((a) => a.signal) }, 'health: notice queued');
      }
    }

    if (!wake) return;
    const toWake = open.filter((a) => !a.woken_at);
    const wait = retry.get(project.id);
    if (!toWake.length || (wait && wait.at > at.getTime())) return;
    const won = new Set(await store.claimWake(toWake.map((a) => a.id), at));
    const mine = toWake.filter((a) => won.has(a.id));
    if (!mine.length) return;
    // what was pushed in an earlier sweep counts as told too
    for (const a of mine) if (a.noticed_at) noticed.add(a.id);
    try {
      const rules = await currentRulesBlock(deps.repos, owner.id, project.id);
      const started = await deps.chat.wake(owner, conversation.id, healthWakeText(mine, noticed, at, rules));
      retry.delete(project.id);
      deps.log.info({ projectId: project.id, conversationId: conversation.id, alerts: mine.map((a) => a.signal) }, 'health: chat woken');
      started.done.catch((err: unknown) => deps.log.warn({ conversationId: conversation.id, code: failureLabel(err) }, 'health: wake run failed'));
    } catch (err) {
      await store.releaseWake(mine.map((a) => a.id)).catch(() => undefined);
      const pause = Math.min(WAKE_RETRY_MAX_MS, wait ? wait.pause * 2 : WAKE_RETRY_FIRST_MS);
      retry.set(project.id, { at: now().getTime() + pause, pause });
      deps.log.warn({ projectId: project.id, code: failureLabel(err) }, 'health: wake failed, will retry');
    }
  }

  async function checkProject(project: Project): Promise<void> {
    if (!project.owner_id) return;
    const owner = await deps.repos.users.findById(project.owner_id);
    if (!owner) return;
    const setup = (await deps.repos.projectSetup.get(project.id)).data;
    const at = now();
    const seen = setup.health.enabled ? await snapshot(project, owner, setup, at) : emptySnapshot(at);
    const open = await reconcile(store, project.id, seen, setup.health);
    // without automatic work the person drives the tabs: the panel and the push, no concierge turn on their quota
    if (open.length) await tell(project, owner, open, seen.automation);
  }

  return {
    checkProject,
    async sweep() {
      if (!active()) return;
      const projects = await deps.repos.projects.list({ status: 'active' });
      for (const p of projects) {
        if (!active()) return;
        await checkProject(p).catch((err: unknown) => deps.log.warn({ projectId: p.id, code: failureLabel(err) }, 'health: project check failed'));
      }
    },
  };
}

/** What a project with the watcher off "shows": nothing, so its running alerts resolve. */
function emptySnapshot(now: Date): HealthSnapshot {
  return { now, automation: false, autonomy: 'pr', base_branch: 'main', prs: [], base: null, queued: [], active_runs: 0, last_run_at: null, tabs: [], doing: [], runs: [], machines: [], min_agent_version: '0.0.0' };
}

/**
 * Starts the watcher: a sweep every `HEALTH_SWEEP_MS` and a daily purge. The first sweep waits a few CI syncs
 * after boot, so the merge executor of this process has read the base branch again (its reading is in memory).
 * Returns the stop.
 */
export function startHealthWatcher(deps: HealthWatcherDeps & { sweepMs?: number }): () => void {
  const watcher = createHealthWatcher(deps);
  let running = false;
  const sweep = () => {
    if (running) return;
    running = true;
    void watcher
      .sweep()
      .catch((err: unknown) => deps.log.warn({ code: failureLabel(err) }, 'health: sweep failed'))
      .finally(() => (running = false));
  };
  const timer = setInterval(sweep, deps.sweepMs ?? HEALTH_SWEEP_MS);
  const first = setTimeout(sweep, FIRST_SWEEP_MS);
  const purge = setInterval(() => void deps.repos.healthAlerts.purgeResolvedBefore(new Date(Date.now() - HEALTH_ALERTS_KEPT_MS)).catch(() => undefined), 24 * 3600_000);
  timer.unref();
  first.unref();
  purge.unref();
  return () => {
    clearInterval(timer);
    clearTimeout(first);
    clearInterval(purge);
  };
}
