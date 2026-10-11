import { useRouter } from 'expo-router';
import { useEffect } from 'react';
import { Alert, FlatList, Linking, Switch, View } from 'react-native';
import type { TChatDecision, TConciergeNote, TLessonItem } from '@/services/api/contract';
import { TERMHUB_URL } from '@/services/api/config';
import { AppText, Banner, Button, EmptyState, Field, Screen } from '@/ui';
import { ContextLimitCard } from './context-limit-card';
import { useChatMemoryStore } from '../viewmodel/useChatMemoryStore';
import { t, tk, useTranslation } from '@/i18n';
import { formatDate } from '@/i18n/format';

const fmtDate = (iso: string) => formatDate(iso);

/** "Lições" (spec 2026-09-27 failure lessons §6/§8): labels for `evidence` (pt-BR keys, verbatim from the
 * binding clarifications; translated where shown) — the mobile twin of `ChatMemoryPage`'s `EVIDENCE_LABEL`. */
const EVIDENCE_LABEL: Record<TLessonItem['evidence'], string> = { observed: tk('observada'), fixed: tk('corrigida'), confirmed: tk('confirmada') };

/** "arquivo <path>" for a file-origin lesson, "anotação do projeto" for a note-origin one —
 * verbatim, copied from `ChatMemoryPage`'s `originText`. */
function originText(l: TLessonItem): string {
  return l.origin === 'file' ? t('arquivo {{path}}', { path: l.path ?? '' }) : t('anotação do projeto');
}

/** "Abrir origem" (binding clarifications): the PR link when `pr` is set; else the card, built as
 * the web app's own `/project/<ref>` URL (`TERMHUB_URL`, the same host the web app is served from)
 * since the phone has no in-app card screen to navigate to; `null` — a note-origin lesson with
 * neither — hides the action, as the app has no project notes screen either. */
function lessonSourceHref(l: TLessonItem): string | null {
  if (l.pr) return l.pr;
  if (l.card) return `${TERMHUB_URL}/project/${l.card}`;
  return null;
}

/** One decision's answer, as the list shows it: the picked labels, or the free text (chat decision
 * memory spec 2026-09-26 §4.6 — `answer.text` and `answer.labels` are mutually meaningful, never
 * both at once). Copied from `apps/web/src/pages/ChatMemoryPage.tsx`'s `answerText`. */
function answerText(d: TChatDecision): string {
  return d.answer.text ?? d.answer.labels.join(', ');
}

function DecisionRow({ decision, forgetting, onForget }: { decision: TChatDecision; forgetting: boolean; onForget(): void }) {
  const { t } = useTranslation();
  return (
    <View className="gap-1 rounded-xl border border-app-border bg-app-surface2 p-4">
      <AppText className="font-semibold">{decision.question}</AppText>
      <AppText variant="muted">{`→ ${answerText(decision)}`}</AppText>
      <AppText variant="muted" className="text-xs">
        {`${decision.project_name ?? t('sem projeto')} · ${fmtDate(decision.created_at)} · ${t('sugerida {{n}}×', { n: decision.suggested_count })} · ${t('aceita {{n}}×', { n: decision.accepted_count })}`}
      </AppText>
      <Button label={t('Esquecer')} variant="ghost" disabled={forgetting} onPress={onForget} />
    </View>
  );
}

/** "Anotações do concierge" (spec D12/§8): one `record_decision` note, as the list shows it — the
 * mobile twin of `ChatMemoryPage`'s row. */
function NoteRow({ note, forgetting, onForget }: { note: TConciergeNote; forgetting: boolean; onForget(): void }) {
  const { t } = useTranslation();
  return (
    <View className="gap-1 rounded-xl border border-app-border bg-app-surface2 p-4">
      <AppText className="font-semibold">{note.question}</AppText>
      <AppText variant="muted">{`→ ${note.decision}`}</AppText>
      <AppText variant="muted" className="text-xs">
        {`${note.reason} · ${note.project_name ?? t('sem projeto')} · ${fmtDate(note.created_at)}`}
      </AppText>
      <Button label={t('Esquecer')} variant="ghost" disabled={forgetting} onPress={onForget} />
    </View>
  );
}

/** "Lições" (spec 2026-09-27 failure lessons §6/§8): one `lesson` item, as the list shows it — the
 * mobile twin of `ChatMemoryPage`'s row. "Verificar"/"Desfazer verificação" is one button, the
 * direction decided by the row's own current state; "Abrir origem" is hidden when
 * `lessonSourceHref` has nothing to open. */
