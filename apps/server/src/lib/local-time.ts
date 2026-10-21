/** `zone` when Intl knows it, else UTC (a user's stored zone may be missing or stale). */
export function zoneOrUtc(zone: string | null): string {
  if (zone) {
    try {
      new Intl.DateTimeFormat('en-CA', { timeZone: zone });
      return zone;
    } catch {
      // unknown zone: UTC
    }
  }
  return 'UTC';
}

/** Minutes `zone` is ahead of UTC at the instant `at`. */
function offsetMinutes(zone: string, at: Date): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(at)
      .map((x) => [x.type, Number(x.value)]),
  );
  const asUtc = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!);
  return Math.round((asUtc - Math.floor(at.getTime() / 60_000) * 60_000) / 60_000);
}

/** Wall time (as a UTC timestamp of its fields) → the instant with the offset in force then (a DST change moves it). */
function wallToInstant(wall: number, zone: string): number {
  const at = wall - offsetMinutes(zone, new Date(wall)) * 60_000;
  return wall - offsetMinutes(zone, new Date(at)) * 60_000;
}

/**
 * The next instant after `now` at which the clock in `zone` reads `hhmm` ("HH:MM", 24 h): later today
 * when that time is still ahead, else tomorrow ("durante a noite" → "08:00" said at 22:00 is 08:00 of
 * the next day). Throws on a malformed `hhmm`; the caller validates it first.
 */
export function nextLocalTime(hhmm: string, zone: string, now: Date): Date {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  if (!m) throw new Error('bad local time');
  const [hour, minute] = [Number(m[1]), Number(m[2])];
  const local = new Date(now.getTime() + offsetMinutes(zone, now) * 60_000);
  for (let days = 0; days <= 2; days++) {
    const at = wallToInstant(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + days, hour, minute), zone);
    if (at > now.getTime()) return new Date(at);
  }
  throw new Error('unreachable');
}

/**
 * "YYYY-MM-DDTHH:MM" (or with a space) read on the clock of `zone` (TER-1100: "dia 23 às 9h", said
 * without an offset). Null when malformed or not a real date.
 */
export function localDateTime(text: string, zone: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ]([01]\d|2[0-3]):([0-5]\d)$/.exec(text);
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  const check = new Date(wall);
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  return new Date(wallToInstant(wall, zone));
}

/** "2026-10-21 18:00" on the clock of `zone`: how the server tells the concierge a time in the person's zone. */
export function formatLocal(at: Date, zone: string): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(at)
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}
