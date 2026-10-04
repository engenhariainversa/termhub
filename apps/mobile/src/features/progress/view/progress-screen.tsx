import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { FlatList, Linking, Pressable, RefreshControl, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { relativeTime } from '@/features/shared/relative-time';
import type { TAgentOnCard, TEpicProgress } from '@/services/api/contract';
import { MAX_READABLE_WIDTH, readableColumn } from '@/ui';
import { ciLabel, epicCiLine, formatEstimate, stateLabel } from '../model/format';
import { useProgressStore } from '../viewmodel/useProgressStore';

function Bar({ percent }: { percent: number }) {
  return (
    <View className="h-1.5 w-full rounded bg-zinc-800">
      <View className="h-1.5 rounded bg-indigo-400" style={{ width: `${percent}%` }} />
    </View>
  );
}

function Agent({ agent }: { agent: TAgentOnCard }) {
  const since = agent.state_at ? ` · ${relativeTime(agent.state_at, Date.now())}` : '';
  return (
    <Text className={agent.needs_you ? 'text-xs text-amber-400' : 'text-xs text-zinc-400'}>
      {`${agent.tab_name} · ${stateLabel(agent.state, agent.background)}${since} · ${agent.machine_name}`}
    </Text>
  );
}

function Epic({ epic }: { epic: TEpicProgress }) {
  const [open, setOpen] = useState(false);
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
        {epic.ci && <Text className="text-xs text-zinc-400">{epicCiLine(epic.ci)}</Text>}
        {epic.ci_error && <Text className="text-xs text-red-400">{epic.ci_error}</Text>}
        {waiting > 0 && <Text className="text-xs text-amber-400">{waiting === 1 ? '1 agente esperando você' : `${waiting} agentes esperando você`}</Text>}
      </Pressable>
      {open &&
        epic.cards.map((c) => (
          <View key={c.id} className="mt-3 gap-1">
            <Text className="text-sm text-white">{`${c.ref} ${c.title}`}</Text>
            <Bar percent={c.percent} />
            <Text className="text-xs text-zinc-400">{`${c.units.done}/${c.units.total} · ${formatEstimate(c.estimate)}`}</Text>
            {c.agents?.map((a) => <Agent key={a.tab_id} agent={a} />)}
            {c.pull_requests.map((p) => (
              <Pressable key={p.number} onPress={() => void Linking.openURL(p.state === 'merged' && p.deploy_url ? p.deploy_url : p.url)}>
                <Text className="text-xs text-indigo-300">{`PR #${p.number} · ${ciLabel(p)}`}</Text>
              </Pressable>
            ))}
          </View>
        ))}
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
  const epics = useProgressStore((s) => s.epics);
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
        ListHeaderComponent={error ? <Text className="px-4 pt-4 text-sm text-red-400">{error}</Text> : null}
        ListEmptyComponent={!loading ? <Text className="px-4 pt-8 text-center text-sm text-zinc-500">Nenhum épico em andamento</Text> : null}
      />
    </SafeAreaView>
  );
}
