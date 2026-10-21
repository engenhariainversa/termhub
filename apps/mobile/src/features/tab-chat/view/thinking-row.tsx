import { ActivityIndicator, View } from 'react-native';
import { AppText } from '@/ui';

/** The "pensando…" line under the last row while the agent works (TER-1102): a spinner and what it does. */
export function ThinkingRow({ text }: { text: string }) {
  return (
    <View testID="session-thinking" accessibilityLiveRegion="polite" className="flex-row items-center gap-2 self-start py-1">
      <ActivityIndicator size="small" />
      <AppText variant="muted" className="shrink text-sm" numberOfLines={1}>
        {text}
      </AppText>
    </View>
  );
}
