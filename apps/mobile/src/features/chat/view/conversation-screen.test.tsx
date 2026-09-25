import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';

jest.mock('@/features/session/viewmodel/useSessionStore', () => ({ useSessionStore: require('../../../../test/helpers/ui-stores').stores.store }));
jest.mock('@/features/chat/viewmodel/useChatStore', () => ({ useChatStore: require('../../../../test/helpers/ui-stores').stores.chat }));

let mockId = 'p-termhub';
const mockRouter = { push: jest.fn(), back: jest.fn(), replace: jest.fn(), canGoBack: jest.fn(() => true) };
jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => ({ id: mockId }),
  Link: ({ children }: { children: unknown }) => children,
}));

import { useChatStore } from '@/features/chat/viewmodel/useChatStore';
import { useSessionStore } from '@/features/session/viewmodel/useSessionStore';
import type { TChatAction, TChatEvent, TChatGrant, TChatMessage, TChatResponse, TTabQuestion } from '@/services/api/contract';
import { enrolStores, stores } from '../../../../test/helpers/ui-stores';
import { ConversationScreen } from './conversation-screen';

const SEEDED_USER = 'Como estão as abas do projeto?';
const SEEDED_ASSISTANT = 'A aba api está esperando sua confirmação pra rodar `npm test`.';

function assistantRow(id: string, extra: Partial<TChatMessage> = {}): TChatMessage {
  return { id, conversation_id: 'c-termhub', role: 'assistant', text: '', usage: null, error_code: null, created_at: new Date().toISOString(), ...extra };
}

function delta(messageId: string, text: string): TChatEvent {
  return { type: 'delta', user_id: 'u1', conversation_id: 'c-termhub', message_id: messageId, delta: text };
}

/** Appends rows to the open project's thread, as the socket's events would. */
function addRows(rows: TChatMessage[], live: TChatEvent[]) {
  const s = useChatStore.getState();
  const slot = s.conversations['p-termhub']!;
  useChatStore.setState({ conversations: { ...s.conversations, 'p-termhub': { ...slot, messages: [...slot.messages, ...rows] } }, live });
}

/** Replaces one of the store's actions for a test. Not `jest.spyOn(getState(), …)`: zustand
 * replaces the state object on every `setState`, so a restored spy would linger on the new one. */
const realActions = { ...stores.chat.getState() };
function stubAction<K extends 'decide' | 'reset' | 'setHost' | 'revokeGrant' | 'answerTabQuestion'>(name: K) {
  const fn = jest.fn(async () => undefined);
  useChatStore.setState({ [name]: fn } as Partial<ReturnType<typeof useChatStore.getState>>);
  return fn;
}

/** Serves the open project's `GET chat` with its actions and grants changed — the screen re-reads
 * on open, so a slot seeded straight into the store would be overwritten by the mock's answer. */
function serveChat(patch: (res: TChatResponse) => Pick<TChatResponse, 'actions' | 'grants'>) {
  const real = stores.api.chat.bind(stores.api);
  jest.spyOn(stores.api, 'chat').mockImplementation(async (auth, projectId) => {
    const res = await real(auth, projectId);
    return projectId === 'p-termhub' ? { ...res, ...patch(res) } : res;
  });
}

const GRANT: TChatGrant = { id: 'g1', tab_id: 't-api', tool: 'send_input', source_action_id: 'a-termhub-1', created_at: '2026-09-25T10:00:00.000Z', expires_at: '2099-01-01T00:00:00.000Z', tab_name: 'api' };
const withAction = (res: TChatResponse, patch: Partial<TChatAction>): TChatAction[] => res.actions.map((a) => (a.id === 'a-termhub-1' ? { ...a, ...patch } : a));

/** The first load of a file signs its first P-256 proof, slow while other suites share the CPU. */
const LOAD = { timeout: 15_000 };

beforeAll(async () => {
  await enrolStores();
  await stores.chat.getState().loadProjects();
});

