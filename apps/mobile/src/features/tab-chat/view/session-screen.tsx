import { useLocalSearchParams, useRouter, type Href } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Text, View } from 'react-native';
import { replyRefOf, type ReplyRef } from '@/features/chat/model/reply';
import { MessageBubble } from '@/features/chat/view/message-bubble';
import { MessageMenu } from '@/features/chat/view/message-menu';
import { Composer } from '@/features/chat/view/composer';
import { TabQuestionCard } from '@/features/chat/view/tab-question-card';
import { TabSuggestionCard } from '@/features/chat/view/tab-suggestion-card';
import type { PickedFile } from '@/features/chat/viewmodel/attachments';
import { useTranslation } from '@/i18n';
import { kindFromNameAndMime, type TChatAttachment, type TTabQuestion, type TTabQuestionAnswerBody, type TTabSuggestion } from '@/services/api/contract';
import { ApiError } from '@/services/api/errors';
import { AppText, Banner, Button, EmptyState, KeyboardInsetView, MAX_READABLE_WIDTH, readableColumn, Screen } from '@/ui';
import { availabilityText } from '../model/availability-text';
import { emptyReasonText } from '../model/empty-reason-text';
import { TAB_CHAT_MSG } from '../model/messages';
import { quotedText } from '../model/reply-text';
import { buildRows, type Row } from '../model/timeline';
import { useSessionsStore } from '../viewmodel/useSessionsStore';
import { useTabChatStore } from '../viewmodel/useTabChatStore';
import { RawScreenSheet } from './raw-screen-sheet';
import { SessionHeader } from './session-header';
import { SessionMenu, type SessionMenuChoice } from './session-menu';
import { StartAgentPanel } from './start-agent-panel';
import { ToolsRow } from './tools-row';

const READABLE_COLUMN = readableColumn(MAX_READABLE_WIDTH);

/** Availabilities where nothing typed can reach the tab: the composer is off. */
const BLOCKED = new Set(['offline', 'agent_outdated', 'unsupported_machine']);
/** Availabilities where the transcript cannot be read but the tab can still be typed into and looked at. */
const SCREEN_ONLY = new Set(['no_session', 'unsupported_tool']);

type Entry = { kind: 'row'; row: Row } | { kind: 'question'; question: TTabQuestion } | { kind: 'suggestion'; suggestion: TTabSuggestion } | { kind: 'first'; text: string };

const entryKey = (e: Entry) => (e.kind === 'row' ? `r:${e.row.id}` : e.kind === 'question' ? `q:${e.question.id}` : e.kind === 'suggestion' ? `s:${e.suggestion.id}` : 'first');

/** The first message of a session started from this phone, shown as sent until the transcript brings it (TER-1107). */
function FirstPrompt({ text }: { text: string }) {
  const { t } = useTranslation();
  const message = useMemo(() => ({ id: 'first-prompt', conversation_id: '', role: 'user' as const, text, usage: null, error_code: null, created_at: '' }), [text]);
  return (
    <View testID="session-first-prompt" className="gap-1">
      <MessageBubble message={message} streamed={undefined} started={false} />
      <AppText variant="muted" className="self-end text-xs">
        {t('Enviada · o agente está iniciando')}
      </AppText>
    </View>
  );
}

/** A message row as the chat's bubble: same markdown for the assistant. A row's images are counted. A
 * touch held on it opens its menu, with "Responder" quoting it above the composer (TER-1090). */
