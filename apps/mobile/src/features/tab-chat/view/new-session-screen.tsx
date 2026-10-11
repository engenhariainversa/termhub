import { useRouter, type Href } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useTranslation } from '@/i18n';
import { useChatStore } from '@/features/chat/viewmodel/useChatStore';
import { TAB_MESSAGE_MAX_CHARS } from '@/services/api/contract';
import { AppText, Button, Screen } from '@/ui';
import { TAB_CHAT_MSG } from '../model/messages';
import { useSessionsStore } from '../viewmodel/useSessionsStore';

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
  const projectMachines = useSessionsStore((s) => s.projectMachines);
  const clearStartError = useSessionsStore((s) => s.clearStartError);

  const [projectId, setProjectId] = useState<string | null>(null);
  const [machines, setMachines] = useState<{ id: string; name: string }[]>([]);
  const [machineId, setMachineId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState('');

  useEffect(() => {
    clearStartError();
    if (useChatStore.getState().projects.length === 0) void loadProjects();
  }, [loadProjects, clearStartError]);

  useEffect(() => {
    setMachines([]);
    setMachineId(null);
    if (!projectId) return;
    let live = true;
    void projectMachines(projectId).then((list) => {
      if (!live) return;
      setMachines(list);
      setMachineId(list[0]?.id ?? null);
    });
    return () => {
      live = false;
    };
  }, [projectId, projectMachines]);

  const canStart = projectId !== null && prompt.trim().length > 0 && !starting;
  const submit = async () => {
    if (!projectId) return;
    const machine = machines.length > 1 && machineId ? { machine_id: machineId } : {};
    const tabId = await start({ project_id: projectId, ...machine, prompt });
    if (tabId) router.replace(`/session/${tabId}` as Href);
  };
  const goBack = () => (router.canGoBack() ? router.back() : router.replace('/(tabs)/chats' as Href));
  const tooLong = prompt.trim().length > TAB_MESSAGE_MAX_CHARS;

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
              <Choice key={m.id} label={m.name} selected={m.id === machineId} onPress={() => setMachineId(m.id)} />
            ))}
          </View>
        ) : null}
        <View className="gap-1.5">
          <AppText variant="label">{t('Primeira mensagem')}</AppText>
          <TextInput
            value={prompt}
            onChangeText={setPrompt}
            accessibilityLabel={t('Primeira mensagem')}
            placeholder={t('O que o Claude deve fazer?')}
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
