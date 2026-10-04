import { Pressable, Text, View } from 'react-native';
import { Icon, type IconName } from '@/ui';
import type { ReplyCardKind } from '@/services/api/contract';
import type { ReplyRef } from '../model/reply';

const CANCEL_ICON: IconName = { ios: 'xmark', android: 'close' };
const CARD_HEADING: Record<ReplyCardKind, string> = { action: 'Respondendo à confirmação', tab_question: 'Respondendo à pergunta da aba' };

/** The message (TER-447) or card (TER-849) the next send answers, on top of the composer's pill: who or what, the excerpt, and ✕. */
export function ReplyPreview({ reply, onCancel }: { reply: ReplyRef; onCancel?(): void }) {
  return (
    <View testID="reply-preview" className="mx-1 mb-2 mt-1 flex-row items-center gap-2 rounded-2xl bg-app-surface px-3 py-2">
      <View className="w-0.5 self-stretch rounded-full bg-app-accent" />
      <View className="flex-1">
        <Text className="text-xs font-semibold text-app-accent">{reply.card ? CARD_HEADING[reply.card] : reply.role === 'assistant' ? 'Respondendo a Concierge' : 'Respondendo a você'}</Text>
        <Text className="text-sm text-app-muted" numberOfLines={1}>
          {reply.excerpt}
        </Text>
      </View>
      <Pressable accessibilityRole="button" accessibilityLabel="Cancelar resposta" onPress={onCancel} hitSlop={8} className="h-7 w-7 items-center justify-center rounded-full">
        <Icon name={CANCEL_ICON} size={14} tone="muted" />
      </Pressable>
    </View>
  );
}
