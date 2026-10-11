import { Pressable, View } from 'react-native';
import { useTranslation } from '@/i18n';
import type { TTabSummary } from '@/services/api/contract';
import { AppText } from '@/ui';
import { availabilityText } from '../model/availability-text';
import { stateLine } from '../model/state-line';
import { StatusDot } from './status-dot';

/** One tab of the Sessões list: its status dot (status-dot.tsx), name, machine and its state line — or, for a tab that cannot be read
 * as a conversation, why (it still opens: the screen offers "Ver tela"). */
export function SessionRow({ tab, onPress, onScreen = true }: { tab: TTabSummary; onPress(): void; onScreen?: boolean }) {
  const { t } = useTranslation();
  const why = availabilityText(tab.availability);
  const line = why ?? stateLine(tab);
  // "Trabalhando · Bash (automático, TER-123)": the automatic run's card, for whoever hears the row (TER-1044)
  const heard = tab.auto_ref ? t('{{state}} (automático, {{ref}})', { state: line, ref: tab.auto_ref }) : line;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`${tab.name}, ${tab.machine.name}, ${heard}`} onPress={onPress} className="flex-row items-center gap-3 border-b border-app-border px-6 py-4">
      <StatusDot tab={tab} onScreen={onScreen} />
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
