import { useEffect, useState } from 'react';
import { replyLabel } from '../../lib/chat-reply';
import type { ChatReplyRef } from '../../lib/types';

const UNAVAILABLE_MS = 3000;

/**
 * What a message answers, above its text (TER-447): the author (or the card's kind, TER-849) and the
 * excerpt saved when it was sent, so it reads the same whether or not the original is still around. A click asks the panel to
 * show the original; when it cannot (deleted, or outside the loaded messages) the quote says so for a
 * few seconds instead of doing nothing.
 */
export function ChatReplyQuote({ reply, onOpen }: { reply: ChatReplyRef; onOpen?: (id: string) => boolean }) {
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    if (!unavailable) return;
    const timer = window.setTimeout(() => setUnavailable(false), UNAVAILABLE_MS);
    return () => window.clearTimeout(timer);
  }, [unavailable]);
  const author = replyLabel(reply);
  // A card's quote (TER-849) opens the card; a message's, the message.
  const target = reply.card?.id ?? reply.id;
  return (
    <button
      type="button"
      aria-label={`${reply.card ? 'Ver card original' : 'Ver mensagem original'}: ${author}, ${reply.excerpt}`}
      onClick={() => {
        if (!(target !== null && onOpen?.(target))) setUnavailable(true);
      }}
      className="mb-1.5 block w-full rounded-lg border-l-2 border-accent bg-bg/60 px-2.5 py-1.5 text-left text-xs hover:bg-bg focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
    >
      <span className="block font-medium text-accent">{author}</span>
      <span className="line-clamp-2 whitespace-normal text-fg-dim">{reply.excerpt}</span>
      {unavailable && (
        <span role="status" className="mt-0.5 block text-fg-dim">
          {reply.card ? 'Card original indisponível' : 'Mensagem original indisponível'}
        </span>
      )}
    </button>
  );
}
