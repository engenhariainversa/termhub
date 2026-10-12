// The header's context meter (TER-315 on the web, TER-1038 here): the same thresholds as
// apps/web/src/lib/chat-context.ts — keep the two in step. Numbers come from the server; nothing here
// estimates tokens.
import { CHAT_CONTEXT_LIMIT_MAX, CHAT_CONTEXT_LIMIT_MIN } from '@termhub/mobile-api';
import { t } from '@/i18n';
import { formatDateTime, formatNumber } from '@/i18n/format';
import type { ChatConversation } from './types';

/** From this share of the limit on, the meter turns amber and suggests compacting. */
export const CONTEXT_WARN_AT = 0.8;
/** From this share on, the next turns may hit the window: the meter turns red. */
export const CONTEXT_FULL_AT = 0.95;

export type ContextLevel = 'ok' | 'warn' | 'full';

export interface ContextMeter {
  tokens: number;
  /** What it is measured against: the person's own limit, else the model's window; null when neither is known. */
  max: number | null;
  /** True when `max` is the person's limit. */
  ownLimit: boolean;
  window: number | null;
  /** 0–1, never above 1; null without `max`. */
  share: number | null;
  level: ContextLevel;
  compactedAt: string | null;
}

/** The meter for a conversation, or null before its first answer reported a fill. */
export function contextMeter(conversation: ChatConversation | null | undefined, limit: number | null | undefined): ContextMeter | null {
  const tokens = conversation?.context_tokens;
  if (typeof tokens !== 'number') return null;
  const window = conversation?.context_window ?? null;
  const ownLimit = limit != null && limit > 0;
  const max = ownLimit ? limit : window;
  const share = max !== null && max > 0 ? Math.min(1, Math.max(0, tokens / max)) : null;
  const level: ContextLevel = share === null ? 'ok' : share >= CONTEXT_FULL_AT ? 'full' : share >= CONTEXT_WARN_AT ? 'warn' : 'ok';
  return { tokens, max, ownLimit, window, share, level, compactedAt: conversation?.context_compacted_at ?? null };
}

/** 950 → "950", 150 000 → "150k", 1 000 000 → "1M": the status line's units, short enough for a header. */
export function shortTokens(n: number): string {
  if (n < 1_000) return String(Math.round(n));
  if (n < 1_000_000) return `${Math.round(n / 1_000)}k`;
  const m = Math.round(n / 100_000) / 10;
  return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
}

/** "ctx 150k/200k" (or "ctx 150k" without a limit or window), as Claude Code's status line says it. */
export function contextLabel(m: ContextMeter): string {
  return m.max === null ? `ctx ${shortTokens(m.tokens)}` : `ctx ${shortTokens(m.tokens)}/${shortTokens(m.max)}`;
}

/** The sheet's lines: exact numbers, the window when a limit is in use, the last compaction, and what to do when high. */
export function contextDetails(m: ContextMeter): string[] {
  const exact = (v: number) => formatNumber(v);
  const pct = m.share === null ? null : `${Math.round(m.share * 100)}%`;
  const lines = [
    m.max === null
      ? t('Contexto da conversa: {{tokens}} tokens', { tokens: exact(m.tokens) })
      : m.ownLimit
        ? t('Contexto da conversa: {{tokens}} de {{limit}} tokens ({{share}}), o seu limite', { tokens: exact(m.tokens), limit: exact(m.max), share: pct })
        : t('Contexto da conversa: {{tokens}} de {{window}} tokens ({{share}})', { tokens: exact(m.tokens), window: exact(m.max), share: pct }),
  ];
  if (m.ownLimit && m.window !== null) lines.push(t('Janela do modelo: {{window}} tokens', { window: exact(m.window) }));
  lines.push(m.compactedAt ? t('Última compactação: {{when}}', { when: formatDateTime(m.compactedAt, { dateStyle: 'short', timeStyle: 'short' }) }) : t('Esta conversa ainda não foi compactada.'));
  if (m.level !== 'ok') lines.push(t('Está perto do limite: compacte a conversa no chat do termhub na web (botão Compactar ou /compact).'));
  return lines;
}

/** The limit field's text → tokens: empty is `null` (back to the model's window), a whole number of
 *  thousands inside the server's bounds (`chatContextLimit` in @termhub/mobile-api) is its token count,
 *  and anything else is `undefined` (refused). "200" is 200 000 tokens. */
export function parseContextLimit(text: string): number | null | undefined {
  const v = text.trim();
  if (v === '') return null;
  if (!/^\d{1,5}$/.test(v)) return undefined;
  const tokens = Number(v) * 1_000;
  return tokens >= CHAT_CONTEXT_LIMIT_MIN && tokens <= CHAT_CONTEXT_LIMIT_MAX ? tokens : undefined;
}
