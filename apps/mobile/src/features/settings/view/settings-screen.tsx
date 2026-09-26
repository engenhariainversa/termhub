import * as Application from 'expo-application';
import { useRouter } from 'expo-router';
import { useEffect, useState, type ReactNode } from 'react';
import { Switch, View } from 'react-native';
import { hostLine } from '@/features/chat/model/copy';
import { HostSheet } from '@/features/chat/view/host-sheet';
import { useChatStore } from '@/features/chat/viewmodel/useChatStore';
import { useSessionStore } from '@/features/session/viewmodel/useSessionStore';
import { useThemeStore, type ThemePreference } from '@/features/theme/viewmodel/useThemeStore';
import { diagnosticKey } from '@/services/key';
import { AppText, Button, Screen, Sheet } from '@/ui';
import { runKeyDiagnostic, type KeyDiagnosticResult } from '../model/key-diagnostic';
import { useSettingsStore } from '../viewmodel/useSettingsStore';
import { KeyDiagnosticSheet } from './key-diagnostic-sheet';

const PLATFORM_LABEL: Record<'ios' | 'android', string> = { ios: 'iOS', android: 'Android' };

const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: 'system', label: 'Sistema' },
  { value: 'light', label: 'Claro' },
  { value: 'dark', label: 'Escuro' },
];

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View className="gap-3 border-b border-app-border pb-6">
      <AppText variant="label">{title}</AppText>
      {children}
    </View>
  );
}

/** Ajustes (spec §11.2, design spec §7): this device, biometrics, the general chat's machine and
 * its trusted tabs, the theme, the key diagnostic, the version and leaving. */
export function SettingsScreen() {
  const router = useRouter();
  const device = useSettingsStore((s) => s.device);
  const loadDevice = useSettingsStore((s) => s.loadDevice);
  const server = useSettingsStore((s) => s.server);
  const biometricsEnabled = useSessionStore((s) => s.biometricsEnabled);
  const enableBiometrics = useSessionStore((s) => s.enableBiometrics);
  const disableBiometrics = useSessionStore((s) => s.disableBiometrics);
  const leave = useSessionStore((s) => s.leave);
  const host = useChatStore((s) => s.conversations['']?.host ?? null);
  const refreshGeneralChat = useChatStore((s) => s.refresh);
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);

  const [pickingHost, setPickingHost] = useState(false);
  const [confirmingLeave, setConfirmingLeave] = useState(false);
  const [diagnosing, setDiagnosing] = useState(false);
  const [diagnosticResult, setDiagnosticResult] = useState<KeyDiagnosticResult | null>(null);

  useEffect(() => {
    void loadDevice();
    // Re-reads the general chat's slot for its current machine, without switching what is
    // actually open (`refresh` never touches `activeProject`, `live` or the socket) — unlike
    // `open(null)`, this is safe even while a project's conversation is genuinely the one on
    // screen underneath the tabs.
    void refreshGeneralChat(null);
  }, [loadDevice, refreshGeneralChat]);

  const runDiagnostic = () => {
    setDiagnosticResult(null);
    setDiagnosing(true);
    void runKeyDiagnostic(diagnosticKey).then(setDiagnosticResult);
  };

  const confirmLeave = () => {
    setConfirmingLeave(false);
    void leave();
  };

  return (
    <Screen scroll>
      <View className="gap-6 pb-10">
        <AppText variant="title">Ajustes</AppText>

        <Section title="Este aparelho">
          <AppText className="font-semibold">{device?.name ?? '—'}</AppText>
          <AppText variant="muted">{device ? `${device.model} · ${PLATFORM_LABEL[device.platform]}` : 'Carregando…'}</AppText>
        </Section>

        <Section title="Biometria">
          <View className="flex-row items-center justify-between">
            <AppText>Usar biometria para desbloquear</AppText>
            <Switch value={biometricsEnabled} onValueChange={(value) => void (value ? enableBiometrics() : disableBiometrics())} />
          </View>
          <AppText variant="muted">Atalho para o seu PIN ao desbloquear e ao autorizar ações.</AppText>
        </Section>

        <Section title="Chat">
          <AppText variant="muted">{host ? hostLine(host).text : 'Escolhendo a máquina do chat geral…'}</AppText>
          <Button label="Trocar máquina ou conta" variant="secondary" onPress={() => setPickingHost(true)} />
          <HostSheet open={pickingHost} onClose={() => setPickingHost(false)} />
          <Button label="Abas confiáveis" variant="secondary" onPress={() => router.push('/chat-grants')} />
        </Section>

        <Section title="Aparência">
          <View className="flex-row gap-2">
            {THEME_OPTIONS.map((option) => (
              <View key={option.value} className="flex-1">
                <Button label={option.label} variant={theme === option.value ? 'primary' : 'secondary'} onPress={() => setTheme(option.value)} />
              </View>
            ))}
          </View>
        </Section>

        <Section title="Diagnóstico da chave">
          <Button label="Testar a chave do aparelho" variant="secondary" onPress={runDiagnostic} />
          <KeyDiagnosticSheet open={diagnosing} onClose={() => setDiagnosing(false)} result={diagnosticResult} />
        </Section>

        <Section title="Versão">
          <AppText variant="muted">
            {Application.nativeApplicationVersion} ({Application.nativeBuildVersion})
          </AppText>
          <AppText variant="muted">{server}</AppText>
        </Section>

        <Button label="Sair e remover este aparelho" variant="danger" onPress={() => setConfirmingLeave(true)} />
        <Sheet open={confirmingLeave} onClose={() => setConfirmingLeave(false)} title="Remover este aparelho">
          <View className="gap-4">
            <AppText>Este aparelho perde o acesso agora. Isso não pode ser desfeito.</AppText>
            <Button label="Remover" variant="danger" onPress={confirmLeave} />
            <Button label="Cancelar" variant="ghost" onPress={() => setConfirmingLeave(false)} />
          </View>
        </Sheet>
      </View>
    </Screen>
  );
}
