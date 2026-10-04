import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { replyLabel } from '../model/reply';
import type { ChatMessage } from '../model/types';

const UNAVAILABLE_MS = 3000;

/**
 * What a message answers, above its text in the person's bubble (TER-447): the author and the excerpt
 * saved when it was sent, so it reads the same with or without the original. A tap asks the screen to
 * show the original; when it cannot (deleted, or not among the loaded messages) the quote says so for
 * a few seconds.
 */
export function ReplyQuote({ reply, onOpen }: { reply: NonNullable<ChatMessage['reply_to']>; onOpen?(id: string): boolean }) {
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    if (!unavailable) return;
    const timer = setTimeout(() => setUnavailable(false), UNAVAILABLE_MS);
    return () => clearTimeout(timer);
  }, [unavailable]);
  const author = replyLabel(reply);
  // A card's quote (TER-849) opens the card; a message's, the message.
  const target = reply.card?.id ?? reply.id;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${reply.card ? 'Ver card original' : 'Ver mensagem original'}: ${author}, ${reply.excerpt}`}
      onPress={() => {
        if (!(target !== null && onOpen?.(target))) setUnavailable(true);
      }}
      className="mb-1.5 flex-row gap-2 rounded-xl bg-black/15 px-2.5 py-1.5"
    >
      <View className="w-0.5 self-stretch rounded-full bg-white/70" />
      <View className="shrink">
        <Text className="text-xs font-semibold text-white">{author}</Text>
        <Text className="text-sm text-white/80" numberOfLines={2}>
          {reply.excerpt}
        </Text>
        {unavailable ? <Text className="pt-0.5 text-xs text-white/80">{reply.card ? 'Card original indisponível' : 'Mensagem original indisponível'}</Text> : null}
      </View>
    </Pressable>
  );
}
