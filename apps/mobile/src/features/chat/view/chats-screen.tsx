import { useFocusEffect, useRouter, type Href } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, RefreshControl, View } from 'react-native';
import { AiLoginBanner } from '@/features/ai-login/view/ai-login-banner';
import { useAiLoginStore } from '@/features/ai-login/viewmodel/useAiLoginStore';
import { isFavorite } from '@/features/home/model/favorites';
import { ProjectSessionsView } from '@/features/tab-chat/view/project-sessions';
import { useSessionsStore } from '@/features/tab-chat/viewmodel/useSessionsStore';
import { useTranslation } from '@/i18n';
import { AppText, Banner, EmptyState, Screen, SPLIT_LIST_WIDTH, useWideLayout } from '@/ui';
import { chatsOrder, tabsNeedingYou } from '../model/project-list';
import { useChatStore } from '../viewmodel/useChatStore';
import { ConversationView } from './conversation-screen';
import { FavoriteSheet } from './favorite-sheet';
import { ProjectRow, type ProjectRowData } from './project-row';

/** How long the split's list waits after the last socket event of a burst before re-reading the
 * projects: one request per burst of cards, decisions and messages, not one per event. */
const LIVE_LIST_DEBOUNCE_MS = 1000;

/** What the split's right pane shows: a project's sessions, or a chat (`general` or a project id). */
type Pane = { kind: 'sessions' | 'chat'; route: string };

/** Chats (spec §11.2, TER-1106): the account-wide chat, then one row per project — the Favoritos first —
 * each saying whether its concierge is answering and how much waits for the person (its confirmations
 * and its tabs waiting on them). A tap, or the list icon, opens the project's sessions (its concierge
 * first); the chat icon opens the concierge straight away. From `WIDE_MIN_WIDTH` (spec 2026-09-28 iPad
 * §2.3) the list and the chosen screen sit side by side instead of pushing one. */
export function ChatsScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const projects = useChatStore((s) => s.projects);
  const loading = useChatStore((s) => s.loadingProjects);
  const error = useChatStore((s) => s.error);
  const loadProjects = useChatStore((s) => s.loadProjects);
  const loadAiLogins = useAiLoginStore((s) => s.load);
  const wide = useWideLayout();
  const openByRoute = useChatStore((s) => s.openByRoute);
  const subscribeEvents = useChatStore((s) => s.subscribeEvents);
  const tabs = useSessionsStore((s) => s.tabs);
  const loadSessions = useSessionsStore((s) => s.load);
  /** The split's right pane (spec 2026-09-28 iPad §2.3). Kept while the window is compact, so
   * widening it again brings the same screen back. */
  const [pane, setPane] = useState<Pane | null>(null);
  const selected = pane?.route ?? null;
  const chatPane = pane?.kind === 'chat' ? pane.route : null;
  // Read by the focus effect below without being among its deps: selecting a row already opens it
  // (it mounts `ConversationView`, whose own effect calls `openByRoute`), so the focus callback must
  // not change identity — and re-run — on every selection or width change, or it would fire a
  // redundant `openByRoute`/`loadProjects` on each tap and each rotation across the breakpoint.
  const setFavorite = useChatStore((s) => s.setFavorite);
  /** The project whose long-press sheet is open (TER-541). */
  const [sheetFor, setSheetFor] = useState<string | null>(null);
  const paneRef = useRef({ wide, chatPane });
  paneRef.current = { wide, chatPane };

  // On every focus, not only on mount: the tabs stay mounted under a pushed conversation, so a
  // decision or a finished answer there would otherwise leave this list stale. The split's pane is
  // re-opened too: a pushed conversation (a deep link, a notification) made itself the store's
  // active one, and the pane shows the active one — read from the ref, so this only happens on a
  // real focus, not on every render that changes `wide`/`selected`.
  useFocusEffect(
    useCallback(() => {
      void loadProjects();
      // The tabs, for the rows' "precisa de você" count and the sessions screen (TER-1106).
      void loadSessions();
      // An expired AI login shows its red warning here too (TER-1047).
      void loadAiLogins();
      const { wide, chatPane } = paneRef.current;
      if (wide && chatPane) void openByRoute(chatPane);
    }, [loadProjects, loadSessions, loadAiLogins, openByRoute]),
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

  const openChat = (route: string) => (wide ? setPane({ kind: 'chat', route }) : router.push(`/chat/${route}` as Href));
  const openSessions = (projectId: string) => (wide ? setPane({ kind: 'sessions', route: projectId }) : router.push(`/project-sessions/${projectId}` as Href));

  const waiting = tabsNeedingYou(tabs);
  const rows: (ProjectRowData & { pinned: boolean | null })[] = [
    { route: 'general', name: t('Chat geral'), busy: false, pending: 0, lastMessageAt: null, pinned: null },
    ...chatsOrder(projects).map((p) => ({
      route: p.id,
      name: p.name,
      busy: p.busy,
      pending: p.pending_confirmations,
      needsYou: waiting.get(p.id) ?? 0,
      lastMessageAt: p.last_message_at,
      pinned: isFavorite(p),
    })),
  ];
  const sheetProject = projects.find((p) => p.id === sheetFor);

  const list = (
    <>
      <View className="gap-3 px-6 pb-2 pt-4">
        <AppText variant="title">{t('Chats')}</AppText>
        <AiLoginBanner />
        {/* The store has one `error`: with a chat in the pane, the pane's banner already shows it. */}
        {error && !(wide && chatPane) ? <Banner tone="danger" text={error} /> : null}
      </View>
      <FlatList
        data={rows}
        keyExtractor={(row) => row.route}
        extraData={wide ? selected : null}
        renderItem={({ item }) => {
          // Chat geral is no project: it has no sessions, so its row is the chat itself.
          const project = item.pinned !== null;
          return (
            <ProjectRow
              row={item}
              selected={wide && item.route === selected}
              onPress={() => (project ? openSessions(item.route) : openChat(item.route))}
              actions={project ? { onSessions: () => openSessions(item.route), onChat: () => openChat(item.route) } : undefined}
              favorite={item.pinned === null ? undefined : { pinned: item.pinned, onToggle: () => void setFavorite(item.route, !item.pinned), onLongPress: () => setSheetFor(item.route) }}
            />
          );
        }}
        refreshControl={
          <RefreshControl
            refreshing={loading}
            onRefresh={() => {
              void loadProjects();
              void loadSessions();
            }}
          />
        }
      />
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
          {pane?.kind === 'chat' ? (
            <ConversationView key={`chat-${pane.route}`} routeId={pane.route} embedded />
          ) : pane?.kind === 'sessions' ? (
            <ProjectSessionsView key={`sessions-${pane.route}`} projectId={pane.route} embedded onOpenChat={() => setPane({ kind: 'chat', route: pane.route })} />
          ) : (
            <EmptyState title={t('Escolha uma conversa')} hint={t('Selecione um chat na lista ao lado.')} />
          )}
        </View>
      </View>
    </Screen>
  );
}
