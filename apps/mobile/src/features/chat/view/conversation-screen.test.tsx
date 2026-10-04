import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { DeviceEventEmitter, FlatList, StyleSheet } from 'react-native';
import { getAnimatedStyle } from 'react-native-reanimated';

jest.mock('@/features/session/viewmodel/useSessionStore', () => ({ useSessionStore: require('../../../../test/helpers/ui-stores').stores.store }));
jest.mock('@/features/chat/viewmodel/useChatStore', () => ({ useChatStore: require('../../../../test/helpers/ui-stores').stores.chat }));

const mockVoice = { state: 'idle' as import('../viewmodel/use-voice').VoiceState, seconds: 0, error: null as string | null, notice: null as string | null, start: jest.fn(), stop: jest.fn(), cancel: jest.fn() };
let mockOnText: ((text: string) => void) | null = null;
jest.mock('@/features/chat/viewmodel/use-voice', () => ({
  useVoice: (onText: (text: string) => void) => {
    mockOnText = onText;
    return mockVoice;
  },
  // The attachment sheet's recorder: never records here.
  useRecorder: () => ({ state: 'idle', seconds: 0, error: null, start: jest.fn(async () => undefined), stop: jest.fn(async () => null), cancel: jest.fn() }),
}));

let mockId = 'p-termhub';
const mockRouter = { push: jest.fn(), back: jest.fn(), replace: jest.fn(), canGoBack: jest.fn(() => true) };
jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => ({ id: mockId }),
  Link: ({ children }: { children: unknown }) => children,
}));

import { useChatStore } from '@/features/chat/viewmodel/useChatStore';
import { useSessionStore } from '@/features/session/viewmodel/useSessionStore';
import type { TChatAction, TChatEvent, TChatGrant, TChatMessage, TChatProjectGrant, TChatResponse, TChatStandingGrant, TSubagentView, TTabLimit, TTabQuestion, TTabSuggestion } from '@/services/api/contract';
import { ApiError } from '@/services/api/errors';
import { enrolStores, stores } from '../../../../test/helpers/ui-stores';
import { emptyFold, foldLive } from '../model/live';
import type { ChatMessage } from '../model/types';
import { ConversationScreen, ConversationView } from './conversation-screen';

/** The composer's text frame (composer.tsx `textFrame`): sharing the buttons' row, or on its own line above it. */
const BESIDE_BUTTONS = { marginLeft: 40, marginRight: 40, marginBottom: 0, height: 36 };
const ABOVE_BUTTONS = { marginLeft: 8, marginRight: 8, marginBottom: 40 };
/** A glide is 220 ms; the wait leaves room for a slow CI runner. */
const SETTLE = { timeout: 3000 };

const SEEDED_USER = 'Como estão as abas do projeto?';
const SEEDED_ASSISTANT = 'A aba api está esperando sua confirmação pra rodar `npm test`.';

function assistantRow(id: string, extra: Partial<TChatMessage> = {}): TChatMessage {
  return { id, conversation_id: 'c-termhub', role: 'assistant', text: '', usage: null, error_code: null, created_at: new Date().toISOString(), ...extra };
}

/** A `created_at` `n` seconds after the seeded thread: rows added in a test sort after it, in this order. */
const at = (n: number) => new Date(Date.now() + n * 1000).toISOString();

function delta(messageId: string, text: string): TChatEvent {
  return { type: 'delta', user_id: 'u1', conversation_id: 'c-termhub', message_id: messageId, delta: text };
}

/** Appends rows to the open project's thread, as the socket's events would. */
function addRows(rows: ChatMessage[], live: TChatEvent[]) {
  const s = useChatStore.getState();
  const slot = s.conversations['p-termhub']!;
  useChatStore.setState({ conversations: { ...s.conversations, 'p-termhub': { ...slot, messages: [...slot.messages, ...rows] } }, live: foldLive(live) });
}

/** Replaces one of the store's actions for a test. Not `jest.spyOn(getState(), …)`: zustand
 * replaces the state object on every `setState`, so a restored spy would linger on the new one. */
const realActions = { ...stores.chat.getState() };
function stubAction<K extends 'send' | 'decide' | 'decideMany' | 'reset' | 'setHost' | 'revokeGrant' | 'answerTabQuestion' | 'sendTabSuggestion' | 'dismissTabSuggestion' | 'answerTabLimit' | 'retrySend' | 'cancelSubagent'>(name: K) {
  const fn = jest.fn(async () => undefined);
  useChatStore.setState({ [name]: fn } as Partial<ReturnType<typeof useChatStore.getState>>);
  return fn;
}

/** Serves the open project's `GET chat` with its actions, grants and project grants changed — the
 * screen re-reads on open, so a slot seeded straight into the store would be overwritten by the
 * mock's answer. These tests look at one pending card: the seed's second one (`a-termhub-2`) is
 * always left out, unless `keepBoth` is set (the grouped-card tests want both pending actions on
 * screen). A patch may leave `project_grants` out: it then keeps whatever the real mock answered. */
function serveChat(patch: (res: TChatResponse) => Partial<Pick<TChatResponse, 'actions' | 'grants' | 'project_grants' | 'standing_grants' | 'subagents'>> = (res) => res, keepBoth = false) {
  const real = stores.api.chat.bind(stores.api);
  jest.spyOn(stores.api, 'chat').mockImplementation(async (auth, projectId) => {
    const res = await real(auth, projectId);
    if (projectId !== 'p-termhub') return res;
    const one = keepBoth ? res : { ...res, actions: res.actions.filter((a) => a.id !== 'a-termhub-2') };
    return { ...one, ...patch(one) };
  });
}

const GRANT: TChatGrant = { id: 'g1', tab_id: 't-api', tool: 'send_input', source_action_id: 'a-termhub-1', created_at: '2026-09-25T10:00:00.000Z', expires_at: '2099-01-01T00:00:00.000Z', tab_name: 'api' };
const PROJECT_GRANT: TChatProjectGrant = { id: 'pg1', project_id: 'p-termhub', project_name: 'termhub', source_action_id: 'a-termhub-2', created_at: '2026-09-25T10:00:00.000Z', expires_at: '2099-01-01T00:00:00.000Z', scope: 'board' };
const STANDING_GRANT: TChatStandingGrant = { id: 'sg1', project_id: 'p-termhub', project_name: 'termhub', kind: 'terminal', source_action_id: 'a-termhub-1', created_at: '2026-09-25T10:00:00.000Z' };
const SUBAGENT: TSubagentView = { id: 'sub1', description: 'Buscar CI', subagent_type: null, status: 'running', started_at: '2026-09-27T00:00:00.000Z', ended_at: null };
const withAction = (res: TChatResponse, patch: Partial<TChatAction>): TChatAction[] => res.actions.map((a) => (a.id === 'a-termhub-1' ? { ...a, ...patch } : a));

