import { View } from 'react-native';
import { useTranslation } from '@/i18n';
import { AppText, Button, Sheet } from '@/ui';
import { PERMISSIONS_MSG as MSG } from '../model/messages';
import { useSessionStore } from '@/features/session/viewmodel/useSessionStore';
import { usePermissionsStore } from '../viewmodel/usePermissionsStore';

/** The notification primer (permission prompts spec §3.4): says what the termhub notifies before
 * the one-time OS prompt. Mounted once, globally, by `app/_layout.tsx`; `pushPrimerOpen` opens it, but it only shows
 * while the session is unlocked and no PIN sheet is up (it presents again once those go away). */
export function PushPrimerSheet() {
  // Re-renders on a language change; PERMISSIONS_MSG's getters read it.
  useTranslation();
  const open = usePermissionsStore((s) => s.pushPrimerOpen);
  const unlocked = useSessionStore((s) => s.phase === 'unlocked' && s.pinPrompt === null);
  const acceptPush = usePermissionsStore((s) => s.acceptPush);
  const dismissPush = usePermissionsStore((s) => s.dismissPush);
  return (
    <Sheet open={open && unlocked} onClose={dismissPush} title={MSG.pushTitle}>
      <View className="gap-4">
        <AppText>{MSG.pushBody}</AppText>
        <Button label={MSG.pushAccept} onPress={() => void acceptPush()} />
        <Button label={MSG.later} variant="ghost" onPress={dismissPush} />
      </View>
    </Sheet>
  );
}
