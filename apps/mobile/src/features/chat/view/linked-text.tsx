import { useMemo } from 'react';
import { Text } from 'react-native';
import { splitUrls } from '../model/links';
import { openWebLink, shareLink } from './chat-links';

/**
 * Plain text with its http(s) URLs as links (TER-1089), for the person's message and a quote's excerpt,
 * which are shown as typed. Nested in the caller's `Text`, so it keeps its style and line limit: a tap
 * opens the system's browser, a long press shares the URL (and so copies it). Inside a quote the link's
 * own press wins over the quote's.
 */
export function LinkedText({ text }: { text: string }) {
  const pieces = useMemo(() => splitUrls(text), [text]);
  return (
    <>
      {pieces.map((p, i) =>
        p.url ? (
          <Text key={i} accessibilityRole="link" className="underline" onPress={() => openWebLink(p.url)} onLongPress={() => shareLink(p.url)}>
            {p.text}
          </Text>
        ) : (
          p.text
        ),
      )}
    </>
  );
}
