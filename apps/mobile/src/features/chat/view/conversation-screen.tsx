import { useLocalSearchParams, useRouter } from 'expo-router';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Keyboard, KeyboardAvoidingView, Platform, Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from '@/i18n';
import type { TChatAttachment, TTabQuestionAnswerBody } from '@/services/api/contract';
import { AppText, Banner, Button, EmptyState, Icon, type IconName, MAX_READABLE_WIDTH, readableColumn, Screen } from '@/ui';
import { inboxKey } from '../model/chat-inbox';
import { activeGrantIndex } from '../model/grant-time';
import { isReplyable, replyRefOf, replyRefOfCard, type ReplyableCard, type ReplyRef } from '../model/reply';
import { isActive } from '../model/subagents';
import { chatTimeline, groupPendingActions, type ChatEntry } from '../model/timeline';
import type { ChatAction, ChatMessage, ChatStandingGrant } from '../model/types';
import type { ChatDecision } from '../viewmodel/createChatStore';
import { useChatStore } from '../viewmodel/useChatStore';
import { ActionCard } from './action-card';
import { ActionGroupCard } from './action-group-card';
import { Composer } from './composer';
import { HostLine } from './host-line';
import { MessageBubble } from './message-bubble';
import { PendingBar } from './pending-bar';
import { SwipeToReply } from './swipe-to-reply';
import { TabLimitCard } from './tab-limit-card';
import { TabQuestionCard } from './tab-question-card';
import { TabSuggestionCard } from './tab-suggestion-card';

/** How far from its end (the inverted list's offset 0) the reader counts as scrolled up (TER-984), like
 * the web's `isNearBottom`; within it, the thread follows what arrives (TER-1001). */
const NEAR_END = 80;
/** The inverted list's offset 0 is the thread's end, and new rows come in at index 0, before every row
 * on screen: the scroll view keeps the first visible row where it is when rows come in or grow before
 * it (TER-1001), so a reader scrolled up stays on the line they were reading; a reader within
 * `NEAR_END` of the end is taken along to the new end instead. */
const KEEP_READING_POSITION = { minIndexForVisible: 0, autoscrollToTopThreshold: NEAR_END };
/** How often the grant index re-checks expiry (spec §4.2 "Stable rows"): never during render. */
const GRANT_TICK_MS = 30_000;
/** The header's way to the conversation's settings (TER-1039). */
const SETTINGS_ICON: IconName = { ios: 'gearshape', android: 'settings' };

const entryKey = (entry: ChatEntry) =>
  entry.kind === 'message'
    ? // A sent row keeps its local key once it becomes the server's: no remount, no flash (TER-1001).
      `m:${entry.message.row_key ?? entry.message.id}`
    : entry.kind === 'action'
      ? `a:${entry.action.id}`
      : entry.kind === 'action_group'
        ? `g:${entry.actions[0]!.id}`
        : entry.kind === 'tab_suggestion'
          ? `s:${entry.suggestion.id}`
          : entry.kind === 'tab_limit'
            ? `l:${entry.limit.id}`
            : `q:${entry.question.id}`;

/** Whether `entry` is the card of the action or question `id` — a group holds several actions. */
const holds = (entry: ChatEntry, id: string): boolean =>
  (entry.kind === 'action' && entry.action.id === id) ||
  (entry.kind === 'action_group' && entry.actions.some((a) => a.id === id)) ||
  (entry.kind === 'tab_question' && entry.question.id === id);

/** How long the thread waits, after an approximate scroll, to retry a jump to a row not measured yet. */
const JUMP_RETRY_MS = 300;

/** The thread and the composer never stretch past a readable width (spec 2026-09-28 iPad §2.4); the
 * header and the list's own frame still span the pane. */
const READABLE_COLUMN = readableColumn(MAX_READABLE_WIDTH);

/** One message row, subscribed to its own streamed text (spec §4.2 "Incremental fold"): a delta
 * re-renders this row and nothing else — `renderItem` and `extraData` do not change for it.
 * Every started row waits, not only the newest: with queued or injected turns several answers can be
 * pending at once (spec 2026-09-26 concierge always free), and a process that dies closes its open
 * turns with a reason, so a leftover reads as the failure it is. */
