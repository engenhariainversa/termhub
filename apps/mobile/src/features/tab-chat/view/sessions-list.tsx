import { useRouter, type Href } from 'expo-router';
import { useEffect } from 'react';
import { RefreshControl, SectionList, View } from 'react-native';
import { useTranslation } from '@/i18n';
import { AppText, Banner, Button, EmptyState } from '@/ui';
import { TAB_CHAT_MSG } from '../model/messages';
import { useSessionsStore } from '../viewmodel/useSessionsStore';
import { SessionRow } from './session-row';
import { useListOnScreen } from './status-dot';

/** Sessões (spec 2026-10-01 tab chat §6, D14): the terminal tabs of the person's projects, grouped by
 * project, each opening as a conversation; "Nova sessão" starts one. Loaded once when shown. */
export function SessionsList() {
  const { t } = useTranslation();
  const router = useRouter();
  const groups = useSessionsStore((s) => s.groups);
  const loaded = useSessionsStore((s) => s.loaded);
  const loading = useSessionsStore((s) => s.loading);
  const refreshing = useSessionsStore((s) => s.refreshing);
  const forbidden = useSessionsStore((s) => s.forbidden);
  const error = useSessionsStore((s) => s.error);
  const load = useSessionsStore((s) => s.load);
  const refresh = useSessionsStore((s) => s.refresh);
  const onScreen = useListOnScreen();

  useEffect(() => {
    void load();
  }, [load]);

  const newSession = <Button label={t('Nova sessão')} onPress={() => router.push('/session/new' as Href)} />;

  if (forbidden) return <EmptyState title={t('Sessões')} hint={TAB_CHAT_MSG.noAccess} />;

  const sections = groups.map((g) => ({ key: g.project.id, title: g.project.name, data: g.tabs }));
  return (
    <SectionList
      sections={sections}
      keyExtractor={(tab) => tab.id}
      ListHeaderComponent={
        <View className="gap-3 px-6 pb-2 pt-2">
          {error ? <Banner tone="danger" text={error} /> : null}
          {sections.length > 0 ? newSession : null}
        </View>
      }
      ListEmptyComponent={loaded && !loading ? <EmptyState title={t('Sessões')} hint={TAB_CHAT_MSG.emptyList} action={newSession} /> : null}
      renderSectionHeader={({ section }) => (
        <View className="bg-app-bg px-6 pb-1 pt-4">
          <AppText variant="label">{section.title}</AppText>
        </View>
      )}
      renderItem={({ item }) => <SessionRow tab={item} onScreen={onScreen} onPress={() => router.push(`/session/${item.id}` as Href)} />}
      extraData={onScreen}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
      stickySectionHeadersEnabled={false}
    />
  );
}
