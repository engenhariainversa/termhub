import { View } from 'react-native';
import { AppText, Button } from '@/ui';
import { isGrantActive, untilLabel } from '../model/grant-time';
import type { ChatGrant } from '../model/types';

type Props = { grants: ChatGrant[]; revokingId: string | null; onRevoke(id: string): void };

/** The trusted tabs of this conversation, right above the composer (spec 2026-09-25 §6.1): while
 * one is listed, the concierge types into that tab without asking. Nothing when there is none. */
export function GrantsStrip({ grants, revokingId, onRevoke }: Props) {
  const active = grants.filter((g) => isGrantActive(g));
  if (active.length === 0) return null;
  return (
    <View className="gap-1 px-4 pb-2">
      {active.map((g) => (
        <View key={g.id} className="flex-row items-center justify-between gap-2 rounded-xl border border-app-accent bg-app-surface2 px-3 py-2">
          <AppText variant="muted" className="flex-1">
            {`Enviando direto para ${g.tab_name ? `a aba ${g.tab_name}` : 'uma aba que não existe mais'} ${untilLabel(g.expires_at)}`}
          </AppText>
          <Button label="Revogar" variant="ghost" onPress={() => onRevoke(g.id)} disabled={revokingId === g.id} />
        </View>
      ))}
    </View>
  );
}
