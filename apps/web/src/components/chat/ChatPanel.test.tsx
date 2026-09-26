// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ChatPanel } from './ChatPanel';
import type { ChatAction, ChatGrant, ChatMessage, TabQuestion, TabSuggestion } from '../../lib/types';

const chatMock = vi.fn();
const sendMock = vi.fn();
const streamMock = vi.fn();
const decideMock = vi.fn();
const decideManyMock = vi.fn();
const setHostMock = vi.fn();
const machinesMock = vi.fn();
const accountsMock = vi.fn();
const resetMock = vi.fn();
const revokeMock = vi.fn();
const answerMock = vi.fn();
const screenMock = vi.fn();
const sendSuggestionMock = vi.fn();
const dismissSuggestionMock = vi.fn();

vi.mock('../../lib/api', () => {
  // Same signature as the real one: the page shows `message`, so a stand-in that swallows it would
  // make the pt-BR server message untestable.
  class ApiError extends Error {
    constructor(
      public status: number,
      message: string,
      public code?: string,
    ) {
      super(message);
    }
  }
  return {
    ApiError,
    api: {
      chat: (...a: unknown[]) => chatMock(...a),
      sendChatMessage: (...a: unknown[]) => sendMock(...a),
      decideChatAction: (...a: unknown[]) => decideMock(...a),
      decideChatActions: (...a: unknown[]) => decideManyMock(...a),
      setChatHost: (...a: unknown[]) => setHostMock(...a),
      resetChat: (...a: unknown[]) => resetMock(...a),
      revokeChatGrant: (...a: unknown[]) => revokeMock(...a),
      answerTabQuestion: (...a: unknown[]) => answerMock(...a),
      tabQuestionScreen: (...a: unknown[]) => screenMock(...a),
      sendTabSuggestion: (...a: unknown[]) => sendSuggestionMock(...a),
      dismissTabSuggestion: (...a: unknown[]) => dismissSuggestionMock(...a),
      machines: { list: (...a: unknown[]) => machinesMock(...a) },
      aiAccounts: { list: (...a: unknown[]) => accountsMock(...a) },
    },
  };
});
// The chat is the signed-in user's own, whoever an admin may be "viewing as": the panel needs that id
// to offer only machines `POST /chat/host` will accept, and needs to know when it is looking at
// someone else's rows. Held in a mutable box so one test can switch the scope without a second mock
// factory.
const auth = vi.hoisted(() => ({ state: { user: { id: 'u1' }, viewAs: null } as { user: { id: string } | null; viewAs: unknown } }));
vi.mock('../../lib/auth', () => ({ useAuth: () => auth.state }));
vi.mock('../../lib/chat', () => ({ useChatStream: (...a: unknown[]) => streamMock(...a) }));

const msg = (over: Partial<ChatMessage> & { id: string }): ChatMessage => ({
  conversation_id: 'c1',
  role: 'user',
  text: '',
  error_code: null,
  created_at: '2026-09-21T00:00:00.000Z',
  ...over,
});

const action = (over: Partial<ChatAction> & { id: string }): ChatAction => ({
  tool: 'send_input',
  args: { tab_id: 't1', text: 'npm test' },
  class: 'write',
  status: 'pending',
  machine_id: null,
  project_id: null,
  tab_id: 't1',
  summary: 'digitar `npm test` na aba Terminal 2 do projeto reactivando, no macbook m3',
  created_at: '2026-09-21T00:00:00.000Z',
  ...over,
});

/** A host that can run the conversation, reused across the tests below that don't care what it is. */
const READY = { kind: 'ready', machine: { id: 'm1', name: 'jarvis' }, configDir: null, account: { kind: 'default' }, sessionAtStake: false };

const grant = (over: Partial<ChatGrant> & { id: string }): ChatGrant => ({
  tab_id: 't1',
  tool: 'send_input',
  source_action_id: 'a1',
  created_at: '2026-09-21T00:00:00.000Z',
  expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  tab_name: 'Terminal 1',
  ...over,
});

