// Dates and numbers in the language the app shows (i18n spec §2): no `'pt-BR'` literal is passed
// to `toLocale*` / `Intl` anywhere else. Hermes' `Intl` formats both languages.
import { currentLocale, type Locale } from './index';

type DateInput = string | number | Date;

/** The BCP 47 tag `Intl` gets for a locale. */
export function intlLocale(locale: Locale = currentLocale()): string {
  return locale === 'en' ? 'en-US' : 'pt-BR';
}

function toDate(value: DateInput): Date {
  return value instanceof Date ? value : new Date(value);
}

/** "04/10/2026" / "10/4/2026". */
export function formatDate(value: DateInput, options?: Intl.DateTimeFormatOptions): string {
  return toDate(value).toLocaleDateString(intlLocale(), options);
}

/** "14:05" / "2:05 PM" (two-digit hour and minute unless `options` say otherwise). */
export function formatTime(value: DateInput, options: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' }): string {
  return toDate(value).toLocaleTimeString(intlLocale(), options);
}

/** Date and time together. */
export function formatDateTime(value: DateInput, options?: Intl.DateTimeFormatOptions): string {
  return toDate(value).toLocaleString(intlLocale(), options);
}

/** An `Intl.DateTimeFormat` in the current language (for `formatToParts`, a time zone…). */
export function dateTimeFormat(options?: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(intlLocale(), options);
}

/** "1.234,5" / "1,234.5". */
export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return value.toLocaleString(intlLocale(), options);
}
