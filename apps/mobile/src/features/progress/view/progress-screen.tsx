import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { FlatList, Linking, Pressable, RefreshControl, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { PauseCard } from '@/features/automation/view/pause-card';
import { relativeTime } from '@/features/shared/relative-time';
import { useTranslation } from '@/i18n';
import type { TAgentOnCard, TAutomationFeedEvent, TCardProgress, TEpicProgress } from '@/services/api/contract';
import { AppText, Button, MAX_READABLE_WIDTH, readableColumn, Sheet } from '@/ui';
import { ciLabel, epicCiLine, formatEstimate, stateLabel, usageLine } from '../model/format';
import { feedLine, feedWhy } from '../model/feed';
import { useProgressStore } from '../viewmodel/useProgressStore';

function Bar({ percent }: { percent: number }) {
  return (
    <View className="h-1.5 w-full rounded bg-zinc-800">
      <View className="h-1.5 rounded bg-indigo-400" style={{ width: `${percent}%` }} />
    </View>
  );
}

function Agent({ agent }: { agent: TAgentOnCard }) {
  useTranslation();
  const since = agent.state_at ? ` · ${relativeTime(agent.state_at, Date.now())}` : '';
  return (
    <View className="flex-row flex-wrap items-center gap-2">
      <Text className={agent.needs_you ? 'text-xs text-amber-400' : 'text-xs text-zinc-400'}>
        {`${agent.tab_name} · ${stateLabel(agent.state, agent.background, agent.finished)}${since} · ${agent.machine_name}`}
      </Text>
      {agent.automatic ? <AutoBadge /> : null}
    </View>
  );
}

/** "automático": the card is tagged for automatic work. */
function AutoBadge() {
  const { t } = useTranslation();
  return (
    <Text accessibilityLabel={t('automático')} className="rounded bg-indigo-400/20 px-1 text-[10px] text-indigo-300">
      {t('automático')}
    </Text>
  );
}

/** The automatic work's feed (spec D25): what the agents did, newest first. Absent when there is nothing to show. */
function Feed({ feed }: { feed: TAutomationFeedEvent[] }) {
  const { t } = useTranslation();
  const lines = feed.map((e) => ({ e, text: feedLine(e) })).filter((l): l is { e: TAutomationFeedEvent; text: string } => l.text !== null);
  if (lines.length === 0) return null;
  return (
    <View testID="progress-feed" className="mx-4 my-2 gap-2 rounded-xl bg-zinc-900 p-4">
      <Text accessibilityRole="header" className="text-base font-semibold text-white">
        {t('Automático')}
      </Text>
      {lines.map(({ e, text }) => (
        <View key={e.id} className="gap-0.5">
          <Text className={e.kind === 'escalated' || e.kind === 'deploy_failed' || e.kind === 'release_failed' || e.kind === 'run_blocked' ? 'text-sm text-amber-400' : 'text-sm text-zinc-200'}>{text}</Text>
          {feedWhy(e) ? <Text className="text-xs text-zinc-400">{feedWhy(e)}</Text> : null}
          <View className="flex-row flex-wrap items-center gap-2">
            <Text className="text-xs text-zinc-500">{relativeTime(e.created_at, Date.now())}</Text>
            {e.run_id ? <Text className="text-xs text-zinc-500" accessibilityLabel={t('execução {{id}}', { id: e.run_id })}>{`#${e.run_id.slice(-6)}`}</Text> : null}
            {e.url ? (
              <Pressable onPress={() => void Linking.openURL(e.url as string)} accessibilityRole="link">
                <Text className="text-xs text-indigo-300">{e.pr !== null ? t('PR #{{number}}', { number: e.pr }) : t('abrir')}</Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      ))}
    </View>
  );
}

function Epic({ epic }: { epic: TEpicProgress }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [menuFor, setMenuFor] = useState<TCardProgress | null>(null);
  const toggleAuto = () => {
    const card = menuFor;
    setMenuFor(null);
    if (card) void useProgressStore.getState().setAuto(card.id, !card.auto);
  };
  const waiting = epic.agents?.needs_you ?? 0;
  return (
    <View className="mx-4 my-2 rounded-xl bg-zinc-900 p-4">
      <Pressable onPress={() => setOpen((v) => !v)} accessibilityRole="button" accessibilityState={{ expanded: open }}>
        <View className="flex-row items-baseline justify-between">
          <Text className="flex-1 text-base font-semibold text-white">{epic.title}</Text>
          <Text className="text-lg font-semibold text-white">{`${epic.percent}%`}</Text>
        </View>
        <Text className="text-xs text-zinc-500">{`${epic.project.name} · ${epic.ref}`}</Text>
        <View className="my-2">
          <Bar percent={epic.percent} />
        </View>
        <Text className="text-xs text-zinc-400">{formatEstimate(epic.estimate)}</Text>
        {usageLine(epic.usage) && <Text className="text-xs text-zinc-400">{usageLine(epic.usage)}</Text>}
        {epic.ci && <Text className="text-xs text-zinc-400">{epicCiLine(epic.ci)}</Text>}
        {epic.ci_error && <Text className="text-xs text-red-400">{epic.ci_error}</Text>}
        {waiting > 0 && <Text className="text-xs text-amber-400">{t('{{count}} agentes esperando você', { count: waiting })}</Text>}
      </Pressable>
      {open &&
        epic.cards.map((c) => (
          <View key={c.id} className="mt-3 gap-1">
            <Pressable onLongPress={() => setMenuFor(c)} accessibilityLabel={`${c.ref} ${c.title}`} accessibilityHint={t('Segure para o trabalho automático')} className="flex-row items-center gap-2">
              <Text className="flex-1 text-sm text-white">{`${c.ref} ${c.title}`}</Text>
              {c.auto ? <AutoBadge /> : null}
            </Pressable>
            <Bar percent={c.percent} />
            <Text className="text-xs text-zinc-400">{`${c.units.done}/${c.units.total} · ${formatEstimate(c.estimate)}`}</Text>
            {usageLine(c.usage) && <Text className="text-xs text-zinc-400">{usageLine(c.usage)}</Text>}
            {c.agents?.map((a) => <Agent key={a.tab_id} agent={a} />)}
            {c.pull_requests.map((p) => (
              <Pressable key={p.number} onPress={() => void Linking.openURL(p.state === 'merged' && p.deploy_url ? p.deploy_url : p.url)}>
                {/* i18n-ignore */}
                <Text className="text-xs text-indigo-300">{`PR #${p.number} · ${ciLabel(p)}`}</Text>
              </Pressable>
            ))}
          </View>
        ))}
      <Sheet open={menuFor !== null} onClose={() => setMenuFor(null)} title={t('Trabalho automático')}>
        <View className="gap-4">
          {menuFor ? <AppText variant="muted">{`${menuFor.ref} ${menuFor.title}`}</AppText> : null}
          <Button label={menuFor?.auto ? t('Tirar do trabalho automático') : t('Marcar como automático')} onPress={toggleAuto} />
          <Button label={t('Cancelar')} variant="ghost" onPress={() => setMenuFor(null)} />
        </View>
      </Sheet>
    </View>
  );
}

/** The epics stay a readable column on the iPad (spec 2026-09-28 §2.4); the list's own frame, and so
 * its pull-to-refresh and background, still span the window. */
const COLUMN = readableColumn(MAX_READABLE_WIDTH);

/** The tabs have no header, so the screen keeps off the status bar itself (the notch, the Dynamic
 * Island, Android's bar), like the other tabs do through `Screen`. The bottom is the tab bar's. */
const SAFE_EDGES = ['top', 'left', 'right'] as const;

/** The Progresso tab (spec 2026-09-26 progress-panel D10): active epics across projects, read-only. */
export function ProgressScreen() {
  const { t } = useTranslation();
  const epics = useProgressStore((s) => s.epics);
  const feed = useProgressStore((s) => s.feed);
  const loading = useProgressStore((s) => s.loading);
  const refreshing = useProgressStore((s) => s.refreshing);
  const error = useProgressStore((s) => s.error);
  useFocusEffect(
    useCallback(() => {
      useProgressStore.getState().startPolling();
      return () => useProgressStore.getState().stopPolling();
    }, []),
  );
  return (
    // The list's own colour, so the strip behind the status bar is the list's and not a band of its own.
    <SafeAreaView testID="progress-safe-area" edges={SAFE_EDGES} className="flex-1 bg-[#0B0E17]">
      <FlatList
        testID="progress-list"
        className="flex-1 bg-[#0B0E17]"
        contentContainerStyle={COLUMN}
        data={epics}
        keyExtractor={(e) => e.id}
        renderItem={({ item }) => <Epic epic={item} />}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void useProgressStore.getState().refresh()} />}
        ListHeaderComponent={
          <>
            <View className="px-4 pt-4">
              <PauseCard testID="progress-pause-card" />
            </View>
            {error ? <Text className="px-4 pt-4 text-sm text-red-400">{error}</Text> : null}
            <Feed feed={feed} />
          </>
        }
        ListEmptyComponent={!loading ? <Text className="px-4 pt-8 text-center text-sm text-zinc-500">{t('Nenhum épico em andamento')}</Text> : null}
      />
    </SafeAreaView>
  );
}
