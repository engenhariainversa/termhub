import { Pressable, View } from 'react-native';
import type { TTabSummary } from '@/services/api/contract';
import { AppText } from '@/ui';
import { availabilityText } from '../model/availability-text';
import { stateLine } from '../model/state-line';

/** The dot's colour: the accent while it works, the danger tone when it needs the person or failed. */
function dotClass(tab: TTabSummary): string {
  if (tab.availability !== 'ready') return 'bg-app-muted';
  if (tab.needs_you || tab.state === 'error') return 'bg-app-danger';
  if (tab.state === 'working') return 'bg-app-accent';
  return 'bg-app-border';
}

/** One tab of the Sessões list: name, machine and its state line — or, for a tab that cannot be read
 * as a conversation, why (it still opens: the screen offers "Ver tela"). */
export function SessionRow({ tab, onPress }: { tab: TTabSummary; onPress(): void }) {
  const why = availabilityText(tab.availability);
  const line = why ?? stateLine(tab);
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`${tab.name}, ${tab.machine.name}, ${line}`} onPress={onPress} className="flex-row items-center gap-3 border-b border-app-border px-6 py-4">
      <View className={`h-2.5 w-2.5 rounded-full ${dotClass(tab)}`} />
      <View className="flex-1 gap-0.5">
        <View className="flex-row items-center gap-2">
          <AppText className="shrink font-semibold" numberOfLines={1}>
            {tab.name}
          </AppText>
          <AppText variant="muted">{tab.machine.name}</AppText>
        </View>
        <AppText variant="muted" className={tab.needs_you && !why ? 'text-app-danger' : ''} numberOfLines={1}>
          {line}
        </AppText>
      </View>
    </Pressable>
  );
}
