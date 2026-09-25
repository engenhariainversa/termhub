import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { AppText, Button, PinDots, PinPad, Sheet } from '@/ui';
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
  // from an empty pad. A *rejected* PIN keeps the same prompt open (only `error` changes), so
  // `onDigit` below clears the pad unconditionally on every submission — this effect alone would
  // leave a wrong PIN's six digits stuck on screen.
  useEffect(() => {
    setPin('');
  }, [pinPrompt?.actionId]);

  const onDigit = (digit: string) => {
    if (pin.length >= PIN_LENGTH) return;
    const next = pin + digit;
    setPin(next);
    if (next.length === PIN_LENGTH) {
      setPin('');
      void resolvePinPrompt(next);
    }
  };

  const onBackspace = () => setPin((p) => p.slice(0, -1));

  return (
    <Sheet open={pinPrompt !== null} onClose={cancelPinPrompt} title={pinPrompt?.decision === 'approve_tab' ? 'Permitir sempre nesta aba' : 'Autorizar esta ação'}>
      <View className="gap-6">
        <PinDots filled={pin.length} error={Boolean(error)} />
        {error ? (
          <AppText className="text-app-danger">
            {error}
            {attemptsLeft !== null ? attemptsSuffix(attemptsLeft) : ''}
          </AppText>
        ) : null}
        <PinPad
          onDigit={onDigit}
          onBackspace={onBackspace}
          onBiometrics={biometricsEnabled ? () => void resolvePinPrompt('biometrics') : undefined}
          disabled={busy}
        />
        <Button label="Cancelar" variant="ghost" onPress={cancelPinPrompt} disabled={busy} />
      </View>
    </Sheet>
  );
}
