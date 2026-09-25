import { useEffect, useState } from 'react';
import type { TabQuestion, TabQuestionAnswer, TabQuestionChoice, TabQuestionPermission } from '../../lib/types';
import { answerSummary, statusLabel, tabLabel } from './tab-question-text';

export interface TabQuestionCardProps {
  question: TabQuestion;
  /** This card's answer is in flight: every control is disabled. */
  answering: boolean;
  /** Why the last answer did not go through (pt-BR). */
  error?: string | null;
  onAnswer: (body: TabQuestionAnswer) => void;
  /** The tab's live excerpt, for a permission card while it is open. Stable across renders. */
  loadScreen?: (id: string) => Promise<string>;
}

/**
 * A question an agent in a tab asked, inline in the thread (spec 2026-09-25 §6.2). Presentational:
 * the request and the error handling live in `ChatPanel`. Everything shown is plain text — never HTML.
 */
export function TabQuestionCard(props: TabQuestionCardProps) {
  const { question, error } = props;
  return (
    <li className="rounded-xl border border-attention/40 bg-bg-2 px-4 py-3 text-sm">
      {question.kind === 'choice' ? <ChoiceBody {...props} question={question} /> : <PermissionBody {...props} question={question} />}
      {question.status !== 'open' && <p className="mt-1 text-xs text-fg-dim">{statusLabel(question)}</p>}
      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
    </li>
  );
}

function ChoiceBody({ question, answering, onAnswer }: TabQuestionCardProps & { question: TabQuestionChoice }) {
  const items = question.payload.questions;
  const [current, setCurrent] = useState(0);
  const [selected, setSelected] = useState<number[][]>(() => items.map(() => []));
  const [texts, setTexts] = useState<string[]>(() => items.map(() => ''));
  const title = <p className="font-medium text-fg">{`${tabLabel(question)} perguntou`}</p>;
  if (question.status !== 'open') {
    return (
      <>
        {title}
        <ul className="mt-1 space-y-0.5 whitespace-pre-wrap text-fg">
          {answerSummary(question).map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      </>
    );
  }
  const answers = items.map((_, i) => (texts[i]!.trim() ? { selected: [], text: texts[i]!.trim() } : { selected: [...selected[i]!].sort((a, b) => a - b) }));
  const complete = answers.every((a) => 'text' in a || a.selected.length > 0);
  const item = items[current]!;
  const typing = texts[current]!.trim() !== '';
  const toggle = (option: number) =>
    setSelected((prev) => prev.map((s, j) => (j !== current ? s : item.multi_select ? (s.includes(option) ? s.filter((x) => x !== option) : [...s, option]) : [option])));
  return (
    <>
      {title}
      {items.length > 1 && (
        <div role="tablist" className="mt-2 flex flex-wrap gap-1">
          {items.map((it, i) => (
            <button key={i} type="button" role="tab" aria-selected={i === current} className={i === current ? 'btn-primary' : 'btn-ghost'} onClick={() => setCurrent(i)}>
              {it.header || `Pergunta ${i + 1}`}
            </button>
          ))}
        </div>
      )}
      <fieldset className="mt-2" disabled={answering}>
        <legend className="whitespace-pre-wrap text-fg">{item.question}</legend>
        {item.options.map((o, oi) => (
          <label key={oi} className="mt-1 flex items-start gap-2">
            <input type={item.multi_select ? 'checkbox' : 'radio'} name={`${question.id}-${current}`} checked={selected[current]!.includes(oi)} disabled={typing} onChange={() => toggle(oi)} />
            <span>
              <span className="text-fg">{o.label}</span>
              {o.recommended && <span className="ml-2 rounded bg-accent/20 px-1 text-xs text-fg">Recomendada</span>}
              {o.description && <span className="block text-xs text-fg-dim">{o.description}</span>}
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
            onChange={(e) => setTexts((prev) => prev.map((t, j) => (j === current ? e.target.value : t)))}
          />
        </label>
      </fieldset>
      <button type="button" className="btn-primary mt-2" disabled={answering || !complete} onClick={() => onAnswer({ answers })}>
        Responder
      </button>
    </>
  );
}

function PermissionBody({ question, answering, onAnswer, loadScreen }: TabQuestionCardProps & { question: TabQuestionPermission }) {
  const open = question.status === 'open';
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
      <p className="whitespace-pre-wrap text-fg">{`${tabLabel(question)} pede permissão para usar «${question.payload.tool_name}»`}</p>
      {open && screen !== null && (
        <details className="mt-2" open>
          <summary className="cursor-pointer text-xs text-fg-dim">Tela da aba</summary>
          <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap font-mono text-xs text-fg">{screen}</pre>
        </details>
      )}
      {open ? (
        <>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" className="btn-primary" disabled={answering} onClick={() => onAnswer({ allow: true })}>
              Permitir
            </button>
            <button type="button" className="btn-danger" disabled={answering} onClick={() => onAnswer({ allow: false })}>
              Negar
            </button>
            <button type="button" className="btn-ghost" disabled={answering} onClick={() => setDenying(true)}>
              Negar e dizer…
            </button>
          </div>
          {denying && (
            <div className="mt-2 flex gap-2">
              <input aria-label="O que dizer à aba" className="input" maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} />
              <button type="button" className="btn-danger" disabled={answering || !text.trim()} onClick={() => onAnswer({ allow: false, text: text.trim() })}>
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
