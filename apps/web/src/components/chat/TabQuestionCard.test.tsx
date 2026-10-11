// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TabQuestionCard } from './TabQuestionCard';
import type { TabQuestion, TabQuestionAutoAnswer } from '../../lib/types';

afterEach(() => cleanup());

const base = { tab_id: 't1', tab_name: 'api', error_code: null, created_at: '', answered_at: null, closed_at: null };
const colors = { question: 'What is your favorite color?', header: 'Color', multi_select: false, options: [{ label: 'Blue', description: 'Calm and classic.', recommended: true }, { label: 'Green', description: 'Fresh and natural.', recommended: false }, { label: 'Red', description: 'Bold and energetic.', recommended: false }] };
const fruits = { question: 'Which fruits do you like?', header: 'Fruits', multi_select: true, options: [{ label: 'Apple', description: '', recommended: false }, { label: 'Banana', description: '', recommended: false }, { label: 'Mango', description: '', recommended: false }] };
const choice = (over: Partial<TabQuestion> = {}) => ({ ...base, id: 'q1', kind: 'choice', status: 'open', answer: null, payload: { questions: [colors, fruits] }, ...over }) as TabQuestion;
const permission = (over: Partial<TabQuestion> = {}) => ({ ...base, id: 'q2', kind: 'permission', status: 'open', answer: null, payload: { tool_name: 'Bash' }, ...over }) as TabQuestion;

it('answers a two-question card: a radio on the first tab, checkboxes on the second', () => {
  const onAnswer = vi.fn();
  render(<TabQuestionCard question={choice()} answering={false} onAnswer={onAnswer} />);
  expect(screen.getByText('A aba «api» perguntou')).toBeInTheDocument();
  expect(screen.getByText('Recomendada')).toBeInTheDocument();
  expect(screen.getByText('Calm and classic.')).toBeInTheDocument();
  const submit = screen.getByRole('button', { name: 'Responder' });
  expect(submit).toBeDisabled();
  fireEvent.click(screen.getByRole('radio', { name: /Green/ }));
  fireEvent.click(screen.getByRole('tab', { name: 'Fruits' }));
  fireEvent.click(screen.getByRole('checkbox', { name: /Mango/ }));
  fireEvent.click(screen.getByRole('checkbox', { name: /Apple/ }));
  fireEvent.click(submit);
  expect(onAnswer).toHaveBeenCalledWith('q1', { answers: [{ selected: [1] }, { selected: [0, 2] }] });
});

