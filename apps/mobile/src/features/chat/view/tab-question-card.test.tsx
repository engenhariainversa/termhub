import { act, fireEvent, render, screen } from '@testing-library/react-native';
import type { TabQuestion, TabQuestionAutoAnswer, TabQuestionSuggestion } from '../model/types';
import { TabQuestionCard } from './tab-question-card';

const SUGGESTION: TabQuestionSuggestion = {
  items: [{ question_index: 0, decision_id: 'd1', similarity: 0.9, selected: [1], source: { question: 'Usar worktree?', project_name: 'termhub', answered_at: '2026-09-20T10:00:00.000Z' } }],
};

const BASE_QUESTION: TabQuestion = {
  id: 'q1',
  tab_id: 't-api',
  tab_name: 'api',
  kind: 'choice',
  status: 'open',
  error_code: null,
  created_at: new Date().toISOString(),
  answered_at: null,
  closed_at: null,
  answer: null,
  payload: {
    questions: [
      {
        question: 'Usar worktree?',
        header: 'Worktree',
        multi_select: false,
        options: [
          { label: 'Sim', description: '', recommended: false },
          { label: 'Não', description: '', recommended: false },
        ],
      },
    ],
  },
};

describe('TabQuestionCard: suggested answer (chat decision memory spec 2026-09-26 §5.1)', () => {
  it('pre-selects the suggested option and shows "Sugestão da memória"', async () => {
    await render(<TabQuestionCard question={{ ...BASE_QUESTION, suggestion: SUGGESTION }} busy={false} onAnswer={jest.fn()} loadScreen={async () => null} onForget={jest.fn()} />);
    expect(screen.getByRole('radio', { name: 'Não' }).props.accessibilityState.checked).toBe(true);
    expect(screen.getByRole('radio', { name: 'Sim' }).props.accessibilityState.checked).toBe(false);
    expect(screen.getByText('Sugestão da memória: você respondeu «Não» a «Usar worktree?» em termhub, 20/09/2026')).toBeTruthy();
  });

  it('a text suggestion fills "Outra resposta" instead of pre-selecting an option', async () => {
    const textSuggestion: TabQuestionSuggestion = { items: [{ ...SUGGESTION.items[0]!, selected: [], text: 'Os dois' }] };
    await render(<TabQuestionCard question={{ ...BASE_QUESTION, suggestion: textSuggestion }} busy={false} onAnswer={jest.fn()} loadScreen={async () => null} onForget={jest.fn()} />);
    expect(screen.getByLabelText('Outra resposta').props.value).toBe('Os dois');
    expect(screen.getByText('Sugestão da memória: você respondeu «Os dois» a «Usar worktree?» em termhub, 20/09/2026')).toBeTruthy();
  });

  it('"Esquecer esta decisão" calls onForget(decisionId) and clears the pre-selection', async () => {
    const onForget = jest.fn(async () => undefined);
    const onAnswer = jest.fn();
    await render(<TabQuestionCard question={{ ...BASE_QUESTION, suggestion: SUGGESTION }} busy={false} onAnswer={onAnswer} loadScreen={async () => null} onForget={onForget} />);

    await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Esquecer esta decisão' })));
    expect(onForget).toHaveBeenCalledWith('d1');
    expect(screen.queryByText(/Sugestão da memória/)).toBeNull();
    expect(screen.getByRole('radio', { name: 'Não' }).props.accessibilityState.checked).toBe(false);

    // Nothing is answered on its own: "Responder" still needs its own press.
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it('"Esquecer esta decisão" on a suggestion with an empty decision_id only clears the pre-selection', async () => {
    const onForget = jest.fn(async () => undefined);
    const noDecision: TabQuestionSuggestion = { items: [{ ...SUGGESTION.items[0]!, decision_id: '', similarity: 0 }] };
    await render(<TabQuestionCard question={{ ...BASE_QUESTION, suggestion: noDecision }} busy={false} onAnswer={jest.fn()} loadScreen={async () => null} onForget={onForget} />);
    await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Esquecer esta decisão' })));
    expect(onForget).not.toHaveBeenCalled();
    expect(screen.getByRole('radio', { name: 'Não' }).props.accessibilityState.checked).toBe(false);
  });

  it('no suggestion line renders for a question with no suggestion, or once it is answered', async () => {
    await render(<TabQuestionCard question={BASE_QUESTION} busy={false} onAnswer={jest.fn()} loadScreen={async () => null} />);
    expect(screen.queryByText(/Sugestão da memória/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Esquecer esta decisão' })).toBeNull();
  });

  it('an answered/closed card shows no suggestion line even if `suggestion` is still on the payload', async () => {
    const closed: TabQuestion = { ...BASE_QUESTION, suggestion: SUGGESTION, status: 'answered', answer: { answers: [{ selected: [1] }] } };
    await render(<TabQuestionCard question={closed} busy={false} onAnswer={jest.fn()} loadScreen={async () => null} onForget={jest.fn()} />);
    expect(screen.queryByText(/Sugestão da memória/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Esquecer esta decisão' })).toBeNull();
  });

  describe('several questions', () => {
    const TWO: TabQuestion = {
      ...BASE_QUESTION,
      payload: {
        questions: [
          (BASE_QUESTION as Extract<TabQuestion, { kind: 'choice' }>).payload.questions[0]!,
          { question: 'Rodar os testes?', header: 'Testes', multi_select: false, options: [{ label: 'Sim', description: '', recommended: false }, { label: 'Não', description: '', recommended: false }] },
        ],
      },
    };
    const BOTH: TabQuestionSuggestion = {
      items: [SUGGESTION.items[0]!, { question_index: 1, decision_id: 'd2', similarity: 0.99, selected: [0], source: { question: 'Rodar os testes?', project_name: 'termhub', answered_at: '2026-09-20T10:00:00.000Z' } }],
    };

    it('marks each suggested tab and keeps "Responder" off until every suggested question was viewed', async () => {
      const onAnswer = jest.fn();
      await render(<TabQuestionCard question={{ ...TWO, suggestion: BOTH }} busy={false} onAnswer={onAnswer} loadScreen={async () => null} onForget={jest.fn()} />);
      expect(screen.getByRole('tab', { name: 'Worktree · sugerida' })).toBeTruthy();
      expect(screen.getByRole('tab', { name: 'Testes · sugerida' })).toBeTruthy();
      // Both are pre-answered, but "Testes" was never shown: its answer must not go out unseen.
      expect(screen.getByRole('button', { name: 'Responder' }).props.accessibilityState.disabled).toBe(true);
      await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Responder' })));
      expect(onAnswer).not.toHaveBeenCalled();

      await act(async () => fireEvent.press(screen.getByRole('tab', { name: 'Testes · sugerida' })));
      expect(screen.getByRole('button', { name: 'Responder' }).props.accessibilityState.disabled).toBe(false);
      await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Responder' })));
      expect(onAnswer).toHaveBeenCalledWith('q1', { answers: [{ selected: [1] }, { selected: [0] }] });
    });

    it('a tab without a suggestion has no mark and only needs an answer', async () => {
      await render(<TabQuestionCard question={{ ...TWO, suggestion: SUGGESTION }} busy={false} onAnswer={jest.fn()} loadScreen={async () => null} onForget={jest.fn()} />);
      expect(screen.getByRole('tab', { name: 'Worktree · sugerida' })).toBeTruthy();
      await act(async () => fireEvent.press(screen.getByRole('tab', { name: 'Testes' })));
      await act(async () => fireEvent.press(screen.getByRole('radio', { name: 'Sim' })));
      expect(screen.getByRole('button', { name: 'Responder' }).props.accessibilityState.disabled).toBe(false);
    });
  });

  it('a concierge suggestion shows its own line and reason, with no "Esquecer esta decisão" button when it cited no decision', async () => {
    const conciergeSuggestion: TabQuestionSuggestion = {
      items: [{ question_index: 0, decision_id: '', similarity: 0, selected: [1], by: 'concierge', reason: 'Você sempre usa branch em vez de worktree', sources: ['doc:i1'], source: { question: 'Usar worktree?', project_name: 'termhub', answered_at: '2026-09-20T10:00:00.000Z' } }],
    };
    await render(<TabQuestionCard question={{ ...BASE_QUESTION, suggestion: conciergeSuggestion }} busy={false} onAnswer={jest.fn()} loadScreen={async () => null} onForget={jest.fn()} />);
    expect(screen.getByText('Sugestão do concierge: «Não». Motivo: Você sempre usa branch em vez de worktree')).toBeTruthy();
    expect(screen.queryByText(/Sugestão da memória/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Esquecer esta decisão' })).toBeNull();
  });
});

describe('TabQuestionCard: a suggestion that arrives after the card is on screen (the concierge wake path)', () => {
  const late: TabQuestionSuggestion = {
    items: [{ question_index: 0, decision_id: '', similarity: 0, selected: [1], by: 'concierge', reason: 'Você sempre usa branch', sources: ['doc:i1'], source: { question: 'Usar worktree?', project_name: 'termhub', answered_at: '2026-09-20T10:00:00.000Z' } }],
  };

  it('is shown and pre-selected when the person has not touched the card', async () => {
    const view = await render(<TabQuestionCard question={BASE_QUESTION} busy={false} onAnswer={jest.fn()} loadScreen={async () => null} onForget={jest.fn()} />);
    expect(screen.getByRole('radio', { name: 'Não' }).props.accessibilityState.checked).toBe(false);
    await view.rerender(<TabQuestionCard question={{ ...BASE_QUESTION, suggestion: late }} busy={false} onAnswer={jest.fn()} loadScreen={async () => null} onForget={jest.fn()} />);
    expect(screen.getByRole('radio', { name: 'Não' }).props.accessibilityState.checked).toBe(true);
    expect(screen.getByText('Sugestão do concierge: «Não». Motivo: Você sempre usa branch')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Responder' }).props.accessibilityState.disabled).toBe(false);
  });

  it('after the person edited the card, the line shows but their selection is kept', async () => {
    const view = await render(<TabQuestionCard question={BASE_QUESTION} busy={false} onAnswer={jest.fn()} loadScreen={async () => null} onForget={jest.fn()} />);
    await act(async () => fireEvent.press(screen.getByRole('radio', { name: 'Sim' })));
    await view.rerender(<TabQuestionCard question={{ ...BASE_QUESTION, suggestion: late }} busy={false} onAnswer={jest.fn()} loadScreen={async () => null} onForget={jest.fn()} />);
    expect(screen.getByText('Sugestão do concierge: «Não». Motivo: Você sempre usa branch')).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Sim' }).props.accessibilityState.checked).toBe(true);
    expect(screen.getByRole('radio', { name: 'Não' }).props.accessibilityState.checked).toBe(false);
  });

  it('a typed "Outra resposta" also counts as an edit', async () => {
    const view = await render(<TabQuestionCard question={BASE_QUESTION} busy={false} onAnswer={jest.fn()} loadScreen={async () => null} onForget={jest.fn()} />);
    await act(async () => fireEvent.changeText(screen.getByLabelText('Outra resposta'), 'Os dois'));
    await view.rerender(<TabQuestionCard question={{ ...BASE_QUESTION, suggestion: late }} busy={false} onAnswer={jest.fn()} loadScreen={async () => null} onForget={jest.fn()} />);
    expect(screen.getByLabelText('Outra resposta').props.value).toBe('Os dois');
  });

  it('the same suggestion re-sent (a new object, same items) does not re-seed a forgotten pre-selection', async () => {
    const q = (): TabQuestion => ({ ...BASE_QUESTION, suggestion: { items: [{ ...SUGGESTION.items[0]! }] } });
    const view = await render(<TabQuestionCard question={q()} busy={false} onAnswer={jest.fn()} loadScreen={async () => null} onForget={jest.fn(async () => undefined)} />);
    await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Esquecer esta decisão' })));
    expect(screen.getByRole('radio', { name: 'Não' }).props.accessibilityState.checked).toBe(false);
    await view.rerender(<TabQuestionCard question={q()} busy={false} onAnswer={jest.fn()} loadScreen={async () => null} onForget={jest.fn(async () => undefined)} />);
    expect(screen.getByRole('radio', { name: 'Não' }).props.accessibilityState.checked).toBe(false);
    expect(screen.queryByText(/Sugestão da memória/)).toBeNull();
  });
});

describe('automatic answer countdown (concierge memory spec 2026-09-26 §6/§8)', () => {
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
  const memorySource = { question_index: 0, decision_id: 'd1', similarity: 0.99, selected: [0], source: { question: 'Usar worktree?', project_name: 'termhub', answered_at: '2026-09-20T10:00:00.000Z' } };
  const card = (over: Partial<TabQuestion> = {}): TabQuestion => ({ ...BASE_QUESTION, payload: { questions: [yesNo] }, ...over } as TabQuestion);

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(now);
  });
  afterEach(() => jest.useRealTimers());

  it('shows the countdown, its reason, the memory source, both buttons, no options, and ticks down', async () => {
    await render(<TabQuestionCard question={card({ auto_answer: auto(), suggestion: { items: [memorySource] } })} busy={false} onAnswer={jest.fn()} loadScreen={async () => null} />);
    expect(screen.getByText(/Resposta automática em 0:42 — «Sim»\. Motivo: Mesma pergunta respondida antes Fonte: você respondeu «Sim» a «Usar worktree\?» em termhub, 20\/09\/2026/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancelar' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Responder agora' })).toBeTruthy();
    expect(screen.queryByRole('radio')).toBeNull();
    await act(async () => jest.advanceTimersByTime(1000));
    expect(screen.getByText(/0:41/)).toBeTruthy();
  });

  it('a countdown on the option the agent recommended (automatic board work) reads its own reason, translated', async () => {
    await render(<TabQuestionCard question={card({ auto_answer: auto({ by: 'automation', reason: 'Opção recomendada pelo agente', sources: [] }) })} busy={false} onAnswer={jest.fn()} loadScreen={async () => null} />);
    expect(screen.getByText('Resposta automática em 0:42 — «Sim». Motivo: Opção recomendada pelo agente')).toBeTruthy();
  });

  it('"Cancelar" calls onCancelAutoAnswer with the question id', async () => {
    const onCancelAutoAnswer = jest.fn();
    await render(<TabQuestionCard question={card({ auto_answer: auto() })} busy={false} onAnswer={jest.fn()} loadScreen={async () => null} onCancelAutoAnswer={onCancelAutoAnswer} />);
    await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Cancelar' })));
    expect(onCancelAutoAnswer).toHaveBeenCalledWith('q1');
  });

  it('once auto_answer.status becomes "cancelled" (the store replaced the question from the API response), the card shows the proposed answer pre-selected and enabled', async () => {
    const view = await render(<TabQuestionCard question={card({ auto_answer: auto() })} busy={false} onAnswer={jest.fn()} loadScreen={async () => null} />);
    await view.rerender(<TabQuestionCard question={card({ auto_answer: auto({ status: 'cancelled' }) })} busy={false} onAnswer={jest.fn()} loadScreen={async () => null} />);
    const radio = screen.getByRole('radio', { name: 'Sim' });
    expect(radio.props.accessibilityState.checked).toBe(true);
    expect(radio.props.accessibilityState.disabled).toBe(false);
    expect(screen.getByRole('button', { name: 'Responder' }).props.accessibilityState.disabled).toBe(false);
  });

  it('"Responder agora" answers with the proposed answer', async () => {
    const onAnswer = jest.fn();
    await render(<TabQuestionCard question={card({ auto_answer: auto() })} busy={false} onAnswer={onAnswer} loadScreen={async () => null} />);
    await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Responder agora' })));
    expect(onAnswer).toHaveBeenCalledWith('q1', { answers: [{ selected: [0] }] });
  });

  it('a countdown at 0:00 still "scheduled" shows "Enviando…" (no negative numbers) and keeps both buttons until the server says sent', async () => {
    const onCancelAutoAnswer = jest.fn();
    await render(<TabQuestionCard question={card({ auto_answer: auto({ due_at: now.toISOString() }) })} busy={false} onAnswer={jest.fn()} loadScreen={async () => null} onCancelAutoAnswer={onCancelAutoAnswer} />);
    expect(screen.getByText('Enviando…')).toBeTruthy();
    expect(screen.queryByText(/-\d/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Responder agora' })).toBeTruthy();
    await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Cancelar' })));
    expect(onCancelAutoAnswer).toHaveBeenCalledWith('q1');
  });

  it('a countdown reaching 0:00 while on screen shows "Enviando…" next to the buttons', async () => {
    await render(<TabQuestionCard question={card({ auto_answer: auto({ due_at: new Date(now.getTime() + 1000).toISOString() }) })} busy={false} onAnswer={jest.fn()} loadScreen={async () => null} />);
    expect(screen.queryByText('Enviando…')).toBeNull();
    await act(async () => jest.advanceTimersByTime(1000));
    expect(screen.getByText('Enviando…')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancelar' })).toBeTruthy();
  });

  it('the countdown line names the chosen option\'s description after its label, cut at 80 characters', async () => {
    const steps = { question: 'Como seguir?', header: 'Passo', multi_select: false, options: [{ label: 'Opção 1', description: 'faz merge e push para main', recommended: false }, { label: 'Opção 2', description: 'y'.repeat(100), recommended: false }] };
    const view = await render(<TabQuestionCard question={card({ payload: { questions: [steps] }, auto_answer: auto() })} busy={false} onAnswer={jest.fn()} loadScreen={async () => null} />);
    expect(screen.getByText(/Resposta automática em 0:42 — «Opção 1» \(faz merge e push para main\)\. Motivo: Mesma pergunta respondida antes/)).toBeTruthy();
    await view.rerender(<TabQuestionCard question={card({ payload: { questions: [steps] }, auto_answer: auto({ answer: { answers: [{ selected: [1] }] } }) })} busy={false} onAnswer={jest.fn()} loadScreen={async () => null} />);
    expect(screen.getByText(new RegExp(`«Opção 2» \\(${'y'.repeat(80)}…\\)\\. Motivo`))).toBeTruthy();
  });

  it('a "sent" countdown on a still-open card shows "Enviando…" with no buttons', async () => {
    await render(<TabQuestionCard question={card({ auto_answer: auto({ status: 'sent' }) })} busy={false} onAnswer={jest.fn()} loadScreen={async () => null} />);
    expect(screen.getByText('Enviando…')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Cancelar' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Responder agora' })).toBeNull();
  });

  it('an answered card with answered_via "auto" shows the automatic-answer line and forgets each decision source', async () => {
    const onForget = jest.fn(async () => undefined);
    await render(
      <TabQuestionCard
        question={card({
          status: 'answered',
          answer: { answers: [{ selected: [0] }] },
          answered_via: 'auto',
          auto_answer: auto({ status: 'sent', sources: [{ kind: 'decision', id: 'd1' }, { kind: 'decision', id: 'd2' }] }),
        })}
        busy={false}
        onAnswer={jest.fn()}
        loadScreen={async () => null}
        onForget={onForget}
      />,
    );
    expect(screen.getByText('Respondida automaticamente: «Sim» — motivo Mesma pergunta respondida antes')).toBeTruthy();
    await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Esquecer o precedente' })));
    expect(onForget).toHaveBeenCalledWith('d1');
    expect(onForget).toHaveBeenCalledWith('d2');
  });

  it.each([
    ['TAB_PROMPT_CHANGED', 'Não consegui responder sozinho: a pergunta mudou na aba.'],
    ['SOMETHING_ELSE', 'Não consegui responder sozinho.'],
  ])('auto_answer.status "failed" (%s) shows the normal, editable card plus its own line', async (code, text) => {
    await render(<TabQuestionCard question={card({ auto_answer: auto({ status: 'failed', error_code: code }) })} busy={false} onAnswer={jest.fn()} loadScreen={async () => null} />);
    const radio = screen.getByRole('radio', { name: 'Sim' });
    expect(radio.props.accessibilityState.disabled).toBe(false);
    expect(screen.getByText(text)).toBeTruthy();
  });
});

describe('TabQuestionCard: a question that came from Codex', () => {
  const PERMISSION: TabQuestion = { ...BASE_QUESTION, kind: 'permission', payload: { tool_name: 'Bash', agent: 'codex', question: 'Rodar <b>npm test</b>?' }, answer: null } as TabQuestion;
  it('a permission card says the Codex asks, shows the question as plain text and keeps the tool as secondary text', async () => {
    const onAnswer = jest.fn();
    await render(<TabQuestionCard question={PERMISSION} busy={false} onAnswer={onAnswer} loadScreen={async () => null} />);
    expect(screen.getByText('A aba «api» pede permissão (o Codex)')).toBeTruthy();
    expect(screen.getByText('Rodar <b>npm test</b>?')).toBeTruthy();
    expect(screen.getByText('«Bash»')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Permitir' }));
    expect(onAnswer).toHaveBeenCalledWith('q1', { allow: true });
  });
  it('a choice card names the Codex in its title', async () => {
    await render(<TabQuestionCard question={{ ...BASE_QUESTION, payload: { ...BASE_QUESTION.payload, agent: 'codex' } } as TabQuestion} busy={false} onAnswer={jest.fn()} loadScreen={async () => null} />);
    expect(screen.getByText('A aba «api» perguntou (o Codex)')).toBeTruthy();
  });
  it('a Claude permission card is unchanged', async () => {
    await render(<TabQuestionCard question={{ ...BASE_QUESTION, kind: 'permission', payload: { tool_name: 'Bash' } } as TabQuestion} busy={false} onAnswer={jest.fn()} loadScreen={async () => null} />);
    expect(screen.getByText('A aba «api» pede permissão para usar «Bash»')).toBeTruthy();
  });
});

// TER-641: a card the countdown answered by itself carries "Decisão automática"; one answered by a tap does not.
describe('TabQuestionCard: "Decisão automática" (TER-641)', () => {
  const auto = { reason: 'Já decidido', sources: [{ ref: 'decision:d1', question: 'Usar worktree?', answer: 'Não' }] };
  const answered = { ...BASE_QUESTION, status: 'answered' as const, answer: { answers: [{ selected: [1] }] } };

  it('shows the badge and its decision on an automatically answered card', async () => {
    await render(<TabQuestionCard question={{ ...answered, answered_via: 'auto', auto_decision: auto }} busy={false} onAnswer={jest.fn()} loadScreen={async () => null} onForget={jest.fn()} />);
    await fireEvent.press(screen.getByRole('button', { name: 'Decisão automática' }));
    expect(screen.getByText('Motivo: Já decidido')).toBeTruthy();
    expect(screen.getByText('• «Usar worktree?» → Não (decision:d1)')).toBeTruthy();
  });

  it('no badge on a card answered by a tap', async () => {
    await render(<TabQuestionCard question={{ ...answered, answered_via: 'card' }} busy={false} onAnswer={jest.fn()} loadScreen={async () => null} onForget={jest.fn()} />);
    expect(screen.queryByRole('button', { name: 'Decisão automática' })).toBeNull();
  });
});