beforeEach(() => {
  chatMock.mockReset();
  sendMock.mockReset();
  streamMock.mockReset();
  decideMock.mockReset();
  decideManyMock.mockReset();
  setHostMock.mockReset();
  machinesMock.mockReset();
  accountsMock.mockReset();
  resetMock.mockReset();
  revokeMock.mockReset();
  answerMock.mockReset();
  screenMock.mockReset();
  sendSuggestionMock.mockReset();
  dismissSuggestionMock.mockReset();
  screenMock.mockResolvedValue({ text: 'Do you want to proceed?' });
  accountsMock.mockResolvedValue({ accounts: [] });
  auth.state = { user: { id: 'u1' }, viewAs: null };
  chatMock.mockResolvedValue({ conversation: { id: 'c1', title: null, model: null, review_mode: false, last_message_at: null }, messages: [msg({ id: 'm1', role: 'user', text: 'oi' })], actions: [] });
  sendMock.mockResolvedValue({ message: msg({ id: 'm3', role: 'assistant', text: 'pronto' }) });
  streamMock.mockReturnValue({ connected: true });
});

afterEach(() => cleanup());

it('loads the project conversation and sends into it', async () => {
  chatMock.mockResolvedValue({ conversation: { id: 'c_p1', project_id: 'p1', ai_account_id: null }, messages: [], actions: [], host: READY });
  sendMock.mockResolvedValue({ message: { id: 'm2' } });
  render(
    <MemoryRouter>
      <ChatPanel projectId="p1" />
    </MemoryRouter>,
  );
  await waitFor(() => expect(chatMock).toHaveBeenCalledWith('p1'));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'status?' } });
  fireEvent.click(screen.getByRole('button', { name: /enviar/i }));
  await waitFor(() => expect(sendMock).toHaveBeenCalledWith('status?', 'p1'));
});

it('ignores live events of another conversation', async () => {
  // load answers conversation c_p1; the stream mock hands us onEvent
  let onEvent!: (e: unknown) => void;
  streamMock.mockImplementation((_reload: unknown, cb: (e: unknown) => void) => {
    onEvent = cb;
    return { connected: true };
  });
  chatMock.mockResolvedValue({
    conversation: { id: 'c_p1', project_id: 'p1', ai_account_id: null },
    messages: [{ id: 'm9', conversation_id: 'c_p1', role: 'assistant', text: '', error_code: null, created_at: '' }],
    actions: [],
    host: READY,
  });
  render(
    <MemoryRouter>
      <ChatPanel projectId="p1" />
    </MemoryRouter>,
  );
  // The empty row of this conversation, on screen: the panel knows its own id by now.
  await screen.findByText('A resposta não terminou — tente de novo.');
  // A delta for that very row, tagged with another conversation: never folded in.
  act(() => onEvent({ type: 'delta', conversation_id: 'c_other', message_id: 'm9', delta: 'VAZOU' }));
  expect(screen.queryByText('VAZOU')).toBeNull();
  act(() => onEvent({ type: 'confirmation', conversation_id: 'c_other', action_id: 'a9', tool: 'send_input', args: {}, class: 'write', machine_id: null, project_id: null, tab_id: null, summary: 'NÃO É DAQUI', created_at: '' }));
  expect(screen.queryByText('NÃO É DAQUI')).toBeNull();
});

