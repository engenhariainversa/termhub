import { memo } from 'react';
import { Text, View } from 'react-native';
import Markdown from 'react-native-markdown-display';
import type { SchemeName } from '@/theme/tokens';
import { AppText, useSchemeName } from '@/ui';
import { failureSentence } from '../model/copy';
import { splitSettled } from '../model/markdown-split';
import type { ChatMessage } from '../model/types';
import { markdownStyle } from './markdown-style';

type Props = {
  message: ChatMessage;
  /** The text streamed so far for this row (`live.deltas`). */
  streamed: string | undefined;
  /** Whether this row's run showed any sign of life (`live.started`). */
  started: boolean;
};

/** The part of a streaming answer that no later delta can change: parsed once per distinct text. */
const SettledMarkdown = memo(function SettledMarkdown({ text, scheme }: { text: string; scheme: SchemeName }) {
  return <Markdown style={markdownStyle(scheme)}>{text}</Markdown>;
});

/** One row of the thread: the person's text as typed, the assistant's rendered as markdown — its
 * final text, or the deltas streamed so far, or "pensando…" while its run shows signs of life. An
 * empty row that never started reads as the failure it is, same as the web. Memoised on its own
 * row's props: a delta re-renders only the bubble it streams into, and inside it only the tail after
 * the last blank line is re-parsed (`splitSettled`); the settled prefix keeps its parsed tree. When
 * the final text lands the whole body renders once — the same markdown, so nothing reflows. */
export const MessageBubble = memo(function MessageBubble({ message, streamed, started }: Props) {
  const scheme = useSchemeName();

  if (message.role === 'user') {
    return (
      <View className="max-w-[85%] self-end rounded-2xl bg-app-accent px-4 py-2.5">
        <Text className="text-base text-white">{message.text}</Text>
      </View>
    );
  }

  const streaming = !message.text && !!streamed;
  const body = message.text || streamed || '';
  const { settled, tail } = streaming ? splitSettled(body) : { settled: '', tail: body };
  return (
    <View className="max-w-[92%] gap-1 self-start rounded-2xl bg-app-surface px-4 py-2.5">
      {settled ? <SettledMarkdown text={settled} scheme={scheme} /> : null}
      {tail ? <Markdown style={markdownStyle(scheme)}>{tail}</Markdown> : null}
      {message.error_code !== null ? (
        <Text className="text-sm text-app-danger">{failureSentence(message.error_code)}</Text>
      ) : !body && started ? (
        <AppText variant="muted">pensando…</AppText>
      ) : !body ? (
        <Text className="text-sm text-app-danger">{failureSentence(null)}</Text>
      ) : null}
    </View>
  );
});
