import { View } from 'react-native';
import { useTranslation } from '@/i18n';
import { AppText, Button } from '@/ui';
import { PERMISSIONS_MSG as MSG } from '../model/messages';
import { showAdCard } from '../viewmodel/createPermissionsStore';
import { usePermissionsStore } from '../viewmodel/usePermissionsStore';

/** The ad measurement consent (permission prompts spec §3.4), on Home until decided: "Continuar"
 * always opens ATT on iOS; Android has no ATT, so it keeps "Permitir" / "Agora não". */
export function AdConsentCard() {
  // Re-renders on a language change; PERMISSIONS_MSG's getters read it.
  useTranslation();
  const visible = usePermissionsStore(showAdCard);
  const acceptAds = usePermissionsStore((s) => s.acceptAds);
  const platform = usePermissionsStore((s) => s.platform);
  const declineAds = usePermissionsStore((s) => s.declineAds);
  if (!visible) return null;
  return (
    <View className="gap-3 rounded-2xl border border-app-border bg-app-surface p-4">
      <AppText className="font-semibold">{MSG.adTitle}</AppText>
      <AppText variant="muted">{MSG.adBody}</AppText>
      {platform === 'ios' ? (
        // App Review: a pre-prompt must always lead to the system ATT request, never be a way out of it.
        <Button label={MSG.adContinue} onPress={() => void acceptAds()} />
      ) : (
        <View className="flex-row gap-2">
          <View className="flex-1">
            <Button label={MSG.later} variant="secondary" onPress={() => void declineAds()} />
          </View>
          <View className="flex-1">
            <Button label={MSG.adAccept} onPress={() => void acceptAds()} />
          </View>
        </View>
      )}
    </View>
  );
}
