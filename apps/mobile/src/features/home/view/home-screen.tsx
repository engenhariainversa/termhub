import { useFocusEffect, useRouter, type Href } from 'expo-router';
import { useCallback, useState } from 'react';
import { FlatList, RefreshControl, View } from 'react-native';
import { AiLoginBanner } from '@/features/ai-login/view/ai-login-banner';
import { useAiLoginStore } from '@/features/ai-login/viewmodel/useAiLoginStore';
import { FavoriteSheet } from '@/features/chat/view/favorite-sheet';
import { ProjectRow } from '@/features/chat/view/project-row';
import { useChatStore } from '@/features/chat/viewmodel/useChatStore';
import { AdConsentCard } from '@/features/permissions/view/ad-consent-card';
import { usePermissionsStore } from '@/features/permissions/viewmodel/usePermissionsStore';
import { useTranslation } from '@/i18n';
import { AppText, Banner, Button, EmptyState, Screen } from '@/ui';
import { favoriteProjects } from '../model/favorites';

/**
 * Home (TER-541): the first tab, the projects pinned in Favoritos — the same group as the web
 * sidebar's pin — in its order. The rows are Chats' own; a tap pushes the project's chat on every
 * window size (the route deep links use), so Home keeps the readable column instead of a split.
 */
export function HomeScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const projects = useChatStore((s) => s.projects);
  const loading = useChatStore((s) => s.loadingProjects);
  const error = useChatStore((s) => s.error);
  const loadProjects = useChatStore((s) => s.loadProjects);
  const setFavorite = useChatStore((s) => s.setFavorite);
  const refreshStatuses = usePermissionsStore((s) => s.refreshStatuses);
  const loadAiLogins = useAiLoginStore((s) => s.load);
  const [sheetFor, setSheetFor] = useState<string | null>(null);

  // On every focus: a pin changed in Chats, or on the web, shows up when the person comes back;
  // the OS statuses are re-read so the ad card follows a change made in the system settings, and the
  // AI logins so an expired one shows its red warning (TER-1047).
  useFocusEffect(
    useCallback(() => {
      void loadProjects();
      void refreshStatuses();
      void loadAiLogins();
    }, [loadProjects, refreshStatuses, loadAiLogins]),
  );

  const favorites = favoriteProjects(projects);
  const sheetProject = favorites.find((p) => p.id === sheetFor);

  return (
    <Screen padded={false}>
      <View className="gap-3 px-6 pb-2 pt-4">
        <AppText variant="title">{t('Home')}</AppText>
        {error ? <Banner tone="danger" text={error} /> : null}
        <AiLoginBanner />
        <AdConsentCard />
        {favorites.length > 0 ? <AppText variant="muted">{t('Favoritos')}</AppText> : null}
      </View>
      {/* No list at all after a failure: the banner says why, and "nothing pinned" would not be true. */}
      {favorites.length === 0 && !loading && (projects.length > 0 || !error) ? (
        <EmptyState
          title={t('Nenhum projeto fixado')}
          hint={t('Na aba Chats, toque no alfinete de um projeto, ou segure a linha, para fixá-lo aqui.')}
          action={<Button label={t('Ver projetos')} variant="secondary" onPress={() => router.navigate('/(tabs)/chats' as Href)} />}
        />
      ) : (
        <FlatList
          data={favorites}
          keyExtractor={(p) => p.id}
          renderItem={({ item }) => (
            <ProjectRow
              row={{ route: item.id, name: item.name, detail: item.key, busy: item.busy, pending: item.pending_confirmations, lastMessageAt: item.last_message_at }}
              selected={false}
              onPress={() => router.push(`/chat/${item.id}` as Href)}
              favorite={{ pinned: true, onToggle: () => void setFavorite(item.id, false), onLongPress: () => setSheetFor(item.id) }}
            />
          )}
          refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void loadProjects()} />}
        />
      )}
      <FavoriteSheet
        project={sheetProject ? { id: sheetProject.id, name: sheetProject.name, pinned: true } : null}
        onClose={() => setSheetFor(null)}
        onToggle={() => sheetProject && void setFavorite(sheetProject.id, false)}
      />
    </Screen>
  );
}
