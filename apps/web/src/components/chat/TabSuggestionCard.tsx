import { useTranslation } from '../../i18n';
import { memo, useState } from 'react';
import type { TabSuggestion } from '../../lib/types';
import { CODEX_REPLY_PLACEHOLDER, CONTEXT_PREVIEW_MAX, isReplyCard, lastParagraph, suggestionFieldLabel, suggestionFieldMax, suggestionHint, suggestionStatusLabel, suggestionTitle } from './tab-suggestion-text';

export interface TabSuggestionCardProps {
  suggestion: TabSuggestion;
  /** This card's send or dismiss is in flight: every control is disabled. */
  busy: boolean;
  /** Why the last send or dismiss did not go through (the server's text, or the panel's own translated one). */
  error?: string | null;
  onSend: (text: string) => void;
  onDismiss: () => void;
}

/**
 * Claude Code's dimmed next prompt in a tab that finished its turn — an offer, not a question (spec 2026-09-26
 * TER-203 §5) —, inline in the thread, with the agent's message it answers (spec 2026-09-26 §6.4): the text
 * editable, Enviar / Dispensar. Presentational: the requests live in `ChatPanel`. Plain text only.
 */
export const TabSuggestionCard = memo(function TabSuggestionCard({ suggestion, busy, error, onSend, onDismiss }: TabSuggestionCardProps) {
  const { t } = useTranslation();
  const [text, setText] = useState(suggestion.payload.text);
  const open = suggestion.status === 'open';
  const trimmed = text.trim();
  const context = suggestion.payload.context?.trim() || null;
  // A Codex reply card holds no suggested text: it asks the person a question, so it takes an answer, not an edit.
  const codex = isReplyCard(suggestion);
  return (
    <li className="rounded-xl border border-line bg-bg-2 px-4 py-3 text-sm">
      <p className="font-medium text-fg">{suggestionTitle(suggestion)}</p>
      {open && <p className="text-xs text-fg-dim">{suggestionHint(suggestion)}</p>}
      {context && <SuggestionContext text={context} />}
      {open ? (
        <>
          {codex ? (
            <input type="text" aria-label={t(CODEX_REPLY_PLACEHOLDER)} placeholder={t(CODEX_REPLY_PLACEHOLDER)} className="input mt-2" maxLength={2000} value={text} disabled={busy} onChange={(e) => setText(e.target.value)} />
          ) : (
            <label className="mt-2 block text-xs text-fg-dim">
              {suggestionFieldLabel(suggestion)}
              <input type="text" className="input mt-1" maxLength={suggestionFieldMax(suggestion)} value={text} disabled={busy} onChange={(e) => setText(e.target.value)} />
            </label>
          )}
          <div className="mt-2 flex gap-2">
            <button type="button" className="btn-primary" disabled={busy || !trimmed} onClick={() => onSend(trimmed)}>
              {t('Enviar')}
            </button>
            <button type="button" className="btn-ghost" disabled={busy} onClick={onDismiss}>
              {t('Dispensar')}
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="mt-1 whitespace-pre-wrap text-fg">{suggestion.answer?.text ?? suggestion.payload.text}</p>
          <p className="mt-1 text-xs text-fg-dim">{suggestionStatusLabel(suggestion)}</p>
        </>
      )}
      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
    </li>
  );
});

/** The agent's message, plain text in a quote: its last paragraph, the whole of it on demand. */
function SuggestionContext({ text }: { text: string }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const short = lastParagraph(text, CONTEXT_PREVIEW_MAX);
  return (
    <blockquote className="mt-2 border-l-2 border-accent/40 pl-3 text-fg-dim">
      <p className="whitespace-pre-wrap">{expanded ? text : short}</p>
      {short !== text && (
        <button type="button" className="mt-1 text-xs text-accent hover:underline" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
          {expanded ? t('Recolher') : t('Ver mensagem inteira')}
        </button>
      )}
    </blockquote>
  );
}