const MessageRow = memo(function MessageRow({
  message,
  onReply,
  onOpenReply,
  highlighted,
}: {
  message: ChatMessage;
  onReply(message: ChatMessage): void;
  onOpenReply(id: string): boolean;
  highlighted: boolean;
}) {
  const streamed = useChatStore((s) => s.live.deltas.get(message.id));
  const started = useChatStore((s) => s.live.started.has(message.id));
  const retrySend = useChatStore((s) => s.retrySend);
  const onRetry = useCallback((id: string) => void retrySend(id), [retrySend]);
  const reply = useCallback(() => onReply(message), [onReply, message]);
  // Markdown paths in an answer open as previews, looked for on the conversation's project machines.
  const activeProject = useChatStore((s) => s.activeProject);
  const fileContext = useMemo(() => ({ projectId: activeProject ?? null }), [activeProject]);
  const bubble = <MessageBubble message={message} streamed={streamed} started={started} onRetry={onRetry} onOpenReply={onOpenReply} highlighted={highlighted} fileContext={fileContext} />;
  // Only a row the server has, with something in it, can be answered (TER-447). The wrapper stays either
  // way: a sent row becoming the server's, or an answer getting its text, is not remounted (TER-1001).
  return (
    <SwipeToReply onReply={reply} enabled={isReplyable(message)}>
      {bubble}
    </SwipeToReply>
  );
});

/** The conversation (spec §11.2): thread, action cards, the host line when the host needs attention,
 * the pending bar and composer; the header's cog opens its settings (TER-1039). `routeId` is a conversation id (a deep link), a project id or
 * `general` — the store resolves which. `embedded` is the iPad split's right pane (spec 2026-09-28
 * §2.3): no "Voltar", the list next to it is the way out. */
