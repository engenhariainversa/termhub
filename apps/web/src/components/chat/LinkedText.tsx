import { useMemo } from 'react';
import { splitUrls } from '../../lib/links';

/**
 * Plain text with its http(s) URLs as links (TER-1089): the person's message and a quote's excerpt,
 * which are shown as typed and never parsed as Markdown. A link opens in a new tab, and its click stops
 * here, so a link inside a quote does not also scroll to the quoted message.
 */
export function LinkedText({ text }: { text: string }) {
  const pieces = useMemo(() => splitUrls(text), [text]);
  return (
    <>
      {pieces.map((p, i) =>
        p.url ? (
          <a key={i} href={p.url} target="_blank" rel="noopener noreferrer" className="text-accent underline underline-offset-2 [overflow-wrap:anywhere]" onClick={(e) => e.stopPropagation()}>
            {p.text}
          </a>
        ) : (
          p.text
        ),
      )}
    </>
  );
}
