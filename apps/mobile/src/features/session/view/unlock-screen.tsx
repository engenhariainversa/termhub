import { useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { AppText, Button, Countdown, PinInput, Screen } from '@/ui';
import { attemptsSuffix } from '../model/messages';
import { useSessionStore } from '../viewmodel/useSessionStore';

const PIN_LENGTH = 6;

/** Desbloquear (P§5.3–5.6, design spec §5.4): the PIN on the system number pad, and the biometric
 * shortcut when enabled. "Sair e remover este aparelho" lives in Ajustes, not here. */
export function UnlockScreen() {
  const unlock = useSessionStore((s) => s.unlock);
  const unlockWithBiometrics = useSessionStore((s) => s.unlockWithBiometrics);
  const lockExpired = useSessionStore((s) => s.lockExpired);
  const error = useSessionStore((s) => s.error);
  const attemptsLeft = useSessionStore((s) => s.attemptsLeft);
  const lockedUntil = useSessionStore((s) => s.lockedUntil);
  const biometricsEnabled = useSessionStore((s) => s.biometricsEnabled);
  const busy = useSessionStore((s) => s.busy);

  const [pin, setPin] = useState('');

  const onChange = (next: string) => {
    setPin(next);
    if (next.length === PIN_LENGTH) {
      setPin('');
      void unlock(next);
    }
  };

  return (
    <Screen>
      <View className="flex-1 justify-center gap-6">
        <AppText variant="title">Desbloquear</AppText>
        <AppText variant="muted">Digite seu PIN</AppText>
        {lockedUntil ? (
          <View className="gap-2">
            <AppText className="text-app-danger">Aparelho bloqueado</AppText>
            <Countdown until={lockedUntil} onExpire={lockExpired} />
          </View>
        ) : error ? (
          <AppText className="text-app-danger">
            {error}
            {attemptsLeft !== null ? attemptsSuffix(attemptsLeft) : ''}
          </AppText>
        ) : null}
        {busy ? (
          <View className="items-center gap-3 py-4">
            <ActivityIndicator />
            <AppText variant="muted">Conferindo o PIN…</AppText>
          </View>
        ) : (
          <PinInput
            value={pin}
            onChange={onChange}
            length={PIN_LENGTH}
            disabled={Boolean(lockedUntil)}
            error={Boolean(error) && !lockedUntil}
            accessibilityLabel="PIN"
          />
        )}
        {biometricsEnabled ? (
          <Button label="Usar biometria" variant="ghost" onPress={() => void unlockWithBiometrics()} disabled={Boolean(lockedUntil) || busy} />
        ) : null}
      </View>
    </Screen>
  );
}