function LessonRow({
  lesson,
  verifying,
  forgetting,
  onToggleVerified,
  onForget,
}: {
  lesson: TLessonItem;
  verifying: boolean;
  forgetting: boolean;
  onToggleVerified(): void;
  onForget(): void;
}) {
  const { t } = useTranslation();
  const href = lessonSourceHref(lesson);
  return (
    <View className="gap-1 rounded-xl border border-app-border bg-app-surface2 p-4">
      <AppText className="font-semibold">{lesson.title}</AppText>
      <AppText variant="muted">{lesson.excerpt}</AppText>
      <AppText variant="muted" className="text-xs">
        {`${lesson.project?.name ?? t('sem projeto')} · ${originText(lesson)} · ${t(EVIDENCE_LABEL[lesson.evidence])} · ${fmtDate(lesson.created_at)}${lesson.verified ? ` · ${t('verificada')}` : ''}`}
      </AppText>
      <View className="flex-row flex-wrap items-center gap-3">
        <Button label={lesson.verified ? t('Desfazer verificação') : t('Verificar')} variant="ghost" disabled={verifying} onPress={onToggleVerified} />
        <Button label={t('Esquecer')} variant="ghost" disabled={forgetting} onPress={onForget} />
        {href ? <Button label={t('Abrir origem')} variant="ghost" onPress={() => void Linking.openURL(href)} /> : null}
      </View>
    </View>
  );
}

/**
 * "Memória do chat" (chat decision memory spec 2026-09-26 §5.2), route `/chat-memory`, reached from
 * a row in Ajustes: the switch, a search field and the list of remembered decisions, paginated —
 * the mobile twin of the web's `ChatMemoryPage`. "Esquecer" confirms with a native `Alert.alert`
 * (the web asks `window.confirm`); no PIN either way, consistent with TER-56's cards.
 */
