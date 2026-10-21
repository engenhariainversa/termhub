import { useRouter, type Href } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useTranslation } from '@/i18n';
import { useChatStore } from '@/features/chat/viewmodel/useChatStore';
import { MODEL_RE, TAB_MESSAGE_MAX_CHARS, type TProjectAiResponse } from '@/services/api/contract';
import { AppText, Button, Screen } from '@/ui';
import { TAB_CHAT_MSG } from '../model/messages';
import { useSessionsStore } from '../viewmodel/useSessionsStore';
import { SessionModelPicker } from './session-model-picker';

/** One choice of a picker: a row that reads as selected. */
function Choice({ label, selected, onPress }: { label: string; selected: boolean; onPress(): void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      onPress={onPress}
      className={`rounded-xl border px-4 py-3 ${selected ? 'border-app-accent bg-app-surface2' : 'border-app-border bg-app-surface'}`}
    >
      <Text className={`text-base ${selected ? 'font-semibold text-app-accent' : 'text-app-text'}`}>{label}</Text>
    </Pressable>
  );
}

/**
 * "Nova sessão" (spec 2026-10-01 tab chat §6): Claude Code in a new tab of a project, started with the
 * first message. The machine is asked only when the project's accounts live on more than one; otherwise
 * the server picks. On success the route becomes the new session, so "Voltar" goes back to the list.
 */
export function NewSessionScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const projects = useChatStore((s) => s.projects);
  const loadProjects = useChatStore((s) => s.loadProjects);
  const starting = useSessionsStore((s) => s.starting);
  const startError = useSessionsStore((s) => s.startError);
  const start = useSessionsStore((s) => s.start);
  const projectOptions = useSessionsStore((s) => s.projectOptions);
  const clearStartError = useSessionsStore((s) => s.clearStartError);

  const [projectId, setProjectId] = useState<string | null>(null);
  const [machines, setMachines] = useState<{ id: string; name: string }[]>([]);
  const [machineId, setMachineId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState('');
  const [options, setOptions] = useState<TProjectAiResponse | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [model, setModel] = useState('');
  const [loadingOptions, setLoadingOptions] = useState(false);
  const [optionsFailed, setOptionsFailed] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    clearStartError();
    if (useChatStore.getState().projects.length === 0) void loadProjects();
  }, [loadProjects, clearStartError]);

  useEffect(() => {
    setMachines([]);
    setMachineId(null);
    setOptions(null);
    setAccountId(null);
    setModel('');
    setOptionsFailed(false);
    if (!projectId) return;
    setLoadingOptions(true);
    let live = true;
    void projectOptions(projectId).then((result) => {
      if (!live) return;
      setLoadingOptions(false);
      setOptionsFailed(result === null);
      setOptions(result);
      const byId = new Map((result?.available ?? []).map((a) => [a.machine_id, a.machine_name]));
      const list = [...byId].map(([id, name]) => ({ id, name }));
      setMachines(list);
      setMachineId(list[0]?.id ?? null);
    });
    return () => { live = false; };
  }, [projectId, projectOptions, reload]);

  const accounts = (options?.available ?? []).filter((a) => a.machine_id === machineId);
  const account = accounts.find((a) => a.id === accountId) ?? null;
  const validModel = model.trim() === '' || MODEL_RE.test(model.trim());
  const tooLong = prompt.trim().length > TAB_MESSAGE_MAX_CHARS;
  const canStart = projectId !== null && prompt.trim().length > 0 && !tooLong && !starting && !loadingOptions && !optionsFailed && validModel;
  const submit = async () => {
    if (!projectId || !canStart) return;
    const machine = machines.length > 1 && machineId ? { machine_id: machineId } : {};
    const tabId = await start({ project_id: projectId, ...machine, ...(account ? { account_id: account.id } : {}), ...(model.trim() ? { model: model.trim() } : {}), prompt });
    if (tabId) router.replace(`/session/${tabId}` as Href);
  };
  const goBack = () => (router.canGoBack() ? router.back() : router.replace('/(tabs)/chats' as Href));

  return (
    <Screen padded={false}>
      <View className="flex-row items-center gap-2 border-b border-app-border px-2 py-2">
        <Button label={t('Voltar')} variant="ghost" onPress={goBack} />
        <AppText variant="title" className="flex-1 text-xl" numberOfLines={1}>
          {t('Nova sessão')}
        </AppText>
      </View>
      <ScrollView className="flex-1" keyboardShouldPersistTaps="handled" contentContainerClassName="gap-5 px-6 py-4">
        <View className="gap-2">
          <AppText variant="label">{t('Projeto')}</AppText>
          {projects.map((p) => (
            <Choice key={p.id} label={p.name} selected={p.id === projectId} onPress={() => setProjectId(p.id)} />
          ))}
        </View>
        {machines.length > 1 ? (
          <View className="gap-2">
            <AppText variant="label">{t('Máquina')}</AppText>
            {machines.map((m) => (
              <Choice key={m.id} label={m.name} selected={m.id === machineId} onPress={() => { setMachineId(m.id); setAccountId(null); setModel(''); }} />
            ))}
          </View>
        ) : null}
        {optionsFailed ? <View className="gap-2"><Text className="text-sm text-app-danger">{TAB_CHAT_MSG.agentOptionsFailed}</Text><Button label={t('Tentar de novo')} onPress={() => setReload((n) => n + 1)} /></View> : null}
        {accounts.length ? (
          <View className="gap-2">
            <AppText variant="label">{t('Conta de IA')}</AppText>
            <Choice label={t('Padrão do projeto')} selected={!account} onPress={() => { setAccountId(null); setModel(''); }} />
            {accounts.map((a) => <Choice key={a.id} label={`${a.label} · ${a.provider === 'chatgpt' ? 'Codex' : 'Claude Code'}`} selected={a.id === accountId} onPress={() => { setAccountId(a.id); setModel(''); }} />)}
          </View>
        ) : null}
        {account ? <SessionModelPicker provider={account.provider} defaultModel={options?.ai.models[account.provider] ?? null} value={model} onChange={setModel} disabled={starting} /> : accounts.length ? <AppText variant="muted">{t('Escolha uma conta para definir o modelo desta sessão.')}</AppText> : null}
        <View className="gap-1.5">
          <AppText variant="label">{t('Primeira mensagem')}</AppText>
          <TextInput
            value={prompt}
            onChangeText={setPrompt}
            accessibilityLabel={t('Primeira mensagem')}
            placeholder={t('O que o agente deve fazer?')}
            multiline
            textAlignVertical="top"
            style={{ minHeight: 110 }}
            className="rounded-xl border border-app-border bg-app-surface px-4 py-3 text-base text-app-text placeholder:text-app-muted"
          />
          {tooLong ? <Text className="text-sm text-app-danger">{TAB_CHAT_MSG.tooLong}</Text> : null}
        </View>
        <Button label={t('Iniciar')} onPress={() => void submit()} disabled={!canStart} loading={starting} />
        {startError && !tooLong ? <Text className="text-sm text-app-danger">{startError}</Text> : null}
      </ScrollView>
    </Screen>
  );
}
