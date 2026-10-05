import * as Application from 'expo-application';
import { useRouter } from 'expo-router';
import { useEffect, useState, type ReactNode } from 'react';
import { AppState, Switch, View } from 'react-native';
import { ACCOUNT_MSG } from '@/features/account/model/messages';
import { useAccountStore } from '@/features/account/viewmodel/useAccountStore';
import { hostLine } from '@/features/chat/model/copy';
import { HostSheet } from '@/features/chat/view/host-sheet';
import { useChatStore } from '@/features/chat/viewmodel/useChatStore';
import { PERMISSIONS_MSG } from '@/features/permissions/model/messages';
import { usePermissionsStore } from '@/features/permissions/viewmodel/usePermissionsStore';
import { useSessionStore } from '@/features/session/viewmodel/useSessionStore';
import { useThemeStore, type ThemePreference } from '@/features/theme/viewmodel/useThemeStore';
import { diagnosticKey } from '@/services/key';
import { runningUpdate } from '@/services/updates';
import { AppText, Button, Screen, Sheet } from '@/ui';
import { runKeyDiagnostic, type KeyDiagnosticResult } from '../model/key-diagnostic';
import { updateLabel } from '../model/update-label';
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

/** Ajustes (spec §11.2, design spec §7): this device, biometrics, notifications and privacy, the general chat's machine and
 * "Permissões do chat" (its trusted tabs and projects), the theme, the key diagnostic, the version,
 * leaving and "Excluir minha conta" (TER-720). */
