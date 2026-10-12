import { chatBus } from '../chat/bus.js';
import type { Repositories } from '../db/repositories/index.js';
import { localeOf, t, type Locale } from '../i18n/index.js';
import { zoneOrUtc } from '../lib/local-time.js';
import { automationSummaryText, type PushText } from '../mobile/push-text.js';
import { REASON_TEXT } from './eligibility.js';
import { escalationReasonText, SLOT_FREE_REASONS } from './escalation-text.js';
import { MERGE_TOOL } from './merge.js';
import { dayIn } from './usage.js';

/** How often the timer looks for summaries that are due. */
export const SUMMARY_TICK_MS = 5 * 60_000;

type Log = { warn: (o: object, m: string) => void };

/** One thing that waits on the person: a card and the reason, in the reader's language. */
export interface WaitingItem {
  label: (locale: Locale) => string;
}

export interface SummaryContent {
  /** `YYYY-MM-DD`, the user's local day of the send (the title's date) */
  day: string;
  /** where the covered period starts: the previous summary, or 24 h before */
  since: Date;
  /** the user's zone, to write `since` */
  zone: string;
  cards: number;
  merges: number;
  deploys: number;
  waiting: WaitingItem[];
  /** estimated USD of the day; null = nothing priced */
  cost: number | null;
}

const dateOf = (day: string, locale: Locale) => {
  const [y, m, d] = day.split('-');
  return locale === 'en' ? `${m}/${d}/${y}` : `${d}/${m}/${y}`; // pt-BR and es read day first
};

/** `dd/mm HH:mm` (`mm/dd` in English) of `at` in `zone`. */
function sinceText(at: Date, zone: string, locale: Locale): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: zone, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at).map((x) => [x.type, x.value]));
  return `${locale === 'en' ? `${p.month}/${p.day}` : `${p.day}/${p.month}`} ${p.hour}:${p.minute}`;
}

/** The chat message of the summary, in the owner's language (spec D26, pt-BR copy as the key). */
export function summaryMessage(s: SummaryContent, locale: Locale): string {
  const waiting = s.waiting.length === 0 ? t(locale, 'nada') : s.waiting.map((w) => w.label(locale)).join('; ');
  return [
    t(locale, 'Resumo do automático — {{date}}', { date: dateOf(s.day, locale) }),
    t(locale, 'Desde {{since}}', { since: sinceText(s.since, s.zone, locale) }),
    t(locale, 'Feitos: {{cards}} cards, {{merges}} merges, {{deploys}} deploys', { cards: s.cards, merges: s.merges, deploys: s.deploys }),
    t(locale, 'Esperando você: {{waiting}}', { waiting }),
    t(locale, 'Custo estimado do dia: {{cost}}', { cost: s.cost === null ? '—' : t(locale, 'US$ {{value}}', { value: s.cost.toFixed(2) }) }),
  ].join('\n');
}

export interface SummaryDeps {
  repos: Repositories;
  lifecycle: { readonly draining: boolean };
  /** One push to the user's phones; absent when the mobile API is off. */
  push?: (userId: string, textFor: (locale: Locale) => PushText, data: Record<string, unknown>, collapseId: string) => Promise<void>;
  log?: Log;
}

function localHour(zone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  return Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
}

/** Who gets a summary and from which hour: the owner's projects with automation on, at the earliest `summary_hour`. */
async function dueOwners(repos: Repositories): Promise<Map<string, { hour: number; projectIds: string[] }>> {
  const owners = new Map<string, { hour: number | null; projectIds: string[] }>();
  for (const { project_id, data } of await repos.projectSetup.listWithAutomation()) {
    const project = await repos.projects.findById(project_id);
    if (!project?.owner_id) continue;
    const entry = owners.get(project.owner_id) ?? { hour: null, projectIds: [] };
    entry.projectIds.push(project_id);
    const h = data.automation.summary_hour;
    if (h !== null && h !== undefined) entry.hour = entry.hour === null ? h : Math.min(entry.hour, h);
    owners.set(project.owner_id, entry);
  }
  const out = new Map<string, { hour: number; projectIds: string[] }>();
  for (const [id, e] of owners) if (e.hour !== null) out.set(id, { hour: e.hour, projectIds: e.projectIds });
  return out;
}

