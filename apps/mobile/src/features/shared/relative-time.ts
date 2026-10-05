import { t } from '@/i18n';
import { formatDate } from '@/i18n/format';

/**
 * The notifications and chat relative timestamp: "agora" under a minute, "há N min" under an
 * hour, "há N h" under a day, "ontem" for the previous day, and the day and month for anything
 * older ("DD/MM" in pt-BR), in the language the app shows.
 */
export function relativeTime(iso: string, now: number): string {
  const at = new Date(iso);
  const minutes = Math.floor((now - at.getTime()) / 60_000);
  if (minutes < 1) return t('agora');
  if (minutes < 60) return t('há {{n}} min', { n: minutes });

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('há {{n}} h', { n: hours });

  const days = Math.floor(hours / 24);
  if (days === 1) return t('ontem');

  return formatDate(at, { day: '2-digit', month: '2-digit' });
}
