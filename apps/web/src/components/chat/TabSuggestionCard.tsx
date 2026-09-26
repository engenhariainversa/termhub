import { useState } from 'react';
import type { TabSuggestion } from '../../lib/types';
import { CONTEXT_PREVIEW_MAX, lastParagraph, suggestionStatusLabel, suggestionTitle } from './tab-suggestion-text';

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
 * Claude Code's dimmed next prompt in a tab, inline in the thread (spec 2026-09-25 tab suggestions §6.4), with
 * the agent's message it answers (spec 2026-09-26 §6.4): the text editable, Enviar / Dispensar. Presentational:
 * the requests live in `ChatPanel`. Plain text only.
 */
export function TabSuggestionCard({ suggestion, busy, error, onSend, onDismiss }: TabSuggestionCardProps) {
  const [text, setText] = useState(suggestion.payload.text);
  const open = suggestion.status === 'open';
  const trimmed = text.trim();
  const context = suggestion.payload.context?.trim() || null;
  return (
    <li className="rounded-xl border border-accent/40 bg-bg-2 px-4 py-3 text-sm">
      <p className="font-medium text-fg">{suggestionTitle(suggestion)}</p>
      {context && <SuggestionContext text={context} />}
      {open ? (
        <>
          <label className="mt-2 block text-xs text-fg-dim">
            Sugestão do Claude Code (opcional — edite ou dispense)
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

/** The agent's message, plain text in a quote: its last paragraph, the whole of it on demand. */
function SuggestionContext({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const short = lastParagraph(text, CONTEXT_PREVIEW_MAX);
  return (
    <blockquote className="mt-2 border-l-2 border-accent/40 pl-3 text-fg-dim">
      <p className="whitespace-pre-wrap">{expanded ? text : short}</p>
      {short !== text && (
        <button type="button" className="mt-1 text-xs text-accent hover:underline" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'Recolher' : 'Ver mensagem inteira'}
        </button>
      )}
    </blockquote>
  );
}
