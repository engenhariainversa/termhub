import { useLocalSearchParams, useRouter, type Href } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useTranslation } from '@/i18n';
import { useChatStore } from '@/features/chat/viewmodel/useChatStore';
import { TAB_MESSAGE_MAX_CHARS, type TSessionStartMachine } from '@/services/api/contract';
import { AppText, Button, KeyboardInsetView, Screen } from '@/ui';
import { TAB_CHAT_MSG } from '../model/messages';
import { preselectedAccount, preselectedMachine } from '../model/new-session-picks';
import { cliOf, modelText } from '../model/started-agent';
import { useSessionsStore } from '../viewmodel/useSessionsStore';

/** One choice of a picker: a row that reads as selected, with an optional second line. */
function Choice({ label, detail, selected, disabled = false, testID, onPress }: { label: string; detail?: string; selected: boolean; disabled?: boolean; testID?: string; onPress(): void }) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={detail}
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      className={`rounded-xl border px-4 py-3 ${selected ? 'border-app-accent bg-app-surface2' : 'border-app-border bg-app-surface'} ${disabled ? 'opacity-50' : ''}`}
    >
      <Text className={`text-base ${selected ? 'font-semibold text-app-accent' : 'text-app-text'}`}>{label}</Text>
      {detail ? <Text className="text-xs text-app-muted">{detail}</Text> : null}
    </Pressable>
  );
}

/**
 * "Nova sessão" (spec 2026-10-01 tab chat §6, TER-1119): an agent in a new tab of a project, started with
 * the first message. Opened from a project's sessions (TER-1106), `?projectId=` comes fixed and shows in
 * the header; from Chats, the project is picked first. Then the machine (the project's, an offline one
 * shown but not selectable) and the AI account on it, each preselected only when no one would doubt it
 * (`new-session-picks`). On success the route becomes the new session, so "Voltar" goes back to the list.
 */
