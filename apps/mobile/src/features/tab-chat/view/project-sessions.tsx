import { useFocusEffect, useLocalSearchParams, useRouter, type Href } from 'expo-router';
import { useCallback } from 'react';
import { FlatList, RefreshControl, View } from 'react-native';
import { ProjectRow } from '@/features/chat/view/project-row';
import { useChatStore } from '@/features/chat/viewmodel/useChatStore';
import { useTranslation } from '@/i18n';
import { AppText, Banner, Button, Screen } from '@/ui';
import { TAB_CHAT_MSG } from '../model/messages';
import { useSessionsStore } from '../viewmodel/useSessionsStore';
import { SessionRow } from './session-row';
import { useListOnScreen } from './status-dot';

/**
 * A project's sessions (TER-1106): its concierge first, then a conversation per tab open in the project
 * (name, machine, agent and state), and "Iniciar sessão" for a new one. Pushed from Chats on a phone,
 * or in the split's pane (`embedded`), where `onOpenChat` keeps the concierge in the pane too. It reads
 * the stores the Chats list already loads; the pushed screen reloads them on focus.
 */
export function ProjectSessionsView({ projectId, embedded = false, onOpenChat }: { projectId: string; embedded?: boolean; onOpenChat?(): void }) {
  const { t } = useTranslation();
  const router = useRouter();
  const project = useChatStore((s) => s.projects.find((p) => p.id === projectId));
  const loadProjects = useChatStore((s) => s.loadProjects);
  const allTabs = useSessionsStore((s) => s.tabs);
  const forbidden = useSessionsStore((s) => s.forbidden);
  const error = useSessionsStore((s) => s.error);
  const refreshing = useSessionsStore((s) => s.refreshing);
  const refresh = useSessionsStore((s) => s.refresh);
  const onScreen = useListOnScreen();
  const tabs = allTabs.filter((tab) => tab.project.id === projectId);
  // A deep link may land here before the projects are read: the tabs still know the project's name.
  const name = project?.name ?? tabs[0]?.project.name ?? '';

  const openChat = onOpenChat ?? (() => router.push(`/chat/${projectId}` as Href));
  const goBack = () => (router.canGoBack() ? router.back() : router.replace('/(tabs)/chats' as Href));

  const header = (
    <View>
      <ProjectRow
        row={{ route: projectId, name: t('Concierge'), detail: t('Chat do projeto'), busy: project?.busy ?? false, pending: project?.pending_confirmations ?? 0, lastMessageAt: project?.last_message_at ?? null }}
        selected={false}
        onPress={openChat}
      />
      <View className="gap-3 px-6 pb-1 pt-4">
        {error ? <Banner tone="danger" text={error} /> : null}
        {forbidden ? null : <Button label={t('Iniciar sessão')} onPress={() => router.push(`/session/new?projectId=${encodeURIComponent(projectId)}` as Href)} />}
        <AppText variant="label">{t('Sessões')}</AppText>
      </View>
    </View>
  );

  return (
    <View className="flex-1">
      <View className={`flex-row items-center gap-2 border-b border-app-border ${embedded ? 'px-6 py-3' : 'px-2 py-2'}`}>
        {embedded ? null : <Button label={t('Voltar')} variant="ghost" onPress={goBack} />}
        <AppText variant="title" className="flex-1 text-xl" numberOfLines={1}>
          {name}
        </AppText>
      </View>
      <FlatList
        data={tabs}
        keyExtractor={(tab) => tab.id}
        ListHeaderComponent={header}
        ListEmptyComponent={
          <AppText variant="muted" className="px-6 py-3">
            {forbidden ? TAB_CHAT_MSG.noAccess : TAB_CHAT_MSG.emptyList}
          </AppText>
        }
        renderItem={({ item }) => <SessionRow tab={item} onScreen={onScreen} onPress={() => router.push(`/session/${item.id}` as Href)} />}
        extraData={onScreen}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              void refresh();
              void loadProjects({ quiet: true });
            }}
          />
        }
      />
    </View>
  );
}

/** `app/project-sessions/[projectId].tsx`: the sessions pushed from Chats, re-read each time they come back into view. */
export function ProjectSessionsScreen() {
  const { projectId } = useLocalSearchParams<{ projectId: string }>();
  const load = useSessionsStore((s) => s.load);
  const loadProjects = useChatStore((s) => s.loadProjects);
  useFocusEffect(
    useCallback(() => {
      void load();
      void loadProjects({ quiet: true });
    }, [load, loadProjects]),
  );
  return (
    <Screen padded={false}>
      <ProjectSessionsView projectId={String(projectId ?? '')} />
    </Screen>
  );
}
