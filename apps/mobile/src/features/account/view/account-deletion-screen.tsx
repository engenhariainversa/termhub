import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useSessionStore } from '@/features/session/viewmodel/useSessionStore';
import { AppText, Button, Screen, Sheet } from '@/ui';
import { ACCOUNT_MSG, deletionDate } from '../model/messages';
import { useAccountStore } from '../viewmodel/useAccountStore';

/**
 * The blocking screen of a pending account deletion (TER-720), route `/account-deletion`: the
 * redirect holds an unlocked session here while the account is pending. It shows the final date,
 * "Cancelar exclusão" (back to the app as it was) and "Sair e remover este aparelho". Nothing here
 * polls: the date is read once, when it is not known yet.
 */
export function AccountDeletionScreen() {
  const scheduledAt = useAccountStore((s) => s.scheduledAt);
  const cancelling = useAccountStore((s) => s.cancelling);
  const error = useAccountStore((s) => s.error);
  const cancelDeletion = useAccountStore((s) => s.cancelDeletion);
  const refresh = useAccountStore((s) => s.refresh);
  const leave = useSessionStore((s) => s.leave);
  const [confirmingLeave, setConfirmingLeave] = useState(false);

  useEffect(() => {
    if (!useAccountStore.getState().scheduledAt) void refresh();
  }, [refresh]);

  const date = deletionDate(scheduledAt);

  return (
    <Screen scroll>
      <View className="gap-6 pb-10">
        <AppText variant="title">{ACCOUNT_MSG.pendingTitle}</AppText>
        <AppText className="font-semibold">{date ? ACCOUNT_MSG.pendingOn(date) : ACCOUNT_MSG.pendingNoDate}</AppText>
        <AppText variant="muted">{ACCOUNT_MSG.pendingBody}</AppText>
        {error ? <AppText className="text-app-danger">{error}</AppText> : null}
        <Button label={ACCOUNT_MSG.cancelButton} loading={cancelling} onPress={() => void cancelDeletion()} />
        <Button label={ACCOUNT_MSG.leaveButton} variant="ghost" onPress={() => setConfirmingLeave(true)} disabled={cancelling} />
        <Sheet open={confirmingLeave} onClose={() => setConfirmingLeave(false)} title={ACCOUNT_MSG.leaveTitle}>
          <View className="gap-4">
            <AppText>{ACCOUNT_MSG.leaveBody}</AppText>
            <Button
              label={ACCOUNT_MSG.leaveConfirm}
              variant="danger"
              onPress={() => {
                setConfirmingLeave(false);
                void leave();
              }}
            />
            <Button label={ACCOUNT_MSG.leaveBack} variant="ghost" onPress={() => setConfirmingLeave(false)} />
          </View>
        </Sheet>
      </View>
    </Screen>
  );
}
