import { useEffect, useRef, useState } from 'react';
import { i18n, useTranslation } from '../../i18n';
import { COMPACT_SHORTCUT, contextLevel, contextMax, contextShare, contextTitle, formatShare, formatTokens } from '../../lib/chat-context';
import { formatDateTime, formatTime } from '../../lib/format';

const RING: Record<ReturnType<typeof contextLevel>, string> = { ok: 'stroke-fg-dim', warn: 'stroke-warn', full: 'stroke-danger' };
const TEXT: Record<ReturnType<typeof contextLevel>, string> = { ok: 'text-fg-dim', warn: 'text-warn', full: 'text-danger' };

const R = 6;
const CIRCUMFERENCE = 2 * Math.PI * R;

/** "às 14:05" today, "em 28/10 14:05" on an earlier day: the popover only needs the hour for today. */
function compactedText(iso: string, now: Date): string {
  const at = new Date(iso);
  return at.toDateString() === now.toDateString()
    ? i18n.t('compactado às {{time}}', { time: formatTime(at) })
    : i18n.t('compactado em {{when}}', { when: formatDateTime(at, { dateStyle: 'short', timeStyle: 'short' }) });
}

/**
 * The context at a glance in the chat header, left of the cog (TER-1151): a small ring and the share,
 * measured like the dialog's meter and the phone's (`contextMax`: the person's limit first, else the
 * model's window). A click opens the exact numbers, the last compaction and "Compactar". Nothing shows
 * before the first answer (a new conversation has no fill yet).
 */
export function ChatContextBadge({
  tokens,
  window,
  limit = null,
  compactedAt = null,
  compacting,
  canCompact,
  onCompact,
  now = new Date(),
}: {
  tokens: number | null;
  window: number | null;
  limit?: number | null;
  compactedAt?: string | null;
  compacting: boolean;
  canCompact: boolean;
  onCompact: () => void;
  now?: Date;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  if (tokens === null) return null;
  const max = contextMax(window, limit);
  const share = contextShare(tokens, max);
  const level = contextLevel(share);
  const label = share === null ? formatTokens(tokens) : formatShare(share);
  const amount =
    max === null
      ? t('{{tokens}} tokens', { tokens: formatTokens(tokens) })
      : max === limit
        ? t('{{tokens}} de {{max}} tokens (o seu limite)', { tokens: formatTokens(tokens), max: formatTokens(max) })
        : t('{{tokens}} de {{max}} tokens', { tokens: formatTokens(tokens), max: formatTokens(max) });
  const detail = compactedAt ? `${amount} · ${compactedText(compactedAt, now)}` : amount;

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        role="meter"
        aria-label={t('Contexto da conversa')}
        aria-valuemin={0}
        aria-valuemax={max ?? undefined}
        aria-valuenow={tokens}
        aria-valuetext={share === null ? t('{{tokens}} tokens', { tokens: formatTokens(tokens) }) : t('{{share}} do contexto', { share: formatShare(share) })}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={contextTitle(tokens, window, limit, compactedAt)}
        className={`flex items-center gap-1 rounded px-1.5 py-1 font-mono text-xs hover:bg-bg-3 ${TEXT[level]}`}
        onClick={() => setOpen((v) => !v)}
      >
        {share !== null && (
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden className="-rotate-90">
            <circle cx="8" cy="8" r={R} fill="none" strokeWidth="2" className="stroke-bg-3" />
            <circle
              cx="8"
              cy="8"
              r={R}
              fill="none"
              strokeWidth="2"
              strokeLinecap="round"
              className={RING[level]}
              strokeDasharray={CIRCUMFERENCE}
              strokeDashoffset={CIRCUMFERENCE * (1 - Math.max(share, 0.02))}
            />
          </svg>
        )}
        {label}
      </button>
      {open && (
        <div role="dialog" aria-label={t('Contexto da conversa')} className="absolute right-0 top-full z-50 mt-1 w-64 rounded border border-line bg-bg-2 p-3 text-xs shadow-lg">
          <p className="text-fg">{detail}</p>
          <button
            type="button"
            aria-keyshortcuts={COMPACT_SHORTCUT}
            title={t('Resume a conversa para liberar contexto ({{shortcut}} ou /compact)', { shortcut: COMPACT_SHORTCUT })}
            className={`mt-2 rounded border border-line px-2 py-1 hover:bg-bg-3 hover:text-fg disabled:opacity-50 ${level === 'ok' ? 'text-fg-dim' : `${TEXT[level]} font-medium`} ${compacting ? 'animate-pulse' : ''}`}
            disabled={!canCompact}
            onClick={() => {
              setOpen(false);
              onCompact();
            }}
          >
            {compacting ? t('Compactando…') : t('Compactar')}
          </button>
        </div>
      )}
    </div>
  );
}
