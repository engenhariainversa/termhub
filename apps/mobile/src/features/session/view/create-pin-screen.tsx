import { useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { AppText, Banner, PinInput, Screen } from '@/ui';
import { useSessionStore } from '../viewmodel/useSessionStore';

const PIN_LENGTH = 6;

/** Criar PIN (P§4.5, design spec §5.3): six digits, typed twice; a mismatch restarts at step 1.
 * The store's own `createPin` re-checks equality (defence in depth) but this screen never lets a
 * mismatched pair reach it. */
export function CreatePinScreen() {
  const createPin = useSessionStore((s) => s.createPin);
  const storeError = useSessionStore((s) => s.error);
  const busy = useSessionStore((s) => s.busy);

  const [step, setStep] = useState<1 | 2>(1);
  const [firstPin, setFirstPin] = useState('');
  const [pin, setPin] = useState('');
  const [mismatch, setMismatch] = useState<string | null>(null);

  const onChange = (next: string) => {
    setMismatch(null);
    setPin(next);
    if (next.length < PIN_LENGTH) return;

    if (step === 1) {
      setFirstPin(next);
      setPin('');
      setStep(2);
      return;
    }
    if (next !== firstPin) {
      setMismatch('Os PINs não são iguais');
      setFirstPin('');
      setPin('');
      setStep(1);
      return;
    }
    // Unconditional, right after submitting: a server-side failure (the store's own `error`
    // covers it) must not leave step 2 with a full, stuck field.
    const confirmed = next;
    const first = firstPin;
    setFirstPin('');
    setPin('');
    setStep(1);
    void createPin(first, confirmed);
  };

  return (
    <Screen>
      <View className="flex-1 justify-center gap-6">
        <AppText variant="title">Criar PIN</AppText>
        {busy ? null : <AppText variant="muted">{step === 1 ? 'Crie um PIN de 6 dígitos' : 'Repita o PIN'}</AppText>}
        {mismatch ? <Banner tone="danger" text={mismatch} /> : null}
        {storeError ? <Banner tone="danger" text={storeError} /> : null}
        {/* Activation (the server call, then scrypt wrapping the secret) takes a moment: say so, rather
            than show step 1's empty field as if nothing happened. */}
        {busy ? (
          <View className="items-center gap-3 py-4">
            <ActivityIndicator />
            <AppText variant="muted">Ativando este aparelho…</AppText>
          </View>
        ) : (
          <PinInput value={pin} onChange={onChange} length={PIN_LENGTH} accessibilityLabel="PIN" />
        )}
      </View>
    </Screen>
  );
}
