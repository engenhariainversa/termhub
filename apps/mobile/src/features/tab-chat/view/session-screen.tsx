import { useLocalSearchParams, useRouter, type Href } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, KeyboardAvoidingView, Platform, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MessageBubble } from '@/features/chat/view/message-bubble';
import { Composer } from '@/features/chat/view/composer';
import { TabQuestionCard } from '@/features/chat/view/tab-question-card';
import { TabSuggestionCard } from '@/features/chat/view/tab-suggestion-card';
import type { PickedFile } from '@/features/chat/viewmodel/attachments';
import { kindFromNameAndMime, type TChatAttachment, type TTabQuestion, type TTabQuestionAnswerBody, type TTabSuggestion } from '@/services/api/contract';
import { ApiError } from '@/services/api/errors';
import { AppText, Banner, Button, EmptyState, MAX_READABLE_WIDTH, readableColumn, Screen } from '@/ui';
import { availabilityText } from '../model/availability-text';
import { TAB_CHAT_MSG } from '../model/messages';
import { buildRows, type Row } from '../model/timeline';
import { useTabChatStore } from '../viewmodel/useTabChatStore';
import { RawScreenSheet } from './raw-screen-sheet';
import { SessionHeader } from './session-header';
import { SessionMenu, type SessionMenuChoice } from './session-menu';
import { ToolsRow } from './tools-row';

const READABLE_COLUMN = readableColumn(MAX_READABLE_WIDTH);

/** Availabilities where nothing typed can reach the tab: the composer is off. */
const BLOCKED = new Set(['offline', 'agent_outdated', 'unsupported_machine']);
/** Availabilities where the transcript cannot be read but the tab can still be typed into and looked at. */
const SCREEN_ONLY = new Set(['no_session', 'unsupported_tool']);

type Entry = { kind: 'row'; row: Row } | { kind: 'question'; question: TTabQuestion } | { kind: 'suggestion'; suggestion: TTabSuggestion };

const entryKey = (e: Entry) => (e.kind === 'row' ? `r:${e.row.id}` : e.kind === 'question' ? `q:${e.question.id}` : `s:${e.suggestion.id}`);

/** A message row as the chat's bubble: same markdown for the assistant. A row's images are counted. */
function SessionMessage({ row, tabId }: { row: Extract<Row, { kind: 'message' }>; tabId: string }) {
  const message = useMemo(() => ({ id: row.id, conversation_id: '', role: row.role, text: row.text, usage: null, error_code: null, created_at: row.at }), [row]);
  // A Markdown path in the session's answer opens as a preview, read on the tab's machine.
  const fileContext = useMemo(() => ({ tabId }), [tabId]);
  return (
    <View className="gap-1">
      {row.text ? <MessageBubble message={message} streamed={undefined} started={false} fileContext={fileContext} /> : null}
      {row.images > 0 ? (
        <AppText variant="muted" className={row.role === 'user' ? 'self-end' : 'self-start'}>
          {row.images === 1 ? '1 imagem' : `${row.images} imagens`}
        </AppText>
      ) : null}
    </View>
  );
}

/** A file saved on the tab's machine, as a chip of the composer: its path stands in for an id. */
function asChip(file: PickedFile, path: string): TChatAttachment {
  return { id: path, name: file.name, mime: file.mime, kind: kindFromNameAndMime(file.name, file.mime) ?? 'text', bytes: file.bytes ?? 0, status: 'ready', error_code: null, meta: null, created_at: new Date().toISOString() };
}

/**
 * A terminal tab that runs Claude Code, read as a conversation (spec 2026-10-01 tab chat §6). The store
 * is this screen's own: opened on mount, closed when it goes. The composer is the chat's; its files go
 * to the tab's machine and their paths ride in the text, one per line. While the tab works, ↑ is
 * "Interromper". Nothing of the conversation is kept on the phone.
 */