/** The first load of a file signs its first P-256 proof, slow while other suites share the CPU. */
const LOAD = { timeout: 15_000 };

beforeAll(async () => {
  await enrolStores();
  await stores.chat.getState().loadProjects();
});

/** The slots as the test found them, restored after it: rows a test put in (`addRows`, a send over a
 * mocked 202) would otherwise stay — a re-read merges by id and keeps rows newer than its snapshot,
 * so the next test's open would not wash them out. */
let conversationsBefore: ReturnType<typeof useChatStore.getState>['conversations'];

beforeEach(() => {
  mockId = 'p-termhub';
  conversationsBefore = useChatStore.getState().conversations;
  for (const fn of Object.values(mockRouter)) fn.mockClear();
  mockRouter.canGoBack.mockReturnValue(true);
  mockVoice.state = 'idle';
  mockVoice.seconds = 0;
  mockVoice.error = null;
  mockVoice.notice = null;
  // The screens are under test here, not the socket (the store's own tests cover it): no events.
  jest.spyOn(stores.api, 'events').mockReturnValue(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
  useChatStore.setState({
    error: null,
    sending: false,
    live: emptyFold(),
    conversations: conversationsBefore,
    send: realActions.send,
    decide: realActions.decide,
    decideMany: realActions.decideMany,
    reset: realActions.reset,
    setHost: realActions.setHost,
    revokeGrant: realActions.revokeGrant,
    answerTabQuestion: realActions.answerTabQuestion,
    sendTabSuggestion: realActions.sendTabSuggestion,
    dismissTabSuggestion: realActions.dismissTabSuggestion,
    answerTabLimit: realActions.answerTabLimit,
    retrySend: realActions.retrySend,
    cancelSubagent: realActions.cancelSubagent,
    questionErrors: {},
    suggestionErrors: {},
    answeringQuestionIds: [],
    busySuggestionIds: [],
    limitErrors: {},
    busyLimitIds: [],
  });
});

describe('Conversa', () => {
  it('renders the thread: the person in plain text, the assistant as markdown and the title; a ready project chat names its host but offers no machine picker', async () => {
    await render(<ConversationScreen />);
    expect(await screen.findByText(SEEDED_USER, undefined, LOAD)).toBeTruthy();
    const markdown = screen.getAllByTestId('markdown').map((node) => node.props.children);
    expect(markdown).toContain(SEEDED_ASSISTANT);
    expect(markdown).not.toContain(SEEDED_USER);
    expect(screen.getByText('termhub')).toBeTruthy();
    // A project chat's host line is the way to the project's accounts and model (TER-589); its machine is not picked here.
    expect(screen.getByText('Esta conversa roda na máquina jarvis, na conta padrão do Claude dela.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Conta e modelo' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Trocar máquina ou conta' })).toBeNull();
  });

  it('shows a streaming bubble with the folded deltas, "pensando…" for a started empty row, and a failure sentence', async () => {
    await render(<ConversationScreen />);
    await screen.findByText(SEEDED_USER, undefined, LOAD);

    // A started row waits wherever it is: several answers can be pending at once (spec 2026-09-26).
    const thinking = assistantRow('m-think', { created_at: at(3) });
    await act(() =>
      addRows(
        [assistantRow('m-stream', { created_at: at(1) }), assistantRow('m-failed', { error_code: 'HOST_GONE', created_at: at(2) }), thinking],
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
    await act(() => useChatStore.setState({ live: foldLive([delta('m-stream', 'Rodei'), delta('m-stream', ' os testes')]) }));
    expect(screen.getByText('Rodei os testes')).toBeTruthy();
    expect(renders).toEqual(['Rodei os testes']);
  });

  it('renders the pending action card; Autorizar calls decide(id, approve)', async () => {
    serveChat();
    const decide = stubAction('decide');
    await render(<ConversationScreen />);
    expect(await screen.findByText('digitar `npm test` na aba api do projeto termhub, no jarvis', undefined, LOAD)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Recusar' })).toBeTruthy();

    await fireEvent.press(screen.getByRole('button', { name: 'Autorizar' }));
    expect(decide).toHaveBeenCalledWith('a-termhub-1', 'approve');
  });

  it('groups two pending actions into one card; toggling and approving calls decideMany, "Ver separadas" ungroups', async () => {
    serveChat(undefined, true);
    const decideMany = stubAction('decideMany');
    await render(<ConversationScreen />);
    expect(await screen.findByText('2 ações aguardando sua confirmação', undefined, LOAD)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Autorizar' })).toBeNull();

    const secondSummary = 'mover a tarefa TER-12 "Revisar o login" do projeto termhub';
    const secondRow = screen.getByRole('checkbox', { name: secondSummary });
    expect(secondRow.props.accessibilityState.checked).toBe(true);
    await fireEvent.press(secondRow);
    expect(screen.getByRole('checkbox', { name: secondSummary }).props.accessibilityState.checked).toBe(false);

    await fireEvent.press(screen.getByRole('button', { name: 'Aprovar selecionadas (1)' }));
    expect(decideMany).toHaveBeenCalledWith([
      { id: 'a-termhub-1', decision: 'approve' },
      { id: 'a-termhub-2', decision: 'deny' },
    ]);

    await fireEvent.press(screen.getByRole('button', { name: 'Ver separadas' }));
    expect(screen.getAllByRole('button', { name: 'Autorizar' })).toHaveLength(2);
  });

  it('Autorizar approves a write card at once, with no PIN sheet (TER-92)', async () => {
    serveChat();
    // Spied, not `stubAction`: the store's own `decide` logic (the thing under test) still runs,
    // it just never reaches the real mock server, so the shared fixture stays pending for later tests.
    const decide = jest.spyOn(stores.api, 'decide').mockResolvedValueOnce(undefined);
    await render(<ConversationScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Autorizar' }, LOAD));
    await waitFor(() => expect(useChatStore.getState().decidingId).toBeNull());
    expect(decide).toHaveBeenCalledWith(expect.anything(), 'a-termhub-1', { decision: 'approve' });
    expect(useSessionStore.getState().pinPrompt).toBeNull();
  });

  it('Autorizar opens the PIN sheet for an irreversible card (TER-92)', async () => {
    serveChat((res) => ({ actions: withAction(res, { class: 'irreversible' }), grants: [] }));
    await render(<ConversationScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Autorizar' }, LOAD));
    expect(useSessionStore.getState().pinPrompt).toEqual({ actionId: 'a-termhub-1', decision: 'approve' });
    await act(() => useSessionStore.getState().cancelPinPrompt());
    expect(useChatStore.getState().decidingId).toBeNull();
  });

  it('offers "Permitir sempre nesta aba" on a pending send_input; it calls decide(id, approve_tab)', async () => {
    serveChat();
    const decide = stubAction('decide');
    await render(<ConversationScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Permitir sempre nesta aba' }, LOAD));
    expect(decide).toHaveBeenCalledWith('a-termhub-1', 'approve_tab');
  });

  it('offers "Permitir sempre neste projeto" on a pending move_task; it calls decide(id, approve_project)', async () => {
    serveChat((res) => ({ actions: res.actions.filter((a) => a.id === 'a-termhub-2') }), true);
    const decide = stubAction('decide');
    await render(<ConversationScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Permitir sempre neste projeto' }, LOAD));
    expect(decide).toHaveBeenCalledWith('a-termhub-2', 'approve_project');
  });

  it("counts the active grant in the header, opens Permissões do chat, and keeps the card's Revogar", async () => {
    serveChat((res) => ({ actions: withAction(res, { status: 'approved' }), grants: [GRANT] }));
    const revokeGrant = stubAction('revokeGrant');
    await render(<ConversationScreen />);
    const link = await screen.findByRole('button', { name: '1 permissão ativa' }, LOAD);
    expect(screen.queryByText(/^Enviando direto para/)).toBeNull();
    await fireEvent.press(link);
    expect(mockRouter.push).toHaveBeenCalledWith('/chat-grants');
    const revoke = screen.getAllByRole('button', { name: 'Revogar' });
    expect(revoke).toHaveLength(1);
    await fireEvent.press(revoke[0]!);
    expect(revokeGrant).toHaveBeenCalledWith('g1');
  });

  it('counts a tab grant and a project grant together: "2 permissões ativas"', async () => {
    serveChat((res) => ({ actions: withAction(res, { status: 'approved' }), grants: [GRANT], project_grants: [PROJECT_GRANT] }));
    await render(<ConversationScreen />);
    expect(await screen.findByRole('button', { name: '2 permissões ativas' }, LOAD)).toBeTruthy();
  });

  it('counts a standing grant with the others, and shows it on the card that created it (TER-386)', async () => {
    serveChat((res) => ({ actions: withAction(res, { status: 'approved' }), grants: [GRANT], project_grants: [], standing_grants: [STANDING_GRANT] }));
    const revokeGrant = stubAction('revokeGrant');
    await render(<ConversationScreen />);
    expect(await screen.findByRole('button', { name: '2 permissões ativas' }, LOAD)).toBeTruthy();
    expect(screen.getByText('Teclas e texto nas abas liberado neste projeto, sem prazo')).toBeTruthy();
    const revoke = screen.getAllByRole('button', { name: 'Revogar' });
    expect(revoke).toHaveLength(2);
    await fireEvent.press(revoke[1]!);
    expect(revokeGrant).toHaveBeenCalledWith('sg1');
  });

  it('shows the project grant on the card that created it, with Revogar', async () => {
    serveChat((res) => ({ actions: res.actions.filter((a) => a.id === 'a-termhub-2'), grants: [], project_grants: [PROJECT_GRANT] }), true);
    const revokeGrant = stubAction('revokeGrant');
    await render(<ConversationScreen />);
    expect(await screen.findByText(/^Permitido neste projeto/, undefined, LOAD)).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Revogar' }));
    expect(revokeGrant).toHaveBeenCalledWith('pg1');
  });

  it('shows no header button without an active grant', async () => {
    serveChat((res) => ({ actions: res.actions, grants: [] }));
    await render(<ConversationScreen />);
    await screen.findByText(SEEDED_USER, undefined, LOAD);
    expect(screen.queryByRole('button', { name: /permiss(ão|ões) ativa/ })).toBeNull();
  });

  it('with one running subagent, the header shows Subagentes (1); pressing it opens the sheet, whose Cancelar calls the store', async () => {
    serveChat(() => ({ subagents: [SUBAGENT] }));
    const cancelSubagent = stubAction('cancelSubagent');
    await render(<ConversationScreen />);
    const button = await screen.findByRole('button', { name: 'Subagentes (1)' }, LOAD);
    expect(screen.queryByText('Buscar CI')).toBeNull(); // the sheet is not open yet

    await fireEvent.press(button);
    expect(screen.getByText('Buscar CI')).toBeTruthy();
    expect(screen.getByText(/rodando/)).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Cancelar Buscar CI' }));
    expect(cancelSubagent).toHaveBeenCalledWith('sub1');
  });

  it('the sheet shows the elapsed time as of when it opens, not as of when the screen mounted', async () => {
    const realNow = Date.now.bind(Date);
    let offset = 0;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
    try {
      serveChat(() => ({ subagents: [{ ...SUBAGENT, started_at: new Date(realNow()).toISOString() }] }));
      await render(<ConversationScreen />);
      const button = await screen.findByRole('button', { name: 'Subagentes (1)' }, LOAD);
      offset = 10 * 60_000; // ten minutes later, the sheet is opened for the first time
      await fireEvent.press(button);
      expect(screen.getByText(/há 10 min/)).toBeTruthy();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('shows no Subagentes button with nothing running', async () => {
    serveChat(() => ({ subagents: [] }));
    await render(<ConversationScreen />);
    await screen.findByText(SEEDED_USER, undefined, LOAD);
    expect(screen.queryByRole('button', { name: /^Subagentes/ })).toBeNull();
  });

  it('a card whose action carries a subagent shows "Pedido pelo subagente «X»"', async () => {
    serveChat((res) => ({ actions: withAction(res, { subagent: { id: 'sub1', description: 'Buscar CI' } }) }));
    await render(<ConversationScreen />);
    expect(await screen.findByText('Pedido pelo subagente «Buscar CI»', undefined, LOAD)).toBeTruthy();
  });

  it('a grouped card shows the origin line for the action a subagent proposed', async () => {
    serveChat((res) => ({ actions: withAction(res, { subagent: { id: 'sub1', description: 'Buscar CI' } }) }), true);
    await render(<ConversationScreen />);
    await screen.findByText('2 ações aguardando sua confirmação', undefined, LOAD);
    expect(screen.getByText('Pedido pelo subagente «Buscar CI»')).toBeTruthy();
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

  it('an empty box offers Ditar; typing adds Enviar beside it, which sends and empties the box at once', async () => {
    const sent = jest.spyOn(stores.api, 'sendMessage').mockResolvedValue({ conversation_id: 'c-termhub', user_message_id: 'u', assistant_message_id: 'a' });
    await render(<ConversationScreen />);
    await screen.findByText(SEEDED_USER, undefined, LOAD);

    const dictate = screen.getByRole('button', { name: 'Ditar' });
    expect(dictate.props.accessibilityState.disabled).toBe(false);
    expect(screen.queryByRole('button', { name: 'Enviar' })).toBeNull();

    await fireEvent.changeText(screen.getByLabelText('Mensagem'), 'como está o deploy?');
    // The microphone stays: dictating adds to what is typed.
    expect(screen.getByRole('button', { name: 'Ditar' }).props.accessibilityState.disabled).toBe(false);
    await fireEvent.press(screen.getByRole('button', { name: 'Enviar' }));
    expect(sent).toHaveBeenCalledWith(expect.anything(), { text: 'como está o deploy?', project_id: 'p-termhub' });
    expect(screen.getByLabelText('Mensagem').props.value).toBe('');
  });

  it('Ditar starts a recording; while recording the button reads Parar, and the transcription lands in the box', async () => {
    await render(<ConversationScreen />);
    await screen.findByText(SEEDED_USER, undefined, LOAD);
    await fireEvent.press(screen.getByRole('button', { name: 'Ditar' }));
    expect(mockVoice.start).toHaveBeenCalledTimes(1);

    mockVoice.state = 'recording';
    mockVoice.seconds = 65;
    await act(() => mockOnText!('roda os testes')); // a re-render: the hook's state is read again
    expect(screen.getByLabelText('Mensagem').props.value).toBe('roda os testes');
    expect(screen.getByText('1:05')).toBeTruthy();
    // Listening never sends mid-sentence: ↑ steps aside while recording, even with text in the box.
    expect(screen.queryByRole('button', { name: 'Enviar' })).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Parar' }));
    expect(mockVoice.stop).toHaveBeenCalledTimes(1);
    await fireEvent.press(screen.getByRole('button', { name: 'Cancelar gravação' }));
    expect(mockVoice.cancel).toHaveBeenCalledTimes(1);
  });

  it('while the clip is being transcribed the button waits and the status line says so; an error shows under the box', async () => {
    await render(<ConversationScreen />);
    await screen.findByText(SEEDED_USER, undefined, LOAD);
    mockVoice.state = 'transcribing';
    mockVoice.error = 'Falha ao transcrever o áudio';
    // A store change the composer's props follow, so it renders again and reads the hook's new state
    // (a transcription of '' would leave the text as it is, and React would skip the render).
    await act(() => useChatStore.setState({ sending: true }));
    expect(screen.getByText('transcrevendo…')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Ditar' }).props.accessibilityState.disabled).toBe(true);
    expect(screen.getByText('Falha ao transcrever o áudio')).toBeTruthy();
  });

  it("shows a sent message's attachments under its text, with their status, and opens an image full screen", async () => {
    await render(<ConversationScreen />);
    await screen.findByText(SEEDED_USER, undefined, LOAD);
    const attachment = { id: 'att1', name: 'relatorio.pdf', mime: 'application/pdf', kind: 'pdf' as const, bytes: 2048, status: 'pending' as const, error_code: null, meta: null, created_at: new Date().toISOString() };
    const image = { ...attachment, id: 'img1', name: 'foto.jpg', mime: 'image/jpeg', kind: 'image' as const, status: 'ready' as const };
    await act(() => addRows([{ ...assistantRow('m-user'), role: 'user', text: 'leia', attachments: [attachment, image] }], []));

    expect(screen.getByText('relatorio.pdf')).toBeTruthy();
    expect(screen.getByText('2 KB')).toBeTruthy();
    expect(screen.getByText('processando…')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Abrir imagem foto.jpg' }));
    expect(await screen.findByRole('button', { name: 'Fechar imagem' })).toBeTruthy();
  });

  it('the box grows with its content between one and six lines, then scrolls; wrapping moves the text above the buttons', async () => {
    await render(<ConversationScreen />);
    const input = await screen.findByLabelText('Mensagem', undefined, LOAD);
    // NativeWind hands the host element an array of styles: flatten before reading.
    const style = () => StyleSheet.flatten(screen.getByLabelText('Mensagem').props.style);
    const scrolls = () => screen.getByLabelText('Mensagem').props.scrollEnabled;
    // The text's frame glides (composer.motion.test.tsx looks at the motion): wait for where it lands.
    const lands = (frame: object) => waitFor(() => expect(getAnimatedStyle(screen.getByTestId('composer-text'))).toMatchObject(frame), SETTLE);
    // One line: no padding of its own, the text between 📎 and the button, on their row. The input
    // has no height set: it sizes itself to its text, between one line and six.
    expect(style()).toMatchObject({ minHeight: 22, maxHeight: 132, lineHeight: 22, padding: 0, paddingTop: 0, paddingBottom: 0 });
    expect(style().height).toBeUndefined();
    expect(screen.getByLabelText('Mensagem').props.textAlignVertical).toBe('top');
    expect(scrolls()).toBe(false);
    await lands(BESIDE_BUTTONS);

    await fireEvent(input, 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 300, height: 66 } } });
    expect(scrolls()).toBe(false);
    await lands({ ...ABOVE_BUTTONS, height: 72 });
    // The input survived the switch: the same host element, not a remount (the keyboard stays up).
    expect(screen.getByLabelText('Mensagem')).toBe(input);

    await fireEvent(input, 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 300, height: 400 } } });
    expect(scrolls()).toBe(true);
    await lands({ height: 138 });
    await fireEvent(input, 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 300, height: 10 } } });
    expect(scrolls()).toBe(false);
    // Still above: the text only goes back beside the buttons once the box is emptied.
    await lands({ ...ABOVE_BUTTONS, height: 28 });
  });

  it('sending a long message brings the box back to one line, beside the buttons', async () => {
    jest.spyOn(stores.api, 'sendMessage').mockResolvedValue({ conversation_id: 'c-termhub', user_message_id: 'u', assistant_message_id: 'a' });
    await render(<ConversationScreen />);
    const input = await screen.findByLabelText('Mensagem', undefined, LOAD);
    await fireEvent.changeText(input, 'uma mensagem longa '.repeat(30));
    await fireEvent(input, 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 300, height: 400 } } });
    expect(screen.getByLabelText('Mensagem').props.scrollEnabled).toBe(true);
    await waitFor(() => expect(getAnimatedStyle(screen.getByTestId('composer-text'))).toMatchObject(ABOVE_BUTTONS), SETTLE);

    await fireEvent.press(screen.getByRole('button', { name: 'Enviar' }));
    expect(screen.getByLabelText('Mensagem').props.value).toBe('');
    expect(screen.getByLabelText('Mensagem').props.scrollEnabled).toBe(false);
    expect(screen.getByRole('button', { name: 'Ditar' })).toBeTruthy();
    await waitFor(() => expect(getAnimatedStyle(screen.getByTestId('composer-text'))).toMatchObject(BESIDE_BUTTONS), SETTLE);
  });

  it('avoids the keyboard with padding on iOS', async () => {
    await render(<ConversationScreen />);
    await screen.findByText(SEEDED_USER, undefined, LOAD);
    // RNTL only sees host views: the `padding` behaviour is the one that pads the bottom by the
    // keyboard's height (0 while it is down); `height` and no behaviour leave the padding unset.
    expect(StyleSheet.flatten(screen.getByTestId('conversation-keyboard').props.style).paddingBottom).toBe(0);
  });

  it('lifts the composer right onto the keyboard, from where the conversation really starts on screen (measured)', async () => {
    // Host views' native methods are jest mocks shared by every view: this one says the conversation
    // starts 91 pt down the screen — more than the (zero) top inset jest reports.
    const nativeMethods = require('@react-native/jest-preset/jest/MockNativeMethods').default as { measureInWindow: jest.Mock };
    nativeMethods.measureInWindow.mockImplementation((cb: (x: number, y: number, w: number, h: number) => void) => cb(0, 91, 390, 700));
    try {
      await render(<ConversationScreen />);
      await screen.findByText(SEEDED_USER, undefined, LOAD);
      const layout = { persist: () => undefined, nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 700 } } };
      await fireEvent(screen.getByTestId('conversation-body'), 'layout', layout);
      await fireEvent(screen.getByTestId('conversation-keyboard'), 'layout', layout);
      // The keyboard's top at 500 on screen; the avoiding view's bottom is at 91 + 700 = 791 on screen.
      await act(() => {
        DeviceEventEmitter.emit('keyboardWillShow', {
          duration: 0,
          easing: 'keyboard',
          startCoordinates: { screenX: 0, screenY: 844, width: 390, height: 0 },
          endCoordinates: { screenX: 0, screenY: 500, width: 390, height: 344 },
          isEventFromThisApp: true,
        });
      });
      await waitFor(() => expect(StyleSheet.flatten(screen.getByTestId('conversation-keyboard').props.style).paddingBottom).toBe(291));
    } finally {
      nativeMethods.measureInWindow.mockReset();
    }
  });

  it('keeps nothing empty under the box: the dictation error and notice lines only show with text', async () => {
    await render(<ConversationScreen />);
    await screen.findByText(SEEDED_USER, undefined, LOAD);
    expect(screen.queryByText('Nenhuma fala reconhecida')).toBeNull();
    mockVoice.notice = 'Nenhuma fala reconhecida';
    await act(() => useChatStore.setState({ sending: true }));
    expect(screen.getByText('Nenhuma fala reconhecida')).toBeTruthy();
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
    // The tabs' index is Home now (TER-541): a conversation falls back to the list it belongs to.
    expect(mockRouter.replace).toHaveBeenCalledWith('/(tabs)/chats');
  });

  const QUESTION_BASE = { tab_id: 't-api', tab_name: 'api', error_code: null, created_at: new Date().toISOString(), answered_at: null, closed_at: null };
  const OPEN_CHOICE = { ...QUESTION_BASE, id: 'q1', kind: 'choice', status: 'open', answer: null, payload: { questions: [{ question: 'Qual banco usamos nos testes?', header: 'Banco', multi_select: false, options: [{ label: 'Postgres', description: 'O mesmo da produção.', recommended: true }, { label: 'SQLite', description: '', recommended: false }] }] } } as TTabQuestion;
  const OPEN_PERMISSION = { ...QUESTION_BASE, id: 'q2', kind: 'permission', status: 'open', answer: null, payload: { tool_name: 'Bash' } } as TTabQuestion;
  const TWO_QUESTIONS = {
    ...QUESTION_BASE,
    id: 'q3',
    kind: 'choice',
    status: 'open',
    answer: null,
    payload: {
      questions: [
        { question: 'Qual banco usamos nos testes?', header: 'Banco', multi_select: false, options: [{ label: 'Postgres', description: 'O mesmo da produção.', recommended: true }, { label: 'SQLite', description: '', recommended: false }] },
        { question: 'Qual runner?', header: 'Runner', multi_select: false, options: [{ label: 'Vitest', description: '', recommended: false }, { label: 'Jest', description: '', recommended: false }] },
      ],
    },
  } as TTabQuestion;

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
    await fireEvent.press(screen.getByRole('radio', { name: 'Postgres, recomendada' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Responder' }));
    expect(answer).toHaveBeenCalledWith('q1', { answers: [{ selected: [0] }] });
  });

  it("dragging a tab's question card answers it with a reference to the card (TER-849)", async () => {
    serveQuestions([OPEN_CHOICE]);
    const sent = jest.spyOn(stores.api, 'sendMessage').mockReturnValue(new Promise(() => undefined));
    await render(<ConversationScreen />);
    const card = await screen.findByTestId('tab-question-q1', undefined, LOAD);
    const row = screen.getAllByTestId('swipe-to-reply-row').find((r) => within(r).queryByTestId('tab-question-q1'))!;
    expect(within(row).getByTestId('tab-question-q1')).toBe(card);
    await fireEvent(row, 'accessibilityAction', { nativeEvent: { actionName: 'reply' } });
    expect(screen.getByText('Respondendo à pergunta da aba')).toBeTruthy();

    await fireEvent.changeText(screen.getByLabelText('Mensagem'), 'Postgres, como na produção');
    await fireEvent.press(screen.getByRole('button', { name: 'Enviar' }));
    expect(sent).toHaveBeenCalledWith(expect.anything(), { text: 'Postgres, como na produção', project_id: 'p-termhub', reply_to_card: { kind: 'tab_question', id: 'q1' } });
    expect(await screen.findByRole('button', { name: 'Ver card original: Pergunta da aba, Qual banco usamos nos testes?' })).toBeTruthy();
    useChatStore.setState({ sending: false });
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

  const OPEN_SUGGESTION = { id: 's1', tab_id: 't-api', tab_name: 'api', kind: 'suggestion', payload: { text: 'commit it' }, status: 'open', answer: null, error_code: null, created_at: new Date().toISOString(), answered_at: null, closed_at: null } as TTabSuggestion;

  /** Serves the open project's `GET chat` with these tab suggestions. */
  function serveSuggestions(suggestions: TTabSuggestion[]) {
    const real = stores.api.chat.bind(stores.api);
    jest.spyOn(stores.api, 'chat').mockImplementation(async (auth, projectId) => {
      const res = await real(auth, projectId);
      return projectId === 'p-termhub' ? { ...res, tab_suggestions: suggestions } : res;
    });
  }

  const OPEN_LIMIT: TTabLimit = {
    id: 'l1',
    tab_id: 't-api',
    tab_name: 'api',
    payload: { account: { id: 'acc-1', label: 'Claude Pedro' }, machine: { id: 'm-jarvis', name: 'jarvis' }, resets_at: null, candidates: [{ id: 'acc-2', label: 'Claude Trabalho' }] },
    status: 'open',
    result: null,
    created_at: new Date().toISOString(),
    closed_at: null,
  };

  /** Serves the open project's `GET chat` with these usage-limit cards. */
  function serveLimits(limits: TTabLimit[]) {
    const real = stores.api.chat.bind(stores.api);
    jest.spyOn(stores.api, 'chat').mockImplementation(async (auth, projectId) => {
      const res = await real(auth, projectId);
      return projectId === 'p-termhub' ? { ...res, tab_limits: limits } : res;
    });
  }

  it('renders a usage-limit card in the thread; its buttons answer it, and its error shows in it (TER-589)', async () => {
    serveLimits([OPEN_LIMIT]);
    const answer = stubAction('answerTabLimit');
    await render(<ConversationScreen />);
    expect(await screen.findByText('Limite de uso da conta', undefined, LOAD)).toBeTruthy();
    expect(screen.getByText('A conta Claude Pedro da aba api atingiu o limite de uso (cota de tokens esgotada). A troca automática está desligada na máquina jarvis.')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Trocar para Claude Trabalho' }));
    expect(answer).toHaveBeenCalledWith('l1', 'acc-2');
    await fireEvent.press(screen.getByRole('button', { name: 'Esperar' }));
    expect(answer).toHaveBeenLastCalledWith('l1', null);
    await act(async () => useChatStore.setState({ limitErrors: { l1: 'A máquina jarvis está offline' } }));
    expect(within(screen.getByTestId('tab-limit-l1')).getByText('A máquina jarvis está offline')).toBeTruthy();
  });

  it('a closed usage-limit card says how it ended and offers nothing', async () => {
    serveLimits([{ ...OPEN_LIMIT, status: 'swapped', result: 'acc-2' }]);
    await render(<ConversationScreen />);
    expect(await screen.findByText('Conta trocada para Claude Trabalho.', undefined, LOAD)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Esperar' })).toBeNull();
  });

  it("the project chat's host sheet names the project's account and leads to its accounts and model (TER-589)", async () => {
    const real = stores.api.chat.bind(stores.api);
    jest.spyOn(stores.api, 'chat').mockImplementation(async (auth, projectId) => {
      const res = await real(auth, projectId);
      if (projectId !== 'p-termhub' || res.host.kind !== 'ready') return res;
      return { ...res, host: { ...res.host, account: { kind: 'chosen', id: 'acc-2', label: 'Claude Trabalho', via: 'project' } } };
    });
    await render(<ConversationScreen />);
    expect(await screen.findByText('Esta conversa roda na máquina jarvis, na conta Claude Trabalho, definida pelo projeto.', undefined, LOAD)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Trocar máquina ou conta' })).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Conta e modelo' }));
    expect(await screen.findByText('Conta definida pelo projeto: Claude Trabalho', undefined, LOAD)).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Contas e modelo do projeto' }));
    expect(mockRouter.push).toHaveBeenCalledWith('/project-ai/p-termhub');
  });

  it('the account-wide chat keeps its host line hidden while ready, and never offers the project row', async () => {
    mockId = 'general';
    await render(<ConversationScreen />);
    expect(await screen.findByText('Chat geral', undefined, LOAD)).toBeTruthy();
    await waitFor(() => expect(useChatStore.getState().conversations['']?.loaded).toBe(true), LOAD);
    expect(screen.queryByText(/Esta conversa roda na máquina/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Conta e modelo' })).toBeNull();
  });

  it("renders a tab's suggestion; Enviar sends the edited text, Dispensar dismisses", async () => {
    serveSuggestions([OPEN_SUGGESTION]);
    const sendSuggestion = stubAction('sendTabSuggestion');
    const dismissSuggestion = stubAction('dismissTabSuggestion');
    await render(<ConversationScreen />);
    expect(await screen.findByText('«api» terminou — o Claude Code sugere:', undefined, LOAD)).toBeTruthy();
    expect(screen.getByText('Não precisa responder.')).toBeTruthy();
    await fireEvent.changeText(screen.getByLabelText('Sugestão do Claude Code (opcional — edite ou dispense)'), '  commit it and push ');
    // Scoped to the card: the composer has its own "Enviar" button on screen at the same time.
    await fireEvent.press(within(screen.getByTestId('tab-suggestion-s1')).getByRole('button', { name: 'Enviar' }));
    expect(sendSuggestion).toHaveBeenCalledWith('s1', 'commit it and push');
    await fireEvent.press(screen.getByRole('button', { name: 'Dispensar' }));
    expect(dismissSuggestion).toHaveBeenCalledWith('s1');
  });

  it.each([
    [{ ...OPEN_SUGGESTION, status: 'answered', answer: { text: 'commit it and push' } } as TTabSuggestion, ['commit it and push', 'Enviada']],
    [{ ...OPEN_SUGGESTION, status: 'dismissed' } as TTabSuggestion, ['Dispensada']],
    [{ ...OPEN_SUGGESTION, status: 'answered_in_tab' } as TTabSuggestion, ['Respondida na aba']],
  ])('a closed suggestion is read-only and says how it ended (%#)', async (s, texts) => {
    serveSuggestions([s]);
    await render(<ConversationScreen />);
    for (const t of texts) expect(await screen.findByText(t, undefined, LOAD)).toBeTruthy();
    expect(screen.queryByLabelText('Sugestão do Claude Code (opcional — edite ou dispense)')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Dispensar' })).toBeNull();
  });

  it('a11y: question tabs say which is selected; options name the recommended one and read their description as a hint (spec 2026-09-26 §4.12)', async () => {
    serveQuestions([TWO_QUESTIONS]);
    await render(<ConversationScreen />);
    expect(await screen.findByRole('tab', { name: 'Banco', selected: true }, LOAD)).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Runner', selected: false })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Postgres, recomendada' }).props.accessibilityHint).toBe('O mesmo da produção.');
    expect(screen.getByRole('radio', { name: 'SQLite' }).props.accessibilityHint).toBeUndefined();
    await fireEvent.press(screen.getByRole('tab', { name: 'Runner' }));
    expect(screen.getByRole('tab', { name: 'Runner', selected: true })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Vitest' })).toBeTruthy();
  });

  it('each question card shows its own error, and only the card in flight is busy (spec 2026-09-26 §4.13)', async () => {
    serveQuestions([OPEN_CHOICE, OPEN_PERMISSION]);
    await render(<ConversationScreen />);
    await screen.findByText('Qual banco usamos nos testes?', undefined, LOAD);
    await act(async () => useChatStore.setState({ questionErrors: { q2: 'A pergunta mudou na aba' }, answeringQuestionIds: ['q1'] }));
    expect(within(screen.getByTestId('tab-question-q2')).getByText('A pergunta mudou na aba')).toBeTruthy();
    expect(within(screen.getByTestId('tab-question-q1')).queryByText('A pergunta mudou na aba')).toBeNull();
    expect(within(screen.getByTestId('tab-question-q1')).getByRole('radio', { name: 'SQLite', disabled: true })).toBeTruthy();
    expect(within(screen.getByTestId('tab-question-q2')).getByRole('button', { name: 'Permitir', disabled: false })).toBeTruthy();
  });

  it('a suggestion card shows the message it answers, collapsed to its last paragraph, and its own error', async () => {
    serveSuggestions([{ ...OPEN_SUGGESTION, payload: { text: 'C, pode seguir', context: 'Criei o arquivo notes.txt.\n\nQuer que eu faça o commit?' } } as TTabSuggestion]);
    await render(<ConversationScreen />);
    expect(await screen.findByText('Quer que eu faça o commit?', undefined, LOAD)).toBeTruthy();
    expect(screen.queryByText(/Criei o arquivo/)).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Ver mensagem inteira' }));
    expect(screen.getByText(/Criei o arquivo notes\.txt\./)).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Recolher' }));
    expect(screen.queryByText(/Criei o arquivo/)).toBeNull();
    await act(async () => useChatStore.setState({ suggestionErrors: { s1: 'A sugestão mudou na aba' } }));
    expect(within(screen.getByTestId('tab-suggestion-s1')).getByText('A sugestão mudou na aba')).toBeTruthy();
  });

  it('a row whose send failed shows the reason and "Tentar de novo", which calls retrySend', async () => {
    const retrySend = stubAction('retrySend');
    await render(<ConversationScreen />);
    await screen.findByText(SEEDED_USER, undefined, LOAD);
    await act(() =>
      addRows([{ id: 'local:1', conversation_id: 'c-termhub', role: 'user', text: 'oi de novo', usage: null, error_code: null, created_at: new Date().toISOString(), local: 'failed', local_error: 'A máquina do chat está offline.' }], []),
    );
    expect(screen.getByText('oi de novo')).toBeTruthy();
    expect(screen.getByText('A máquina do chat está offline.')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(retrySend).toHaveBeenCalledWith('local:1');
  });

  it('the box empties as soon as Enviar is pressed and gets its text back when the send fails', async () => {
    let reject!: (e: unknown) => void;
    jest.spyOn(stores.api, 'sendMessage').mockImplementation(() => new Promise((_, r) => { reject = r; }));
    await render(<ConversationScreen />);
    await screen.findByText(SEEDED_USER, undefined, LOAD);

    await fireEvent.changeText(screen.getByLabelText('Mensagem'), 'oi');
    await fireEvent.press(screen.getByRole('button', { name: 'Enviar' }));
    expect(screen.getByLabelText('Mensagem').props.value).toBe('');
    await act(async () => {
      reject(new ApiError(409, 'HOST_OFFLINE', 'A máquina do chat está offline.'));
    });
    expect(screen.getByLabelText('Mensagem').props.value).toBe('oi');
  });
});

describe('Conversa: pending cards at hand (spec 2026-09-30 TER-477)', () => {
  const SECOND = 'mover a tarefa TER-12 "Revisar o login" do projeto termhub';

  it('shows the pending bar above the composer; a line scrolls the thread to the card that holds it', async () => {
    serveChat(undefined, true);
    const scrollToIndex = jest.spyOn(FlatList.prototype, 'scrollToIndex').mockImplementation(() => undefined);
    await render(<ConversationScreen />);
    expect(await screen.findByText('2 ações aguardando sua confirmação', undefined, LOAD)).toBeTruthy();
    // Nothing else waits in the seed: the two confirmations.
    await fireEvent.press(within(screen.getByTestId('pending-bar')).getByRole('button', { name: /2 pendentes$/ }));
    await fireEvent.press(within(screen.getByTestId('pending-bar')).getByText(SECOND));
    // Both are in one group card: the line finds the group that holds its id.
    const data = screen.getByTestId('conversation-thread').props.data as { kind: string }[];
    const index = data.findIndex((e) => e.kind === 'action_group');
    expect(index).toBeGreaterThanOrEqual(0);
    expect(scrollToIndex).toHaveBeenCalledWith({ index, viewPosition: 0.5, animated: true });
    // The bar folds after the jump.
    expect(within(screen.getByTestId('pending-bar')).queryByText(SECOND)).toBeNull();
  });

  it('"Aprovar as reversíveis (2)" approves both writes through decideMany', async () => {
    serveChat(undefined, true);
    const decideMany = stubAction('decideMany');
    await render(<ConversationScreen />);
    await screen.findByText('2 ações aguardando sua confirmação', undefined, LOAD);
    await fireEvent.press(within(screen.getByTestId('pending-bar')).getByRole('button', { name: /2 pendentes$/ }));
    await fireEvent.press(screen.getByRole('button', { name: 'Aprovar as reversíveis (2)' }));
    expect(decideMany).toHaveBeenCalledWith([
      { id: 'a-termhub-1', decision: 'approve' },
      { id: 'a-termhub-2', decision: 'approve' },
    ]);
  });

  it('no bar while nothing waits', async () => {
    serveChat((res) => ({ actions: withAction(res, { status: 'executed' }) }));
    await render(<ConversationScreen />);
    await screen.findByText('executada', undefined, LOAD);
    expect(screen.queryByTestId('pending-bar')).toBeNull();
  });

  it('an expired card offers "Propor de novo", which sends "Proponha de novo: <summary>" in this conversation', async () => {
    serveChat((res) => ({ actions: withAction(res, { status: 'failed', error_code: 'TAB_GONE' }) }));
    const send = stubAction('send');
    await render(<ConversationScreen />);
    expect(await screen.findByText('expirou: a aba foi fechada', undefined, LOAD)).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Propor de novo' }));
    expect(send).toHaveBeenCalledWith('Proponha de novo: digitar `npm test` na aba api do projeto termhub, no jarvis');
  });
});

describe('ConversationView (iPad, spec 2026-09-28 §2.3/§2.4)', () => {
  it('embedded: shows the thread without a "Voltar" button', async () => {
    await render(<ConversationView routeId="p-termhub" embedded />);
    expect(await screen.findByText(SEEDED_USER, undefined, { timeout: 15_000 })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Voltar' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Nova conversa' })).toBeTruthy();
  });

  it('as the route: keeps "Voltar"', async () => {
    await render(<ConversationScreen />);
    await screen.findByText(SEEDED_USER, undefined, { timeout: 15_000 });
    expect(screen.getByRole('button', { name: 'Voltar' })).toBeTruthy();
  });

  it('centres the thread and the composer in a readable column; the list itself fills the pane', async () => {
    await render(<ConversationView routeId="p-termhub" embedded />);
    await screen.findByText(SEEDED_USER, undefined, { timeout: 15_000 });
    const list = screen.getByTestId('conversation-thread');
    expect(StyleSheet.flatten(list.props.contentContainerStyle)).toMatchObject({ width: '100%', maxWidth: 720, alignSelf: 'center' });
    expect(StyleSheet.flatten(list.props.style)?.maxWidth).toBeUndefined();
    expect(StyleSheet.flatten(screen.getByTestId('conversation-composer-column').props.style)).toMatchObject({ width: '100%', maxWidth: 720, alignSelf: 'center' });
  });
});

describe('replies (TER-447)', () => {
  it('answering a message quotes it in the composer and sends the reference; the preview goes with the text', async () => {
    // Held open: the optimistic row is what shows the quote while the server has not answered.
    const sent = jest.spyOn(stores.api, 'sendMessage').mockReturnValue(new Promise(() => undefined));
    await render(<ConversationScreen />);
    await screen.findByText(SEEDED_USER, undefined, LOAD);
    const answer = useChatStore.getState().conversations['p-termhub']!.messages.find((m) => m.text === SEEDED_ASSISTANT)!;
    const rows = screen.getAllByTestId('swipe-to-reply-row');
    const row = rows.find((r) => within(r).queryAllByTestId('markdown').some((n) => n.props.children === SEEDED_ASSISTANT))!;
    await fireEvent(row, 'accessibilityAction', { nativeEvent: { actionName: 'reply' } });
    expect(screen.getByText('Respondendo a Concierge')).toBeTruthy();

    await fireEvent.changeText(screen.getByLabelText('Mensagem'), 'roda de novo');
    await fireEvent.press(screen.getByRole('button', { name: 'Enviar' }));
    expect(sent).toHaveBeenCalledWith(expect.anything(), { text: 'roda de novo', project_id: 'p-termhub', reply_to_id: answer.id });
    expect(screen.queryByText('Respondendo a Concierge')).toBeNull();
    // The new row shows what it answers, above its text, from the moment it is sent.
    expect(await screen.findByRole('button', { name: /^Ver mensagem original: Concierge,/ })).toBeTruthy();
    useChatStore.setState({ sending: false });
  });

  it('dragging a confirmation card answers it with a reference to the card (TER-849)', async () => {
    serveChat();
    const sent = jest.spyOn(stores.api, 'sendMessage').mockReturnValue(new Promise(() => undefined));
    await render(<ConversationScreen />);
    const summary = await screen.findByText('digitar `npm test` na aba api do projeto termhub, no jarvis', undefined, LOAD);
    const row = screen.getAllByTestId('swipe-to-reply-row').find((r) => within(r).queryByText('digitar `npm test` na aba api do projeto termhub, no jarvis'))!;
    expect(within(row).getByText('digitar `npm test` na aba api do projeto termhub, no jarvis')).toBe(summary);
    await fireEvent(row, 'accessibilityAction', { nativeEvent: { actionName: 'reply' } });
    expect(screen.getByText('Respondendo à confirmação')).toBeTruthy();

    await fireEvent.changeText(screen.getByLabelText('Mensagem'), 'por que essa aba?');
    await fireEvent.press(screen.getByRole('button', { name: 'Enviar' }));
    expect(sent).toHaveBeenCalledWith(expect.anything(), { text: 'por que essa aba?', project_id: 'p-termhub', reply_to_card: { kind: 'action', id: 'a-termhub-1' } });
    expect(await screen.findByRole('button', { name: 'Ver card original: Confirmação, digitar npm test na aba api do projeto termhub, no jarvis' })).toBeTruthy();
    useChatStore.setState({ sending: false });
  });

  it("a tap on a card's quote scrolls to the card; one no longer in the thread says so", async () => {
    serveChat();
    const scroll = jest.spyOn(require('react-native').FlatList.prototype, 'scrollToIndex').mockImplementation(() => undefined);
    await render(<ConversationScreen />);
    await screen.findByText(SEEDED_USER, undefined, LOAD);
    await act(async () =>
      addRows(
        [
          { id: 'r1', conversation_id: 'c-termhub', role: 'user', text: 'e isso?', usage: null, error_code: null, created_at: at(1), reply_to: { id: null, role: 'assistant', excerpt: 'digitar npm test', card: { kind: 'action', id: 'a-termhub-1' } } },
          { id: 'r2', conversation_id: 'c-termhub', role: 'user', text: 'e aquela?', usage: null, error_code: null, created_at: at(2), reply_to: { id: null, role: 'assistant', excerpt: 'Qual cor?', card: { kind: 'tab_question', id: 'gone' } } },
        ],
        [],
      ),
    );
    await fireEvent.press(await screen.findByRole('button', { name: 'Ver card original: Confirmação, digitar npm test' }));
    expect(scroll).toHaveBeenCalledTimes(1);
    await fireEvent.press(screen.getByRole('button', { name: 'Ver card original: Pergunta da aba, Qual cor?' }));
    expect(screen.getByText('Card original indisponível')).toBeTruthy();
    expect(scroll).toHaveBeenCalledTimes(1);
  });

  it('a tap on a quote scrolls to the original; one that is not loaded says so', async () => {
    const scroll = jest.spyOn(require('react-native').FlatList.prototype, 'scrollToIndex').mockImplementation(() => undefined);
    await render(<ConversationScreen />);
    await screen.findByText(SEEDED_USER, undefined, LOAD);
    const original = useChatStore.getState().conversations['p-termhub']!.messages.find((m) => m.text === SEEDED_ASSISTANT)!;
    await act(async () =>
      addRows(
        [
          { id: 'r1', conversation_id: 'c-termhub', role: 'user', text: 'e isso?', usage: null, error_code: null, created_at: at(1), reply_to: { id: original.id, role: 'assistant', excerpt: 'A aba api está esperando' } },
          { id: 'r2', conversation_id: 'c-termhub', role: 'user', text: 'e aquela?', usage: null, error_code: null, created_at: at(2), reply_to: { id: 'antiga', role: 'user', excerpt: 'uma antiga' } },
        ],
        [],
      ),
    );
    await fireEvent.press(await screen.findByRole('button', { name: 'Ver mensagem original: Concierge, A aba api está esperando' }));
    expect(scroll).toHaveBeenCalledWith(expect.objectContaining({ viewPosition: 0.5, animated: true }));
    expect(screen.queryByText('Mensagem original indisponível')).toBeNull();

    await fireEvent.press(screen.getByRole('button', { name: 'Ver mensagem original: Você, uma antiga' }));
    expect(screen.getByText('Mensagem original indisponível')).toBeTruthy();
    expect(scroll).toHaveBeenCalledTimes(1);
  });

  it('✕ drops the reply, and so does leaving the conversation', async () => {
    const { rerender } = await render(<ConversationView routeId="p-termhub" />);
    await screen.findByText(SEEDED_USER, undefined, LOAD);
    const row = screen.getAllByTestId('swipe-to-reply-row')[0]!;
    await fireEvent(row, 'accessibilityAction', { nativeEvent: { actionName: 'reply' } });
    expect(screen.getByLabelText('Cancelar resposta')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Cancelar resposta'));
    expect(screen.queryByLabelText('Cancelar resposta')).toBeNull();

    await fireEvent(screen.getAllByTestId('swipe-to-reply-row')[0]!, 'accessibilityAction', { nativeEvent: { actionName: 'reply' } });
    expect(screen.getByLabelText('Cancelar resposta')).toBeTruthy();
    await rerender(<ConversationView routeId="general" />);
    await waitFor(() => expect(screen.queryByLabelText('Cancelar resposta')).toBeNull(), LOAD);
  });
});
