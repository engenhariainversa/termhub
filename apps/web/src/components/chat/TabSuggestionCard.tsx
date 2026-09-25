import { useState } from 'react';
import type { TabSuggestion } from '../../lib/types';
import { suggestionStatusLabel, suggestionTitle } from './tab-suggestion-text';

export interface TabSuggestionCardProps {
  suggestion: TabSuggestion;
  /** This card's send or dismiss is in flight: every control is disabled. */
  busy: boolean;
  /** Why the last send or dismiss did not go through (pt-BR). */
  error?: string | null;
  onSend: (text: string) => void;
  onDismiss: () => void;
}

/**
 * Claude Code's dimmed next prompt in a tab, inline in the thread (spec 2026-09-25 tab suggestions §6.4):
 * the text editable, Enviar / Dispensar. Presentational: the requests live in `ChatPanel`. Plain text only.
 */
export function TabSuggestionCard({ suggestion, busy, error, onSend, onDismiss }: TabSuggestionCardProps) {
  const [text, setText] = useState(suggestion.payload.text);
  const open = suggestion.status === 'open';
  const trimmed = text.trim();
  return (
    <li className="rounded-xl border border-accent/40 bg-bg-2 px-4 py-3 text-sm">
      <p className="font-medium text-fg">{suggestionTitle(suggestion)}</p>
      {open ? (
        <>
          <label className="mt-2 block text-xs text-fg-dim">
            Texto da sugestão
            <input type="text" className="input mt-1" maxLength={2000} value={text} disabled={busy} onChange={(e) => setText(e.target.value)} />
          </label>
          <div className="mt-2 flex gap-2">
            <button type="button" className="btn-primary" disabled={busy || !trimmed} onClick={() => onSend(trimmed)}>
              Enviar
            </button>
            <button type="button" className="btn-ghost" disabled={busy} onClick={onDismiss}>
              Dispensar
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
}
