/**
 * How full a chat's CLI session is (TER-315): what the header meter shows and what "Compactar" says
 * when it ends. Numbers come from the server (`context_tokens`/`context_window` on the conversation,
 * the `context` and `compact` events); nothing here estimates tokens.
 */

/** From this share of the window on, the meter is highlighted and suggests compacting. */
export const CONTEXT_WARN_AT = 0.8;
import { formatNumber } from './format';
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

/** The meter's tooltip: the exact numbers, and what to do once it is high. */
export function contextTitle(tokens: number, window: number | null): string {
  const exact = (v: number) => formatNumber(v);
  const share = contextShare(tokens, window);
  const base =
    window === null
      ? i18n.t('Contexto da conversa: {{tokens}} tokens', { tokens: exact(tokens) })
      : i18n.t('Contexto da conversa: {{tokens}} de {{window}} tokens ({{share}})', { tokens: exact(tokens), window: exact(window), share: formatShare(share!) });
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
