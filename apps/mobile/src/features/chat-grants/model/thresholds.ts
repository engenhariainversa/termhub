// The automatic answer's similarity thresholds as "Permissões do chat" shows and edits them (TER-642).
import { formatNumber } from '@/i18n/format';
import { AUTO_THRESHOLD_MAX, AUTO_THRESHOLD_MIN } from '@/services/api/contract';

/** "0,95" / "0.95": a threshold with two decimals, in the reader's language. */
export const thresholdText = (value: number): string => formatNumber(value, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** What the person typed as a number in the accepted range, comma or dot; undefined when it is not one. */
export function parseThreshold(text: string): number | undefined {
  const clean = text.trim().replace(',', '.');
  if (!/^\d(\.\d{1,2})?$/.test(clean)) return undefined;
  const value = Number(clean);
  return value >= AUTO_THRESHOLD_MIN && value <= AUTO_THRESHOLD_MAX ? value : undefined;
}

/** Both fields as the body of the patch (`autoThresholdsBody`); undefined while either is not a
 * threshold or the suggestion one is above the sending one. */
export function parseThresholds(high: string, low: string): { high: number; low: number } | undefined {
  const h = parseThreshold(high);
  const l = parseThreshold(low);
  return h === undefined || l === undefined || l > h ? undefined : { high: h, low: l };
}