export function ConversationView({ routeId, embedded = false }: { routeId: string; embedded?: boolean }) {
  const { t } = useTranslation();
  const router = useRouter();
  const openByRoute = useChatStore((s) => s.openByRoute);
  const activeProject = useChatStore((s) => s.activeProject);
  const slot = useChatStore((s) => (s.activeProject === undefined ? undefined : s.conversations[s.activeProject ?? '']));
  const projects = useChatStore((s) => s.projects);
  const error = useChatStore((s) => s.error);
  const sending = useChatStore((s) => s.sending);
  const decidingId = useChatStore((s) => s.decidingId);
  const send = useChatStore((s) => s.send);
  const uploadAttachment = useChatStore((s) => s.uploadAttachment);
  const deleteAttachment = useChatStore((s) => s.deleteAttachment);
  const attachmentStatuses = useChatStore((s) => s.attachmentStatuses);
  const decide = useChatStore((s) => s.decide);
  const decideMany = useChatStore((s) => s.decideMany);
  const revokingId = useChatStore((s) => s.revokingId);
  const revokeGrant = useChatStore((s) => s.revokeGrant);
  const answeringQuestionIds = useChatStore((s) => s.answeringQuestionIds);
  const questionErrors = useChatStore((s) => s.questionErrors);
  const answerTabQuestion = useChatStore((s) => s.answerTabQuestion);
  const cancelAutoAnswer = useChatStore((s) => s.cancelAutoAnswer);
  const loadTabQuestionScreen = useChatStore((s) => s.loadTabQuestionScreen);
  const busySuggestionIds = useChatStore((s) => s.busySuggestionIds);
  const suggestionErrors = useChatStore((s) => s.suggestionErrors);
  const forgetDecision = useChatStore((s) => s.forgetDecision);
  const sendTabSuggestion = useChatStore((s) => s.sendTabSuggestion);
  const dismissTabSuggestion = useChatStore((s) => s.dismissTabSuggestion);
  const busyLimitIds = useChatStore((s) => s.busyLimitIds);
  const limitErrors = useChatStore((s) => s.limitErrors);
  const answerTabLimit = useChatStore((s) => s.answerTabLimit);
  /** "Ver separadas" holds only for the cards it was clicked on: a new or decided card groups again. */
  const [separate, setSeparate] = useState(false);
  const insets = useSafeAreaInsets();
  /** Where the keyboard-avoiding view's parent starts on screen; `null` until measured. */
  const bodyRef = useRef<View>(null);
  const [bodyTop, setBodyTop] = useState<number | null>(null);
  const measureBody = useCallback(() => bodyRef.current?.measureInWindow((_x, y) => setBodyTop(y)), []);

  // The subagents panel lives in the conversation's settings (TER-1039); a dot on the cog keeps a
  // running subagent noticeable from here.
  const subagentsRunning = useMemo(() => (slot?.subagents ?? []).some(isActive), [slot?.subagents]);

  useEffect(() => {
    if (routeId) void openByRoute(routeId);
  }, [routeId, openByRoute]);

  // Answering a message (TER-447): the screen owns the reference, dropped with the conversation.
  const [replyTo, setReplyTo] = useState<ReplyRef | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const conversationId = slot?.conversation?.id;
  useEffect(() => setReplyTo(null), [routeId, conversationId]);
  useEffect(() => {
    if (highlightId === null) return;
    const timer = setTimeout(() => setHighlightId(null), 1500);
    return () => clearTimeout(timer);
  }, [highlightId]);
  const onReply = useCallback((message: ChatMessage) => setReplyTo(replyRefOf(message)), []);
  // A confirmation or a tab's question is answered the same way (TER-849).
  const onReplyCard = useCallback((card: ReplyableCard) => setReplyTo(replyRefOfCard(card)), []);
  const cancelReply = useCallback(() => setReplyTo(null), []);

  const messages = slot?.messages;
  const actions = slot?.actions;
  const grants = useMemo(() => slot?.grants ?? [], [slot?.grants]);
  const projectGrants = useMemo(() => slot?.projectGrants ?? [], [slot?.projectGrants]);
  // Standing grants ("Liberar sem prazo") never expire: no tick re-checks them.
  const standingGrants = useMemo(() => slot?.standingGrants ?? [], [slot?.standingGrants]);
  const tabQuestions = slot?.tabQuestions;
  const tabSuggestions = slot?.tabSuggestions;
  const tabLimits = slot?.tabLimits;

  // The grants still in force, by the card that created them: built when `grants`/`projectGrants`
  // change and every 30 s while there are any (a grant runs out on its own), never inside a row's render.
  const [grantTick, setGrantTick] = useState(0);
  useEffect(() => {
    if (grants.length === 0 && projectGrants.length === 0) return;
    const timer = setInterval(() => setGrantTick((t) => t + 1), GRANT_TICK_MS);
    return () => clearInterval(timer);
  }, [grants.length, projectGrants.length]);
  // `grantTick` is a dependency on purpose: it is what re-checks expiry.
  const grantIndex = useMemo(() => activeGrantIndex(grants), [grants, grantTick]);
  const projectGrantIndex = useMemo(() => activeGrantIndex(projectGrants), [projectGrants, grantTick]);
  const standingGrantIndex = useMemo(() => {
    const index = new Map<string, ChatStandingGrant>();
    for (const g of standingGrants) if (g.source_action_id !== null) index.set(g.source_action_id, g);
    return index;
  }, [standingGrants]);

  // A deep link followed after unlock replaces `/unlock` with this screen: nothing behind it.
  const goBack = () => (router.canGoBack() ? router.back() : router.replace('/(tabs)/chats'));
  const onDecide = useCallback((actionId: string, decision: ChatDecision) => void decide(actionId, decision), [decide]);
  const onDecideMany = useCallback((d: { id: string; decision: 'approve' | 'deny' }[]) => void decideMany(d), [decideMany]);
  const onRevoke = useCallback((grantId: string) => void revokeGrant(grantId), [revokeGrant]);
  const onAnswer = useCallback((id: string, body: TTabQuestionAnswerBody) => void answerTabQuestion(id, body), [answerTabQuestion]);
  const onCancelAutoAnswer = useCallback((id: string) => void cancelAutoAnswer(id), [cancelAutoAnswer]);
  const onForget = useCallback((decisionId: string) => forgetDecision(decisionId), [forgetDecision]);
  const onSendSuggestion = useCallback((id: string, text: string) => void sendTabSuggestion(id, text), [sendTabSuggestion]);
  const onDismissSuggestion = useCallback((id: string) => void dismissTabSuggestion(id), [dismissTabSuggestion]);
  const onAnswerLimit = useCallback((id: string, accountId: string | null) => void answerTabLimit(id, accountId), [answerTabLimit]);
  // "Propor de novo" (TER-477): a plain chat message; the concierge proposes a fresh card through the gate.
  const onRepropose = useCallback((action: ChatAction) => void send(t('Proponha de novo: {{summary}}', { summary: action.summary })), [send, t]);
  const onApproveWrites = useCallback((ids: string[]) => void decideMany(ids.map((id) => ({ id, decision: 'approve' as const }))), [decideMany]);
  const timeline = useMemo(
    () => chatTimeline(messages ?? [], actions ?? [], tabQuestions ?? [], tabSuggestions ?? [], tabLimits ?? []),
    [messages, actions, tabQuestions, tabSuggestions, tabLimits],
  );
  const pendingKey = (actions ?? [])
    .filter((a) => a.status === 'pending')
    .map((a) => a.id)
    .join(',');
  useEffect(() => setSeparate(false), [pendingKey]);
  // Newest first, for the inverted list that keeps the thread pinned to its end.
  const entries = useMemo(() => (separate ? timeline : groupPendingActions(timeline)).slice().reverse(), [separate, timeline]);
  // The pending bar's jump (TER-477): scrolls the thread to the row that holds the card. A row far
  // up the list may not be measured yet: `onScrollToIndexFailed` scrolls to its estimated offset,
  // which renders it, then tries once more.
  const listRef = useRef<FlatList<ChatEntry>>(null);
  const retriedJump = useRef(false);
  const onJump = useCallback(
    (id: string) => {
      const index = entries.findIndex((e) => holds(e, id));
      if (index < 0) return;
      retriedJump.current = false;
      listRef.current?.scrollToIndex({ index, viewPosition: 0.5, animated: true });
    },
    [entries],
  );
  const onScrollToIndexFailed = useCallback((info: { index: number; averageItemLength: number }) => {
    listRef.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: false });
    if (retriedJump.current) return;
    retriedJump.current = true;
    setTimeout(() => listRef.current?.scrollToIndex({ index: info.index, viewPosition: 0.5, animated: true }), JUMP_RETRY_MS);
  }, []);

  // TER-984: the "novas mensagens" pill, as on the web. The inverted list shows its end at offset 0, so
  // a reader there sees what arrives; one scrolled up (past `NEAR_END`) stays where they are reading
  // (`KEEP_READING_POSITION`, TER-1001) and is told how many rows arrived at the end — the rows newer
  // than the end they last saw, or one when the newest row was replaced — and the pill takes them back.
  const farFromEnd = useRef(false);
  const [unread, setUnread] = useState(0);
  const lastEnd = useRef(entries[0] ? entryKey(entries[0]) : '');
  useEffect(() => {
    const before = lastEnd.current;
    lastEnd.current = entries[0] ? entryKey(entries[0]) : '';
    if (!farFromEnd.current || lastEnd.current === before) return;
    const newer = entries.findIndex((e) => entryKey(e) === before);
    setUnread((n) => n + (newer > 0 ? newer : 1));
  }, [entries]);
  const onScroll = useCallback((e: { nativeEvent: { contentOffset: { y: number } } }) => {
    farFromEnd.current = e.nativeEvent.contentOffset.y > NEAR_END;
    if (!farFromEnd.current) setUnread(0);
  }, []);
  const toEnd = useCallback(() => {
    farFromEnd.current = false;
    setUnread(0);
    listRef.current?.scrollToOffset({ offset: 0, animated: true });
  }, []);

  // The preview goes with the text, at once, and comes back with it if the send fails. What the person
  // writes reads at the end, as in any messaging app, wherever they had scrolled to (TER-1001).
  const onSend = useCallback(
    async (text: string, attachments: TChatAttachment[]) => {
      const quoted = replyTo;
      if (quoted) setReplyTo(null);
      toEnd();
      const ok = await (quoted ? send(text, attachments, quoted) : send(text, attachments));
      if (!ok && quoted) setReplyTo((current) => current ?? quoted);
      return ok;
    },
    [replyTo, send, toEnd],
  );

  // A quote's tap (TER-447): the original, if the thread has it, scrolls to the middle the same way
  // and is outlined for a moment. Read through a ref so the rows' callback stays stable across deltas.
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const onOpenReply = useCallback((id: string): boolean => {
    // A card's quote (TER-849) finds its card, alone or in a group, like the pending bar's jump.
    const index = entriesRef.current.findIndex((e) => (e.kind === 'message' && e.message.id === id) || holds(e, id));
    if (index < 0) return false;
    retriedJump.current = false;
    listRef.current?.scrollToIndex({ index, viewPosition: 0.5, animated: true });
    setHighlightId(id);
    return true;
  }, []);

  // Stable across deltas: a message row reads its own streamed text from the store (`MessageRow`),
  // so neither this callback nor `extra` change while an answer streams. The memoised rows re-render
  // only where their own props changed.
  const onShowSeparately = useCallback(() => setSeparate(true), []);
  const renderItem = useCallback(
    ({ item }: { item: ChatEntry }) =>
      item.kind === 'tab_suggestion' ? (
        <TabSuggestionCard
          suggestion={item.suggestion}
          busy={busySuggestionIds.includes(item.suggestion.id)}
          error={suggestionErrors[item.suggestion.id] ?? null}
          onSend={onSendSuggestion}
          onDismiss={onDismissSuggestion}
        />
      ) : item.kind === 'tab_limit' ? (
        <TabLimitCard limit={item.limit} busy={busyLimitIds.includes(item.limit.id)} error={limitErrors[item.limit.id] ?? null} onAnswer={onAnswerLimit} />
      ) : item.kind === 'tab_question' ? (
        <SwipeToReply onReply={() => onReplyCard({ kind: 'tab_question', question: item.question })}>
          <TabQuestionCard
            question={item.question}
            busy={answeringQuestionIds.includes(item.question.id)}
            error={questionErrors[item.question.id] ?? null}
            onAnswer={onAnswer}
            loadScreen={loadTabQuestionScreen}
            onForget={onForget}
            onCancelAutoAnswer={onCancelAutoAnswer}
          />
        </SwipeToReply>
      ) : item.kind === 'message' ? (
        <MessageRow message={item.message} onReply={onReply} onOpenReply={onOpenReply} highlighted={highlightId === item.message.id} />
      ) : item.kind === 'action_group' ? (
        <ActionGroupCard actions={item.actions} busy={decidingId !== null} onDecide={onDecideMany} onShowSeparately={onShowSeparately} />
      ) : (
        <SwipeToReply onReply={() => onReplyCard({ kind: 'action', action: item.action })}>
          <ActionCard
            action={item.action}
            busy={decidingId !== null}
            onDecide={onDecide}
            grant={grantIndex.get(item.action.id)}
            projectGrant={projectGrantIndex.get(item.action.id)}
            standingGrant={standingGrantIndex.get(item.action.id)}
            revoking={revokingId !== null}
            onRevoke={onRevoke}
            onRepropose={onRepropose}
          />
        </SwipeToReply>
      ),
    [
      answeringQuestionIds,
      questionErrors,
      busySuggestionIds,
      suggestionErrors,
      busyLimitIds,
      limitErrors,
      decidingId,
      grantIndex,
      projectGrantIndex,
      standingGrantIndex,
      highlightId,
      loadTabQuestionScreen,
      onOpenReply,
      onReply,
      onReplyCard,
      onAnswer,
      onAnswerLimit,
      onCancelAutoAnswer,
      onDecide,
      onForget,
      onDecideMany,
      onShowSeparately,
      onDismissSuggestion,
      onRevoke,
      onRepropose,
      onSendSuggestion,
      revokingId,
    ],
  );
  const extra = useMemo(
    () => ({ decidingId, grantIndex, projectGrantIndex, standingGrantIndex, revokingId, answeringQuestionIds, questionErrors, busySuggestionIds, suggestionErrors, busyLimitIds, limitErrors, highlightId }),
    [decidingId, grantIndex, projectGrantIndex, standingGrantIndex, revokingId, answeringQuestionIds, questionErrors, busySuggestionIds, suggestionErrors, busyLimitIds, limitErrors, highlightId],
  );

  const title = activeProject ? (projects.find((p) => p.id === activeProject)?.name ?? t('Conversa')) : t('Chat geral');
  const shownError = error ?? slot?.error ?? null;

  return (
    <Screen padded={false} width="full">
      {/* `padding` on iOS, `height` on Android (spec §4.2 "Keyboard"): stock behaviour on both, no
          extra native module. The avoiding view compares its frame, relative to its parent, with the
          keyboard's top on screen: the offset is where that parent really starts on screen, measured,
          so the composer lands right on the keyboard. It used to be assumed to be the top safe-area
          inset; wherever the screen really starts elsewhere, the pill floated off the keyboard by the
          difference. */}
      <View ref={bodyRef} testID="conversation-body" className="flex-1" onLayout={measureBody}>
      <KeyboardAvoidingView testID="conversation-keyboard" className="flex-1" behavior={Platform.OS === 'ios' ? 'padding' : 'height'} keyboardVerticalOffset={bodyTop ?? insets.top}>
        {/* The header block — title, host line, error — and the footer block below — pending bar, composer —
            are siblings of the list, never rows inside it: a line appearing there changes the list's
            frame, not its content, and the inverted list keeps its end pinned through that. */}
        <View>
          <View className={`flex-row items-center gap-2 border-b border-app-border py-2 ${embedded ? 'px-4' : 'px-2'}`}>
            {embedded ? null : <Button label={t('Voltar')} variant="ghost" onPress={goBack} />}
            <AppText variant="title" className="flex-1 text-xl" numberOfLines={1}>
              {title}
            </AppText>
            {/* Everything else about the conversation — where it runs, subagents, trusted tabs, memory,
                "Nova conversa" — is one tap away, in its settings (TER-1039). */}
            <Pressable
              testID="conversation-settings"
              accessibilityRole="button"
              accessibilityLabel={t('Configurações da conversa')}
              hitSlop={8}
              onPress={() => router.push('/chat-settings')}
              className="h-10 w-10 items-center justify-center rounded-full"
            >
              <Icon name={SETTINGS_ICON} size={22} tone="muted" />
              {subagentsRunning ? <View testID="conversation-settings-dot" className="absolute right-1.5 top-1.5 h-2.5 w-2.5 rounded-full bg-app-accent" /> : null}
            </Pressable>
          </View>
          {/* Inline only when something stands in the way (offline, no machine, none chosen, an old
              agent): a ready host — account-wide or a project's, with its accounts, model and files
              (spec 2026-09-30 project AI accounts §8) — is shown in the conversation's settings. */}
          {slot?.host && slot.host.kind !== 'ready' ? <HostLine host={slot.host} canChange={activeProject === null} projectId={activeProject ?? null} /> : null}
          {shownError ? (
            <View className="px-4 pt-3">
              <Banner tone="danger" text={shownError} />
            </View>
          ) : null}
        </View>
        {entries.length === 0 ? (
          slot && !slot.loaded && !slot.error ? (
            <View className="flex-1 items-center justify-center">
              <ActivityIndicator />
            </View>
          ) : (
            // A tap on the empty thread dismisses the keyboard, as dragging the list does below.
            <Pressable accessible={false} className="flex-1" onPress={Keyboard.dismiss}>
              <EmptyState title={t('Nenhuma mensagem ainda')} hint={t('Escreva abaixo para começar a conversa.')} />
            </Pressable>
          )
        ) : (
          <View className="flex-1">
          <FlatList
            ref={listRef}
            testID="conversation-thread"
            inverted
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="handled"
            data={entries}
            keyExtractor={entryKey}
            contentContainerClassName="gap-3 px-4 py-4"
            contentContainerStyle={READABLE_COLUMN}
            extraData={extra}
            renderItem={renderItem}
            onScrollToIndexFailed={onScrollToIndexFailed}
            maintainVisibleContentPosition={KEEP_READING_POSITION}
            onScroll={onScroll}
            scrollEventThrottle={64}
          />
          {unread > 0 ? (
            <View pointerEvents="box-none" className="absolute bottom-2 left-0 right-0 items-center">
              <Pressable testID="conversation-unread" accessibilityRole="button" onPress={toEnd} className="rounded-full border border-app-border bg-app-surface2 px-3 py-1">
                <AppText variant="muted">{t('↓ {{count}} novas mensagens', { count: unread })}</AppText>
              </Pressable>
            </View>
          ) : null}
          </View>
        )}
        {/* The footer block, a sibling of the list like the header: its height changes the list's
            frame, not its content (spec 2026-09-26 §4.2 "Keyboard"). */}
        <View testID="conversation-composer-column" style={READABLE_COLUMN}>
          {/* What waits on the person, however far up the thread (TER-477); hidden while nothing does. */}
          <PendingBar entries={timeline} deciding={decidingId !== null} onJump={onJump} onApprove={onApproveWrites} />
          <Composer sending={sending} onSend={onSend} replyTo={replyTo} onCancelReply={cancelReply} uploadAttachment={uploadAttachment} deleteAttachment={deleteAttachment} attachmentStatuses={attachmentStatuses} inbox={activeProject === undefined ? undefined : inboxKey(activeProject)} />
        </View>
      </KeyboardAvoidingView>
      </View>
    </Screen>
  );
}

/** The `/chat/[id]` route: the conversation full screen, with "Voltar". */
export function ConversationScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <ConversationView routeId={id} />;
}