export function SettingsScreen() {
  const router = useRouter();
  const device = useSettingsStore((s) => s.device);
  const loadDevice = useSettingsStore((s) => s.loadDevice);
  const server = useSettingsStore((s) => s.server);
  const pushTest = useSettingsStore((s) => s.pushTest);
  const sendTestPush = useSettingsStore((s) => s.sendTestPush);
  const tabFinished = useSettingsStore((s) => s.tabFinished);
  const pushSettingsError = useSettingsStore((s) => s.pushSettingsError);
  const loadPushSettings = useSettingsStore((s) => s.loadPushSettings);
  const setTabFinished = useSettingsStore((s) => s.setTabFinished);
  const biometricsEnabled = useSessionStore((s) => s.biometricsEnabled);
  const enableBiometrics = useSessionStore((s) => s.enableBiometrics);
  const disableBiometrics = useSessionStore((s) => s.disableBiometrics);
  const leave = useSessionStore((s) => s.leave);
  const host = useChatStore((s) => s.conversations['']?.host ?? null);
  const refreshGeneralChat = useChatStore((s) => s.refresh);
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);

  const notificationStatus = usePermissionsStore((s) => s.notificationStatus);
  const adConsent = usePermissionsStore((s) => s.adConsent);
  const refreshStatuses = usePermissionsStore((s) => s.refreshStatuses);
  const syncAdConsent = usePermissionsStore((s) => s.syncAdConsent);
  const acceptPush = usePermissionsStore((s) => s.acceptPush);
  const openSystemSettings = usePermissionsStore((s) => s.openSystemSettings);
  const setAdsFromSettings = usePermissionsStore((s) => s.setAdsFromSettings);

  const [pickingHost, setPickingHost] = useState(false);
  const [confirmingLeave, setConfirmingLeave] = useState(false);
  // Inline, not a sheet: the PIN sheet opens next, and one modal handing over to another is fragile on iOS.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const requestingDeletion = useAccountStore((s) => s.requesting);
  const deletionError = useAccountStore((s) => s.error);
  const requestDeletion = useAccountStore((s) => s.requestDeletion);
  const clearDeletionError = useAccountStore((s) => s.clearError);
  const [diagnosing, setDiagnosing] = useState(false);
  const [diagnosticResult, setDiagnosticResult] = useState<KeyDiagnosticResult | null>(null);

  useEffect(() => {
    void loadDevice();
    void loadPushSettings();
    // Re-reads the general chat's slot for its current machine, without switching what is
    // actually open (`refresh` never touches `activeProject`, `live` or the socket) — unlike
    // `open(null)`, this is safe even while a project's conversation is genuinely the one on
    // screen underneath the tabs.
    void refreshGeneralChat(null);
  }, [loadDevice, loadPushSettings, refreshGeneralChat]);

  // The OS statuses, now and whenever the person comes back from the system settings.
  useEffect(() => {
    void refreshStatuses();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void syncAdConsent(); // also downgrades an ATT grant revoked in the system settings
    });
    return () => sub.remove();
  }, [refreshStatuses, syncAdConsent]);

  const runDiagnostic = () => {
    setDiagnosticResult(null);
    setDiagnosing(true);
    void runKeyDiagnostic(diagnosticKey).then(setDiagnosticResult);
  };

  const confirmLeave = () => {
    setConfirmingLeave(false);
    void leave();
  };

  const startDelete = () => {
    clearDeletionError();
    setConfirmingDelete(true);
  };

  const closeDelete = () => {
    clearDeletionError();
    setConfirmingDelete(false);
  };

  // Once pending, the redirect swaps Ajustes for the blocking screen; the panel only closes.
  const confirmDelete = () => {
    void requestDeletion().then((pending) => {
      if (pending) setConfirmingDelete(false);
    });
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
            <Switch accessibilityLabel="Usar biometria para desbloquear" value={biometricsEnabled} onValueChange={(value) => void (value ? enableBiometrics() : disableBiometrics())} />
          </View>
          <AppText variant="muted">Atalho para o seu PIN ao desbloquear e ao autorizar ações.</AppText>
        </Section>

        <Section title="Notificações">
          <AppText variant="muted">{PERMISSIONS_MSG.notificationStatus[notificationStatus ?? 'undetermined']}</AppText>
          {notificationStatus === 'undetermined' ? <Button label={PERMISSIONS_MSG.pushAccept} variant="secondary" onPress={() => void acceptPush()} /> : null}
          {notificationStatus === 'denied' ? <Button label={PERMISSIONS_MSG.openSettings} variant="secondary" onPress={() => void openSystemSettings()} /> : null}
          {notificationStatus === 'granted' ? (
            <>
              <View className="flex-row items-center justify-between">
                <AppText>{PERMISSIONS_MSG.tabFinishedSwitch}</AppText>
                <Switch
                  accessibilityLabel={PERMISSIONS_MSG.tabFinishedSwitch}
                  value={tabFinished === true}
                  disabled={tabFinished === null}
                  onValueChange={(value) => void setTabFinished(value)}
                />
              </View>
              <AppText variant="muted">{PERMISSIONS_MSG.tabFinishedHint}</AppText>
              {pushSettingsError ? <AppText className="text-app-danger">{pushSettingsError}</AppText> : null}
              <Button label={PERMISSIONS_MSG.pushTest} variant="secondary" loading={pushTest.sending} onPress={() => void sendTestPush()} />
              <AppText variant="muted">{pushTest.note ? `${pushTest.note} ${PERMISSIONS_MSG.pushTestHint}` : PERMISSIONS_MSG.pushTestHint}</AppText>
              {pushTest.error ? <AppText className="text-app-danger">{pushTest.error}</AppText> : null}
            </>
          ) : null}
        </Section>

        <Section title="Privacidade">
          <View className="flex-row items-center justify-between">
            <AppText>{PERMISSIONS_MSG.adsSwitch}</AppText>
            <Switch accessibilityLabel={PERMISSIONS_MSG.adsSwitch} value={adConsent === 'granted'} onValueChange={(value) => void setAdsFromSettings(value)} />
          </View>
          <AppText variant="muted">{PERMISSIONS_MSG.adsHint}</AppText>
        </Section>

        <Section title="Chat">
          <AppText variant="muted">{host ? hostLine(host).text : 'Escolhendo a máquina do chat geral…'}</AppText>
          <Button label="Trocar máquina ou conta" variant="secondary" onPress={() => setPickingHost(true)} />
          <HostSheet open={pickingHost} onClose={() => setPickingHost(false)} />
          <Button label="Permissões do chat" variant="secondary" onPress={() => router.push('/chat-grants')} />
          {/* chat decision memory spec 2026-09-26 §5.2: "Memória do chat" is reached from here, no PIN. */}
          <Button label="Memória do chat" variant="secondary" onPress={() => router.push('/chat-memory')} />
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
          <AppText variant="muted">{updateLabel(runningUpdate().updateId, runningUpdate().isEmbeddedLaunch)}</AppText>
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

        {confirmingDelete ? (
          <View testID="delete-account-panel" className="gap-3 rounded-xl border border-app-danger p-4">
            <AppText variant="title">{ACCOUNT_MSG.confirmTitle}</AppText>
            <AppText className="font-semibold">{ACCOUNT_MSG.confirmWhen}</AppText>
            <AppText>{ACCOUNT_MSG.confirmDeleted}</AppText>
            <AppText>{ACCOUNT_MSG.confirmKept}</AppText>
            <AppText variant="muted">{ACCOUNT_MSG.confirmCancel}</AppText>
            {deletionError ? <AppText className="text-app-danger">{deletionError}</AppText> : null}
            <Button label={ACCOUNT_MSG.confirmButton} variant="danger" loading={requestingDeletion} onPress={confirmDelete} />
            <Button label={ACCOUNT_MSG.back} variant="ghost" onPress={closeDelete} disabled={requestingDeletion} />
          </View>
        ) : (
          <Button label={ACCOUNT_MSG.deleteButton} variant="danger" onPress={startDelete} />
        )}
      </View>
    </Screen>
  );
}
