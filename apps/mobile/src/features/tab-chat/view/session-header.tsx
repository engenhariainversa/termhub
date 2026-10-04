import { View } from 'react-native';
import type { TTabSummary } from '@/services/api/contract';
import { AppText, Button } from '@/ui';
import { availabilityText } from '../model/availability-text';
import { modeLabel } from '../model/mode-label';
import { stateLine } from '../model/state-line';

/** The session's header (spec 2026-10-01 tab chat §6): the tab's name, its state line ("Trabalhando ·
 * Bash", "Esperando você", or why it cannot be read), Claude Code's mode, and the menu. */
export function SessionHeader({ tab, availability, mode, onBack, onMenu }: { tab: TTabSummary | null; availability: string; mode: string | null; onBack(): void; onMenu(): void }) {
  const label = modeLabel(mode);
  const line = tab ? (availabilityText(availability) ?? stateLine(tab)) : null;
  return (
    <View className="flex-row items-center gap-2 border-b border-app-border px-2 py-2">
      <Button label="Voltar" variant="ghost" onPress={onBack} />
      <View className="flex-1">
        <AppText variant="title" className="text-xl" numberOfLines={1}>
          {tab?.name ?? 'Sessão'}
        </AppText>
        {line || label ? (
          <View className="flex-row items-center gap-2">
            {line ? (
              <AppText variant="muted" className="shrink" numberOfLines={1}>
                {line}
              </AppText>
            ) : null}
            {label ? (
              <View className="rounded-full bg-app-surface2 px-2 py-0.5">
                <AppText variant="muted" className="text-xs">
                  {label}
                </AppText>
              </View>
            ) : null}
          </View>
        ) : null}
      </View>
      <Button label="Mais ações" variant="ghost" onPress={onMenu} />
    </View>
  );
}