async function compose(repos: Repositories, ownerId: string, projectIds: string[], zone: string, day: string, now: Date): Promise<SummaryContent> {
  // the period since the previous summary (24 h before for the first); cost is per day, so the days it touches count whole
  const since = (await repos.automationSummaries.previousSentAt(ownerId, day)) ?? new Date(now.getTime() - 86_400_000);
  const [activity, cost, parked, approvals] = await Promise.all([
    repos.automationSummaries.activity(projectIds, since, now),
    repos.automationSummaries.costOfDays(projectIds, dayIn(zone, since), day),
    repos.automationSummaries.parkedRuns(projectIds, SLOT_FREE_REASONS as string[]),
    repos.automationSummaries.pendingCards(ownerId, MERGE_TOOL, projectIds),
  ]);
  const tasks = new Map((await repos.tasks.findByIds(parked.flatMap((p) => (p.task_id ? [p.task_id] : [])))).map((x) => [x.id, x]));
  const waiting: WaitingItem[] = [
    ...parked.map((p) => ({
      label: (locale: Locale) => `${(p.task_id ? tasks.get(p.task_id)?.ref : null) ?? t(locale, 'Um card')} (${escalationReasonText(p.reason, locale)})`,
    })),
    ...approvals.map((a) => ({
      label: (locale: Locale) => `${a.number === null ? t(locale, 'Um PR') : `PR #${a.number}`} (${t(locale, REASON_TEXT.merge_needs_approval)})`,
    })),
  ];
  return { day, since, zone, ...activity, waiting, cost };
}

/**
 * Sends the summaries that are due (spec D26, F-28): per user, once a day, at the earliest `summary_hour` of
 * their projects with automation on, in `users.time_zone` (UTC when unknown). The row in
 * `automation_summaries` is the claim, so both colours and every tick send it once. A draining colour sends
 * nothing. Off by default: a project with `summary_hour: null` (and a user with no such project) is never
 * read further. Returns how many summaries this call sent.
 */
export async function sendDueSummaries(deps: SummaryDeps, now: Date = new Date()): Promise<number> {
  const { repos, log } = deps;
  if (deps.lifecycle.draining) return 0;
  let sent = 0;
  for (const [ownerId, { hour, projectIds }] of await dueOwners(repos)) {
    if (deps.lifecycle.draining) break;
    try {
      const zone = zoneOrUtc(await repos.users.timeZone(ownerId));
      if (localHour(zone, now) < hour) continue;
      const day = dayIn(zone, now);
      if (!(await repos.automationSummaries.claim(ownerId, day))) continue;
      let written = false;
      try {
        const owner = await repos.users.findById(ownerId);
        if (!owner) throw new Error('owner gone');
        const content = await compose(repos, ownerId, projectIds, zone, day, now);
        // the account chat: one summary for all of the person's projects
        const conversation = await repos.chat.getOrCreateForUser(ownerId);
        const message = await repos.chat.addMessage({ conversation_id: conversation.id, role: 'assistant', text: summaryMessage(content, localeOf(owner.locale)) });
        written = true;
        chatBus.publish({ type: 'message', user_id: ownerId, conversation_id: conversation.id, message });
        sent++;
        await deps.push?.(ownerId, (locale) => automationSummaryText({ date: dateOf(content.day, locale), cards: content.cards, merges: content.merges, deploys: content.deploys, waiting: content.waiting.length }, locale), { kind: 'automation_summary', conversation_id: conversation.id }, `summary:${day}`).catch((e: unknown) =>
          log?.warn({ userId: ownerId, err: e instanceof Error ? e.message : String(e) }, 'automation: summary push failed'),
        );
      } catch (e) {
        // nothing was posted: give the claim back so the next tick tries again (a posted message keeps it)
        if (!written) await repos.automationSummaries.release(ownerId, day).catch(() => {});
        throw e;
      }
    } catch (e) {
      log?.warn({ userId: ownerId, err: e instanceof Error ? e.message : String(e) }, 'automation: daily summary failed');
    }
  }
  return sent;
}

/** The 5-minute timer of the summaries; returns its stop. */
export function startSummaryTimer(deps: SummaryDeps, opts: { tickMs?: number } = {}): () => void {
  const timer = setInterval(() => void sendDueSummaries(deps).catch(() => {}), opts.tickMs ?? SUMMARY_TICK_MS);
  timer.unref();
  return () => clearInterval(timer);
}
