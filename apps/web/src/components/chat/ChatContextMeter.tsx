import { useTranslation } from '../../i18n';
import { COMPACT_SHORTCUT, contextLevel, contextMax, contextShare, contextTitle, formatShare, formatTokens } from '../../lib/chat-context';

const BAR: Record<ReturnType<typeof contextLevel>, string> = { ok: 'bg-accent', warn: 'bg-warn', full: 'bg-danger' };
const TEXT: Record<ReturnType<typeof contextLevel>, string> = { ok: 'text-fg-dim', warn: 'text-warn', full: 'text-danger' };

/**
 * The chat header's context meter and its "Compactar" button (TER-315). Presentational: the panel
 * owns the numbers and the request. With no fill yet (a new conversation, an older server) only the
 * button is there; the numbers show from the first answer on. With the person's own `limit` (TER-1038)
 * it reads "150K / 200K" against that limit instead of the model's window, and warns on it.
 */
export function ChatContextMeter({
  tokens,
  window,
  limit = null,
  compactedAt = null,
  compacting,
  canCompact,
  onCompact,
}: {
  tokens: number | null;
  window: number | null;
  limit?: number | null;
  compactedAt?: string | null;
  compacting: boolean;
  canCompact: boolean;
  onCompact: () => void;
}) {
  const { t } = useTranslation();
  const max = contextMax(window, limit);
  const share = tokens === null ? null : contextShare(tokens, max);
  const level = contextLevel(share);
  return (
    <div className="flex min-w-0 items-center gap-1">
      {tokens !== null && (
        <div
          role="meter"
          aria-label={t('Contexto da conversa')}
          aria-valuemin={0}
          aria-valuemax={max ?? undefined}
          aria-valuenow={tokens}
          aria-valuetext={share === null ? t('{{tokens}} tokens', { tokens: formatTokens(tokens) }) : t('{{share}} do contexto', { share: formatShare(share) })}
          title={contextTitle(tokens, window, limit, compactedAt)}
          className={`flex min-w-0 items-center gap-1.5 px-1 text-xs ${TEXT[level]}`}
        >
          {share !== null && (
            <span className="h-1.5 w-12 shrink-0 overflow-hidden rounded-full bg-bg-3">
              <span className={`block h-full rounded-full ${BAR[level]}`} style={{ width: `${Math.max(share * 100, 2)}%` }} />
            </span>
          )}
          <span className="truncate font-mono">
            {formatTokens(tokens)}
            {max !== null && <span className="hidden sm:inline"> / {formatTokens(max)}</span>}
            {share !== null && ` · ${formatShare(share)}`}
          </span>
        </div>
      )}
      <button
        type="button"
        aria-keyshortcuts={COMPACT_SHORTCUT}
        title={t('Resume a conversa para liberar contexto ({{shortcut}} ou /compact)', { shortcut: COMPACT_SHORTCUT })}
        className={`rounded px-2 py-1 text-xs hover:bg-bg-3 hover:text-fg disabled:opacity-50 ${level === 'ok' ? 'text-fg-dim' : `${TEXT[level]} font-medium`} ${compacting ? 'animate-pulse' : ''}`}
        disabled={!canCompact}
        onClick={onCompact}
      >
        {compacting ? t('Compactando…') : t('Compactar')}
      </button>
    </div>
  );
}
