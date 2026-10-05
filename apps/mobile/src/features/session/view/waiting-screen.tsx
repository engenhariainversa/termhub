import { View } from 'react-native';
import { formatVerificationCode } from '@/services/api/contract';
import { useTranslation } from '@/i18n';
import { AppText, Button, Countdown, Screen } from '@/ui';
import { useSessionStore } from '../viewmodel/useSessionStore';

/** Aguardando aprovação (P§4.2–4.5, design spec §5.2): the verification code, large, until the
 * web approves — with the mock's own simulation buttons when `mockControls` is present. */
export function WaitingScreen() {
  const { t } = useTranslation();
  const request = useSessionStore((s) => s.request);
  const mockControls = useSessionStore((s) => s.mockControls);
  const cancelRequest = useSessionStore((s) => s.cancelRequest);

  if (!request) return null;

  return (
    <Screen>
      <View className="flex-1 justify-center gap-6">
        <AppText variant="title">{t('Aguardando aprovação')}</AppText>
        <AppText variant="code" className="text-center">
          {formatVerificationCode(request.code)}
        </AppText>
        <AppText variant="muted">{t('Abra o termhub na web para aprovar este aparelho.')}</AppText>
        <View className="flex-row items-center justify-center gap-2">
          <AppText variant="muted">{t('Expira em')}</AppText>
          <Countdown until={request.expiresAt} onExpire={() => undefined} />
        </View>
        {mockControls ? (
          <View className="gap-3">
            <Button label={t('Simular aprovação na web')} variant="secondary" onPress={() => mockControls.approve(request.id)} />
            <Button label={t('Simular recusa')} variant="secondary" onPress={() => mockControls.deny(request.id)} />
          </View>
        ) : null}
        <Button label={t('Cancelar')} variant="ghost" onPress={cancelRequest} />
      </View>
    </Screen>
  );
}