export function SessionView({ tabId }: { tabId: string }) {
  const router = useRouter();
  const store = useTabChatStore(tabId);
  const status = store((s) => s.status);
  const tab = store((s) => s.tab);
  const availability = store((s) => s.availability);
  const items = store((s) => s.items);
  const mode = store((s) => s.mode);
  const degraded = store((s) => s.degraded);
  const questions = store((s) => s.questions);
  const suggestions = store((s) => s.suggestions);
  const sending = store((s) => s.sending);
  const error = store((s) => s.error);
  const loadingEarlier = store((s) => s.loadingEarlier);
  const answeringQuestionIds = store((s) => s.answeringQuestionIds);
  const questionErrors = store((s) => s.questionErrors);
  const busySuggestionIds = store((s) => s.busySuggestionIds);
  const suggestionErrors = store((s) => s.suggestionErrors);
  const { send, act, loadEarlier, answerTabQuestion, cancelAutoAnswer, loadTabQuestionScreen, sendTabSuggestion, dismissTabSuggestion, uploadFile, loadScreen } = store.getState();

  const [menuOpen, setMenuOpen] = useState(false);
  const [screenOpen, setScreenOpen] = useState(false);
  const insets = useSafeAreaInsets();
  const bodyRef = useRef<View>(null);
  const [bodyTop, setBodyTop] = useState<number | null>(null);
  const measureBody = useCallback(() => bodyRef.current?.measureInWindow((_x, y) => setBodyTop(y)), []);

  const working = tab?.state === 'working' && !tab.background;
  const rows = useMemo(() => buildRows(items, tab?.state === 'working'), [items, tab?.state]);
  // Newest first for the inverted list: the open cards sit after the last row.
  const entries = useMemo<Entry[]>(
    () => [
      ...suggestions.map((suggestion): Entry => ({ kind: 'suggestion', suggestion })).reverse(),
      ...questions.map((question): Entry => ({ kind: 'question', question })).reverse(),
      ...rows.map((row): Entry => ({ kind: 'row', row })).reverse(),
    ],
    [rows, questions, suggestions],
  );

  const onAnswer = useCallback((id: string, body: TTabQuestionAnswerBody) => void answerTabQuestion(id, body), [answerTabQuestion]);
  const onCancelAutoAnswer = useCallback((id: string) => void cancelAutoAnswer(id), [cancelAutoAnswer]);
  const onSendSuggestion = useCallback((id: string, text: string) => void sendTabSuggestion(id, text), [sendTabSuggestion]);
  const onDismissSuggestion = useCallback((id: string) => void dismissTabSuggestion(id), [dismissTabSuggestion]);

  const renderItem = useCallback(
    ({ item }: { item: Entry }) => {
      if (item.kind === 'question')
        return (
          <TabQuestionCard
            question={item.question}
            busy={answeringQuestionIds.includes(item.question.id)}
            error={questionErrors[item.question.id] ?? null}
            onAnswer={onAnswer}
            loadScreen={loadTabQuestionScreen}
            onCancelAutoAnswer={onCancelAutoAnswer}
          />
        );
      if (item.kind === 'suggestion')
        return (
          <TabSuggestionCard
            suggestion={item.suggestion}
            busy={busySuggestionIds.includes(item.suggestion.id)}
            error={suggestionErrors[item.suggestion.id] ?? null}
            onSend={onSendSuggestion}
            onDismiss={onDismissSuggestion}
          />
        );
      const row = item.row;
      if (row.kind === 'message') return <SessionMessage row={row} tabId={tabId} />;
      if (row.kind === 'tools') return <ToolsRow tools={row.tools} />;
      return (
        <AppText variant="muted" className="self-center text-center text-xs">
          {row.text}
        </AppText>
      );
    },
    [answeringQuestionIds, questionErrors, busySuggestionIds, suggestionErrors, onAnswer, onCancelAutoAnswer, onSendSuggestion, onDismissSuggestion, loadTabQuestionScreen, tabId],
  );

  // The composer's chips: the file is saved on the tab's machine; its path is sent as a line of the text.
  const uploadAttachment = useCallback(
    async (file: PickedFile, onProgress: (fraction: number) => void) => {
      try {
        const saved = await uploadFile(file);
        onProgress(1);
        return asChip(file, saved.path);
      } catch {
        throw new ApiError(0, 'TAB_FILE_FAILED', TAB_CHAT_MSG.fileFailed);
      }
    },
    [uploadFile],
  );
  // A file saved on the machine stays there: a removed chip only leaves the message.
  const deleteAttachment = useCallback(async () => undefined, []);
  const onSend = useCallback(
    (text: string, attachments: TChatAttachment[]) => send([text.trim(), ...attachments.map((a) => a.id)].filter(Boolean).join('\n')),
    [send],
  );

  const onMenu = (choice: SessionMenuChoice) => {
    if (choice === 'screen') setScreenOpen(true);
    else void act(choice);
  };
  const goBack = () => (router.canGoBack() ? router.back() : router.replace('/(tabs)/chats' as Href));
  const why = availabilityText(availability);

  return (
    <Screen padded={false} width="full">
      <View ref={bodyRef} className="flex-1" onLayout={measureBody}>
        <KeyboardAvoidingView className="flex-1" behavior={Platform.OS === 'ios' ? 'padding' : 'height'} keyboardVerticalOffset={bodyTop ?? insets.top}>
          <SessionHeader tab={tab} availability={availability} mode={mode} onBack={goBack} onMenu={() => setMenuOpen(true)} />
          {status === 'error' && error ? (
            <View className="px-4 pt-3">
              <Banner tone="danger" text={error} />
            </View>
          ) : null}
          {status === 'loading' ? (
            <View className="flex-1 items-center justify-center">
              <ActivityIndicator />
            </View>
          ) : entries.length === 0 ? (
            <View className="flex-1">{status === 'ready' ? <EmptyState title="Nenhuma mensagem ainda" hint="Escreva abaixo para falar com o Claude nesta aba." /> : null}</View>
          ) : (
            <FlatList
              testID="session-thread"
              inverted
              keyboardDismissMode="interactive"
              keyboardShouldPersistTaps="handled"
              data={entries}
              keyExtractor={entryKey}
              renderItem={renderItem}
              contentContainerClassName="gap-3 px-4 py-4"
              contentContainerStyle={READABLE_COLUMN}
              // Inverted: the end is the top of the conversation, where the earlier page goes.
              onEndReached={() => void loadEarlier()}
              onEndReachedThreshold={0.3}
              ListFooterComponent={loadingEarlier ? <ActivityIndicator /> : null}
            />
          )}
          <View style={READABLE_COLUMN}>
            {degraded ? <AppText variant="muted" className="px-4 pt-2 text-xs">{TAB_CHAT_MSG.degraded}</AppText> : null}
            {why ? (
              <View testID="session-availability" className="flex-row items-center gap-2 px-4 pt-2">
                <AppText variant="muted" className="flex-1">
                  {why}
                </AppText>
                {SCREEN_ONLY.has(availability) ? <Button label="Ver tela" variant="ghost" onPress={() => setScreenOpen(true)} /> : null}
              </View>
            ) : null}
            <Composer
              sending={sending}
              onSend={onSend}
              uploadAttachment={uploadAttachment}
              deleteAttachment={deleteAttachment}
              disabled={BLOCKED.has(availability)}
              onInterrupt={working ? () => void act('interrupt') : undefined}
            />
            {status !== 'error' && error ? <Text className="px-4 pb-2 text-xs text-app-danger">{error}</Text> : null}
          </View>
        </KeyboardAvoidingView>
      </View>
      <SessionMenu open={menuOpen} onClose={() => setMenuOpen(false)} onChoose={onMenu} />
      <RawScreenSheet open={screenOpen} onClose={() => setScreenOpen(false)} load={loadScreen} />
    </Screen>
  );
}

/** The `/session/[tabId]` route. */
export function SessionScreen() {
  const { tabId } = useLocalSearchParams<{ tabId: string }>();
  return <SessionView tabId={tabId} />;
}