function SessionMessage({ row, tabId, onReply }: { row: Extract<Row, { kind: 'message' }>; tabId: string; onReply(ref: ReplyRef): void }) {
  const { t } = useTranslation();
  const message = useMemo(() => ({ id: row.id, conversation_id: '', role: row.role, text: row.text, usage: null, error_code: null, created_at: row.at }), [row]);
  // A Markdown path in the session's answer opens as a preview, read on the tab's machine.
  const fileContext = useMemo(() => ({ tabId }), [tabId]);
  return (
    <View className="gap-1">
      {row.text ? (
        <MessageMenu message={message} onReply={() => onReply({ ...replyRefOf(message), ...(message.role === 'assistant' ? { author: 'Claude' } : {}) })}>
          <MessageBubble message={message} streamed={undefined} started={false} fileContext={fileContext} />
        </MessageMenu>
      ) : null}
      {row.images > 0 ? (
        <AppText variant="muted" className={row.role === 'user' ? 'self-end' : 'self-start'}>
          {t('{{count}} imagens', { count: row.images })}
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
  const { t } = useTranslation();
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
  const emptyReason = store((s) => s.emptyReason);
  const installingHooks = store((s) => s.installingHooks);
  const hooksInstalled = store((s) => s.hooksInstalled);
  const agentOptions = store((s) => s.agentOptions);
  const agentOptionsError = store((s) => s.agentOptionsError);
  const startingAgent = store((s) => s.startingAgent);
  const startAgentError = store((s) => s.startAgentError);
  const agentStarted = store((s) => s.agentStarted);
  const { send, act, installHooks, startAgent, loadEarlier, answerTabQuestion, cancelAutoAnswer, loadTabQuestionScreen, sendTabSuggestion, dismissTabSuggestion, uploadFile, loadScreen } = store.getState();

  const [menuOpen, setMenuOpen] = useState(false);
  const [screenOpen, setScreenOpen] = useState(false);
  const [replyTo, setReplyTo] = useState<ReplyRef | null>(null);
  const cancelReply = useCallback(() => setReplyTo(null), []);

  // The first message typed in "Nova sessão": shown until the transcript has a message of the person's.
  const firstPrompt = useSessionsStore((s) => s.firstPrompts[tabId] ?? null);
  const dropFirstPrompt = useSessionsStore((s) => s.dropFirstPrompt);
  const transcriptHasPrompt = useMemo(() => items.some((i) => i.kind === 'user'), [items]);
  useEffect(() => {
    if (firstPrompt !== null && transcriptHasPrompt) dropFirstPrompt(tabId);
  }, [firstPrompt, transcriptHasPrompt, dropFirstPrompt, tabId]);
  const pendingFirst = firstPrompt !== null && !transcriptHasPrompt ? firstPrompt : null;

  const working = tab?.state === 'working' && !tab.background;
  const rows = useMemo(() => buildRows(items, tab?.state === 'working'), [items, tab?.state]);
  // Newest first for the inverted list: the open cards sit after the last row, the first message before the first.
  const entries = useMemo<Entry[]>(
    () => [
      ...suggestions.map((suggestion): Entry => ({ kind: 'suggestion', suggestion })).reverse(),
      ...questions.map((question): Entry => ({ kind: 'question', question })).reverse(),
      ...rows.map((row): Entry => ({ kind: 'row', row })).reverse(),
      ...(pendingFirst !== null ? [{ kind: 'first', text: pendingFirst } as Entry] : []),
    ],
    [rows, questions, suggestions, pendingFirst],
  );

  const onAnswer = useCallback((id: string, body: TTabQuestionAnswerBody) => void answerTabQuestion(id, body), [answerTabQuestion]);
  const onCancelAutoAnswer = useCallback((id: string) => void cancelAutoAnswer(id), [cancelAutoAnswer]);
  const onSendSuggestion = useCallback((id: string, text: string) => void sendTabSuggestion(id, text), [sendTabSuggestion]);
  const onDismissSuggestion = useCallback((id: string) => void dismissTabSuggestion(id), [dismissTabSuggestion]);

  const renderItem = useCallback(
    ({ item }: { item: Entry }) => {
      if (item.kind === 'first') return <FirstPrompt text={item.text} />;
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
      if (row.kind === 'message') return <SessionMessage row={row} tabId={tabId} onReply={setReplyTo} />;
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
    async (text: string, attachments: TChatAttachment[]) => {
      const quoted = replyTo;
      const ok = await send(quotedText(quoted, [text.trim(), ...attachments.map((a) => a.id)].filter(Boolean).join('\n')));
      if (ok && quoted) setReplyTo((current) => (current === quoted ? null : current));
      return ok;
    },
    [send, replyTo],
  );

  const onMenu = (choice: SessionMenuChoice) => {
    if (choice === 'screen') setScreenOpen(true);
    else void act(choice);
  };
  const goBack = () => (router.canGoBack() ? router.back() : router.replace('/(tabs)/chats' as Href));
  const why = availabilityText(availability);
  const empty = emptyReasonText(emptyReason, tab?.machine.name ?? '');
  // An agent started in another tab (this one's shell was busy): the screen follows it there.
  const onStartAgent = async (accountId?: string) => {
    const newTab = await startAgent(accountId);
    if (newTab) router.replace(`/session/${newTab}` as Href);
  };
  const emptyAction =
    emptyReason === 'no_agent' && !agentStarted && !BLOCKED.has(availability) ? (
      <StartAgentPanel options={agentOptions} optionsError={agentOptionsError} starting={startingAgent} error={startAgentError} onStart={(id) => void onStartAgent(id)} />
    ) : empty.install && !hooksInstalled && !BLOCKED.has(availability) ? (
      <Button testID="session-install-hooks" label={empty.install} onPress={() => void installHooks()} loading={installingHooks} />
    ) : undefined;

  return (
    <Screen padded={false} width="full">
      {/* The composer sits on the keyboard, the same way as the chat's (TER-1022). */}
      <KeyboardInsetView testID="session-body">
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
          <View className="flex-1">
            {status === 'ready' ? (
              // Never blank without a reason (TER-1091): why there is no history, and what brings it.
              <View testID="session-empty" className="flex-1">
                <EmptyState
                  title={empty.title}
                  hint={agentStarted && emptyReason === 'no_agent' ? TAB_CHAT_MSG.agentStarted : hooksInstalled ? TAB_CHAT_MSG.hooksInstalled : empty.hint}
                  action={emptyAction}
                />
              </View>
            ) : null}
          </View>
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
              {SCREEN_ONLY.has(availability) ? <Button label={t('Ver tela')} variant="ghost" onPress={() => setScreenOpen(true)} /> : null}
            </View>
          ) : null}
          <Composer
            sending={sending}
            onSend={onSend}
            replyTo={replyTo}
            onCancelReply={cancelReply}
            uploadAttachment={uploadAttachment}
            deleteAttachment={deleteAttachment}
            disabled={BLOCKED.has(availability)}
            onInterrupt={working ? () => void act('interrupt') : undefined}
          />
          {status !== 'error' && error ? <Text className="px-4 pb-2 text-xs text-app-danger">{error}</Text> : null}
        </View>
      </KeyboardInsetView>
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
