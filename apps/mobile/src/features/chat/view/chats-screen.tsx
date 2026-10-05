import { useFocusEffect, useRouter, type Href } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, Pressable, RefreshControl, Text, View } from 'react-native';
import { isFavorite } from '@/features/home/model/favorites';
import { SessionsList } from '@/features/tab-chat/view/sessions-list';
import { tk, useTranslation } from '@/i18n';
import { AppText, Banner, EmptyState, Screen, SPLIT_LIST_WIDTH, useWideLayout } from '@/ui';
import { useChatStore } from '../viewmodel/useChatStore';
import { ConversationView } from './conversation-screen';
import { FavoriteSheet } from './favorite-sheet';
import { ProjectRow, type ProjectRowData } from './project-row';

/** How long the split's list waits after the last socket event of a burst before re-reading the
 * projects: one request per burst of cards, decisions and messages, not one per event. */
const LIVE_LIST_DEBOUNCE_MS = 1000;

type Segment = 'conversas' | 'sessoes';
const SEGMENTS: { key: Segment; label: string }[] = [
  { key: 'conversas', label: tk('Conversas') },
  { key: 'sessoes', label: tk('Sessões') },
];

/** The two lists of the tab (spec 2026-10-01 tab chat D14): the concierge's chats, and the terminal tabs read as conversations. */
function SegmentBar({ value, onChange }: { value: Segment; onChange(next: Segment): void }) {
  const { t } = useTranslation();
  return (
    <View accessibilityRole="tablist" className="flex-row rounded-xl bg-app-surface2 p-1">
      {SEGMENTS.map((s) => {
        const selected = s.key === value;
        return (
          <Pressable
            key={s.key}
            accessibilityRole="tab"
            accessibilityLabel={t(s.label)}
            accessibilityState={{ selected }}
            onPress={() => onChange(s.key)}
            className={`flex-1 items-center rounded-lg py-2 ${selected ? 'bg-app-surface' : ''}`}
          >
            <Text className={`text-sm ${selected ? 'font-semibold text-app-text' : 'text-app-muted'}`}>{t(s.label)}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Chats (spec §11.2): the account-wide chat, then one per project, each saying whether it is
 * answering and how many confirmations wait for the person. From `WIDE_MIN_WIDTH` (spec 2026-09-28
 * iPad §2.3) the list and the chosen conversation sit side by side instead of pushing a screen. */
export function ChatsScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const projects = useChatStore((s) => s.projects);
  const loading = useChatStore((s) => s.loadingProjects);
  const error = useChatStore((s) => s.error);
  const loadProjects = useChatStore((s) => s.loadProjects);
  const wide = useWideLayout();
  const openByRoute = useChatStore((s) => s.openByRoute);
  const subscribeEvents = useChatStore((s) => s.subscribeEvents);
  /** The chat in the split's right pane (spec 2026-09-28 iPad §2.3). Kept while the window is
   * compact, so widening it again brings the same chat back. */
  const [selected, setSelected] = useState<string | null>(null);
  // Read by the focus effect below without being among its deps: selecting a row already opens it
  // (it mounts `ConversationView`, whose own effect calls `openByRoute`), so the focus callback must
  // not change identity — and re-run — on every selection or width change, or it would fire a
  // redundant `openByRoute`/`loadProjects` on each tap and each rotation across the breakpoint.
  const setFavorite = useChatStore((s) => s.setFavorite);
  /** The project whose long-press sheet is open (TER-541). */
  const [sheetFor, setSheetFor] = useState<string | null>(null);
  /** "Conversas" (the chats) or "Sessões" (the terminal tabs, spec 2026-10-01 tab chat §6). */
  const [segment, setSegment] = useState<Segment>('conversas');
  const paneRef = useRef({ wide, selected });
  paneRef.current = { wide, selected };

  // On every focus, not only on mount: the tabs stay mounted under a pushed conversation, so a
  // decision or a finished answer there would otherwise leave this list stale. The split's pane is
  // re-opened too: a pushed conversation (a deep link, a notification) made itself the store's
  // active one, and the pane shows the active one — read from the ref, so this only happens on a
  // real focus, not on every render that changes `wide`/`selected`.
  useFocusEffect(
    useCallback(() => {
      void loadProjects();
      const { wide, selected } = paneRef.current;
      if (wide && selected) void openByRoute(selected);
    }, [loadProjects, openByRoute]),
  );

  // In the split the tab never loses focus while the person works in the pane, so the focus refresh
  // alone would leave "respondendo…", the pending badges and the other projects' activity stale next
  // to the thread (spec 2026-09-28 iPad §2.3). Every socket event but the streamed deltas (the noisy
  // ones, and they change nothing the list shows) schedules a quiet re-read: a `decision` after an
  // approval in the pane, a `confirmation` or `message` anywhere. Quiet, so the list neither spins
  // nor wipes the pane's banner. The server publishes a `decision` for every decided card, so this
  // also covers decisions taken in the pane without hooking `decide`.
  useEffect(() => {
    if (!wide) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = subscribeEvents((e) => {
      if (e.type === 'delta') return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void loadProjects({ quiet: true });
      }, LIVE_LIST_DEBOUNCE_MS);
    });
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [wide, subscribeEvents, loadProjects]);

  const open = (route: string) => (wide ? setSelected(route) : router.push(`/chat/${route}` as Href));

  const rows: (ProjectRowData & { pinned: boolean | null })[] = [
    { route: 'general', name: t('Chat geral'), busy: false, pending: 0, lastMessageAt: null, pinned: null },
    ...projects.map((p) => ({ route: p.id, name: p.name, busy: p.busy, pending: p.pending_confirmations, lastMessageAt: p.last_message_at, pinned: isFavorite(p) })),
  ];
  const sheetProject = projects.find((p) => p.id === sheetFor);

  const list = (
    <>
      <View className="gap-3 px-6 pb-2 pt-4">
        <AppText variant="title">{t('Chats')}</AppText>
        <SegmentBar value={segment} onChange={setSegment} />
        {/* The store has one `error`: with a chat in the pane, the pane's banner already shows it. */}
        {segment === 'conversas' && error && !(wide && selected) ? <Banner tone="danger" text={error} /> : null}
      </View>
      {segment === 'sessoes' ? (
        <SessionsList />
      ) : (
      <FlatList
        data={rows}
        keyExtractor={(row) => row.route}
        extraData={wide ? selected : null}
        renderItem={({ item }) => (
          <ProjectRow
            row={item}
            selected={wide && item.route === selected}
            onPress={() => open(item.route)}
            favorite={item.pinned === null ? undefined : { pinned: item.pinned, onToggle: () => void setFavorite(item.route, !item.pinned), onLongPress: () => setSheetFor(item.route) }}
          />
        )}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void loadProjects()} />}
      />
      )}
      <FavoriteSheet
        project={sheetProject ? { id: sheetProject.id, name: sheetProject.name, pinned: isFavorite(sheetProject) } : null}
        onClose={() => setSheetFor(null)}
        onToggle={() => sheetProject && void setFavorite(sheetProject.id, !isFavorite(sheetProject))}
      />
    </>
  );

  if (!wide) return <Screen padded={false}>{list}</Screen>;
  return (
    <Screen padded={false} width="full">
      <View className="flex-1 flex-row">
        <View testID="chats-list-pane" style={{ width: SPLIT_LIST_WIDTH }} className="border-r border-app-border">
          {list}
        </View>
        <View testID="chats-detail-pane" className="flex-1">
          {selected ? <ConversationView key={selected} routeId={selected} embedded /> : <EmptyState title={t('Escolha uma conversa')} hint={t('Selecione um chat na lista ao lado.')} />}
        </View>
      </View>
    </Screen>
  );
}
