import type { ReactNode } from 'react';
import { View } from 'react-native';
import { AppText } from './text';

export function EmptyState({ title, hint, action }: { title: string; hint: string; action?: ReactNode }) {
  return (
    <View className="flex-1 items-center justify-center gap-2 px-6">
      <AppText variant="title" className="text-center">
        {title}
      </AppText>
      <AppText variant="muted" className="text-center">
        {hint}
      </AppText>
      {action ? <View className="mt-4 self-stretch">{action}</View> : null}
    </View>
  );
}