export function ChatMemoryScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const memory = useChatMemoryStore((s) => s.memory);
  const decisions = useChatMemoryStore((s) => s.decisions);
  const cursor = useChatMemoryStore((s) => s.cursor);
  const q = useChatMemoryStore((s) => s.q);
  const loadingMore = useChatMemoryStore((s) => s.loadingMore);
  const switching = useChatMemoryStore((s) => s.switching);
  const forgettingId = useChatMemoryStore((s) => s.forgettingId);
  const error = useChatMemoryStore((s) => s.error);
  const load = useChatMemoryStore((s) => s.load);
  const search = useChatMemoryStore((s) => s.search);
  const loadMore = useChatMemoryStore((s) => s.loadMore);
  const toggle = useChatMemoryStore((s) => s.toggle);
  const setAutodecide = useChatMemoryStore((s) => s.setAutodecide);
  const setCodexReplies = useChatMemoryStore((s) => s.setCodexReplies);
  const setContextLimit = useChatMemoryStore((s) => s.setContextLimit);
  const forget = useChatMemoryStore((s) => s.forget);
  const cancel = useChatMemoryStore((s) => s.cancel);
  const notes = useChatMemoryStore((s) => s.notes);
  const notesCursor = useChatMemoryStore((s) => s.notesCursor);
  const loadingMoreNotes = useChatMemoryStore((s) => s.loadingMoreNotes);
  const forgettingNoteId = useChatMemoryStore((s) => s.forgettingNoteId);
  const notesError = useChatMemoryStore((s) => s.notesError);
  const loadNotes = useChatMemoryStore((s) => s.loadNotes);
  const loadMoreNotes = useChatMemoryStore((s) => s.loadMoreNotes);
  const forgetNote = useChatMemoryStore((s) => s.forgetNote);
  // "Lições" (spec 2026-09-27 failure lessons §6/§8): its own search box and pagination,
  // independent of both lists above.
  const lessons = useChatMemoryStore((s) => s.lessons);
  const lessonsCursor = useChatMemoryStore((s) => s.lessonsCursor);
  const lessonsQ = useChatMemoryStore((s) => s.lessonsQ);
  const loadingMoreLessons = useChatMemoryStore((s) => s.loadingMoreLessons);
  const verifyingLessonId = useChatMemoryStore((s) => s.verifyingLessonId);
  const forgettingLessonId = useChatMemoryStore((s) => s.forgettingLessonId);
  const lessonsError = useChatMemoryStore((s) => s.lessonsError);
  const lessonsNote = useChatMemoryStore((s) => s.lessonsNote);
  const loadLessons = useChatMemoryStore((s) => s.loadLessons);
  const searchLessons = useChatMemoryStore((s) => s.searchLessons);
  const loadMoreLessons = useChatMemoryStore((s) => s.loadMoreLessons);
  const toggleLessonVerified = useChatMemoryStore((s) => s.toggleLessonVerified);
  const forgetLesson = useChatMemoryStore((s) => s.forgetLesson);

  useEffect(() => {
    void load();
    // "Anotações do concierge" and "Lições" read on their own, independent of the search box above
    // — same as the web page's own effects for `api.chatNotes()`/`api.chat.lessons.list()`.
    void loadNotes();
    void loadLessons();
    // The store is a singleton that outlives this screen: leaving before a debounced search fires,
    // or while one is already in flight, must not let it land later and clobber the next visit's
    // own fresh `load()` — `cancel()` (createChatMemoryStore.ts) guards exactly that.
    return () => cancel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const goBack = () => (router.canGoBack() ? router.back() : router.replace('/(tabs)'));

  const confirmForget = (d: TChatDecision) => {
    Alert.alert(t('Esquecer esta decisão?'), `«${d.question}»`, [
      { text: t('Cancelar'), style: 'cancel' },
      { text: t('Esquecer'), style: 'destructive', onPress: () => void forget(d.id) },
    ]);
  };

  const confirmForgetNote = (n: TConciergeNote) => {
    Alert.alert(t('Esquecer esta anotação?'), `«${n.question}»`, [
      { text: t('Cancelar'), style: 'cancel' },
      { text: t('Esquecer'), style: 'destructive', onPress: () => void forgetNote(n.id) },
    ]);
  };

  /** "Esquecer esta lição?" verbatim (binding clarifications) — the mobile twin of the web's
   * `window.confirm('Esquecer esta lição?')`. */
  const confirmForgetLesson = (l: TLessonItem) => {
    Alert.alert(t('Esquecer esta lição?'), `«${l.title}»`, [
      { text: t('Cancelar'), style: 'cancel' },
      { text: t('Esquecer'), style: 'destructive', onPress: () => void forgetLesson(l.id) },
    ]);
  };

  return (
    <Screen padded={false}>
      <View className="flex-row items-center gap-2 border-b border-app-border px-2 py-2">
        <Button label={t('Voltar')} variant="ghost" onPress={goBack} />
        <AppText variant="title" className="flex-1 text-xl">
          {t('Memória do chat')}
        </AppText>
      </View>
      <View className="gap-3 px-6 pb-2 pt-4">
        <AppText variant="muted">
          {t('O que o concierge lembra das suas respostas anteriores, para sugerir a mesma resposta quando uma aba perguntar de novo.')}
        </AppText>
        {memory?.available === false ? (
          <AppText variant="muted">{t('Sugestões indisponíveis neste servidor')}</AppText>
        ) : memory ? (
          <>
            <View className="flex-row items-center justify-between gap-3 rounded-xl border border-app-border bg-app-surface2 p-3">
              <AppText className="flex-1">{t('Sugerir respostas com base nas minhas decisões')}</AppText>
              <Switch accessibilityLabel={t('Sugerir respostas com base nas minhas decisões')} value={memory.enabled} disabled={switching} onValueChange={() => void toggle()} />
            </View>
            <View className="gap-1 rounded-xl border border-app-border bg-app-surface2 p-3">
              <View className="flex-row items-center justify-between gap-3">
                <AppText className="flex-1">{t('Responder sozinho quando houver precedente')}</AppText>
                <Switch accessibilityLabel={t('Responder sozinho quando houver precedente')} value={memory.autodecide} onValueChange={(v) => void setAutodecide(v)} />
              </View>
              <AppText variant="muted" className="text-xs">
                {t('Quando a resposta repetir uma decisão sua recente, o concierge espera 60 segundos antes de responder por você, dando tempo de cancelar.')}
              </AppText>
            </View>
          </>
        ) : null}
        {/* Not tied to embeddings (`available`): the Codex reply card needs no precedent search. */}
        {memory ? (
          <View className="gap-1 rounded-xl border border-app-border bg-app-surface2 p-3">
            <View className="flex-row items-center justify-between gap-3">
              <AppText className="flex-1">{t('Responder perguntas do Codex pelo chat')}</AppText>
              <Switch accessibilityLabel={t('Responder perguntas do Codex pelo chat')} value={memory.codex_replies} onValueChange={(v) => void setCodexReplies(v)} />
            </View>
            <AppText variant="muted" className="text-xs">
              {t('Quando o Codex termina o turno com uma pergunta, abre um card no chat para você responder sem ir até a aba.')}
            </AppText>
          </View>
        ) : null}
        {/* TER-1038: the chat's context meter limit; not tied to embeddings either. */}
        {memory ? <ContextLimitCard limit={memory.context_limit ?? null} onSave={setContextLimit} /> : null}
        <Field label={t('Buscar')} value={q} onChangeText={search} placeholder={t('pergunta, resposta ou projeto')} testID="chat-memory-search" />
        {error ? <Banner tone="danger" text={error} /> : null}
      </View>
      {/* One scrolling region for both lists (design mirrors `ChatMemoryPage`'s single page): the
       * notes section always rides in the decisions `FlatList`'s footer, so it shows up whichever
       * state the decisions list itself is in (loading, empty or a page of rows). */}
      <FlatList
        data={decisions ?? []}
        keyExtractor={(d) => d.id}
        contentContainerClassName="gap-3 px-6 pb-6"
        renderItem={({ item }) => <DecisionRow decision={item} forgetting={forgettingId === item.id} onForget={() => confirmForget(item)} />}
        ListEmptyComponent={
          decisions === null ? (
            <View className="items-center justify-center py-6">
              <AppText variant="muted">{t('Carregando…')}</AppText>
            </View>
          ) : (
            <EmptyState title={t('Nenhuma decisão lembrada')} hint={t('Suas respostas às perguntas das abas aparecem aqui.')} />
          )
        }
        ListFooterComponent={
          <View className="gap-3">
            {cursor ? <Button label={loadingMore ? t('Carregando…') : t('Carregar mais')} variant="ghost" disabled={loadingMore} onPress={() => void loadMore()} /> : null}
            <View className="gap-3 pt-6">
              <AppText variant="title" className="text-base">
                {t('Anotações do concierge')}
              </AppText>
              <AppText variant="muted">{t('Decisões que o concierge registrou por conta própria, com o motivo que deu para cada uma.')}</AppText>
              {notesError ? <Banner tone="danger" text={notesError} /> : null}
              {notes === null ? (
                <AppText variant="muted">{t('Carregando…')}</AppText>
              ) : notes.length === 0 ? (
                <AppText variant="muted">{t('Nenhuma anotação ainda.')}</AppText>
              ) : (
                <View className="gap-3">
                  {notes.map((n) => (
                    <NoteRow key={n.id} note={n} forgetting={forgettingNoteId === n.id} onForget={() => confirmForgetNote(n)} />
                  ))}
                </View>
              )}
              {notesCursor ? (
                <Button label={loadingMoreNotes ? t('Carregando…') : t('Carregar mais anotações')} variant="ghost" disabled={loadingMoreNotes} onPress={() => void loadMoreNotes()} />
              ) : null}
            </View>
            <View className="gap-3 pt-6">
              <AppText variant="title" className="text-base">
                {t('Lições')}
              </AppText>
              <AppText variant="muted">
                {t('Erros que já aconteceram — de arquivos docs/lessons e de anotações do projeto — para o concierge não repetir.')}
              </AppText>
              <Field label={t('Buscar lições')} value={lessonsQ} onChangeText={searchLessons} placeholder={t('sintoma, projeto ou arquivo')} testID="chat-memory-lessons-search" />
              {lessonsError ? <Banner tone="danger" text={lessonsError} /> : null}
              {lessonsNote ? <AppText variant="muted">{lessonsNote}</AppText> : null}
              {lessons === null ? (
                <AppText variant="muted">{t('Carregando…')}</AppText>
              ) : lessons.length === 0 ? (
                <AppText variant="muted">{t('Nenhuma lição ainda.')}</AppText>
              ) : (
                <View className="gap-3">
                  {lessons.map((l) => (
                    <LessonRow
                      key={l.id}
                      lesson={l}
                      verifying={verifyingLessonId === l.id}
                      forgetting={forgettingLessonId === l.id}
                      onToggleVerified={() => void toggleLessonVerified(l.id, l.verified)}
                      onForget={() => confirmForgetLesson(l)}
                    />
                  ))}
                </View>
              )}
              {lessonsCursor ? (
                <Button label={loadingMoreLessons ? t('Carregando…') : t('Carregar mais lições')} variant="ghost" disabled={loadingMoreLessons} onPress={() => void loadMoreLessons()} />
              ) : null}
            </View>
          </View>
        }
      />
    </Screen>
  );
}