beforeEach(() => {
  mockId = 'p-termhub';
  for (const fn of Object.values(mockRouter)) fn.mockClear();
  mockRouter.canGoBack.mockReturnValue(true);
  // The screens are under test here, not the socket (the store's own tests cover it): no events.
  jest.spyOn(stores.api, 'events').mockReturnValue(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
  useChatStore.setState({
    error: null,
    live: [],
    decide: realActions.decide,
    reset: realActions.reset,
    setHost: realActions.setHost,
    revokeGrant: realActions.revokeGrant,
    answerTabQuestion: realActions.answerTabQuestion,
  });
});

describe('Conversa', () => {
  it('renders the thread: the person in plain text, the assistant as markdown and the title, with no host line while the host is ready', async () => {
    await render(<ConversationScreen />);
    expect(await screen.findByText(SEEDED_USER, undefined, LOAD)).toBeTruthy();
    const markdown = screen.getAllByTestId('markdown').map((node) => node.props.children);
    expect(markdown).toContain(SEEDED_ASSISTANT);
    expect(markdown).not.toContain(SEEDED_USER);
    expect(screen.getByText('termhub')).toBeTruthy();
    // A ready host needs nothing from the person: where the chat runs is in Ajustes.
    expect(screen.queryByText('Esta conversa roda na máquina jarvis, na conta padrão do Claude dela.')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Trocar máquina ou conta' })).toBeNull();
  });

  it('shows a streaming bubble with the folded deltas, "pensando…" for a started empty row, and a failure sentence', async () => {
    await render(<ConversationScreen />);
    await screen.findByText(SEEDED_USER, undefined, LOAD);

    const thinking = assistantRow('m-think');
    await act(() =>
      addRows(
        [assistantRow('m-stream'), thinking, assistantRow('m-failed', { error_code: 'HOST_GONE' })],
        [delta('m-stream', 'Rodei `npm'), delta('m-stream', ' test` no jarvis'), { type: 'message', user_id: 'u1', conversation_id: 'c-termhub', message: thinking }],
      ),
    );

    expect(screen.getByText('Rodei `npm test` no jarvis')).toBeTruthy();
    expect(screen.getByText('pensando…')).toBeTruthy();
    expect(screen.getByText('A máquina do chat saiu do ar no meio da resposta. Ligue-a e mande a mensagem de novo.')).toBeTruthy();
  });

  it('a new delta re-renders only the streaming bubble, not the rest of the thread', async () => {
    const { renders } = jest.requireMock('react-native-markdown-display') as { renders: unknown[] };
    await render(<ConversationScreen />);
    await screen.findByText(SEEDED_USER, undefined, LOAD);
    await act(() => addRows([assistantRow('m-stream')], [delta('m-stream', 'Rodei')]));

    renders.length = 0;
    await act(() => useChatStore.setState({ live: [delta('m-stream', 'Rodei'), delta('m-stream', ' os testes')] }));
    expect(screen.getByText('Rodei os testes')).toBeTruthy();
    expect(renders).toEqual(['Rodei os testes']);
  });

  it('renders the pending action card; Autorizar calls decide(id, approve)', async () => {
    const decide = stubAction('decide');
    await render(<ConversationScreen />);
    expect(await screen.findByText('digitar `npm test` na aba api do projeto termhub, no jarvis', undefined, LOAD)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Recusar' })).toBeTruthy();

    await fireEvent.press(screen.getByRole('button', { name: 'Autorizar' }));
    expect(decide).toHaveBeenCalledWith('a-termhub-1', 'approve');
  });

  it('Autorizar opens the PIN sheet', async () => {
    await render(<ConversationScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Autorizar' }, LOAD));
    expect(useSessionStore.getState().pinPrompt).toEqual({ actionId: 'a-termhub-1', decision: 'approve' });
    await act(() => useSessionStore.getState().cancelPinPrompt());
    expect(useChatStore.getState().decidingId).toBeNull();
  });

  it('offers "Permitir sempre nesta aba" on a pending send_input; it calls decide(id, approve_tab)', async () => {
    const decide = stubAction('decide');
    await render(<ConversationScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Permitir sempre nesta aba' }, LOAD));
    expect(decide).toHaveBeenCalledWith('a-termhub-1', 'approve_tab');
  });

  it('shows the active grant above the composer and on the card that granted it; Revogar calls revokeGrant', async () => {
    serveChat((res) => ({ actions: withAction(res, { status: 'approved' }), grants: [GRANT] }));
    const revokeGrant = stubAction('revokeGrant');
    await render(<ConversationScreen />);
    expect(await screen.findByText(/^Enviando direto para a aba api até/, undefined, LOAD)).toBeTruthy();
    expect(screen.getByText(/^Permitido até/)).toBeTruthy();
    const revoke = screen.getAllByRole('button', { name: 'Revogar' });
    expect(revoke).toHaveLength(2);
    await fireEvent.press(revoke[0]!);
    expect(revokeGrant).toHaveBeenCalledWith('g1');
  });

  it('a card run under a grant reads "executada · aba confiada"', async () => {
    serveChat((res) => ({ actions: withAction(res, { status: 'executed', grant_id: 'g1' }), grants: [] }));
    await render(<ConversationScreen />);
    expect(await screen.findByText('executada · aba confiada', undefined, LOAD)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Revogar' })).toBeNull();
  });

  it('does not offer it for run_command or answering_permission', async () => {
    serveChat((res) => ({ actions: withAction(res, { tool: 'run_command', summary: 'rodar o comando `ls` na aba api' }), grants: [] }));
    await render(<ConversationScreen />);
    await screen.findByText(/rodar o comando/, undefined, LOAD);
    expect(screen.getByRole('button', { name: 'Autorizar' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Permitir sempre nesta aba' })).toBeNull();
  });

  it('does not offer it for a send_input that answers a permission', async () => {
    serveChat((res) => ({ actions: withAction(res, { args: { text: '1', answering_permission: true }, summary: 'responder a permissão na aba api' }), grants: [] }));
    await render(<ConversationScreen />);
    await screen.findByText('responder a permissão na aba api', undefined, LOAD);
    expect(screen.getByRole('button', { name: 'Autorizar' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Permitir sempre nesta aba' })).toBeNull();
  });

  it('the composer sends on the button and clears; the mic is disabled with "em breve"', async () => {
    const sent = jest.spyOn(stores.api, 'sendMessage').mockResolvedValue({ conversation_id: 'c-termhub', user_message_id: 'u', assistant_message_id: 'a' });
    await render(<ConversationScreen />);
    await screen.findByText(SEEDED_USER, undefined, LOAD);

    const send = screen.getByRole('button', { name: 'Enviar' });
    expect(send.props.accessibilityState.disabled).toBe(true);
    const mic = screen.getByRole('button', { name: /em breve/ });
    expect(mic.props.accessibilityState.disabled).toBe(true);
    expect(within(mic).getByText('em breve')).toBeTruthy();

    await fireEvent.changeText(screen.getByLabelText('Mensagem'), 'como está o deploy?');
    await fireEvent.press(screen.getByRole('button', { name: 'Enviar' }));
    expect(sent).toHaveBeenCalledWith(expect.anything(), { text: 'como está o deploy?', project_id: 'p-termhub' });
    expect(screen.getByLabelText('Mensagem').props.value).toBe('');
  });

  it('Nova conversa asks first, then resets', async () => {
    const reset = stubAction('reset');
    await render(<ConversationScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Nova conversa' }, LOAD));
    expect(reset).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByRole('button', { name: 'Começar nova conversa' }));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('the account-wide chat, with no machine chosen, says so and offers the host sheet, which sets the machine and account', async () => {
    mockId = 'general';
    const setHost = stubAction('setHost');
    await render(<ConversationScreen />);
    expect(await screen.findByText('Chat geral', undefined, LOAD)).toBeTruthy();
    await waitFor(() => expect(useChatStore.getState().conversations['']?.loaded).toBe(true), LOAD);
    await act(async () => {
      const slot = useChatStore.getState().conversations['']!;
      useChatStore.setState({
        conversations: { ...useChatStore.getState().conversations, '': { ...slot, host: { kind: 'not_chosen', machines: [{ id: 'm-jarvis', name: 'jarvis' }, { id: 'm-hulk', name: 'hulk' }], sessionAtStake: false } } },
      });
    });
    expect(screen.getByText('Você tem mais de uma máquina: escolha em qual o chat vai rodar.')).toBeTruthy();

    await fireEvent.press(await screen.findByRole('button', { name: 'Trocar máquina ou conta' }, LOAD));
    expect(await screen.findByText('hulk', undefined, LOAD)).toBeTruthy();
    expect(screen.getByText('offline')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Claude Pedro (jarvis)' }));
    expect(setHost).toHaveBeenCalledWith('m-jarvis', 'acc-1');
  });

  it('an unknown route opens the account-wide chat and says the conversation was not found', async () => {
    mockId = 'c-nowhere';
    await render(<ConversationScreen />);
    expect(await screen.findByText('Conversa não encontrada.', undefined, LOAD)).toBeTruthy();
    expect(screen.getByText('Chat geral')).toBeTruthy();
  });

  it('"Voltar" goes back when there is a screen behind, and to the tabs when the conversation is the only one (a deep link followed after unlock)', async () => {
    await render(<ConversationScreen />);
    await screen.findByText(SEEDED_USER, undefined, LOAD);

    mockRouter.canGoBack.mockReturnValue(true);
    await fireEvent.press(screen.getByRole('button', { name: 'Voltar' }));
    expect(mockRouter.back).toHaveBeenCalledTimes(1);
    expect(mockRouter.replace).not.toHaveBeenCalled();

    mockRouter.canGoBack.mockReturnValue(false);
    await fireEvent.press(screen.getByRole('button', { name: 'Voltar' }));
    expect(mockRouter.back).toHaveBeenCalledTimes(1);
    expect(mockRouter.replace).toHaveBeenCalledWith('/(tabs)');
  });

  const QUESTION_BASE = { tab_id: 't-api', tab_name: 'api', error_code: null, created_at: new Date().toISOString(), answered_at: null, closed_at: null };
  const OPEN_CHOICE = { ...QUESTION_BASE, id: 'q1', kind: 'choice', status: 'open', answer: null, payload: { questions: [{ question: 'Qual banco usamos nos testes?', header: 'Banco', multi_select: false, options: [{ label: 'Postgres', description: 'O mesmo da produção.', recommended: true }, { label: 'SQLite', description: '', recommended: false }] }] } } as TTabQuestion;
  const OPEN_PERMISSION = { ...QUESTION_BASE, id: 'q2', kind: 'permission', status: 'open', answer: null, payload: { tool_name: 'Bash' } } as TTabQuestion;

  /** Serves the open project's `GET chat` with these tab questions. */
  function serveQuestions(questions: TTabQuestion[]) {
    const real = stores.api.chat.bind(stores.api);
    jest.spyOn(stores.api, 'chat').mockImplementation(async (auth, projectId) => {
      const res = await real(auth, projectId);
      return projectId === 'p-termhub' ? { ...res, tab_questions: questions } : res;
    });
  }

  it('renders a tab\'s question; picking an option and Responder answers it', async () => {
    serveQuestions([OPEN_CHOICE]);
    const answer = stubAction('answerTabQuestion');
    await render(<ConversationScreen />);
    expect(await screen.findByText('Qual banco usamos nos testes?', undefined, LOAD)).toBeTruthy();
    expect(screen.getByText('A aba «api» perguntou')).toBeTruthy();
    expect(screen.getByText('Recomendada')).toBeTruthy();
    await fireEvent.press(screen.getByRole('radio', { name: 'Postgres' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Responder' }));
    expect(answer).toHaveBeenCalledWith('q1', { answers: [{ selected: [0] }] });
  });

  it('"Outra resposta" answers with the text', async () => {
    serveQuestions([OPEN_CHOICE]);
    const answer = stubAction('answerTabQuestion');
    await render(<ConversationScreen />);
    await fireEvent.changeText(await screen.findByLabelText('Outra resposta', undefined, LOAD), 'Os dois');
    await fireEvent.press(screen.getByRole('button', { name: 'Responder' }));
    expect(answer).toHaveBeenCalledWith('q1', { answers: [{ selected: [], text: 'Os dois' }] });
  });

  it('a permission card shows the live excerpt; Permitir, Negar and Negar e dizer… answer it', async () => {
    serveQuestions([OPEN_PERMISSION]);
    jest.spyOn(stores.api, 'tabQuestionScreen').mockResolvedValue({ text: 'Bash command\n  npm test\nDo you want to proceed?' });
    const answer = stubAction('answerTabQuestion');
    await render(<ConversationScreen />);
    expect(await screen.findByText('A aba «api» pede permissão para usar «Bash»', undefined, LOAD)).toBeTruthy();
    // Expanded by default: the tool's name alone does not say what is about to run.
    expect(await screen.findByText(/Do you want to proceed\?/, undefined, LOAD)).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Tela da aba' }));
    expect(screen.queryByText(/Do you want to proceed\?/)).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Tela da aba' }));
    expect(screen.getByText(/Do you want to proceed\?/)).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Permitir' }));
    expect(answer).toHaveBeenLastCalledWith('q2', { allow: true });
    await fireEvent.press(screen.getByRole('button', { name: 'Negar' }));
    expect(answer).toHaveBeenLastCalledWith('q2', { allow: false });
    await fireEvent.press(screen.getByRole('button', { name: 'Negar e dizer…' }));
    await fireEvent.changeText(screen.getByLabelText('O que dizer à aba'), 'use pnpm');
    // Scoped to the card: the composer has its own "Enviar" button on screen at the same time.
    await fireEvent.press(within(screen.getByTestId('tab-question-q2')).getByRole('button', { name: 'Enviar' }));
    expect(answer).toHaveBeenLastCalledWith('q2', { allow: false, text: 'use pnpm' });
  });

  it.each([
    [{ ...OPEN_CHOICE, status: 'answered', answer: { answers: [{ selected: [1] }] } } as TTabQuestion, ['Qual banco usamos nos testes? → SQLite', 'Respondida']],
    [{ ...OPEN_PERMISSION, status: 'answered_in_tab' } as TTabQuestion, ['Respondida na aba']],
    [{ ...OPEN_PERMISSION, status: 'expired' } as TTabQuestion, ['Expirada']],
    [{ ...OPEN_PERMISSION, status: 'failed', error_code: 'MACHINE_OFFLINE', answer: { allow: true } } as TTabQuestion, ['Permitido', 'Falhou — a máquina está offline']],
  ])('a closed tab question is read-only and says how it ended (%#)', async (q, texts) => {
    serveQuestions([q]);
    await render(<ConversationScreen />);
    for (const t of texts) expect(await screen.findByText(t, undefined, LOAD)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Responder' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Permitir' })).toBeNull();
  });
});
