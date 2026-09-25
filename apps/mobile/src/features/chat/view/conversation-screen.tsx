import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, KeyboardAvoidingView, Platform, View } from 'react-native';
import { AppText, Banner, Button, EmptyState, Screen, Sheet } from '@/ui';
import { isGrantActive } from '../model/grant-time';
import { foldLive } from '../model/live';
import { chatTimeline, type ChatEntry } from '../model/timeline';
import type { ChatDecision } from '../viewmodel/createChatStore';
import { useChatStore } from '../viewmodel/useChatStore';
import { ActionCard } from './action-card';
import { Composer } from './composer';
import { GrantsStrip } from './grants-strip';
import { HostLine } from './host-line';
import { MessageBubble } from './message-bubble';

const entryKey = (entry: ChatEntry) => (entry.kind === 'message' ? `m:${entry.message.id}` : `a:${entry.action.id}`);

/** The conversation (spec §11.2): thread, action cards, host line, the trusted tabs and composer.
 * The route param is a conversation id (a deep link), a project id or `general` — the store
 * resolves which. */
export function ConversationScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const openByRoute = useChatStore((s) => s.openByRoute);
  const activeProject = useChatStore((s) => s.activeProject);
  const slot = useChatStore((s) => (s.activeProject === undefined ? undefined : s.conversations[s.activeProject ?? '']));
  const projects = useChatStore((s) => s.projects);
  const live = useChatStore((s) => s.live);
  const error = useChatStore((s) => s.error);
  const sending = useChatStore((s) => s.sending);
  const decidingId = useChatStore((s) => s.decidingId);
  const send = useChatStore((s) => s.send);
  const decide = useChatStore((s) => s.decide);
  const revokingId = useChatStore((s) => s.revokingId);
  const revokeGrant = useChatStore((s) => s.revokeGrant);
  const reset = useChatStore((s) => s.reset);
  const [confirmingReset, setConfirmingReset] = useState(false);

  useEffect(() => {
    if (id) void openByRoute(id);
  }, [id, openByRoute]);

  const fold = useMemo(() => foldLive(live), [live]);
  const messages = slot?.messages;
  const actions = slot?.actions;
  const grants = useMemo(() => slot?.grants ?? [], [slot?.grants]);
  const extra = useMemo(() => ({ fold, decidingId, grants, revokingId }), [fold, decidingId, grants, revokingId]);
  // A deep link followed after unlock replaces `/unlock` with this screen: nothing behind it.
  const goBack = () => (router.canGoBack() ? router.back() : router.replace('/(tabs)'));
  const onDecide = useCallback((actionId: string, decision: ChatDecision) => void decide(actionId, decision), [decide]);
  const onRevoke = useCallback((grantId: string) => void revokeGrant(grantId), [revokeGrant]);
  // Newest first, for the inverted list that keeps the thread pinned to its end.
  const entries = useMemo(() => chatTimeline(messages ?? [], actions ?? []).reverse(), [messages, actions]);

  const title = activeProject ? (projects.find((p) => p.id === activeProject)?.name ?? 'Conversa') : 'Chat geral';
  const shownError = error ?? slot?.error ?? null;

  const confirmReset = () => {
    setConfirmingReset(false);
    void reset();
  };

  return (
    <Screen padded={false}>
      <KeyboardAvoidingView className="flex-1" behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View className="flex-row items-center gap-2 border-b border-app-border px-2 py-2">
          <Button label="Voltar" variant="ghost" onPress={goBack} />
          <AppText variant="title" className="flex-1 text-xl" numberOfLines={1}>
            {title}
          </AppText>
          <Button label="Nova conversa" variant="ghost" onPress={() => setConfirmingReset(true)} />
        </View>
        {slot?.host ? <HostLine host={slot.host} canChange={activeProject === null} /> : null}
        {shownError ? (
          <View className="px-4 pt-3">
            <Banner tone="danger" text={shownError} />
          </View>
        ) : null}
        {entries.length === 0 ? (
          slot && !slot.loaded && !slot.error ? (
            <View className="flex-1 items-center justify-center">
              <ActivityIndicator />
            </View>
          ) : (
            <EmptyState title="Nenhuma mensagem ainda" hint="Escreva abaixo para começar a conversa." />
          )
        ) : (
          <FlatList
            inverted
            data={entries}
            keyExtractor={entryKey}
            contentContainerClassName="gap-3 px-4 py-4"
            // The rows read `fold`, `decidingId`, `grants` and `revokingId` besides `entries`: a change
            // there re-runs `renderItem`, and the memoised rows re-render only where their own props changed.
            extraData={extra}
            renderItem={({ item }) =>
              item.kind === 'message' ? (
                <MessageBubble message={item.message} streamed={fold.deltas.get(item.message.id)} started={fold.started.has(item.message.id)} />
              ) : (
                <ActionCard
                  action={item.action}
                  busy={decidingId !== null}
                  onDecide={onDecide}
                  grant={grants.find((g) => g.source_action_id === item.action.id && isGrantActive(g))}
                  revoking={revokingId !== null}
                  onRevoke={onRevoke}
                />
              )
            }
          />
        )}
        <GrantsStrip grants={grants} revokingId={revokingId} onRevoke={onRevoke} />
        <Composer sending={sending} onSend={send} />
      </KeyboardAvoidingView>
      <Sheet open={confirmingReset} onClose={() => setConfirmingReset(false)} title="Começar uma nova conversa?">
        <View className="gap-3">
          <AppText variant="muted">A conversa atual fica arquivada e o chat começa do zero.</AppText>
          <Button label="Começar nova conversa" variant="danger" onPress={confirmReset} />
          <Button label="Cancelar" variant="ghost" onPress={() => setConfirmingReset(false)} />
        </View>
      </Sheet>
    </Screen>
  );
}
