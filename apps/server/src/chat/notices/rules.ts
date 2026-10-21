/**
 * TER-1101: when a notice the concierge asked for (`notify`) leaves as a push. Pure: the dispatcher hands it
 * a conversation's ready notices, the person's rules and the pushes of the last hour, and gets back what to
 * send now, what to drop, or until when to wait.
 *
 * - Levels: `needs_you` (a question, an approval, an error that blocks) and `done` (what the person asked
 *   to follow happened) become pushes when the person keeps that level on; `fyi` never reaches here (it
 *   stays in the chat).
 * - Quiet hours, on the person's clock: nothing leaves inside them; what waited goes out as one push when
 *   they end.
 * - Grouping: after a push, the next `group_minutes` gather what comes into one push at the window's end.
 *   `needs_you` does not wait for the window: it leaves at once, with whatever was waiting.
 * - Cap: at most `NOTICE_LIMITS.perHour` pushes per conversation in any hour; past it, what comes waits for
 *   the hour to free a slot and leaves grouped.
 */

export const NOTICE_LEVELS = ['needs_you', 'done', 'fyi'] as const;
export type NoticeLevel = (typeof NOTICE_LEVELS)[number];
/** The levels that can become a push. */
export type PushLevel = Exclude<NoticeLevel, 'fyi'>;

export const NOTICE_LIMITS = {
  /** Pushes per conversation in any rolling hour. */
  perHour: 6,
  /** Notices waiting in a conversation; past this `notify` refuses (a runaway loop, not a person). */
  pendingPerConversation: 20,
  headlineMax: 120,
  groupMaxMinutes: 60,
  /** A notice whose answer never reported its end (the run died) is sent after this anyway. */
  readyAfterMs: 10 * 60_000,
  /** A notice nobody could send for this long is given up on: what it said is stale by then. */
  staleAfterMs: 24 * 3600_000,
  /** Sent and dropped notices are kept this long (the hourly cap reads the last hour), then purged. */
  keptMs: 7 * 24 * 3600_000,
} as const;

export interface NoticeSettings {
  needs_you: boolean;
  done: boolean;
  /** "HH:MM" on the person's clock; both set or both null. */
  quiet_start: string | null;
  quiet_end: string | null;
  /** 0 turns grouping off. */
  group_minutes: number;
}

export const DEFAULT_NOTICE_SETTINGS: NoticeSettings = { needs_you: true, done: true, quiet_start: null, quiet_end: null, group_minutes: 5 };

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** The stored JSON read leniently: anything missing or malformed falls back to the default. */
export function noticeSettingsOf(raw: unknown): NoticeSettings {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
  const start = typeof r.quiet_start === 'string' && HHMM.test(r.quiet_start) ? r.quiet_start : null;
  const end = typeof r.quiet_end === 'string' && HHMM.test(r.quiet_end) ? r.quiet_end : null;
  const group = typeof r.group_minutes === 'number' && Number.isInteger(r.group_minutes) ? Math.min(NOTICE_LIMITS.groupMaxMinutes, Math.max(0, r.group_minutes)) : DEFAULT_NOTICE_SETTINGS.group_minutes;
  return {
    needs_you: bool(r.needs_you, DEFAULT_NOTICE_SETTINGS.needs_you),
    done: bool(r.done, DEFAULT_NOTICE_SETTINGS.done),
    quiet_start: start && end ? start : null,
    quiet_end: start && end ? end : null,
    group_minutes: group,
  };
}

/** Minutes since midnight on the clock of `zone` at `at`. */
function localMinutes(at: Date, zone: string): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(at)
      .map((x) => [x.type, Number(x.value)]),
  );
  return p.hour! * 60 + p.minute!;
}

const minutesOf = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return h! * 60 + m!;
};

/**
 * When the quiet hours `at` falls in end (the first minute after them), or null when `at` is outside them.
 * The window may cross midnight (22:00–07:00); start == end means no window.
 */
export function quietUntil(s: Pick<NoticeSettings, 'quiet_start' | 'quiet_end'>, zone: string, at: Date): Date | null {
  if (!s.quiet_start || !s.quiet_end) return null;
  const start = minutesOf(s.quiet_start);
  const end = minutesOf(s.quiet_end);
  if (start === end) return null;
  const now = localMinutes(at, zone);
  const inside = start < end ? now >= start && now < end : now >= start || now < end;
  if (!inside) return null;
  // Minutes left until the clock reads `end`; seconds are dropped, so the end lands on its minute.
  const left = (end - now + 24 * 60) % (24 * 60);
  const base = Math.floor(at.getTime() / 60_000) * 60_000;
  return new Date(base + left * 60_000);
}

export interface PlannedNotice {
  id: string;
  level: PushLevel;
}

export type NoticePlan<T extends PlannedNotice> =
  | { kind: 'send'; notices: T[]; drop: T[] }
  | { kind: 'wait'; until: Date; reason: 'quiet' | 'grouped' | 'capped'; drop: T[] }
  | { kind: 'none'; drop: T[] };

/**
 * One conversation's ready notices against the person's rules. `sent` are the conversation's pushes of the
 * last hour (any order). A level the person turned off is dropped; the rest leave together or wait.
 */
export function planNotices<T extends PlannedNotice>(ready: T[], settings: NoticeSettings, zone: string, sent: Date[], now: Date): NoticePlan<T> {
  const drop = ready.filter((n) => !settings[n.level]);
  const keep = ready.filter((n) => settings[n.level]);
  if (keep.length === 0) return { kind: 'none', drop };
  const quiet = quietUntil(settings, zone, now);
  if (quiet) return { kind: 'wait', until: quiet, reason: 'quiet', drop };
  const hourAgo = now.getTime() - 3600_000;
  const recent = sent.map((d) => d.getTime()).filter((t) => t > hourAgo).sort((a, b) => a - b);
  if (recent.length >= NOTICE_LIMITS.perHour) return { kind: 'wait', until: new Date(recent[recent.length - NOTICE_LIMITS.perHour]! + 3600_000), reason: 'capped', drop };
  const last = recent[recent.length - 1];
  const urgent = keep.some((n) => n.level === 'needs_you');
  if (!urgent && last !== undefined && settings.group_minutes > 0) {
    const windowEnd = last + settings.group_minutes * 60_000;
    if (now.getTime() < windowEnd) return { kind: 'wait', until: new Date(windowEnd), reason: 'grouped', drop };
  }
  return { kind: 'send', notices: keep, drop };
}
