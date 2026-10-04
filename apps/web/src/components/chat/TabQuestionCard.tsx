import { memo, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { TabQuestion, TabQuestionAnswer, TabQuestionChoice, TabQuestionPermission, TabQuestionSuggestionItem } from '../../lib/types';
import { AutoDecisionBadge } from './AutoDecisionBadge';
import { ChatReplyButton } from './ChatReplyButton';
import { answerSummary, autoAnswerFailureText, autoAnswerSeconds, choiceAnswerDescription, choiceAnswerLabel, choiceTitle, formatCountdown, permissionTitle, statusLabel, suggestionLine, suggestionSourceSentence, tabLabel } from './tab-question-text';

export interface TabQuestionCardProps {
  question: TabQuestion;
  /** This card's answer is in flight: every control is disabled. */
  answering: boolean;
  /** Why the last answer did not go through (pt-BR). */
  error?: string | null;
  /** Takes the question's id, so the panel can pass one stable callback to every card. */
  onAnswer: (id: string, body: TabQuestionAnswer) => void;
  /** The tab's live excerpt, for a permission card while it is open. Stable across renders. */
  loadScreen?: (id: string) => Promise<string>;
  /** "Esquecer esta decisão" on a suggestion line (chat decision memory spec §5.1): forgets the past
   *  decision it came from, then the card clears that question's pre-selection. */
  onForget?: (decisionId: string) => Promise<void>;
  /** "Cancelar" on a countdown (spec 2026-09-26 concierge memory §6): like `onAnswer`, fire-and-forget —
   *  `ChatPanel` calls the API, updates this question from the response and surfaces a failure through
   *  `error` (409 `NOT_SCHEDULED` — the countdown already sent — gets its own sentence). */
  onCancelAutoAnswer?: (id: string) => void;
  /** "Responder no chat" (TER-849): quotes this card in the composer, where "Responder" answers the tab. */
  onReply?: (question: TabQuestion) => void;
}

/**
 * A question an agent in a tab asked, inline in the thread (spec 2026-09-25 §6.2). Presentational:
 * the request and the error handling live in `ChatPanel`. Everything shown is plain text — never HTML.
 */
export const TabQuestionCard = memo(function TabQuestionCard(props: TabQuestionCardProps) {
  const { question, error } = props;
  return (
    // `data-chat-card`: how the pending bar finds this card to scroll to it (TER-477).
    <li data-chat-card={question.id} className="chat-enter group rounded-xl border border-attention/40 bg-bg-2 px-4 py-3 text-sm">
      {question.kind === 'choice' ? <ChoiceBody {...props} question={question} /> : <PermissionBody {...props} question={question} />}
      {props.onReply && (
        <div className="mt-1 flex justify-end">
          <ChatReplyButton label="Responder no chat" onClick={() => props.onReply?.(question)} />
        </div>
      )}
      {/* TER-641: the countdown decides (or decided) this card by itself, from memory. */}
      {question.auto_decision && <AutoDecisionBadge decision={question.auto_decision} />}
      {question.status !== 'open' && <p className="mt-1 text-xs text-fg-dim">{statusLabel(question)}</p>}
      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
    </li>
  );
});

function ChoiceBody({ question, answering, onAnswer, onForget, onCancelAutoAnswer }: TabQuestionCardProps & { question: TabQuestionChoice }) {
  const items = question.payload.questions;
  const [current, setCurrent] = useState(0);
  // Pre-selected from a similar past decision (spec 2026-09-26 §4.2/§5.1): only present while the card
  // is `open`, and only for the questions that matched. `hint` shrinks as each is forgotten.
  const [hint, setHint] = useState(() => question.suggestion?.items ?? []);
  const [selected, setSelected] = useState<number[][]>(() => items.map((_, i) => hint.find((s) => s.question_index === i)?.selected ?? []));
  const [texts, setTexts] = useState<string[]>(() => items.map((_, i) => hint.find((s) => s.question_index === i)?.text ?? ''));
  // Which questions the person has looked at (the first one is shown at once). A pre-selected answer on
  // a tab never opened must not go out with "Responder", so it waits until every suggested one was seen.
  const [viewed, setViewed] = useState<boolean[]>(() => items.map((_, i) => i === 0));
  // A suggestion can land after the card is on screen (the concierge's wake → `answer_tab_question`
  // path, 10–60 s later): `hint` follows it, keyed by its items' contents so a republish of the same
  // suggestion changes nothing (and never brings back one the person forgot). It also becomes the
  // pre-selection — but only while the person has not edited the card: their own choice always wins.
  const touched = useRef(false);
  const suggestionStamp = JSON.stringify(question.suggestion?.items ?? []);
  const seededStamp = useRef(suggestionStamp);
  useEffect(() => {
    if (seededStamp.current === suggestionStamp) return;
    seededStamp.current = suggestionStamp;
    const next = question.suggestion?.items ?? [];
    setHint(next);
    if (touched.current) return;
    setSelected(items.map((_, i) => next.find((s) => s.question_index === i)?.selected ?? []));
    setTexts(items.map((_, i) => next.find((s) => s.question_index === i)?.text ?? ''));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suggestionStamp]);
  /** Automatic answer countdown (spec 2026-09-26 concierge memory §6/§8): unlike the pre-selection
   *  above, this one tracks `question.auto_answer` on every render — `ChatPanel` owns the cancel call and hands
   *  this card the updated question back, so the countdown/cancelled/sent/failed state always follows
   *  the current prop (a websocket event updates it exactly the same way). */
  const auto = question.auto_answer ?? null;
  const [seconds, setSeconds] = useState(() => (auto?.status === 'scheduled' ? autoAnswerSeconds(auto.due_at) : 0));
  const [forgettingPrecedent, setForgettingPrecedent] = useState(false);
  useEffect(() => {
    if (auto?.status !== 'scheduled') return;
    const dueAt = auto.due_at;
    const tick = () => setSeconds(autoAnswerSeconds(dueAt));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [auto?.status, auto?.status === 'scheduled' ? auto.due_at : null]);
  // "Cancelar" resolved (or a websocket event landed): the proposed answer becomes this question's own
  // pre-selection, now editable — regardless of whether a matching `suggestion` item also exists.
  useEffect(() => {
    if (auto?.status !== 'cancelled') return;
    const a = auto.answer;
    setSelected(items.map((_, i) => a.answers[i]?.selected ?? []));
    setTexts(items.map((_, i) => a.answers[i]?.text ?? ''));
    setViewed(items.map(() => true));
    // Only the transition into `cancelled` re-seeds the pre-selection — once there, the person's own
    // edits (toggling an option, forgetting a suggestion) must not be overwritten by this effect again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto?.status]);
  const title = <p className="font-medium text-fg">{choiceTitle(question)}</p>;
  if (question.status !== 'open') {
    // The countdown is over, but a `failed` one is never shown on a closed card (controller ruling): it
    // only ever explains why *this still-open card* has not answered itself; a `sent` one is the
    // successful automatic answer below (`answered_via: 'auto'`).
    const autoAnswered = question.answered_via === 'auto' && question.auto_answer;
    const forgetPrecedent = async () => {
      if (!question.auto_answer) return;
      setForgettingPrecedent(true);
      try {
        await Promise.allSettled(question.auto_answer.sources.filter((s) => s.kind === 'decision').map((s) => onForget?.(s.id)));
      } finally {
        setForgettingPrecedent(false);
      }
    };
    return (
      <>
        {title}
        <ul className="mt-1 space-y-0.5 whitespace-pre-wrap text-fg">
          {answerSummary(question).map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
        {autoAnswered && (
          <>
            <p className="mt-1 text-fg-dim">{`Respondida automaticamente: «${choiceAnswerLabel(question.payload, question.auto_answer!.answer)}» — motivo ${question.auto_answer!.reason}`}</p>
            <button type="button" className="btn-ghost mt-1 text-xs" disabled={forgettingPrecedent} onClick={() => void forgetPrecedent()}>
              Esquecer o precedente
            </button>
          </>
        )}
      </>
    );
  }
  // A countdown `scheduled`, or `sent` on a card still open (the send is in flight): no interactive
  // options. While the server still says `scheduled` — even past 0:00 on this device's clock, which
  // may run ahead of the sweeper's — the line, "Cancelar" and "Responder agora" stay (the cancel can
  // still win), with "Enviando…" beside them once the clock ran out; only `sent` leaves "Enviando…"
  // alone (spec 2026-09-26 concierge memory §6/§8).
  const sending = auto?.status === 'sent';
  const counting = auto?.status === 'scheduled';
  if (counting || sending) {
    const description = choiceAnswerDescription(question.payload, auto!.answer);
    let line = `Resposta automática em ${formatCountdown(seconds)} — «${choiceAnswerLabel(question.payload, auto!.answer)}»${description ? ` (${description})` : ''}. Motivo: ${auto!.reason}`;
    if (auto!.by === 'memory') {
      const decisionIds = new Set(auto!.sources.filter((s) => s.kind === 'decision').map((s) => s.id));
      const idx = items.findIndex((_, i) => hint.some((h) => h.question_index === i && decisionIds.has(h.decision_id)));
      const backing = idx === -1 ? undefined : hint.find((h) => h.question_index === idx);
      if (backing) line += ` Fonte: ${suggestionSourceSentence(items[idx]!, backing)}`;
    }
    return (
      <>
        {title}
        {sending ? (
          <p className="mt-1 text-fg-dim">Enviando…</p>
        ) : (
          <>
            <p className="mt-1 whitespace-pre-wrap text-fg">{line}</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button type="button" className="btn-ghost" disabled={answering} onClick={() => onCancelAutoAnswer?.(question.id)}>
                Cancelar
              </button>
              <button type="button" className="btn-primary" disabled={answering} onClick={() => onAnswer(question.id, auto!.answer)}>
                Responder agora
              </button>
              {seconds <= 0 && <span className="text-xs text-fg-dim">Enviando…</span>}
            </div>
          </>
        )}
      </>
    );
  }
  const answers = items.map((_, i) => (texts[i]!.trim() ? { selected: [], text: texts[i]!.trim() } : { selected: [...selected[i]!].sort((a, b) => a - b) }));
  const complete = answers.every((a) => 'text' in a || a.selected.length > 0);
  const suggestedUnseen = hint.some((h) => !viewed[h.question_index]);
  const show = (i: number) => {
    setCurrent(i);
    setViewed((prev) => prev.map((v, j) => v || j === i));
  };
  const item = items[current]!;
  const typing = texts[current]!.trim() !== '';
  const toggle = (option: number) => {
    touched.current = true;
    setSelected((prev) => prev.map((s, j) => (j !== current ? s : item.multi_select ? (s.includes(option) ? s.filter((x) => x !== option) : [...s, option]) : [option])));
  };
  // WAI-ARIA tabs (spec 2026-09-26 §4.12): each tab names the panel it controls, the panel names its tab,
  // only the selected tab is in the tab order, and the arrows move between questions (wrapping).
  const tabs = items.length > 1;
  const tabId = (i: number) => `${question.id}-tab-${i}`;
  const panelId = `${question.id}-panel`;
  const descriptionId = (option: number) => `${question.id}-${current}-option-${option}-description`;
  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (step === 0) return;
    e.preventDefault();
    const next = (current + step + items.length) % items.length;
    show(next);
    document.getElementById(tabId(next))?.focus();
  };
  const currentHint = hint.find((s) => s.question_index === current);
  /** "Esquecer esta decisão": the pre-selection it explains is cleared regardless of whether the
   *  DELETE succeeds — the server answers 204 even for a decision already gone. */
  const forget = (h: TabQuestionSuggestionItem) => {
    touched.current = true;
    const clear = () => {
      setHint((prev) => prev.filter((s) => s !== h));
      setSelected((prev) => prev.map((s, j) => (j === h.question_index ? [] : s)));
      setTexts((prev) => prev.map((t, j) => (j === h.question_index ? '' : t)));
    };
    // An empty id (a concierge suggestion that cited no decision): forgetting only clears the pre-selection.
    const result = h.decision_id ? onForget?.(h.decision_id) : undefined;
    if (result) void result.then(clear, clear);
    else clear();
  };
  return (
    <>
      {title}
      {tabs && (
        <div role="tablist" aria-label="Perguntas" className="mt-2 flex flex-wrap gap-1" onKeyDown={onTabKey}>
          {items.map((it, i) => (
            <button
              key={i}
              id={tabId(i)}
              type="button"
              role="tab"
              aria-selected={i === current}
              aria-controls={panelId}
              tabIndex={i === current ? 0 : -1}
              className={i === current ? 'btn-primary' : 'btn-ghost'}
              onClick={() => show(i)}
            >
              {`${it.header || `Pergunta ${i + 1}`}${hint.some((h) => h.question_index === i) ? ' · sugerida' : ''}`}
            </button>
          ))}
        </div>
      )}
      <fieldset id={panelId} className="mt-2" disabled={answering} {...(tabs ? { role: 'tabpanel', 'aria-labelledby': tabId(current) } : {})}>
        <legend className="whitespace-pre-wrap text-fg">{item.question}</legend>
        {item.options.map((o, oi) => (
          <label key={oi} className="mt-1 flex items-start gap-2">
            <input
              type={item.multi_select ? 'checkbox' : 'radio'}
              name={`${question.id}-${current}`}
              aria-label={o.recommended ? `${o.label}, recomendada` : o.label}
              aria-describedby={o.description ? descriptionId(oi) : undefined}
              checked={selected[current]!.includes(oi)}
              disabled={typing}
              onChange={() => toggle(oi)}
            />
            <span>
              <span className="text-fg">{o.label}</span>
              {o.recommended && <span className="ml-2 rounded bg-accent/20 px-1 text-xs text-fg">Recomendada</span>}
              {o.description && (
                <span id={descriptionId(oi)} className="block text-xs text-fg-dim">
                  {o.description}
                </span>
              )}
            </span>
          </label>
        ))}
        <label className="mt-2 block text-xs text-fg-dim">
          Outra resposta
          <input
            type="text"
            className="input mt-1"
            maxLength={2000}
            value={texts[current]}
            onChange={(e) => {
              touched.current = true;
              setTexts((prev) => prev.map((t, j) => (j === current ? e.target.value : t)));
            }}
          />
        </label>
      </fieldset>
      {currentHint && (
        <div className="mt-2">
          <p className="text-xs text-fg-dim">{suggestionLine(item, currentHint)}</p>
          {/* A concierge suggestion that cited no decision (`decision_id: ""`) has nothing to forget. */}
          {!(currentHint.by === 'concierge' && !currentHint.decision_id) && (
            <button type="button" className="btn-ghost mt-1 text-xs" disabled={answering} onClick={() => forget(currentHint)}>
              Esquecer esta decisão
            </button>
          )}
        </div>
      )}
      <button type="button" className="btn-primary mt-2" disabled={answering || !complete || suggestedUnseen} onClick={() => onAnswer(question.id, { answers })}>
        Responder
      </button>
      {auto?.status === 'failed' && <p className="mt-2 text-xs text-danger">{autoAnswerFailureText(auto.error_code)}</p>}
    </>
  );
}

function PermissionBody({ question, answering, onAnswer, loadScreen }: TabQuestionCardProps & { question: TabQuestionPermission }) {
  const open = question.status === 'open';
  const codex = question.payload.agent === 'codex';
  const [screen, setScreen] = useState<string | null>(null);
  const [denying, setDenying] = useState(false);
  const [text, setText] = useState('');
  useEffect(() => {
    if (!open || !loadScreen) return;
    let alive = true;
    // A card whose tab moved on answers 409 here: it simply shows no excerpt.
    loadScreen(question.id).then(
      (t) => {
        if (alive) setScreen(t);
      },
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [open, question.id, loadScreen]);
  return (
    <>
      <p className="whitespace-pre-wrap text-fg">{permissionTitle(question)}</p>
      {codex && (
        <>
          {question.payload.question && <p className="mt-1 whitespace-pre-wrap text-fg">{question.payload.question}</p>}
          <p className="mt-1 whitespace-pre-wrap text-xs text-fg-dim">{`${tabLabel(question)} · «${question.payload.tool_name}»`}</p>
        </>
      )}
      {open && screen !== null && (
        <details className="mt-2" open>
          <summary className="cursor-pointer text-xs text-fg-dim">Tela da aba</summary>
          <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap font-mono text-xs text-fg">{screen}</pre>
        </details>
      )}
      {open ? (
        <>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" className="btn-primary" disabled={answering} onClick={() => onAnswer(question.id, { allow: true })}>
              Permitir
            </button>
            <button type="button" className="btn-danger" disabled={answering} onClick={() => onAnswer(question.id, { allow: false })}>
              Negar
            </button>
            <button type="button" className="btn-ghost" disabled={answering} onClick={() => setDenying(true)}>
              Negar e dizer…
            </button>
          </div>
          {denying && (
            <div className="mt-2 flex gap-2">
              <input aria-label="O que dizer à aba" className="input" maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} />
              <button type="button" className="btn-danger" disabled={answering || !text.trim()} onClick={() => onAnswer(question.id, { allow: false, text: text.trim() })}>
                Enviar
              </button>
            </div>
          )}
        </>
      ) : (
        answerSummary(question).map((line, i) => (
          <p key={i} className="mt-1 text-fg">
            {line}
          </p>
        ))
      )}
    </>
  );
}
