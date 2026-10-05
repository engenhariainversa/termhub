import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo } from 'react';
import { FlatList, Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { filePreviewRoute } from '@/features/file-preview/model/md-paths';
import { useSessionStore } from '@/features/session/viewmodel/useSessionStore';
import { useTranslation } from '@/i18n';
import { api } from '@/services/api';
import type { TFileRecentItem } from '@/services/api/contract';
import { AppText, Banner, Button, Screen } from '@/ui';
import { FILE_RECENT_FILTERS, fileMeta, filterFiles, machineCount, previewPath, skippedText } from '../model/format';
import { createFileRecentStore } from '../viewmodel/createFileRecentStore';

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;

function Badge({ label, tone }: { label: string; tone: 'accent' | 'danger' }) {
  return (
    <View className={`rounded-md border px-1.5 py-0.5 ${tone === 'danger' ? 'border-app-danger' : 'border-app-accent'}`}>
      <Text className={`text-xs ${tone === 'danger' ? 'text-app-danger' : 'text-app-accent'}`}>{label}</Text>
    </View>
  );
}

function FileRow({ item, showMachine, onOpen }: { item: TFileRecentItem; showMachine: boolean; onOpen(): void }) {
  const { t } = useTranslation();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={item.name}
      accessibilityState={{ disabled: item.too_large }}
      disabled={item.too_large}
      onPress={onOpen}
      className="gap-1 border-b border-app-border px-4 py-3"
    >
      <View className="flex-row items-center gap-2">
        <AppText className={`flex-1 font-semibold ${item.too_large ? 'opacity-60' : ''}`} numberOfLines={1}>
          {item.name}
        </AppText>
        {item.cited ? <Badge label={t('citado')} tone="accent" /> : null}
        {item.too_large ? <Badge label={t('muito grande')} tone="danger" /> : null}
      </View>
      <AppText variant="muted" className="text-xs" numberOfLines={2}>
        {fileMeta(item, showMachine, Date.now())}
      </AppText>
    </Pressable>
  );
}

/** A project's recent Markdown files across its machines (spec 2026-10-04 recent Markdown files D7). */
export function FileRecentScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const params = useLocalSearchParams<{ project_id?: string }>();
  const projectId = one(params.project_id) ?? '';
  const store = useMemo(() => createFileRecentStore({ api, session: () => useSessionStore.getState(), projectId }), [projectId]);
  const state = store((s) => s.state);
  const refreshing = store((s) => s.refreshing);
  const filter = store((s) => s.filter);

  useEffect(() => {
    if (projectId) void store.getState().load();
  }, [store, projectId]);

  const goBack = () => (router.canGoBack() ? router.back() : router.replace('/(tabs)'));
  const items = state.phase === 'ok' ? state.items : [];
  const shown = filterFiles(items, filter);
  const showMachine = machineCount(items) > 1;
  const open = (item: TFileRecentItem) => router.push(filePreviewRoute(previewPath(item), { projectId, machineId: item.machine.id }));

  return (
    <Screen padded={false}>
      <View className="flex-row items-center gap-2 border-b border-app-border px-2 py-2">
        <Button label={t('Voltar')} variant="ghost" onPress={goBack} />
        <AppText variant="title" className="flex-1 text-xl" numberOfLines={1}>
          {t('Arquivos')}
        </AppText>
      </View>
      <View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerClassName="gap-2 px-4 py-2">
          {FILE_RECENT_FILTERS.map((f) => {
            const selected = f.key === filter;
            return (
              <Pressable
                key={f.key}
                accessibilityRole="tab"
                accessibilityLabel={t(f.label)}
                accessibilityState={{ selected }}
                onPress={() => store.getState().setFilter(f.key)}
                className={`rounded-xl px-3 py-2 ${selected ? 'bg-app-accent' : 'border border-app-border bg-app-surface2'}`}
              >
                <Text className={`text-sm ${selected ? 'font-semibold text-white' : 'text-app-text'}`}>{t(f.label)}</Text>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>
      <FlatList
        testID="file-recent-list"
        className="flex-1"
        data={shown}
        keyExtractor={(f) => `${f.machine.id}:${f.path}`}
        renderItem={({ item }) => <FileRow item={item} showMachine={showMachine} onOpen={() => open(item)} />}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void store.getState().load({ refresh: true })} />}
        ListHeaderComponent={
          <View className="gap-2 px-4 pt-2">
            {!projectId ? <Banner tone="danger" text={t('Nenhum projeto indicado.')} /> : null}
            {state.phase === 'error' ? <Banner tone="danger" text={state.text} /> : null}
            {state.phase === 'ok'
              ? state.skipped.map((s) => <Banner key={s.machine.id} tone="info" text={skippedText(s.machine.name, s.reason)} />)
              : null}
          </View>
        }
        ListEmptyComponent={
          state.phase === 'loading' && projectId ? (
            <AppText variant="muted" className="px-4 pt-4">
              {t('Listando arquivos…')}
            </AppText>
          ) : state.phase === 'ok' ? (
            <AppText variant="muted" className="px-4 pt-8 text-center">
              {t('Nenhum arquivo .md encontrado')}
            </AppText>
          ) : null
        }
      />
    </Screen>
  );
}