it('drops another conversation\'s events while it does not yet know its own id, then re-admits its own once load resolves', async () => {
  // The load is held open on purpose: `conversationId` stays null for as long as this promise does,
  // which is exactly the window the fix closes — a tagged event must not be admitted on that
  // uncertainty, only an untagged (pre-project-chat server) one may be.
  let resolveLoad!: (value: unknown) => void;
  chatMock.mockImplementationOnce(() => new Promise((resolve) => (resolveLoad = resolve)));
  let onEvent!: (e: unknown) => void;
  streamMock.mockImplementation((_reload: unknown, cb: (e: unknown) => void) => {
    onEvent = cb;
    return { connected: true };
  });
  render(
    <MemoryRouter>
      <ChatPanel projectId="p1" />
    </MemoryRouter>,
  );

  // Delivered while conversationId is still null: two deltas and a confirmation, none of them admitted
  // yet. The delta of the panel's own conversation is what proves the held events are replayed into
  // the fold once its id becomes known, instead of having been dropped for good.
  act(() => {
    onEvent({ type: 'delta', conversation_id: 'c_other', message_id: 'm9', delta: 'VAZOU' });
    onEvent({ type: 'delta', conversation_id: 'c_p1', message_id: 'm1', delta: 'chegou' });
    onEvent({ type: 'confirmation', conversation_id: 'c_other', action_id: 'a9', tool: 'send_input', args: {}, class: 'write', machine_id: null, project_id: null, tab_id: null, summary: 'NÃO É DAQUI', created_at: '' });
  });
  expect(screen.queryByText('NÃO É DAQUI')).toBeNull();
  expect(screen.queryByText('VAZOU')).toBeNull();
  expect(screen.queryByText('chegou')).toBeNull();

  await act(async () => {
    resolveLoad({
      conversation: { id: 'c_p1', project_id: 'p1', ai_account_id: null },
      messages: [{ id: 'm1', conversation_id: 'c_p1', role: 'assistant', text: '', error_code: null, created_at: '' }],
      actions: [],
      host: READY,
    });
  });

  // Now that the panel knows its own id, the held delta of its own conversation reappears...
  expect(await screen.findByText('chegou')).toBeTruthy();
  // ...but the foreign ones, tagged for c_other, never do.
  expect(screen.queryByText('VAZOU')).toBeNull();
  expect(screen.queryByText('NÃO É DAQUI')).toBeNull();
});

it('Nova conversa asks first, resets, and swaps in the empty conversation', async () => {
  chatMock
    .mockResolvedValueOnce({
      conversation: { id: 'c_p1', project_id: 'p1', ai_account_id: null },
      messages: [{ id: 'm1', conversation_id: 'c_p1', role: 'user', text: 'antigo', error_code: null, created_at: '' }],
      actions: [],
      host: READY,
    })
    .mockResolvedValue({ conversation: { id: 'c_new', project_id: 'p1', ai_account_id: null }, messages: [], actions: [], host: READY });
  resetMock.mockResolvedValue({ conversation: { id: 'c_new', project_id: 'p1' } });
  render(
    <MemoryRouter>
      <ChatPanel projectId="p1" />
    </MemoryRouter>,
  );
  await screen.findByText('antigo');
  fireEvent.click(screen.getByRole('button', { name: 'Nova conversa' }));
  expect(resetMock).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Começar de novo' }));
  await waitFor(() => expect(resetMock).toHaveBeenCalledWith('p1'));
  await waitFor(() => expect(screen.queryByText('antigo')).toBeNull());
});

it('shows the server error when the initial load fails, instead of an unhandled rejection', async () => {
  const { ApiError } = await import('../../lib/api');
  chatMock.mockRejectedValue(new ApiError(404, 'Projeto não encontrado'));
  render(
    <MemoryRouter>
      <ChatPanel projectId="p1" />
    </MemoryRouter>,
  );
  expect(await screen.findByText('Projeto não encontrado')).toBeTruthy();
});

it('in a project, a host that is not chosen points to /chat instead of offering a picker', async () => {
  chatMock.mockResolvedValue({ conversation: { id: 'c_p1', project_id: 'p1', ai_account_id: null }, messages: [], actions: [], host: { kind: 'not_chosen', machines: [{ id: 'm1', name: 'a' }, { id: 'm2', name: 'b' }], sessionAtStake: false } });
  render(
    <MemoryRouter>
      <ChatPanel projectId="p1" />
    </MemoryRouter>,
  );
  expect(await screen.findByRole('link', { name: /escolher a máquina do chat/i })).toHaveAttribute('href', '/chat');
});

it('shows how many tabs are trusted as a link to Configurações, and no strip', async () => {
  chatMock.mockResolvedValue({ conversation: { id: 'c_p1', project_id: 'p1', ai_account_id: null }, messages: [], actions: [], host: READY, grants: [grant({ id: 'g1' }), grant({ id: 'g2', tab_id: 't2' }), grant({ id: 'g3', tab_id: 't3', expires_at: new Date(Date.now() - 1000).toISOString() })] });
  render(
    <MemoryRouter>
      <ChatPanel projectId="p1" />
    </MemoryRouter>,
  );
  expect(await screen.findByRole('link', { name: '2 abas confiáveis' })).toHaveAttribute('href', '/settings/chat-grants');
  expect(screen.queryByText(/Enviando direto para/)).toBeNull();
});

