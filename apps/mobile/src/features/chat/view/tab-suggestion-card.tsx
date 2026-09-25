import { memo, useState } from 'react';
import { TextInput, View } from 'react-native';
import { AppText, Button } from '@/ui';
import { suggestionStatusLabel, suggestionTitle } from '../model/tab-suggestion-text';
import type { TabSuggestion } from '../model/types';

type Props = {
  suggestion: TabSuggestion;
  /** A send or dismiss (this card's or another's) is in flight. */
  busy: boolean;
  onSend(suggestionId: string, text: string): void;
  onDismiss(suggestionId: string): void;
};

const INPUT = 'rounded-xl border border-app-border bg-app-surface px-4 py-3 text-base text-app-text placeholder:text-app-muted';

/** Claude Code's dimmed next prompt in a tab (spec 2026-09-25 tab suggestions §6.4), the web card's twin:
 * the text editable, Enviar / Dispensar — no PIN. Memoised: `onSend` and `onDismiss` are stable. */
export const TabSuggestionCard = memo(function TabSuggestionCard({ suggestion, busy, onSend, onDismiss }: Props) {
  const [text, setText] = useState(suggestion.payload.text);
  const open = suggestion.status === 'open';
  const trimmed = text.trim();
  return (
    // The testID tells this card's "Enviar" from the composer's, both on screen at once.
    <View testID={`tab-suggestion-${suggestion.id}`} className="gap-3 rounded-2xl border border-app-accent bg-app-surface2 p-4">
      <AppText variant="label">{suggestionTitle(suggestion)}</AppText>
      {open ? (
        <View className="gap-2">
          <TextInput accessibilityLabel="Texto da sugestão" value={text} maxLength={2000} editable={!busy} onChangeText={setText} className={INPUT} />
          <View className="flex-row gap-2">
            <View className="flex-1">
              <Button label="Enviar" onPress={() => onSend(suggestion.id, trimmed)} disabled={busy || !trimmed} />
            </View>
            <View className="flex-1">
              <Button label="Dispensar" variant="secondary" onPress={() => onDismiss(suggestion.id)} disabled={busy} />
            </View>
          </View>
        </View>
      ) : (
        <View className="gap-1">
          <AppText>{suggestion.answer?.text ?? suggestion.payload.text}</AppText>
          <AppText variant="muted">{suggestionStatusLabel(suggestion)}</AppText>
        </View>
      )}
    </View>
  );
});
