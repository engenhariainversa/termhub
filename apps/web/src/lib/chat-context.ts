/**
 * How full a chat's CLI session is (TER-315): what the header meter shows and what "Compactar" says
 * when it ends. Numbers come from the server (`context_tokens`/`context_window` on the conversation,
 * the `context` and `compact` events); nothing here estimates tokens.
 */

/** From this share of the window on, the meter is highlighted and suggests compacting. */
export const CONTEXT_WARN_AT = 0.8;
import { formatDateTime, formatNumber } from './format';
import { i18n } from '../i18n';
/** From this share on, the next turns may hit the window: the meter turns red. */
export const CONTEXT_FULL_AT = 0.95;

export type ContextLevel = 'ok' | 'warn' | 'full';

/** The share of the window in use (0–1, never above 1), or null when the window is unknown. */
export function contextShare(tokens: number, window: number | null): number | null {
  if (window === null || window <= 0) return null;
  return Math.min(1, Math.max(0, tokens / window));
}

export function contextLevel(share: number | null): ContextLevel {
  if (share === null) return 'ok';
  if (share >= CONTEXT_FULL_AT) return 'full';
  if (share >= CONTEXT_WARN_AT) return 'warn';
  return 'ok';
}

/**
 * 950 → "950", 25 258 → "25 mil" / "25K", 1 000 000 → "1 mi" / "1M": short enough for the dock's
 * header, in the language on screen (Intl compact notation, with a plain space instead of its NBSP).
 */
export function formatTokens(n: number): string {
  if (n < 1_000) return String(Math.round(n));
  return formatNumber(n, { notation: 'compact' }).replace(/\u00a0/g, ' ');
}

/** 0.034 → "3%", 0.004 → "<1%" (a fresh session is never "0%" of a million-token window). */
export function formatShare(share: number): string {
  const pct = Math.round(share * 100);
  return pct === 0 && share > 0 ? '<1%' : `${pct}%`;
}

/** What the meter measures against (TER-1038): the person's own limit when they set one (someone who
 *  compacts at 200k on a 1M window), else the model's window. */
export function contextMax(window: number | null, limit: number | null | undefined): number | null {
  return limit != null && limit > 0 ? limit : window;
}

/** The meter's tooltip: the exact numbers, the last compaction, and what to do once it is high. */
export function contextTitle(tokens: number, window: number | null, limit: number | null = null, compactedAt: string | null = null): string {
  const exact = (v: number) => formatNumber(v);
  const max = contextMax(window, limit);
  const share = contextShare(tokens, max);
  let base =
    max === null
      ? i18n.t('Contexto da conversa: {{tokens}} tokens', { tokens: exact(tokens) })
      : max === limit
        ? i18n.t('Contexto da conversa: {{tokens}} de {{limit}} tokens ({{share}}), o seu limite', { tokens: exact(tokens), limit: exact(max), share: formatShare(share!) })
        : i18n.t('Contexto da conversa: {{tokens}} de {{window}} tokens ({{share}})', { tokens: exact(tokens), window: exact(max), share: formatShare(share!) });
  if (max === limit && window !== null) base = i18n.t('{{base}}; janela do modelo: {{window}}', { base, window: exact(window) });
  if (compactedAt) base = i18n.t('{{base}}. Última compactação: {{when}}', { base, when: formatDateTime(compactedAt, { dateStyle: 'short', timeStyle: 'short' }) });
  return contextLevel(share) === 'ok' ? base : i18n.t('{{base}}. Compacte a conversa para liberar espaço.', { base });
}

/** What the status line says once "Compactar" finished. */
export function compactDoneText(before: number | null, after: number | null): string {
  if (before !== null && after !== null) return i18n.t('Conversa compactada: {{before}} → {{after}} tokens', { before: formatTokens(before), after: formatTokens(after) });
  return i18n.t('Conversa compactada');
}

/** Why "Compactar" failed, by the code the server sent. */
export function compactFailedText(code: string | null): string {
  switch (code) {
    case 'MISSING_SESSION':
      return i18n.t('A sessão desta conversa não existe mais na máquina: não há o que compactar');
    case 'HOST_GONE':
      return i18n.t('A máquina do chat saiu do ar durante a compactação');
    case 'CLI_MISSING':
      return i18n.t('A máquina do chat não tem o Claude Code instalado');
    default:
      return i18n.t('Não foi possível compactar a conversa');
  }
}

/** The shortcut, as `aria-keyshortcuts` and the tooltip spell it. */
export const COMPACT_SHORTCUT = 'Alt+Shift+C';

/**
 * Whether this keystroke is "Compactar": Alt+Shift+C, read from the physical key (`code`), since on a
 * Mac Option+Shift+C types "Ç" and `key` never says "C". No browser reserves it, and neither does the
 * terminal (its own shortcuts are ⌘ and Ctrl+Shift ones).
 */
export function isCompactShortcut(e: Pick<KeyboardEvent, 'code' | 'altKey' | 'shiftKey' | 'ctrlKey' | 'metaKey'>): boolean {
  return e.code === 'KeyC' && e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey;
}

/** Typing `/compact` in the box, like in Claude Code itself, compacts instead of sending the text. */
export function isCompactCommand(text: string): boolean {
  return text.trim() === '/compact';
}

/** Bounds of the person's own context limit, in tokens (TER-1038): the server refuses anything else
 *  (`chatContextLimit` in @termhub/mobile-api). The field takes thousands: "200" is 200 000 tokens. */
export const CONTEXT_LIMIT_MIN = 10_000;
export const CONTEXT_LIMIT_MAX = 10_000_000;

/** The limit field's text → tokens: empty is `null` (back to the model's window), a whole number of
 *  thousands inside the bounds is its token count, and anything else is `undefined` (refused). */
export function parseContextLimit(text: string): number | null | undefined {
  const v = text.trim();
  if (v === '') return null;
  if (!/^\d{1,5}$/.test(v)) return undefined;
  const tokens = Number(v) * 1_000;
  return tokens >= CONTEXT_LIMIT_MIN && tokens <= CONTEXT_LIMIT_MAX ? tokens : undefined;
}