it('"Outra resposta" answers with text and sets the options aside', () => {
  const onAnswer = vi.fn();
  render(<TabQuestionCard question={choice({ payload: { questions: [colors] } } as Partial<TabQuestion>)} answering={false} onAnswer={onAnswer} />);
  expect(screen.queryByRole('tab')).toBeNull(); // one question: no tab strip
  fireEvent.change(screen.getByLabelText('Outra resposta'), { target: { value: '  Purple ' } });
  expect(screen.getByRole('radio', { name: /Blue/ })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Responder' }));
  expect(onAnswer).toHaveBeenCalledWith('q1', { answers: [{ selected: [], text: 'Purple' }] });
});

it('a permission card shows the live excerpt and allows, denies, or denies with a sentence', async () => {
  const onAnswer = vi.fn();
  const loadScreen = vi.fn(async () => ({ text: 'Bash command\n  touch probe-file.txt\nDo you want to proceed?' }));
  render(<TabQuestionCard question={permission()} answering={false} onAnswer={onAnswer} loadScreen={loadScreen} />);
  expect(screen.getByText('A aba «api» pede permissão para usar «Bash»')).toBeInTheDocument();
  // Expanded by default: the tool's name alone does not say what is about to run.
  expect(await screen.findByText(/touch probe-file\.txt/)).toBeVisible();
  expect(screen.getByText('Tela da aba')).toBeInTheDocument();
  expect(loadScreen).toHaveBeenCalledWith('q2');
  fireEvent.click(screen.getByRole('button', { name: 'Permitir' }));
  expect(onAnswer).toHaveBeenLastCalledWith('q2', { allow: true });
  fireEvent.click(screen.getByRole('button', { name: 'Negar' }));
  expect(onAnswer).toHaveBeenLastCalledWith('q2', { allow: false });
  fireEvent.click(screen.getByRole('button', { name: 'Negar e dizer…' }));
  fireEvent.change(screen.getByLabelText('O que dizer à aba'), { target: { value: 'use pnpm' } });
  fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
  expect(onAnswer).toHaveBeenLastCalledWith('q2', { allow: false, text: 'use pnpm' });
});

it('a permission card offers every option of the dialog, the one that stops asking marked (TER-995)', async () => {
  const onAnswer = vi.fn();
  const auto = 'Yes, and switch to auto mode · auto mode handles these prompts for you';
  const options = [
    { number: 1, label: 'Yes', summary: 'Yes', allow: true, highlight: false },
    { number: 2, label: "Yes, and don't ask again for termhub - Create Task commands", summary: "Yes, and don't ask again for termhub - Create Task commands", allow: true, highlight: true },
    { number: 3, label: auto, summary: 'Yes, and switch to auto mode', allow: true, highlight: true },
    { number: 4, label: 'No', summary: 'No', allow: false, highlight: false },
  ];
  render(<TabQuestionCard question={permission()} answering={false} onAnswer={onAnswer} loadScreen={vi.fn(async () => ({ text: 'Do you want to proceed?', options }))} />);
  const group = await screen.findByRole('group', { name: 'Opções da aba' });
  expect(group.querySelectorAll('button')).toHaveLength(4);
  const autoButton = screen.getByRole('button', { name: '3. Yes, and switch to auto mode' });
  expect(autoButton).toHaveClass('btn-primary');
  expect(screen.getByRole('button', { name: '1. Yes' })).not.toHaveClass('btn-primary');
  fireEvent.click(autoButton);
  expect(onAnswer).toHaveBeenLastCalledWith('q2', { allow: true, option: { number: 3, label: auto } });
  fireEvent.click(screen.getByRole('button', { name: '4. No' }));
  expect(onAnswer).toHaveBeenLastCalledWith('q2', { allow: false, option: { number: 4, label: 'No' } });
  // The shortcuts stay.
  expect(screen.getByRole('button', { name: 'Permitir' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Negar' })).toBeInTheDocument();
});

it('a closed permission card names the option chosen', () => {
  render(<TabQuestionCard question={permission({ status: 'answered', answer: { allow: true, option: { number: 3, label: 'x', summary: 'Yes, and switch to auto mode' } } } as Partial<TabQuestion>)} answering={false} onAnswer={vi.fn()} />);
  expect(screen.getByText('Permitido: «Yes, and switch to auto mode»')).toBeInTheDocument();
});

it('disables every answer while one is in flight', () => {
  render(<TabQuestionCard question={permission()} answering onAnswer={vi.fn()} />);
  expect(screen.getByRole('button', { name: 'Permitir' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Negar' })).toBeDisabled();
});

it.each([
  [choice({ status: 'answered', answer: { answers: [{ selected: [1] }, { selected: [0] }] } } as Partial<TabQuestion>), ['What is your favorite color? → Green', 'Respondida']],
  [choice({ status: 'answered_in_tab' }), ['Respondida na aba']],
  [permission({ status: 'expired' }), ['Expirada']],
  [permission({ status: 'failed', error_code: 'MACHINE_OFFLINE', answer: { allow: true } } as Partial<TabQuestion>), ['Permitido', 'Falhou — a máquina está offline']],
])('a closed card is read-only and says how it ended (%#)', (q, texts) => {
  render(<TabQuestionCard question={q} answering={false} onAnswer={vi.fn()} loadScreen={vi.fn(async () => ({ text: 'x' }))} />);
  for (const t of texts) expect(screen.getByText(t)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Responder|Permitir/ })).toBeNull();
});

it('shows the error it is given', () => {
  render(<TabQuestionCard question={permission()} answering={false} onAnswer={vi.fn()} error="A pergunta mudou na aba" />);
  expect(screen.getByText('A pergunta mudou na aba')).toBeInTheDocument();
});

it('the question tabs are a real tab list: ids, aria-controls, a labelled panel, only the selected tab in the tab order, arrows move (spec 2026-09-26 §4.12)', () => {
  render(<TabQuestionCard question={choice()} answering={false} onAnswer={vi.fn()} />);
  const [color, fruitsTab] = screen.getAllByRole('tab');
  expect(color).toHaveAttribute('id', 'q1-tab-0');
  expect(color).toHaveAttribute('aria-controls', 'q1-panel');
  expect(color).toHaveAttribute('tabindex', '0');
  expect(fruitsTab).toHaveAttribute('tabindex', '-1');
  const panel = screen.getByRole('tabpanel');
  expect(panel).toHaveAttribute('id', 'q1-panel');
  expect(panel).toHaveAttribute('aria-labelledby', 'q1-tab-0');
  fireEvent.keyDown(color!, { key: 'ArrowRight' });
  expect(screen.getByRole('tab', { name: 'Fruits' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByRole('tab', { name: 'Fruits' })).toHaveFocus();
  expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'q1-tab-1');
  fireEvent.keyDown(screen.getByRole('tab', { name: 'Fruits' }), { key: 'ArrowRight' });
  expect(screen.getByRole('tab', { name: 'Color' })).toHaveAttribute('aria-selected', 'true'); // wraps
});

it('each option names itself, the recommended one says so, and points at its description', () => {
  render(<TabQuestionCard question={choice()} answering={false} onAnswer={vi.fn()} />);
  expect(screen.getByRole('radio', { name: 'Blue, recomendada' })).toHaveAccessibleDescription('Calm and classic.');
  expect(screen.getByRole('radio', { name: 'Green' })).toHaveAccessibleDescription('Fresh and natural.');
});

it('one question: no tab list and no tab panel role', () => {
  render(<TabQuestionCard question={choice({ payload: { questions: [colors] } } as Partial<TabQuestion>)} answering={false} onAnswer={vi.fn()} />);
  expect(screen.queryByRole('tablist')).toBeNull();
  expect(screen.queryByRole('tabpanel')).toBeNull();
});

const suggestion = { question_index: 0, decision_id: 'd1', similarity: 0.9, selected: [1], source: { question: 'Usar worktree?', project_name: 'termhub', answered_at: '2026-09-20T10:00:00Z' } };

it('a suggestion pre-selects the option, names its source and enables Responder at once', () => {
  const onAnswer = vi.fn();
  render(<TabQuestionCard question={choice({ payload: { questions: [colors] }, suggestion: { items: [suggestion] } } as Partial<TabQuestion>)} answering={false} onAnswer={onAnswer} />);
  expect(screen.getByRole('radio', { name: /Green/ })).toBeChecked();
  expect(screen.getByText('Sugestão da memória: você respondeu «Green» a «Usar worktree?» em termhub, 20/09/2026')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Responder' })).toBeEnabled();
});

it('a text suggestion fills "Outra resposta"', () => {
  const textSuggestion = { ...suggestion, selected: [], text: 'Usar branch' };
  render(<TabQuestionCard question={choice({ payload: { questions: [colors] }, suggestion: { items: [textSuggestion] } } as Partial<TabQuestion>)} answering={false} onAnswer={vi.fn()} />);
  expect(screen.getByLabelText('Outra resposta')).toHaveValue('Usar branch');
  expect(screen.getByText('Sugestão da memória: você respondeu «Usar branch» a «Usar worktree?» em termhub, 20/09/2026')).toBeInTheDocument();
});

it('"Esquecer esta decisão" forgets the decision and clears the pre-selection', async () => {
  const onForget = vi.fn(async () => {});
  render(<TabQuestionCard question={choice({ payload: { questions: [colors] }, suggestion: { items: [suggestion] } } as Partial<TabQuestion>)} answering={false} onAnswer={vi.fn()} onForget={onForget} />);
  fireEvent.click(screen.getByRole('button', { name: 'Esquecer esta decisão' }));
  expect(onForget).toHaveBeenCalledWith('d1');
  await waitFor(() => expect(screen.queryByText(/Sugestão da memória/)).toBeNull());
  expect(screen.getByRole('radio', { name: /Green/ })).not.toBeChecked();
});

it('"Esquecer esta decisão" on a suggestion with an empty decision_id only clears the pre-selection', async () => {
  const onForget = vi.fn(async () => {});
  render(<TabQuestionCard question={choice({ payload: { questions: [colors] }, suggestion: { items: [{ ...suggestion, decision_id: '', similarity: 0 }] } } as Partial<TabQuestion>)} answering={false} onAnswer={vi.fn()} onForget={onForget} />);
  fireEvent.click(screen.getByRole('button', { name: 'Esquecer esta decisão' }));
  expect(onForget).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.getByRole('radio', { name: /Green/ })).not.toBeChecked());
});

it("forgetting one question's suggestion keeps another question's pre-selection", async () => {
  const onForget = vi.fn(async () => {});
  const suggestionFruits = { question_index: 1, decision_id: 'd2', similarity: 0.9, selected: [0, 2], source: { question: 'Quais frutas você gosta?', project_name: 'termhub', answered_at: '2026-09-20T10:00:00Z' } };
  render(<TabQuestionCard question={choice({ suggestion: { items: [suggestion, suggestionFruits] } } as Partial<TabQuestion>)} answering={false} onAnswer={vi.fn()} onForget={onForget} />);
  expect(screen.getByRole('radio', { name: /Green/ })).toBeChecked();
  fireEvent.click(screen.getByRole('button', { name: 'Esquecer esta decisão' }));
  expect(onForget).toHaveBeenCalledWith('d1');
  await waitFor(() => expect(screen.getByRole('radio', { name: /Green/ })).not.toBeChecked());

  // Question 1's own suggestion (a different decision) is untouched by forgetting question 0's.
  fireEvent.click(screen.getByRole('tab', { name: 'Fruits · sugerida' }));
  expect(screen.getByRole('checkbox', { name: /Apple/ })).toBeChecked();
  expect(screen.getByRole('checkbox', { name: /Mango/ })).toBeChecked();
  expect(screen.getByRole('checkbox', { name: /Banana/ })).not.toBeChecked();
  expect(screen.getByText('Sugestão da memória: você respondeu «Apple, Mango» a «Quais frutas você gosta?» em termhub, 20/09/2026')).toBeInTheDocument();
});

it('several suggested questions: each tab says so, and Responder waits until every one was viewed', () => {
  const onAnswer = vi.fn();
  const suggestionFruits = { question_index: 1, decision_id: 'd2', similarity: 0.99, selected: [0, 2], source: { question: 'Quais frutas você gosta?', project_name: 'termhub', answered_at: '2026-09-20T10:00:00Z' } };
  render(<TabQuestionCard question={choice({ suggestion: { items: [suggestion, suggestionFruits] } } as Partial<TabQuestion>)} answering={false} onAnswer={onAnswer} />);
  expect(screen.getByRole('tab', { name: 'Color · sugerida' })).toBeInTheDocument();
  expect(screen.getByRole('tab', { name: 'Fruits · sugerida' })).toBeInTheDocument();
  // Every question is pre-answered, but the second one was never shown: no sending it unseen.
  const submit = screen.getByRole('button', { name: 'Responder' });
  expect(submit).toBeDisabled();
  fireEvent.click(screen.getByRole('tab', { name: 'Fruits · sugerida' }));
  expect(submit).toBeEnabled();
  fireEvent.click(submit);
  expect(onAnswer).toHaveBeenCalledWith('q1', { answers: [{ selected: [1] }, { selected: [0, 2] }] });
});

it('a tab without a suggestion carries no mark and does not hold Responder back', () => {
  render(<TabQuestionCard question={choice({ suggestion: { items: [suggestion] } } as Partial<TabQuestion>)} answering={false} onAnswer={vi.fn()} />);
  expect(screen.getByRole('tab', { name: 'Color · sugerida' })).toBeInTheDocument();
  expect(screen.getByRole('tab', { name: 'Fruits' })).toBeInTheDocument();
  // Fruits has no suggestion, so only an answer to it (not a visit) is missing.
  fireEvent.click(screen.getByRole('tab', { name: 'Fruits' }));
  fireEvent.click(screen.getByRole('checkbox', { name: /Apple/ }));
  expect(screen.getByRole('button', { name: 'Responder' })).toBeEnabled();
});

it('an answered card shows no suggestion line', () => {
  render(<TabQuestionCard question={choice({ status: 'answered', answer: { answers: [{ selected: [1] }] }, suggestion: { items: [suggestion] } } as Partial<TabQuestion>)} answering={false} onAnswer={vi.fn()} />);
  expect(screen.queryByText(/Sugestão da memória/)).toBeNull();
});

it('a concierge suggestion shows its own line and reason, with no "Esquecer esta decisão" link when it cited no decision', () => {
  const conciergeSuggestion = {
    question_index: 0,
    decision_id: '',
    similarity: 0,
    selected: [1],
    by: 'concierge' as const,
    reason: 'Você sempre usa branch em vez de worktree',
    sources: ['doc:i1'],
    source: { question: 'Usar worktree?', project_name: 'termhub', answered_at: '2026-09-20T10:00:00Z' },
  };
  render(<TabQuestionCard question={choice({ payload: { questions: [colors] }, suggestion: { items: [conciergeSuggestion] } } as Partial<TabQuestion>)} answering={false} onAnswer={vi.fn()} />);
  expect(screen.getByText('Sugestão do concierge: «Green». Motivo: Você sempre usa branch em vez de worktree')).toBeInTheDocument();
  expect(screen.queryByText(/Sugestão da memória/)).toBeNull();
  expect(screen.queryByRole('button', { name: 'Esquecer esta decisão' })).toBeNull();
});

describe('a suggestion that arrives after the card is on screen (the concierge wake path)', () => {
  const late = { ...suggestion, decision_id: '', similarity: 0, by: 'concierge' as const, reason: 'Você sempre escolhe verde', sources: ['doc:i1'] };

  it('is shown and pre-selected when the person has not touched the card', () => {
    const { rerender } = render(<TabQuestionCard question={choice({ payload: { questions: [colors] } } as Partial<TabQuestion>)} answering={false} onAnswer={vi.fn()} />);
    expect(screen.getByRole('radio', { name: /Green/ })).not.toBeChecked();
    rerender(<TabQuestionCard question={choice({ payload: { questions: [colors] }, suggestion: { items: [late] } } as Partial<TabQuestion>)} answering={false} onAnswer={vi.fn()} />);
    expect(screen.getByRole('radio', { name: /Green/ })).toBeChecked();
    expect(screen.getByText('Sugestão do concierge: «Green». Motivo: Você sempre escolhe verde')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Responder' })).toBeEnabled();
  });

  it('after the person edited the card, the line shows but their selection is kept', () => {
    const { rerender } = render(<TabQuestionCard question={choice({ payload: { questions: [colors] } } as Partial<TabQuestion>)} answering={false} onAnswer={vi.fn()} />);
    fireEvent.click(screen.getByRole('radio', { name: /Red/ }));
    rerender(<TabQuestionCard question={choice({ payload: { questions: [colors] }, suggestion: { items: [late] } } as Partial<TabQuestion>)} answering={false} onAnswer={vi.fn()} />);
    expect(screen.getByText('Sugestão do concierge: «Green». Motivo: Você sempre escolhe verde')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Red/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: /Green/ })).not.toBeChecked();
  });

  it('a typed "Outra resposta" also counts as an edit', () => {
    const { rerender } = render(<TabQuestionCard question={choice({ payload: { questions: [colors] } } as Partial<TabQuestion>)} answering={false} onAnswer={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Outra resposta'), { target: { value: 'Roxo' } });
    rerender(<TabQuestionCard question={choice({ payload: { questions: [colors] }, suggestion: { items: [late] } } as Partial<TabQuestion>)} answering={false} onAnswer={vi.fn()} />);
    expect(screen.getByLabelText('Outra resposta')).toHaveValue('Roxo');
  });

  it('the same suggestion re-sent (a new object, same items) does not re-seed a forgotten pre-selection', async () => {
    const q = () => choice({ payload: { questions: [colors] }, suggestion: { items: [{ ...suggestion }] } } as Partial<TabQuestion>);
    const { rerender } = render(<TabQuestionCard question={q()} answering={false} onAnswer={vi.fn()} onForget={vi.fn(async () => {})} />);
    fireEvent.click(screen.getByRole('button', { name: 'Esquecer esta decisão' }));
    await waitFor(() => expect(screen.getByRole('radio', { name: /Green/ })).not.toBeChecked());
    rerender(<TabQuestionCard question={q()} answering={false} onAnswer={vi.fn()} onForget={vi.fn(async () => {})} />);
    expect(screen.getByRole('radio', { name: /Green/ })).not.toBeChecked();
    expect(screen.queryByText(/Sugestão da memória/)).toBeNull();
  });
});

describe('automatic answer countdown (spec 2026-09-26 concierge memory §6/§8)', () => {
  const now = new Date('2026-09-27T10:00:00.000Z');
  const yesNo = { question: 'Usar worktree?', header: 'Worktree', multi_select: false, options: [{ label: 'Sim', description: '', recommended: false }, { label: 'Não', description: '', recommended: false }] };
  const auto = (over: Partial<TabQuestionAutoAnswer> = {}): TabQuestionAutoAnswer => ({
    answer: { answers: [{ selected: [0] }] },
    by: 'memory',
    reason: 'Mesma pergunta respondida antes',
    sources: [{ kind: 'decision', id: 'd1' }],
    due_at: new Date(now.getTime() + 42_000).toISOString(),
    status: 'scheduled',
    ...over,
  });
  const memorySource = { question_index: 0, decision_id: 'd1', similarity: 0.99, selected: [0], source: { question: 'Usar worktree?', project_name: 'termhub', answered_at: '2026-09-20T10:00:00Z' } };
  const card = (over: Partial<TabQuestion> = {}) => choice({ payload: { questions: [yesNo] }, ...over } as Partial<TabQuestion>);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });
  afterEach(() => vi.useRealTimers());

  it('shows the countdown, its reason, the memory source, both buttons, no interactive options, and ticks down', async () => {
    render(<TabQuestionCard question={card({ auto_answer: auto(), suggestion: { items: [memorySource] } } as Partial<TabQuestion>)} answering={false} onAnswer={vi.fn()} />);
    expect(screen.getByText(/Resposta automática em 0:42 — «Sim»\. Motivo: Mesma pergunta respondida antes Fonte: você respondeu «Sim» a «Usar worktree\?» em termhub, 20\/09\/2026/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancelar' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Responder agora' })).toBeInTheDocument();
    expect(screen.queryByRole('radio')).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(screen.getByText(/0:41/)).toBeInTheDocument();
  });

  it('a countdown on the option the agent recommended (automatic board work) reads its own reason, translated', () => {
    render(<TabQuestionCard question={card({ auto_answer: auto({ by: 'automation', reason: 'Opção recomendada pelo agente', sources: [] }) } as Partial<TabQuestion>)} answering={false} onAnswer={vi.fn()} />);
    expect(screen.getByText('Resposta automática em 0:42 — «Sim». Motivo: Opção recomendada pelo agente')).toBeInTheDocument();
  });

  it('"Cancelar" calls onCancelAutoAnswer with the question id (the API call and error handling are ChatPanel\'s)', () => {
    const onCancelAutoAnswer = vi.fn();
    render(<TabQuestionCard question={card({ auto_answer: auto() } as Partial<TabQuestion>)} answering={false} onAnswer={vi.fn()} onCancelAutoAnswer={onCancelAutoAnswer} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(onCancelAutoAnswer).toHaveBeenCalledWith('q1');
  });

  it('once `auto_answer.status` becomes "cancelled" (ChatPanel updates the question from the API response), the card shows the proposed answer pre-selected and enabled', () => {
    const { rerender } = render(<TabQuestionCard question={card({ auto_answer: auto() } as Partial<TabQuestion>)} answering={false} onAnswer={vi.fn()} />);
    rerender(<TabQuestionCard question={card({ auto_answer: auto({ status: 'cancelled' }) } as Partial<TabQuestion>)} answering={false} onAnswer={vi.fn()} />);
    const radio = screen.getByRole('radio', { name: 'Sim' });
    expect(radio).toBeChecked();
    expect(radio).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Responder' })).toBeEnabled();
  });

  it('"Responder agora" answers with the proposed answer', () => {
    const onAnswer = vi.fn();
    render(<TabQuestionCard question={card({ auto_answer: auto() } as Partial<TabQuestion>)} answering={false} onAnswer={onAnswer} />);
    fireEvent.click(screen.getByRole('button', { name: 'Responder agora' }));
    expect(onAnswer).toHaveBeenCalledWith('q1', { answers: [{ selected: [0] }] });
  });

  it('a countdown at 0:00 still "scheduled" shows "Enviando…" (no negative numbers) and keeps both buttons until the server says sent', () => {
    const onCancelAutoAnswer = vi.fn();
    render(<TabQuestionCard question={card({ auto_answer: auto({ due_at: now.toISOString() }) } as Partial<TabQuestion>)} answering={false} onAnswer={vi.fn()} onCancelAutoAnswer={onCancelAutoAnswer} />);
    expect(screen.getByText('Enviando…')).toBeInTheDocument();
    expect(screen.queryByText(/-\d/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Responder agora' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(onCancelAutoAnswer).toHaveBeenCalledWith('q1');
  });

  it('a countdown reaching 0:00 while on screen shows "Enviando…" next to the buttons', async () => {
    render(<TabQuestionCard question={card({ auto_answer: auto({ due_at: new Date(now.getTime() + 1000).toISOString() }) } as Partial<TabQuestion>)} answering={false} onAnswer={vi.fn()} />);
    expect(screen.queryByText('Enviando…')).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(screen.getByText('Enviando…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancelar' })).toBeInTheDocument();
  });

  it('the countdown line names the chosen option\'s description after its label, cut at 80 characters', () => {
    const steps = { question: 'Como seguir?', header: 'Passo', multi_select: false, options: [{ label: 'Opção 1', description: 'faz merge e push para main', recommended: false }, { label: 'Opção 2', description: 'y'.repeat(100), recommended: false }] };
    const { rerender } = render(<TabQuestionCard question={choice({ payload: { questions: [steps] }, auto_answer: auto() } as Partial<TabQuestion>)} answering={false} onAnswer={vi.fn()} />);
    expect(screen.getByText(/Resposta automática em 0:42 — «Opção 1» \(faz merge e push para main\)\. Motivo: Mesma pergunta respondida antes/)).toBeInTheDocument();
    rerender(<TabQuestionCard question={choice({ payload: { questions: [steps] }, auto_answer: auto({ answer: { answers: [{ selected: [1] }] } }) } as Partial<TabQuestion>)} answering={false} onAnswer={vi.fn()} />);
    expect(screen.getByText(new RegExp(`«Opção 2» \\(${'y'.repeat(80)}…\\)\\. Motivo`))).toBeInTheDocument();
  });

  it('a "sent" countdown on a still-open card shows "Enviando…" with no buttons', () => {
    render(<TabQuestionCard question={card({ auto_answer: auto({ status: 'sent' }) } as Partial<TabQuestion>)} answering={false} onAnswer={vi.fn()} />);
    expect(screen.getByText('Enviando…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancelar' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Responder agora' })).toBeNull();
  });

  it('an answered card with answered_via "auto" shows the automatic-answer line and forgets each decision source', () => {
    const onForget = vi.fn(async () => {});
    render(
      <TabQuestionCard
        question={
          card({
            status: 'answered',
            answer: { answers: [{ selected: [0] }] },
            answered_via: 'auto',
            auto_answer: auto({ status: 'sent', sources: [{ kind: 'decision', id: 'd1' }, { kind: 'decision', id: 'd2' }] }),
          }) as TabQuestion
        }
        answering={false}
        onAnswer={vi.fn()}
        onForget={onForget}
      />,
    );
    expect(screen.getByText('Respondida automaticamente: «Sim» — motivo Mesma pergunta respondida antes')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Esquecer o precedente' }));
    expect(onForget).toHaveBeenCalledWith('d1');
    expect(onForget).toHaveBeenCalledWith('d2');
  });

  it.each([
    ['TAB_PROMPT_CHANGED', 'Não consegui responder sozinho: a pergunta mudou na aba.'],
    ['SOMETHING_ELSE', 'Não consegui responder sozinho.'],
  ])('auto_answer.status "failed" (%s) shows the normal, editable card plus its own line', (code, text) => {
    render(<TabQuestionCard question={card({ auto_answer: auto({ status: 'failed', error_code: code }) } as Partial<TabQuestion>)} answering={false} onAnswer={vi.fn()} />);
    expect(screen.getByRole('radio', { name: 'Sim' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Sim' })).toBeEnabled();
    expect(screen.getByText(text)).toBeInTheDocument();
  });
});

describe('a question that came from Codex', () => {
  it('a permission card says the Codex asks, shows its question as plain text and keeps the tool as secondary text', () => {
    const onAnswer = vi.fn();
    const q = permission({ payload: { tool_name: 'Bash', agent: 'codex', question: 'Rodar <b>npm test</b>?\nem /tmp' } } as Partial<TabQuestion>);
    const { container } = render(<TabQuestionCard question={q} answering={false} onAnswer={onAnswer} />);
    expect(screen.getByText('A aba «api» pede permissão (o Codex)')).toBeInTheDocument();
    expect(screen.getByText(/Rodar <b>npm test<\/b>\?/)).toHaveClass('whitespace-pre-wrap');
    expect(container.querySelector('b')).toBeNull();
    expect(screen.getByText(/«Bash»/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Permitir' }));
    expect(onAnswer).toHaveBeenCalledWith('q2', { allow: true });
  });
  it('a Codex permission without a question shows just the title and the tool', () => {
    render(<TabQuestionCard question={permission({ payload: { tool_name: 'Bash', agent: 'codex' } } as Partial<TabQuestion>)} answering={false} onAnswer={vi.fn()} />);
    expect(screen.getByText('A aba «api» pede permissão (o Codex)')).toBeInTheDocument();
    expect(screen.getByText(/«Bash»/)).toBeInTheDocument();
  });
  it('a choice card names the Codex in its title', () => {
    render(<TabQuestionCard question={choice({ payload: { questions: [colors], agent: 'codex' } } as Partial<TabQuestion>)} answering={false} onAnswer={vi.fn()} />);
    expect(screen.getByText('A aba «api» perguntou (o Codex)')).toBeInTheDocument();
  });
});

it('carries its id for the pending bar to find it (TER-477)', () => {
  const { container } = render(<TabQuestionCard question={permission()} answering={false} onAnswer={vi.fn()} />);
  expect(container.querySelector('[data-chat-card="q2"]')).not.toBeNull();
});

// TER-641: a card the countdown decides (or decided) by itself carries the badge; one answered by a click does not.
describe('"Decisão automática" (TER-641)', () => {
  const auto = { reason: 'Já decidido', sources: [{ ref: 'decision:d1', question: 'Qual cor?', answer: 'Blue' }] };
  it('shows the badge and its decision on an automatically answered card', () => {
    render(<TabQuestionCard question={choice({ status: 'answered', answer: { answers: [{ selected: [0] }, { selected: [1] }] }, answered_via: 'auto', auto_decision: auto })} answering={false} onAnswer={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Decisão automática' }));
    expect(screen.getByText('Motivo: Já decidido')).toBeInTheDocument();
    expect(screen.getByText(/«Qual cor\?» → Blue/)).toBeInTheDocument();
  });
  it('no badge without auto_decision', () => {
    render(<TabQuestionCard question={choice({ status: 'answered', answer: { answers: [{ selected: [0] }, { selected: [1] }] }, answered_via: 'card' })} answering={false} onAnswer={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Decisão automática' })).toBeNull();
  });
});