it('no link without an active grant', async () => {
  chatMock.mockResolvedValue({ conversation: { id: 'c_p1', project_id: 'p1', ai_account_id: null }, messages: [], actions: [], host: READY, grants: [] });
  render(
    <MemoryRouter>
      <ChatPanel projectId="p1" />
    </MemoryRouter>,
  );
  await waitFor(() => expect(chatMock).toHaveBeenCalled());
  expect(screen.queryByRole('link', { name: /aba(s)? confiáve/ })).toBeNull();
});

it('a message event merges by id without a refetch, and the streamed text stays until the stored one lands', async () => {
  let onEvent!: (e: unknown) => void;
  streamMock.mockImplementation((_reload: unknown, cb: (e: unknown) => void) => {
    onEvent = cb;
    return { connected: true };
  });
  chatMock.mockResolvedValue({
    conversation: { id: 'c_p1', project_id: 'p1', ai_account_id: null },
    messages: [msg({ id: 'm1', role: 'user', text: 'oi' }), msg({ id: 'm2', role: 'assistant', text: '', created_at: '2026-09-21T00:00:01.000Z' })],
    actions: [],
    host: READY,
  });
  render(
    <MemoryRouter>
      <ChatPanel projectId="p1" />
    </MemoryRouter>,
  );
  await screen.findByText('oi');
  act(() => onEvent({ type: 'delta', conversation_id: 'c_p1', message_id: 'm2', delta: 'par' }));
  expect(await screen.findByText('par')).toBeInTheDocument();

  // The stored row: same id, final text. Applied in place — no GET /chat.
  act(() => onEvent({ type: 'message', conversation_id: 'c_p1', message: msg({ id: 'm2', role: 'assistant', text: 'parcial', created_at: '2026-09-21T00:00:01.000Z' }) }));
  expect(await screen.findByText('parcial')).toBeInTheDocument();
  expect(screen.queryByText('par')).toBeNull();
  expect(chatMock).toHaveBeenCalledTimes(1);

  // A row this panel has never seen is appended, again without a refetch.
  act(() => onEvent({ type: 'message', conversation_id: 'c_p1', message: msg({ id: 'm3', role: 'user', text: 'e agora?', created_at: '2026-09-21T00:00:02.000Z' }) }));
  expect(await screen.findByText('e agora?')).toBeInTheDocument();
  expect(chatMock).toHaveBeenCalledTimes(1);
});

