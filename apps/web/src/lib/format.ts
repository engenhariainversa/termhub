import { currentLocale, i18n } from '../i18n';

/**
 * Dates and numbers in the language on screen (spec 2026-10-04 i18n §2). Nothing in the web passes a
 * locale literal to `toLocale*` or `Intl`: it goes through these, so English shows English dates.
 */
type DateInput = string | number | Date;

const toDate = (v: DateInput) => (v instanceof Date ? v : new Date(v));

/** "04/10/2026" / "10/4/2026"; `options` as in `toLocaleDateString` (e.g. `{ day: 'numeric', month: 'long', year: 'numeric' }`). */
export function formatDate(value: DateInput, options?: Intl.DateTimeFormatOptions): string {
  return toDate(value).toLocaleDateString(currentLocale(), options);
}

/** Date and time, as `toLocaleString`. */
export function formatDateTime(value: DateInput, options?: Intl.DateTimeFormatOptions): string {
  return toDate(value).toLocaleString(currentLocale(), options);
}

/** "14:05" / "02:05 PM": hours and minutes unless `options` says otherwise. */
export function formatTime(value: DateInput, options: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' }): string {
  return toDate(value).toLocaleTimeString(currentLocale(), options);
}

/** A number with the language's separators ("25,3" / "25.3"). */
export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return value.toLocaleString(currentLocale(), options);
}

/** An `Intl.DateTimeFormat` in the language on screen, for code that needs `formatToParts`. */
export function dateTimeFormat(options?: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(currentLocale(), options);
}

/** "agora" / "há N min" / "há N h" / "há N d", relative to `now` (defaults to `Date.now()`). */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  const diffMs = Math.max(0, now - then);
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return i18n.t('agora');
  if (diffMin < 60) return i18n.t('há {{n}} min', { n: diffMin });
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return i18n.t('há {{n}} h', { n: diffH });
  const diffD = Math.floor(diffH / 24);
  return i18n.t('há {{n}} d', { n: diffD });
}
