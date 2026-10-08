import { i18n, tk, Trans, useTranslation } from '../i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import type { ChatDecision, ChatMemory, ConciergeNote, LessonItem } from '../lib/types';
import { formatDate } from '../lib/format';
import { MemoryStatusBadge, MemoryStatusControls } from '../components/MemoryStatusControls';

const fmtDate = (iso: string) => formatDate(iso);

/** "Lições" (spec 2026-09-27 failure lessons §6/§8): labels for the two enums the list shows —
 *  binding clarifications, verbatim (pt-BR keys, translated where shown). */
const EVIDENCE_LABEL: Record<LessonItem['evidence'], string> = { observed: tk('observada'), fixed: tk('corrigida'), confirmed: tk('confirmada') };
function originText(l: LessonItem): string {
  if (l.ai_memory) return i18n.t('ai-memory de {{machine}}: {{path}}', { machine: l.ai_memory.machine_name ?? '?', path: l.path ?? '' });
  return l.origin === 'file' ? i18n.t('arquivo {{path}}', { path: l.path ?? '' }) : i18n.t('anotação do projeto');
}

/** "Abrir origem": the PR link when `pr` is set, else the card (the web's `/project/<ref>` route),
 *  else — for a note-origin lesson — the project's own notes; `null` hides the action. */
function sourceHref(l: LessonItem): string | null {
  if (l.pr) return l.pr;
  if (l.card) return `/project/${l.card}`;
  if (l.origin === 'note' && l.project) return `/projects/${l.project.id}/notes`;
  return null;
}

/** One decision's answer, as the list shows it: the picked labels, or the free text (spec 2026-09-26
 * §4.6 — `answer.text` and `answer.labels` are mutually meaningful, never both at once). */
function answerText(d: ChatDecision): string {
  return d.answer.text ?? d.answer.labels.join(', ');
}

/**
 * "Memória do chat" (spec 2026-09-26 §5.2), at `/chat/memoria`: the switch, a search field and the
 * list of remembered decisions, paginated. Forgetting here is the same hard delete as "Esquecer esta
 * decisão" on a card — a card still pointing at a row removed here simply stops offering it. Marking
 * a decision or note "Desatualizada", "Errada" or "Substituída por…" (TER-1013) keeps it listed but out
 * of the default search and the precedents, and can be undone.
 */
