import { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { AppText, Button, PinInput, Sheet } from '@/ui';
import { attemptsSuffix } from '../model/messages';
import { useSessionStore } from '../viewmodel/useSessionStore';

const PIN_LENGTH = 6;

/** Approving a pending action always asks for the PIN, even while unlocked (P§5.6, design spec
 * §5.5). Mounted once, globally, by `app/_layout.tsx`; `pinPrompt` opens it. The sheet stays open
 * (and busy) while `resolvePinPrompt` performs the decision: a wrong PIN shows here with the
 * attempts left; success, a lock or `cancelPinPrompt` close it. */
export function PinPromptSheet() {
  const pinPrompt = useSessionStore((s) => s.pinPrompt);
  const error = useSessionStore((s) => s.error);
  const attemptsLeft = useSessionStore((s) => s.attemptsLeft);
  const busy = useSessionStore((s) => s.busy);
  const biometricsEnabled = useSessionStore((s) => s.biometricsEnabled);
  const resolvePinPrompt = useSessionStore((s) => s.resolvePinPrompt);
  const cancelPinPrompt = useSessionStore((s) => s.cancelPinPrompt);

  const [pin, setPin] = useState('');

  // A fresh prompt (new action id, or none at all — e.g. a cancel with a partial entry) starts
  // from an empty field. A *rejected* PIN keeps the same prompt open (only `error` changes), so
  // `onChange` below clears the field unconditionally on every submission — this effect alone would
  // leave a wrong PIN's six digits stuck on screen.
  useEffect(() => {
    setPin('');
  }, [pinPrompt?.actionId]);

  const onChange = (next: string) => {
    setPin(next);
    if (next.length === PIN_LENGTH) {
      setPin('');
      void resolvePinPrompt(next);
    }
  };

  return (
    <Sheet open={pinPrompt !== null} onClose={cancelPinPrompt} title={pinPrompt?.decision === 'approve_tab' ? 'Permitir sempre nesta aba' : 'Autorizar esta ação'}>
      <View className="gap-6">
        {busy ? (
          <View className="items-center gap-3 py-4">
            <ActivityIndicator />
            <AppText variant="muted">Conferindo o PIN…</AppText>
          </View>
        ) : (
          <PinInput value={pin} onChange={onChange} length={PIN_LENGTH} error={Boolean(error)} accessibilityLabel="PIN" />
        )}
        {error ? (
          <AppText className="text-app-danger">
            {error}
            {attemptsLeft !== null ? attemptsSuffix(attemptsLeft) : ''}
          </AppText>
        ) : null}
        {biometricsEnabled ? (
          <Button label="Usar biometria" variant="secondary" onPress={() => void resolvePinPrompt('biometrics')} disabled={busy} />
        ) : null}
        <Button label="Cancelar" variant="ghost" onPress={cancelPinPrompt} disabled={busy} />
      </View>
    </Sheet>
  );
}