it('"Permitir sempre nesta aba" on a pending card records the grant, shows it on the card and counts it in the header', async () => {
  chatMock.mockResolvedValue({ conversation: { id: 'c_p1', project_id: 'p1', ai_account_id: null }, messages: [], actions: [action({ id: 'a1' })], host: READY, grants: [] });
  decideMock.mockResolvedValue({ action: { id: 'a1', status: 'approved' }, grant: grant({ id: 'g1' }) });
  render(
    <MemoryRouter>
      <ChatPanel projectId="p1" />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Permitir sempre nesta aba' }));
  await waitFor(() => expect(decideMock).toHaveBeenCalledWith('a1', 'approve_tab'));
  expect(await screen.findByRole('link', { name: '1 aba confiável' })).toBeInTheDocument();
  expect(screen.getByText(/^Permitido nesta aba até/)).toBeInTheDocument();
});

it('two pending cards render as one group; Ver separadas shows the cards', async () => {
  chatMock.mockResolvedValue({ conversation: { id: 'c1', ai_account_id: null }, messages: [], actions: [action({ id: 'a1' }), action({ id: 'a2', summary: 'mover o card TER-1' })], host: READY });
  render(
    <MemoryRouter>
      <ChatPanel projectId={null} />
    </MemoryRouter>,
  );
  expect(await screen.findByText('2 ações aguardando sua confirmação')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Autorizar' })).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'Ver separadas' }));
  expect(screen.getAllByRole('button', { name: 'Autorizar' })).toHaveLength(2);
});

it('Aprovar selecionadas decides the whole group in one call and the cards read as decided', async () => {
  chatMock.mockResolvedValue({ conversation: { id: 'c1', ai_account_id: null }, messages: [], actions: [action({ id: 'a1' }), action({ id: 'a2', summary: 'mover o card TER-1' })], host: READY });
  decideManyMock.mockResolvedValue({ actions: [{ id: 'a1', status: 'approved' }, { id: 'a2', status: 'approved' }], skipped: [], queued: true, note: 'Sua decisão foi registrada.' });
  render(
    <MemoryRouter>
      <ChatPanel projectId={null} />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Aprovar selecionadas (2)' }));
  await waitFor(() => expect(decideManyMock).toHaveBeenCalledWith([{ id: 'a1', decision: 'approve' }, { id: 'a2', decision: 'approve' }]));
  expect(await screen.findAllByText('Autorizado')).toHaveLength(2);
  expect(screen.queryByText('2 ações aguardando sua confirmação')).toBeNull();
  // The queued note sits under the first decided card only.
  expect(screen.getAllByText('Sua decisão foi registrada.')).toHaveLength(1);
});

it('a grant event adds to the header count, a grant_revoked removes it, a granted_action appends a card, and events of another conversation are ignored', async () => {
  let onEvent!: (e: unknown) => void;
  streamMock.mockImplementation((_reload: unknown, cb: (e: unknown) => void) => {
    onEvent = cb;
    return { connected: true };
  });
  chatMock.mockResolvedValue({ conversation: { id: 'c_p1', project_id: 'p1', ai_account_id: null }, messages: [], actions: [], host: READY, grants: [] });
  render(
    <MemoryRouter>
      <ChatPanel projectId="p1" />
    </MemoryRouter>,
  );
  await waitFor(() => expect(chatMock).toHaveBeenCalled());

  onEvent({ type: 'grant', conversation_id: 'c_other', grant: grant({ id: 'g_other' }) });
  expect(screen.queryByRole('link', { name: '1 aba confiável' })).toBeNull();

  onEvent({ type: 'grant', conversation_id: 'c_p1', grant: grant({ id: 'g1' }) });
  expect(await screen.findByRole('link', { name: '1 aba confiável' })).toBeInTheDocument();

  onEvent({ type: 'granted_action', conversation_id: 'c_p1', action: action({ id: 'a2', status: 'executed', grant_id: 'g1' }) });
  expect(await screen.findByText('Executado · aba confiada')).toBeInTheDocument();

  onEvent({ type: 'grant_revoked', conversation_id: 'c_p1', grant_id: 'g1' });
  await waitFor(() => expect(screen.queryByRole('link', { name: '1 aba confiável' })).toBeNull());
});

const question = (over: Partial<TabQuestion> & { id: string }): TabQuestion =>
  ({ tab_id: 't1', tab_name: 'api', kind: 'permission', payload: { tool_name: 'Bash' }, answer: null, status: 'open', error_code: null, created_at: '2026-09-21T00:00:00.000Z', answered_at: null, closed_at: null, ...over }) as TabQuestion;

it('shows a tab question from GET /chat and answers it with one click', async () => {
  chatMock.mockResolvedValue({ conversation: { id: 'c_p1', project_id: 'p1', ai_account_id: null }, messages: [], actions: [], host: READY, grants: [], tab_questions: [question({ id: 'q1' })] });
  answerMock.mockResolvedValue({ tab_question: question({ id: 'q1', status: 'answered', answer: { allow: true } } as Partial<TabQuestion> & { id: string }) });
  render(
    <MemoryRouter>
      <ChatPanel projectId="p1" />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Permitir' }));
  await waitFor(() => expect(answerMock).toHaveBeenCalledWith('q1', { allow: true }));
  expect(await screen.findByText('Respondida')).toBeInTheDocument();
  expect(screenMock).toHaveBeenCalledWith('q1');
});

it('a stale question reads "A pergunta mudou na aba"', async () => {
  const { ApiError } = await import('../../lib/api');
  chatMock.mockResolvedValue({ conversation: { id: 'c_p1', project_id: 'p1', ai_account_id: null }, messages: [], actions: [], host: READY, grants: [], tab_questions: [question({ id: 'q1' })] });
  answerMock.mockRejectedValue(new ApiError(409, 'A pergunta mudou na aba', 'TAB_PROMPT_CHANGED'));
  render(
    <MemoryRouter>
      <ChatPanel projectId="p1" />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Negar' }));
  expect(await screen.findByText('A pergunta mudou na aba')).toBeInTheDocument();
});

it('tab question events add and update the card; another conversation\'s are ignored', async () => {
  let onEvent!: (e: unknown) => void;
  streamMock.mockImplementation((_reload: unknown, cb: (e: unknown) => void) => {
    onEvent = cb;
    return { connected: true };
  });
  chatMock.mockResolvedValue({ conversation: { id: 'c_p1', project_id: 'p1', ai_account_id: null }, messages: [], actions: [], host: READY, grants: [] });
  render(
    <MemoryRouter>
      <ChatPanel projectId="p1" />
    </MemoryRouter>,
  );
  await waitFor(() => expect(chatMock).toHaveBeenCalled());
  onEvent({ type: 'tab_question', conversation_id: 'c_other', question: question({ id: 'q9', tab_name: 'OUTRA' }) });
  expect(screen.queryByText(/OUTRA/)).toBeNull();
  onEvent({ type: 'tab_question', conversation_id: 'c_p1', question: question({ id: 'q1' }) });
  expect(await screen.findByText('A aba «api» pede permissão para usar «Bash»')).toBeInTheDocument();
  onEvent({ type: 'tab_question_closed', conversation_id: 'c_p1', question: question({ id: 'q1', status: 'answered_in_tab' }) });
  expect(await screen.findByText('Respondida na aba')).toBeInTheDocument();
});

const suggestion = (over: Partial<TabSuggestion> & { id: string }): TabSuggestion => ({ tab_id: 't1', tab_name: 'api', kind: 'suggestion', payload: { text: 'commit it' }, status: 'open', answer: null, error_code: null, created_at: '2026-09-21T00:00:00.000Z', answered_at: null, closed_at: null, ...over });
const card = async () => (await screen.findByText('«api» está esperando sua resposta')).closest('li') as HTMLElement;

it('shows a tab suggestion from GET /chat and sends it, as edited, with one click', async () => {
  chatMock.mockResolvedValue({ conversation: { id: 'c_p1', project_id: 'p1', ai_account_id: null }, messages: [], actions: [], host: READY, grants: [], tab_questions: [], tab_suggestions: [suggestion({ id: 's1' })] });
  sendSuggestionMock.mockResolvedValue({ tab_suggestion: suggestion({ id: 's1', status: 'answered', answer: { text: 'commit it and push' } }) });
  render(
    <MemoryRouter>
      <ChatPanel projectId="p1" />
    </MemoryRouter>,
  );
  const li = await card();
  fireEvent.change(within(li).getByLabelText('Sugestão do Claude Code (opcional — edite ou dispense)'), { target: { value: 'commit it and push' } });
  fireEvent.click(within(li).getByRole('button', { name: 'Enviar' }));
  await waitFor(() => expect(sendSuggestionMock).toHaveBeenCalledWith('s1', 'commit it and push'));
  expect(await screen.findByText('Enviada')).toBeInTheDocument();
});

it('Dispensar closes the card; a stale suggestion reads "A sugestão mudou na aba"', async () => {
  const { ApiError } = await import('../../lib/api');
  chatMock.mockResolvedValue({ conversation: { id: 'c_p1', project_id: 'p1', ai_account_id: null }, messages: [], actions: [], host: READY, grants: [], tab_suggestions: [suggestion({ id: 's1' }), suggestion({ id: 's2', tab_name: 'web', created_at: '2026-09-21T00:01:00.000Z' })] });
  dismissSuggestionMock.mockResolvedValue({ tab_suggestion: suggestion({ id: 's1', status: 'dismissed' }) });
  sendSuggestionMock.mockRejectedValue(new ApiError(409, 'A sugestão mudou na aba', 'TAB_PROMPT_CHANGED'));
  render(
    <MemoryRouter>
      <ChatPanel projectId="p1" />
    </MemoryRouter>,
  );
  fireEvent.click(within(await card()).getByRole('button', { name: 'Dispensar' }));
  expect(await screen.findByText('Dispensada')).toBeInTheDocument();
  expect(dismissSuggestionMock).toHaveBeenCalledWith('s1');
  const other = (await screen.findByText('«web» está esperando sua resposta')).closest('li') as HTMLElement;
  fireEvent.click(within(other).getByRole('button', { name: 'Enviar' }));
  expect(await screen.findByText('A sugestão mudou na aba')).toBeInTheDocument();
});

it("tab suggestion events add and update the card; another conversation's are ignored", async () => {
  let onEvent!: (e: unknown) => void;
  streamMock.mockImplementation((_reload: unknown, cb: (e: unknown) => void) => {
    onEvent = cb;
    return { connected: true };
  });
  chatMock.mockResolvedValue({ conversation: { id: 'c_p1', project_id: 'p1', ai_account_id: null }, messages: [], actions: [], host: READY, grants: [] });
  render(
    <MemoryRouter>
      <ChatPanel projectId="p1" />
    </MemoryRouter>,
  );
  await waitFor(() => expect(chatMock).toHaveBeenCalled());
  onEvent({ type: 'tab_suggestion', conversation_id: 'c_other', suggestion: suggestion({ id: 's9', tab_name: 'OUTRA' }) });
  expect(screen.queryByText(/OUTRA/)).toBeNull();
  onEvent({ type: 'tab_suggestion', conversation_id: 'c_p1', suggestion: suggestion({ id: 's1' }) });
  expect(await screen.findByText('«api» está esperando sua resposta')).toBeInTheDocument();
  onEvent({ type: 'tab_suggestion_closed', conversation_id: 'c_p1', suggestion: suggestion({ id: 's1', status: 'answered_in_tab' }) });
  expect(await screen.findByText('Respondida na aba')).toBeInTheDocument();
});

it('takes a second message while the first is still being answered, and shows both as pending', async () => {
  chatMock.mockResolvedValue({ conversation: { id: 'c1', ai_account_id: null }, messages: [], actions: [], host: READY });
  // The POST of a web send only answers when its answer is written: hold the first one open.
  let finishFirst!: () => void;
  sendMock.mockImplementationOnce(() => new Promise((r) => (finishFirst = () => r({ message: msg({ id: 'a1', role: 'assistant', text: 'um' }) }))));
  sendMock.mockResolvedValueOnce({ message: msg({ id: 'a2', role: 'assistant', text: 'dois' }) });
  render(
    <MemoryRouter>
      <ChatPanel />
    </MemoryRouter>,
  );
  await waitFor(() => expect(chatMock).toHaveBeenCalled());
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'primeira' } });
  fireEvent.click(screen.getByRole('button', { name: /enviar/i }));
  await waitFor(() => expect(sendMock).toHaveBeenCalledTimes(1));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'segunda' } });
  const button = screen.getByRole('button', { name: /enviar/i }) as HTMLButtonElement;
  expect(button.disabled).toBe(false);
  expect(screen.queryByText('aguarde a resposta terminar')).toBeNull();
  fireEvent.click(button);
  await waitFor(() => expect(sendMock).toHaveBeenCalledTimes(2));
  expect(sendMock).toHaveBeenLastCalledWith('segunda');
  finishFirst();
});

it('shows "pensando…" on every answer that has started, not only the newest', async () => {
  chatMock.mockResolvedValue({
    conversation: { id: 'c1', ai_account_id: null },
    messages: [msg({ id: 'q1', text: 'um' }), msg({ id: 'a1', role: 'assistant' }), msg({ id: 'q2', text: 'dois' }), msg({ id: 'a2', role: 'assistant' })],
    actions: [],
    host: READY,
  });
  streamMock.mockReturnValue({
    events: [
      { type: 'message', conversation_id: 'c1', message: msg({ id: 'a1', role: 'assistant' }) },
      { type: 'message', conversation_id: 'c1', message: msg({ id: 'a2', role: 'assistant' }) },
    ],
    connected: true,
  });
  render(
    <MemoryRouter>
      <ChatPanel />
    </MemoryRouter>,
  );
  await waitFor(() => expect(screen.getAllByText(/pensando/i)).toHaveLength(2));
});