export function ChatMemoryPage() {
  const { t } = useTranslation();
  const [memory, setMemory] = useState<ChatMemory | null>(null);
  const [decisions, setDecisions] = useState<ChatDecision[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const [autodeciding, setAutodeciding] = useState(false);
  const [codexSwitching, setCodexSwitching] = useState(false);
  const [forgettingId, setForgettingId] = useState<string | null>(null);
  // "Anotações do concierge" (spec D12/§8): its own list, independent of the search box above (which
  // only ever filters decisions) — fetched once, not re-read on every keystroke of `q`.
  const [notes, setNotes] = useState<ConciergeNote[] | null>(null);
  const [notesCursor, setNotesCursor] = useState<string | null>(null);
  const [notesError, setNotesError] = useState<string | null>(null);
  const [loadingMoreNotes, setLoadingMoreNotes] = useState(false);
  const [forgettingNoteId, setForgettingNoteId] = useState<string | null>(null);

  // "Lições" (spec 2026-09-27 failure lessons §6/§8): its own search box and pagination, independent of
  // the decisions one above. `lessonsGenRef` guards its search the same way `genRef` guards the
  // decisions one (a slow, superseded search must never clobber a newer one's result); verifying and
  // forgetting reuse `mountedRef` only, exactly like `toggle`/`forget` above.
  const [lessons, setLessons] = useState<LessonItem[] | null>(null);
  const [lessonsCursor, setLessonsCursor] = useState<string | null>(null);
  const [lessonsError, setLessonsError] = useState<string | null>(null);
  const [lessonsNote, setLessonsNote] = useState<string | null>(null);
  const [lessonsQ, setLessonsQ] = useState('');
  const [loadingMoreLessons, setLoadingMoreLessons] = useState(false);
  const [verifyingLessonId, setVerifyingLessonId] = useState<string | null>(null);
  const [forgettingLessonId, setForgettingLessonId] = useState<string | null>(null);
  const lessonsGenRef = useRef(0);

  /**
   * `genRef` guards against a slow, superseded search resolving after a newer one and overwriting its
   * results — the debounce below only ever cancels the *timer*, never a request already in flight.
   * Every "first page" load bumps it to a fresh value and only applies its result (`loadFirstPage`) or
   * appends its page (`loadMore`) if it is still the current one; unmounting also bumps it, so a load
   * still in flight at that point is dropped too.
   *
   * `toggle` and `forget` do *not* use `genRef`: a search starting (and even finishing) while their own
   * PATCH/DELETE is in flight must never make them drop their own successful result — that read the
   * switch back to its old value after a real toggle, or left a forgotten row still listed. They only
   * need to guard against the one hazard that is actually theirs: the page having unmounted by the time
   * they resolve. `mountedRef` is exactly that — true until the cleanup effect below turns it off.
   * Forgetting is safe to apply unconditionally otherwise: filtering a row out of whatever `decisions`
   * holds by then is a no-op if a newer search already replaced the list without that row in it.
   *
   * `togglesRef` counts completed toggles: a first-page load snapshots it when it starts and drops its
   * `mem` if a toggle completed meanwhile — that `GET /memory` may have been read before the PATCH
   * landed, and applying it would flip the switch back. Its list still applies.
   */
  const genRef = useRef(0);
  const togglesRef = useRef(0);
  const mountedRef = useRef(true);
  useEffect(
    () => () => {
      genRef.current += 1;
      mountedRef.current = false;
    },
    [],
  );

  /** Re-reads both halves from the first page: the switch/count line and the (possibly filtered) list. */
  const loadFirstPage = useCallback(async (query: string) => {
    const myGen = ++genRef.current;
    const myToggles = togglesRef.current;
    setError(null);
    try {
      const [mem, page] = await Promise.all([api.chatMemory(), api.chatDecisions(query || undefined)]);
      if (genRef.current !== myGen) return; // superseded by a newer search, or unmounted meanwhile
      if (togglesRef.current === myToggles) setMemory(mem); // else a toggle's own result is newer
      setDecisions(page.decisions);
      setCursor(page.next_cursor);
    } catch (e) {
      if (genRef.current !== myGen) return;
      setError(e instanceof ApiError ? e.message : i18n.t('Não foi possível carregar a memória do chat'));
    }
  }, []);

  // The first read runs at once; every change to `q` after that is debounced (~300ms) so typing does
  // not fire a request per keystroke.
  const didMount = useRef(false);
  useEffect(() => {
    if (!didMount.current) {
      didMount.current = true;
      void loadFirstPage(q);
      return;
    }
    const timer = setTimeout(() => void loadFirstPage(q), 300);
    return () => clearTimeout(timer);
  }, [q, loadFirstPage]);

  const loadMore = async () => {
    if (!cursor) return;
    const myGen = genRef.current;
    setLoadingMore(true);
    setError(null);
    try {
      const page = await api.chatDecisions(q || undefined, cursor);
      if (genRef.current !== myGen) return; // a newer search started, or unmounted, while this ran
      setDecisions((prev) => [...(prev ?? []), ...page.decisions]);
      setCursor(page.next_cursor);
    } catch (e) {
      if (genRef.current !== myGen) return;
      setError(e instanceof ApiError ? e.message : i18n.t('Não foi possível carregar mais decisões'));
    } finally {
      if (genRef.current === myGen) setLoadingMore(false);
    }
  };

  const toggle = async () => {
    if (!memory) return;
    setSwitching(true);
    setError(null);
    try {
      const next = await api.setChatMemory(!memory.enabled);
      togglesRef.current += 1;
      if (!mountedRef.current) return;
      setMemory(next);
    } catch (e) {
      if (!mountedRef.current) return;
      setError(e instanceof ApiError ? e.message : i18n.t('Não foi possível alterar a sugestão de respostas'));
    } finally {
      if (mountedRef.current) setSwitching(false);
    }
  };

  const forget = async (d: ChatDecision) => {
    if (!window.confirm(t('Esquecer a decisão sobre «{{question}}»?', { question: d.question }))) return;
    setForgettingId(d.id);
    setError(null);
    try {
      await api.forgetChatDecision(d.id);
      if (!mountedRef.current) return;
      setDecisions((prev) => (prev ?? []).filter((x) => x.id !== d.id));
    } catch (e) {
      if (!mountedRef.current) return;
      setError(e instanceof ApiError ? e.message : i18n.t('Não foi possível esquecer a decisão'));
    } finally {
      if (mountedRef.current) setForgettingId(null);
    }
  };

  /** "Responder sozinho quando houver precedente" (spec D8): shares the same `memory` row and `switching`
   *  guard model as `toggle` above, but its own busy flag — the two switches are independent controls. */
  const toggleAutodecide = async () => {
    if (!memory) return;
    setAutodeciding(true);
    setError(null);
    try {
      const next = await api.setChatMemory({ autodecide: !memory.autodecide });
      togglesRef.current += 1;
      if (!mountedRef.current) return;
      setMemory(next);
    } catch (e) {
      if (!mountedRef.current) return;
      setError(e instanceof ApiError ? e.message : i18n.t('Não foi possível alterar a resposta automática'));
    } finally {
      if (mountedRef.current) setAutodeciding(false);
    }
  };

  /** "Responder perguntas do Codex pelo chat": its own busy flag, like the autodecide switch. */
  const toggleCodexReplies = async () => {
    if (!memory) return;
    setCodexSwitching(true);
    setError(null);
    try {
      const next = await api.setChatMemory({ codex_replies: !memory.codex_replies });
      togglesRef.current += 1;
      if (!mountedRef.current) return;
      setMemory(next);
    } catch (e) {
      if (!mountedRef.current) return;
      setError(e instanceof ApiError ? e.message : i18n.t('Não foi possível alterar as respostas do Codex'));
    } finally {
      if (mountedRef.current) setCodexSwitching(false);
    }
  };

  useEffect(() => {
    api.chatNotes().then(
      (page) => {
        if (!mountedRef.current) return;
        setNotes(page.notes);
        setNotesCursor(page.next_cursor);
      },
      (e) => {
        if (!mountedRef.current) return;
        setNotesError(e instanceof ApiError ? e.message : i18n.t('Não foi possível carregar as anotações do concierge'));
      },
    );
    // mountedRef alone guards this: no search or toggle ever races a note's own state.
  }, []);

  const loadMoreNotes = async () => {
    if (!notesCursor) return;
    setLoadingMoreNotes(true);
    setNotesError(null);
    try {
      const page = await api.chatNotes(notesCursor);
      if (!mountedRef.current) return;
      setNotes((prev) => [...(prev ?? []), ...page.notes]);
      setNotesCursor(page.next_cursor);
    } catch (e) {
      if (!mountedRef.current) return;
      setNotesError(e instanceof ApiError ? e.message : i18n.t('Não foi possível carregar mais anotações'));
    } finally {
      if (mountedRef.current) setLoadingMoreNotes(false);
    }
  };

  const forgetNote = async (n: ConciergeNote) => {
    if (!window.confirm(t('Esquecer a anotação sobre «{{question}}»?', { question: n.question }))) return;
    setForgettingNoteId(n.id);
    setNotesError(null);
    try {
      await api.forgetChatNote(n.id);
      if (!mountedRef.current) return;
      setNotes((prev) => (prev ?? []).filter((x) => x.id !== n.id));
    } catch (e) {
      if (!mountedRef.current) return;
      setNotesError(e instanceof ApiError ? e.message : i18n.t('Não foi possível esquecer a anotação'));
    } finally {
      if (mountedRef.current) setForgettingNoteId(null);
    }
  };

  /** Re-reads the "Lições" list from its first page (own search box, own debounce below). */
  const loadLessonsFirstPage = useCallback(async (query: string) => {
    const myGen = ++lessonsGenRef.current;
    setLessonsError(null);
    try {
      const page = await api.chat.lessons.list({ q: query || undefined });
      if (lessonsGenRef.current !== myGen) return; // superseded by a newer search, or unmounted meanwhile
      setLessons(page.lessons);
      setLessonsCursor(page.next_cursor);
    } catch (e) {
      if (lessonsGenRef.current !== myGen) return;
      setLessonsError(e instanceof ApiError ? e.message : i18n.t('Não foi possível carregar as lições'));
    }
  }, []);

  const didMountLessons = useRef(false);
  useEffect(() => {
    if (!didMountLessons.current) {
      didMountLessons.current = true;
      void loadLessonsFirstPage(lessonsQ);
      return;
    }
    const timer = setTimeout(() => void loadLessonsFirstPage(lessonsQ), 300);
    return () => clearTimeout(timer);
  }, [lessonsQ, loadLessonsFirstPage]);

  const loadMoreLessons = async () => {
    if (!lessonsCursor) return;
    const myGen = lessonsGenRef.current;
    setLoadingMoreLessons(true);
    setLessonsError(null);
    try {
      const page = await api.chat.lessons.list({ q: lessonsQ || undefined, cursor: lessonsCursor });
      if (lessonsGenRef.current !== myGen) return;
      setLessons((prev) => [...(prev ?? []), ...page.lessons]);
      setLessonsCursor(page.next_cursor);
    } catch (e) {
      if (lessonsGenRef.current !== myGen) return;
      setLessonsError(e instanceof ApiError ? e.message : i18n.t('Não foi possível carregar mais lições'));
    } finally {
      if (lessonsGenRef.current === myGen) setLoadingMoreLessons(false);
    }
  };

  /** "Verificar" / "Desfazer verificação": one handler, the direction decided by the row's own current
   *  state — matches the button that was actually shown. */
  const toggleLessonVerified = async (l: LessonItem) => {
    setVerifyingLessonId(l.id);
    setLessonsError(null);
    try {
      const updated = l.verified ? await api.chat.lessons.unverify(l.id) : await api.chat.lessons.verify(l.id);
      if (!mountedRef.current) return;
      setLessons((prev) => (prev ?? []).map((x) => (x.id === updated.id ? updated : x)));
    } catch (e) {
      if (!mountedRef.current) return;
      setLessonsError(e instanceof ApiError ? e.message : i18n.t('Não foi possível verificar a lição'));
    } finally {
      if (mountedRef.current) setVerifyingLessonId(null);
    }
  };

  const forgetLesson = async (l: LessonItem) => {
    if (!window.confirm(t('Esquecer esta lição?'))) return;
    setForgettingLessonId(l.id);
    setLessonsError(null);
    setLessonsNote(null);
    try {
      const r = await api.chat.lessons.forget(l.id);
      if (!mountedRef.current) return;
      setLessons((prev) => (prev ?? []).filter((x) => x.id !== l.id));
      if (r.note) setLessonsNote(r.note);
    } catch (e) {
      if (!mountedRef.current) return;
      setLessonsError(e instanceof ApiError ? e.message : i18n.t('Não foi possível esquecer a lição'));
    } finally {
      if (mountedRef.current) setForgettingLessonId(null);
    }
  };

  return (
    <div className="w-full min-w-0 flex-1 overflow-y-auto px-4 py-6">
      <h2 className="text-lg font-semibold text-fg">{t('Memória do chat')}</h2>
      <p className="mt-1 text-sm text-fg-muted">
        {t('O que o concierge lembra das suas respostas anteriores, para sugerir a mesma resposta quando uma aba perguntar de novo.')}
      </p>

      {memory?.available === false ? (
        <p className="mt-4 text-sm text-fg-dim">{t('Sugestões indisponíveis neste servidor')}</p>
      ) : (
        memory && (
          <>
            <div className="mt-4 flex items-center justify-between gap-3 rounded-lg border border-line bg-bg-2 p-3">
              <span className="text-sm text-fg">{t('Sugerir respostas com base nas minhas decisões')}</span>
              <button
                type="button"
                role="switch"
                aria-checked={memory.enabled}
                aria-label={t('Sugerir respostas com base nas minhas decisões')}
                disabled={switching}
                onClick={() => void toggle()}
                className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${memory.enabled ? 'bg-accent' : 'bg-fg-dim/40'}`}
              >
                <span className={`absolute left-0 top-0.5 h-4 w-4 rounded-full transition-transform ${memory.enabled ? 'translate-x-[18px] bg-white' : 'translate-x-0.5 bg-fg-muted'}`} />
              </button>
            </div>
            <div className="mt-3 rounded-lg border border-line bg-bg-2 p-3">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm text-fg">{t('Responder sozinho quando houver precedente')}</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={memory.autodecide}
                  aria-label={t('Responder sozinho quando houver precedente')}
                  disabled={autodeciding}
                  onClick={() => void toggleAutodecide()}
                  className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${memory.autodecide ? 'bg-accent' : 'bg-fg-dim/40'}`}
                >
                  <span className={`absolute left-0 top-0.5 h-4 w-4 rounded-full transition-transform ${memory.autodecide ? 'translate-x-[18px] bg-white' : 'translate-x-0.5 bg-fg-muted'}`} />
                </button>
              </div>
              <p className="mt-1 text-xs text-fg-dim">
                {t('Quando a resposta repetir uma decisão sua recente, o concierge espera 60 segundos antes de responder por você, dando tempo de cancelar.')}
              </p>
            </div>
          </>
        )
      )}

      {/* Not tied to embeddings (`available`): the Codex reply card needs no precedent search. */}
      {memory && (
        <div className="mt-3 rounded-lg border border-line bg-bg-2 p-3">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm text-fg">{t('Responder perguntas do Codex pelo chat')}</span>
            <button
              type="button"
              role="switch"
              aria-checked={memory.codex_replies}
              aria-label={t('Responder perguntas do Codex pelo chat')}
              disabled={codexSwitching}
              onClick={() => void toggleCodexReplies()}
              className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${memory.codex_replies ? 'bg-accent' : 'bg-fg-dim/40'}`}
            >
              <span className={`absolute left-0 top-0.5 h-4 w-4 rounded-full transition-transform ${memory.codex_replies ? 'translate-x-[18px] bg-white' : 'translate-x-0.5 bg-fg-muted'}`} />
            </button>
          </div>
          <p className="mt-1 text-xs text-fg-dim">{t('Quando o Codex termina o turno com uma pergunta, abre um card no chat para você responder sem ir até a aba.')}</p>
        </div>
      )}

      <div className="mt-4">
        <label className="label" htmlFor="chat-memory-search">
          {t('Buscar')}
        </label>
        <input id="chat-memory-search" className="input mt-1" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('pergunta, resposta ou projeto')} />
      </div>

      {error && <p className="mt-3 text-sm text-danger">{error}</p>}

      {decisions === null ? (
        <p className="mt-4 text-sm text-fg-dim">{t('Carregando…')}</p>
      ) : decisions.length === 0 ? (
        <p className="mt-4 text-sm text-fg-dim">{t('Nenhuma decisão lembrada ainda.')}</p>
      ) : (
        <ul className="mt-4 space-y-2">
          {decisions.map((d) => (
            <li key={d.id} className="rounded-lg border border-line bg-bg-2 p-3 text-sm" data-status={d.status}>
              <p className={`whitespace-pre-wrap ${d.status === 'current' ? 'text-fg' : 'text-fg-muted line-through'}`}>{d.question}</p>
              <p className="mt-1 text-fg-muted">{`→ ${answerText(d)}`}</p>
              <p className="mt-1 text-xs text-fg-dim">
                {t('{{project}} · {{date}} · sugerida {{suggested}}× · aceita {{accepted}}×', {
                  project: d.project_name ?? t('sem projeto'),
                  date: fmtDate(d.created_at),
                  suggested: d.suggested_count,
                  accepted: d.accepted_count,
                })}
                {' · '}
                <MemoryStatusBadge status={d.status} supersededBy={d.superseded_by} />
              </p>
              <MemoryStatusControls
                kind="decision"
                id={d.id}
                status={d.status}
                setStatus={(status, by) => api.setDecisionStatus(d.id, status, by).then((r) => r.decision)}
                onChange={(updated) => setDecisions((prev) => (prev ?? []).map((x) => (x.id === updated.id ? updated : x)))}
                onError={setError}
              />
              <button type="button" className="btn-ghost mt-2 text-xs text-danger" disabled={forgettingId === d.id} onClick={() => void forget(d)}>
                {t('Esquecer')}
              </button>
            </li>
          ))}
        </ul>
      )}

      {cursor && (
        <button type="button" className="btn-ghost mt-4" disabled={loadingMore} onClick={() => void loadMore()}>
          {loadingMore ? t('Carregando…') : t('Carregar mais')}
        </button>
      )}

      <h3 className="mt-8 text-base font-semibold text-fg">{t('Anotações do concierge')}</h3>
      <p className="mt-1 text-sm text-fg-muted">{t('Decisões que o concierge registrou por conta própria, com o motivo que deu para cada uma.')}</p>

      {notesError && <p className="mt-3 text-sm text-danger">{notesError}</p>}

      {notes === null ? (
        <p className="mt-4 text-sm text-fg-dim">{t('Carregando…')}</p>
      ) : notes.length === 0 ? (
        <p className="mt-4 text-sm text-fg-dim">{t('Nenhuma anotação ainda.')}</p>
      ) : (
        <ul className="mt-4 space-y-2">
          {notes.map((n) => (
            <li key={n.id} className="rounded-lg border border-line bg-bg-2 p-3 text-sm" data-status={n.status}>
              <p className={`whitespace-pre-wrap ${n.status === 'current' ? 'text-fg' : 'text-fg-muted line-through'}`}>{n.question}</p>
              <p className="mt-1 text-fg-muted">{`→ ${n.decision}`}</p>
              <p className="mt-1 text-xs text-fg-dim">
                {`${n.reason} · ${n.project_name ?? t('sem projeto')} · ${fmtDate(n.created_at)} · `}
                <MemoryStatusBadge status={n.status} supersededBy={n.superseded_by} />
              </p>
              <MemoryStatusControls
                kind="note"
                id={n.id}
                status={n.status}
                setStatus={(status, by) => api.setNoteStatus(n.id, status, by).then((r) => r.note)}
                onChange={(updated) => setNotes((prev) => (prev ?? []).map((x) => (x.id === updated.id ? updated : x)))}
                onError={setNotesError}
              />
              <button type="button" className="btn-ghost mt-2 text-xs text-danger" disabled={forgettingNoteId === n.id} onClick={() => void forgetNote(n)}>
                {t('Esquecer')}
              </button>
            </li>
          ))}
        </ul>
      )}

      {notesCursor && (
        <button type="button" className="btn-ghost mt-4" disabled={loadingMoreNotes} onClick={() => void loadMoreNotes()}>
          {loadingMoreNotes ? t('Carregando…') : t('Carregar mais anotações')}
        </button>
      )}

      <h3 className="mt-8 text-base font-semibold text-fg">{t('Lições')}</h3>
      <p className="mt-1 text-sm text-fg-muted">
        <Trans i18nKey="Erros que já aconteceram — de arquivos <0>docs/lessons</0> e de anotações do projeto — para o concierge não repetir." components={[<code key="c" />]} />
      </p>

      <div className="mt-4">
        <label className="label" htmlFor="chat-memory-lessons-search">
          {t('Buscar lições')}
        </label>
        <input
          id="chat-memory-lessons-search"
          className="input mt-1"
          value={lessonsQ}
          onChange={(e) => setLessonsQ(e.target.value)}
          placeholder={t('sintoma, projeto ou arquivo')}
        />
      </div>

      {lessonsError && <p className="mt-3 text-sm text-danger">{lessonsError}</p>}
      {lessonsNote && <p className="mt-3 text-sm text-fg-dim">{lessonsNote}</p>}

      {lessons === null ? (
        <p className="mt-4 text-sm text-fg-dim">{t('Carregando…')}</p>
      ) : lessons.length === 0 ? (
        <p className="mt-4 text-sm text-fg-dim">{t('Nenhuma lição ainda.')}</p>
      ) : (
        <ul className="mt-4 space-y-2">
          {lessons.map((l) => {
            const href = sourceHref(l);
            return (
              <li key={l.id} className="rounded-lg border border-line bg-bg-2 p-3 text-sm">
                <p className="whitespace-pre-wrap text-fg">{l.title}</p>
                <p className="mt-1 text-fg-muted">{l.excerpt}</p>
                <p className="mt-1 text-xs text-fg-dim">
                  {`${l.project?.name ?? t('sem projeto')} · ${originText(l)} · ${t(EVIDENCE_LABEL[l.evidence])} · ${fmtDate(l.created_at)}`}
                  {l.verified && (
                    <>
                      {' · '}
                      <span className="text-ok">{t('verificada')}</span>
                    </>
                  )}
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-3">
                  <button type="button" className="btn-ghost text-xs" disabled={verifyingLessonId === l.id} onClick={() => void toggleLessonVerified(l)}>
                    {l.verified ? t('Desfazer verificação') : t('Verificar')}
                  </button>
                  <button type="button" className="btn-ghost text-xs text-danger" disabled={forgettingLessonId === l.id} onClick={() => void forgetLesson(l)}>
                    {t('Esquecer')}
                  </button>
                  {href &&
                    (href.startsWith('http') ? (
                      <a href={href} target="_blank" rel="noreferrer" className="btn-ghost text-xs">
                        {t('Abrir origem')}
                      </a>
                    ) : (
                      <Link to={href} className="btn-ghost text-xs">
                        {t('Abrir origem')}
                      </Link>
                    ))}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {lessonsCursor && (
        <button type="button" className="btn-ghost mt-4" disabled={loadingMoreLessons} onClick={() => void loadMoreLessons()}>
          {loadingMoreLessons ? t('Carregando…') : t('Carregar mais lições')}
        </button>
      )}
    </div>
  );
}
