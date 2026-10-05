import { useState } from 'react';
import { View } from 'react-native';
import { useTranslation } from '@/i18n';
import { AppText, Banner, Button, Field, Screen } from '@/ui';
import { useSessionStore } from '../viewmodel/useSessionStore';

// Simple enough for client-side gating; the server is the actual authority on a valid address.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Início (P§4.1, design spec §11.2): "Continuar com e-mail" starts the enrolment of this device. */
export function StartScreen() {
  const { t } = useTranslation();
  const requestDevice = useSessionStore((s) => s.requestDevice);
  const busy = useSessionStore((s) => s.busy);
  const notice = useSessionStore((s) => s.notice);
  // A failed request (network, key store, the server's refusal) — the local `error` below is the
  // e-mail's own validation.
  const storeError = useSessionStore((s) => s.error);

  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    const trimmed = email.trim();
    if (!EMAIL_RE.test(trimmed)) {
      setError(t('Digite um e-mail válido'));
      return;
    }
    setError(null);
    void requestDevice(trimmed);
  };

  return (
    <Screen>
      <View className="flex-1 justify-center gap-4">
        {/* i18n-ignore */}
        <AppText variant="title">termhub</AppText>
        <AppText variant="muted">{t('Entre com o e-mail da sua conta para pedir acesso a este aparelho.')}</AppText>
        {notice ? <Banner tone="info" text={notice} /> : null}
        {storeError ? <Banner tone="danger" text={storeError} /> : null}
        <Field
          label={t('E-mail')}
          value={email}
          onChangeText={setEmail}
          keyboardType="email-address"
          autoCapitalize="none"
          error={error ?? undefined}
          testID="start-email"
        />
        <Button label={t('Continuar com e-mail')} onPress={submit} loading={busy} />
      </View>
    </Screen>
  );
}
