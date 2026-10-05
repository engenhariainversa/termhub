import { useFocusEffect, useRouter, type Href } from 'expo-router';
import { useCallback } from 'react';
import { FlatList, Pressable, RefreshControl, View } from 'react-native';
import { usePermissionsStore } from '@/features/permissions/viewmodel/usePermissionsStore';
import { relativeTime } from '@/features/shared/relative-time';
import type { TNotificationRow } from '@/services/api/contract';
import { useTranslation } from '@/i18n';
import { AppText, Banner, EmptyState, Screen } from '@/ui';
import { useNotificationsStore } from '../viewmodel/useNotificationsStore';

/** `data.project_id` when it is a string, else the general chat (design spec §7, ruling). */
function routeFor(row: TNotificationRow): Href {
  const projectId = (row.data as { project_id?: unknown } | null)?.project_id;
  return (typeof projectId === 'string' ? `/chat/${projectId}` : '/chat/general') as Href;
}

function Row({ row, onPress }: { row: TNotificationRow; onPress(): void }) {
  // Re-renders on a language change (the relative time follows it).
  useTranslation();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={row.title} onPress={onPress} className="flex-row items-start gap-3 border-b border-app-border px-6 py-4">
      <View className={`mt-2 h-2 w-2 rounded-full ${row.read_at === null ? 'bg-app-accent' : 'bg-transparent'}`} />
      <View className="flex-1 gap-0.5">
        <AppText className="font-semibold">{row.title}</AppText>
        <AppText variant="muted">{row.body}</AppText>
      </View>
      <AppText variant="muted">{relativeTime(row.created_at, Date.now())}</AppText>
    </Pressable>
  );
}

/** Notificações (spec §9, design spec §7): the account's history, newest first, with an unread
 * dot; tapping marks the row read and opens its chat. */
export function NotificationsScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const items = useNotificationsStore((s) => s.items);
  const loading = useNotificationsStore((s) => s.loading);
  const error = useNotificationsStore((s) => s.error);
  const nextBefore = useNotificationsStore((s) => s.nextBefore);
  const load = useNotificationsStore((s) => s.load);
  const loadMore = useNotificationsStore((s) => s.loadMore);
  const markRead = useNotificationsStore((s) => s.markRead);
  const maybeOpenPushPrimer = usePermissionsStore((s) => s.maybeOpenPushPrimer);

  // On every focus, like Chats: an approval or a new push seen elsewhere would otherwise leave
  // this list stale. Someone who opens this tab without notifications on is offered them.
  useFocusEffect(
    useCallback(() => {
      void load();
      void maybeOpenPushPrimer();
    }, [load, maybeOpenPushPrimer]),
  );

  const onPress = (row: TNotificationRow) => {
    void markRead(row.id).finally(() => router.push(routeFor(row)));
  };

  return (
    <Screen padded={false}>
      <View className="gap-3 px-6 pb-2 pt-4">
        <AppText variant="title">{t('Notificações')}</AppText>
        {error ? <Banner tone="danger" text={error} /> : null}
      </View>
      {items.length === 0 && !loading ? (
        <EmptyState title={t('Nada por aqui')} hint={t('Ações esperando confirmação e respostas prontas aparecem aqui.')} />
      ) : (
        <FlatList
          data={items}
          keyExtractor={(row) => row.id}
          renderItem={({ item }) => <Row row={item} onPress={() => onPress(item)} />}
          refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void load()} />}
          onEndReached={() => {
            if (nextBefore) void loadMore();
          }}
        />
      )}
    </Screen>
  );
}