export function NewSessionScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const projects = useChatStore((s) => s.projects);
  const loadProjects = useChatStore((s) => s.loadProjects);
  const starting = useSessionsStore((s) => s.starting);
  const startError = useSessionsStore((s) => s.startError);
  const start = useSessionsStore((s) => s.start);
  const startOptions = useSessionsStore((s) => s.startOptions);
  const clearStartError = useSessionsStore((s) => s.clearStartError);

  const params = useLocalSearchParams<{ projectId?: string }>();
  const fixedProject = typeof params.projectId === 'string' && params.projectId ? params.projectId : null;
  const [projectId, setProjectId] = useState<string | null>(fixedProject);
  // null while the project's machines are being read
  const [machines, setMachines] = useState<TSessionStartMachine[] | null>(null);
  const [machineId, setMachineId] = useState<string | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState('');

  useEffect(() => {
    clearStartError();
    if (useChatStore.getState().projects.length === 0) void loadProjects();
  }, [loadProjects, clearStartError]);

  useEffect(() => {
    setMachines(null);
    setMachineId(null);
    setAccountId(null);
    if (!projectId) return;
    let live = true;
    void startOptions(projectId).then((list) => {
      if (!live) return;
      setMachines(list);
      const picked = preselectedMachine(list);
      setMachineId(picked);
      const machine = list.find((m) => m.id === picked);
      setAccountId(machine ? preselectedAccount(machine) : null);
    });
    return () => {
      live = false;
    };
  }, [projectId, startOptions]);

  const machine = machines?.find((m) => m.id === machineId) ?? null;
  const account = machine?.choices.find((c) => c.account_id === accountId) ?? null;
  const pickMachine = (m: TSessionStartMachine) => {
    setMachineId(m.id);
    setAccountId(preselectedAccount(m));
  };

  const canStart = projectId !== null && machine !== null && account !== null && prompt.trim().length > 0 && !starting;
  const submit = async () => {
    if (!projectId || !machine || !account) return;
    const tabId = await start({ project_id: projectId, machine_id: machine.id, account_id: account.account_id, prompt });
    if (tabId) router.replace(`/session/${tabId}` as Href);
  };
  const goBack = () => (router.canGoBack() ? router.back() : router.replace('/(tabs)/chats' as Href));
  const tooLong = prompt.trim().length > TAB_MESSAGE_MAX_CHARS;
  const fixedName = fixedProject ? (projects.find((p) => p.id === fixedProject)?.name ?? null) : null;

  return (
    <Screen padded={false}>
      {/* The pickers scroll; the first message and "Iniciar" sit on the keyboard, as the chat's composer (TER-1107). */}
      <KeyboardInsetView testID="new-session-body">
        <View className="flex-row items-center gap-2 border-b border-app-border px-2 py-2">
          <Button label={t('Voltar')} variant="ghost" onPress={goBack} />
          <View className="flex-1">
            <AppText variant="title" className="text-xl" numberOfLines={1}>
              {t('Nova sessão')}
            </AppText>
            {fixedName ? (
              <AppText testID="new-session-project" variant="muted" className="text-xs" numberOfLines={1}>
                {fixedName}
              </AppText>
            ) : null}
          </View>
        </View>
        <ScrollView className="flex-1" keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive" contentContainerClassName="gap-5 px-6 py-4">
          {fixedProject ? null : (
            <View className="gap-2">
              <AppText variant="label">{t('Projeto')}</AppText>
              {projects.map((p) => (
                <Choice key={p.id} label={p.name} selected={p.id === projectId} onPress={() => setProjectId(p.id)} />
              ))}
            </View>
          )}
          {projectId && machines === null ? <ActivityIndicator /> : null}
          {machines ? (
            <View className="gap-2">
              <AppText variant="label">{t('Máquina')}</AppText>
              {machines.length === 0 ? (
                <AppText variant="muted">{t('Nenhuma máquina ligada a este projeto.')}</AppText>
              ) : (
                machines.map((m) => (
                  <Choice key={m.id} testID={`new-session-machine-${m.id}`} label={m.name} detail={m.online ? undefined : t('Offline')} disabled={!m.online} selected={m.id === machineId} onPress={() => pickMachine(m)} />
                ))
              )}
            </View>
          ) : null}
          {machine ? (
            <View className="gap-2">
              <AppText variant="label">{t('Conta de IA')}</AppText>
              {machine.choices.length === 0 ? (
                <AppText variant="muted">{t('Nenhuma conta de IA nesta máquina pode iniciar um agente. Cadastre uma em Contas de IA.')}</AppText>
              ) : (
                machine.choices.map((c) => (
                  <Choice
                    key={c.account_id}
                    testID={`new-session-account-${c.account_id}`}
                    label={c.label}
                    detail={t('{{cli}} · modelo {{model}}', { cli: cliOf(c.provider), model: modelText(c.model) })}
                    selected={c.account_id === accountId}
                    onPress={() => setAccountId(c.account_id)}
                  />
                ))
              )}
            </View>
          ) : null}
        </ScrollView>
        <View testID="new-session-footer" className="gap-3 border-t border-app-border px-6 py-3">
          <View className="gap-1.5">
            <AppText variant="label">{t('Primeira mensagem')}</AppText>
            <TextInput
              value={prompt}
              onChangeText={setPrompt}
              accessibilityLabel={t('Primeira mensagem')}
              placeholder={account?.provider === 'chatgpt' ? t('O que o Codex deve fazer?') : t('O que o Claude deve fazer?')}
              multiline
              textAlignVertical="top"
              style={{ minHeight: 88, maxHeight: 160 }}
              className="rounded-xl border border-app-border bg-app-surface px-4 py-3 text-base text-app-text placeholder:text-app-muted"
            />
            {tooLong ? <Text className="text-sm text-app-danger">{TAB_CHAT_MSG.tooLong}</Text> : null}
          </View>
          <Button label={t('Iniciar')} onPress={() => void submit()} disabled={!canStart} loading={starting} />
          {startError && !tooLong ? <Text className="text-sm text-app-danger">{startError}</Text> : null}
        </View>
      </KeyboardInsetView>
    </Screen>
  );
}
