// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatPanel } from './ChatPanel';
import type { ChatAction, ChatGrant, ChatMessage, ChatProjectGrant, ChatStandingGrant, SubagentView, TabQuestion, TabSuggestion } from '../../lib/types';

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
const uploadMock = vi.fn();
const removeAttachmentMock = vi.fn();
const forgetDecisionMock = vi.fn();
const cancelSubagentMock = vi.fn();
const compactMock = vi.fn();
const cancelAutoAnswerMock = vi.fn();

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
      chat: Object.assign((...a: unknown[]) => chatMock(...a), {
        attachments: {
          upload: (...a: unknown[]) => uploadMock(...a),
          remove: (...a: unknown[]) => removeAttachmentMock(...a),
          url: (id: string) => `/api/chat/attachments/${id}`,
        },
      }),
      sendChatMessage: (...a: unknown[]) => sendMock(...a),
      decideChatAction: (...a: unknown[]) => decideMock(...a),
      decideChatActions: (...a: unknown[]) => decideManyMock(...a),
      setChatHost: (...a: unknown[]) => setHostMock(...a),
      resetChat: (...a: unknown[]) => resetMock(...a),
      compactChat: (...a: unknown[]) => compactMock(...a),
      revokeChatGrant: (...a: unknown[]) => revokeMock(...a),
      answerTabQuestion: (...a: unknown[]) => answerMock(...a),
      tabQuestionScreen: (...a: unknown[]) => screenMock(...a),
      sendTabSuggestion: (...a: unknown[]) => sendSuggestionMock(...a),
      dismissTabSuggestion: (...a: unknown[]) => dismissSuggestionMock(...a),
      forgetChatDecision: (...a: unknown[]) => forgetDecisionMock(...a),
      cancelSubagent: (...a: unknown[]) => cancelSubagentMock(...a),
      cancelAutoAnswer: (...a: unknown[]) => cancelAutoAnswerMock(...a),
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

const sub = (over: Partial<SubagentView> & { id: string }): SubagentView => ({
  description: 'Buscar CI',
  subagent_type: null,
  status: 'running',
  started_at: '2026-09-21T00:00:00.000Z',
  ended_at: null,
  ...over,
});

const grant = (over: Partial<ChatGrant> & { id: string }): ChatGrant => ({
  tab_id: 't1',
  tool: 'send_input',
  source_action_id: 'a1',
  created_at: '2026-09-21T00:00:00.000Z',
  expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  tab_name: 'Terminal 1',
  ...over,
});

const projectGrant = (over: Partial<ChatProjectGrant> & { id: string }): ChatProjectGrant => ({
  project_id: 'p1',
  project_name: 'App',
  source_action_id: 'a1',
  created_at: '2026-09-21T00:00:00.000Z',
  expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  ...over,
});

const standingGrant = (over: Partial<ChatStandingGrant> & { id: string }): ChatStandingGrant => ({
  project_id: 'p1',
  project_name: 'App',
  kind: 'close_tab',
  source_action_id: 'a1',
  created_at: '2026-09-21T00:00:00.000Z',
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
  uploadMock.mockReset();
  removeAttachmentMock.mockReset();
  forgetDecisionMock.mockReset();
  cancelSubagentMock.mockReset();
  compactMock.mockReset();
  compactMock.mockResolvedValue({ conversation_id: 'c1' });
  cancelAutoAnswerMock.mockReset();
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
  // Said twice: in the composer's status line, and where the conversation would be — an empty thread
  // over a status line is easy to read as a conversation that simply has nothing in it.
  const lines = await screen.findAllByText('Projeto não encontrado');
  expect(lines).toHaveLength(2);
  expect(lines.some((l) => l.getAttribute('role') === 'status')).toBe(true);
  expect(lines.some((l) => l.tagName === 'P' && l.classList.contains('text-sm'))).toBe(true);
  expect(screen.queryByText(/Pergunte sobre este projeto/)).toBeNull();
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
  expect(await screen.findByRole('link', { name: '2 permissões ativas' })).toHaveAttribute('href', '/settings/chat-grants');
  expect(screen.queryByText(/Enviando direto para/)).toBeNull();
});

it('counts tab and project grants in the indicator', async () => {
  chatMock.mockResolvedValue({ conversation: { id: 'c_p1', project_id: 'p1', ai_account_id: null }, messages: [], actions: [], host: READY, grants: [grant({ id: 'g1' })], project_grants: [projectGrant({ id: 'pg1' })] });
  render(
    <MemoryRouter>
      <ChatPanel projectId="p1" />
    </MemoryRouter>,
  );
  expect(await screen.findByRole('link', { name: '2 permissões ativas' })).toHaveAttribute('href', '/settings/chat-grants');
});

it('project_grant_revoked removes it from the indicator', async () => {
  let onEvent!: (e: unknown) => void;
  streamMock.mockImplementation((_reload: unknown, cb: (e: unknown) => void) => {
    onEvent = cb;
    return { connected: true };
  });
  chatMock.mockResolvedValue({ conversation: { id: 'c_p1', project_id: 'p1', ai_account_id: null }, messages: [], actions: [], host: READY, grants: [], project_grants: [projectGrant({ id: 'pg1' }), projectGrant({ id: 'pg2', project_id: 'p2' })] });
  render(
    <MemoryRouter>
      <ChatPanel projectId="p1" />
    </MemoryRouter>,
  );
  expect(await screen.findByRole('link', { name: '2 permissões ativas' })).toBeInTheDocument();
  onEvent({ type: 'project_grant_revoked', conversation_id: 'c_p1', grant_id: 'pg1' });
  expect(await screen.findByRole('link', { name: '1 permissão ativa' })).toBeInTheDocument();
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

it('a streamed delta re-renders only its own row: a card in the thread is not rendered again', async () => {
  // `summary` is read by ChatActionCard's render and by nothing else in the panel, so counting its
  // reads counts the card's renders — without mocking the card away.
  let reads = 0;
  const base = action({ id: 'a1', created_at: '2026-09-21T00:00:01.000Z' });
  const counted = {
    ...base,
    get summary() {
      reads += 1;
      return base.summary;
    },
  } as ChatAction;
  let onEvent!: (e: unknown) => void;
  streamMock.mockImplementation((_reload: unknown, cb: (e: unknown) => void) => {
    onEvent = cb;
    return { connected: true };
  });
  chatMock.mockResolvedValue({
    conversation: { id: 'c_p1', project_id: 'p1', ai_account_id: null },
    messages: [msg({ id: 'm1', role: 'user', text: 'oi' }), msg({ id: 'm2', role: 'assistant', text: '', created_at: '2026-09-21T00:00:02.000Z' })],
    actions: [counted],
    host: READY,
    grants: [],
  });
  render(
    <MemoryRouter>
      <ChatPanel projectId="p1" />
    </MemoryRouter>,
  );
  await screen.findByText(base.summary);
  const before = reads;
  expect(before).toBeGreaterThan(0);

  act(() => onEvent({ type: 'delta', conversation_id: 'c_p1', message_id: 'm2', delta: 'um' }));
  expect(await screen.findByText('um')).toBeInTheDocument();
  act(() => onEvent({ type: 'delta', conversation_id: 'c_p1', message_id: 'm2', delta: 'a' }));
  expect(await screen.findByText('uma')).toBeInTheDocument();

  expect(reads).toBe(before);
});

it('a failed send shows the server error in the composer\'s status line and gives the text back', async () => {
  const { ApiError } = await import('../../lib/api');
  chatMock.mockResolvedValue({ conversation: { id: 'c_p1', project_id: 'p1', ai_account_id: null }, messages: [], actions: [], host: READY });
  sendMock.mockRejectedValue(new ApiError(409, 'O chat já está respondendo', 'CHAT_BUSY'));
  render(
    <MemoryRouter>
      <ChatPanel projectId="p1" />
    </MemoryRouter>,
  );
  await waitFor(() => expect(chatMock).toHaveBeenCalledWith('p1'));
  const box = screen.getByRole('textbox') as HTMLTextAreaElement;
  fireEvent.change(box, { target: { value: 'status?' } });
  fireEvent.click(screen.getByRole('button', { name: /enviar/i }));
  await waitFor(() => expect(sendMock).toHaveBeenCalledWith('status?', 'p1'));
  const line = await screen.findByText('O chat já está respondendo');
  expect(line.getAttribute('role')).toBe('status');
  await waitFor(() => expect(box.value).toBe('status?'));
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
  expect(await screen.findByRole('link', { name: '1 permissão ativa' })).toBeInTheDocument();
  expect(screen.getByText(/^Permitido nesta aba até/)).toBeInTheDocument();
});

it('"Liberar teclas e shell nesta aba" passes approve_tab_terminal through', async () => {
  chatMock.mockResolvedValue({ conversation: { id: 'c_p1', project_id: 'p1', ai_account_id: null }, messages: [], actions: [action({ id: 'a1', tool: 'send_key', args: { tab_id: 't1', key: 'Enter' } })], host: READY, grants: [] });
  decideMock.mockResolvedValue({ action: { id: 'a1', status: 'approved' }, grant: grant({ id: 'g1', tool: 'terminal' }) });
  render(
    <MemoryRouter>
      <ChatPanel projectId="p1" />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Liberar teclas e shell nesta aba' }));
  await waitFor(() => expect(decideMock).toHaveBeenCalledWith('a1', 'approve_tab_terminal'));
});

it('"Liberar tudo neste projeto" passes approve_project_all through', async () => {
  chatMock.mockResolvedValue({ conversation: { id: 'c_p1', project_id: 'p1', ai_account_id: null }, messages: [], actions: [action({ id: 'a1', tool: 'create_task', args: { title: 'x' } })], host: READY, grants: [] });
  decideMock.mockResolvedValue({ action: { id: 'a1', status: 'approved' }, project_grant: { id: 'pg1', project_id: 'p1', project_name: 'App', source_action_id: 'a1', created_at: '2026-09-21T00:00:00.000Z', expires_at: new Date(Date.now() + 3_600_000).toISOString(), scope: 'all' } });
  render(
    <MemoryRouter>
      <ChatPanel projectId="p1" />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Liberar tudo neste projeto' }));
  await waitFor(() => expect(decideMock).toHaveBeenCalledWith('a1', 'approve_project_all'));
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
  expect(screen.queryByRole('link', { name: '1 permissão ativa' })).toBeNull();

  onEvent({ type: 'grant', conversation_id: 'c_p1', grant: grant({ id: 'g1' }) });
  expect(await screen.findByRole('link', { name: '1 permissão ativa' })).toBeInTheDocument();

  onEvent({ type: 'granted_action', conversation_id: 'c_p1', action: action({ id: 'a2', status: 'executed', grant_id: 'g1' }) });
  expect(await screen.findByText('Executado · aba confiada')).toBeInTheDocument();

  onEvent({ type: 'grant_revoked', conversation_id: 'c_p1', grant_id: 'g1' });
  await waitFor(() => expect(screen.queryByRole('link', { name: '1 permissão ativa' })).toBeNull());
});

it('a narrow grant event for a tab keeps its active terminal grant; a same-tool grant event replaces', async () => {
  let onEvent!: (e: unknown) => void;
  streamMock.mockImplementation((_reload: unknown, cb: (e: unknown) => void) => {
    onEvent = cb;
    return { connected: true };
  });
  chatMock.mockResolvedValue({ conversation: { id: 'c_p1', project_id: 'p1', ai_account_id: null }, messages: [], actions: [], host: READY, grants: [grant({ id: 'gt', tool: 'terminal' })] });
  render(
    <MemoryRouter>
      <ChatPanel projectId="p1" />
    </MemoryRouter>,
  );
  expect(await screen.findByRole('link', { name: '1 permissão ativa' })).toBeInTheDocument();

  onEvent({ type: 'grant', conversation_id: 'c_p1', grant: grant({ id: 'gn', tool: 'send_key' }) });
  expect(await screen.findByRole('link', { name: '2 permissões ativas' })).toBeInTheDocument();

  onEvent({ type: 'grant', conversation_id: 'c_p1', grant: grant({ id: 'gt2', tool: 'terminal' }) });
  await waitFor(() => expect(screen.queryByRole('link', { name: '3 permissões ativas' })).toBeNull());
  expect(screen.getByRole('link', { name: '2 permissões ativas' })).toBeInTheDocument();
});

it('a narrow grant from a decision keeps the active terminal grant of the same tab', async () => {
  chatMock.mockResolvedValue({ conversation: { id: 'c_p1', project_id: 'p1', ai_account_id: null }, messages: [], actions: [action({ id: 'a1' })], host: READY, grants: [grant({ id: 'gt', tool: 'terminal' })] });
  decideMock.mockResolvedValue({ action: { id: 'a1', status: 'approved' }, grant: grant({ id: 'gn' }) });
  render(
    <MemoryRouter>
      <ChatPanel projectId="p1" />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Permitir sempre nesta aba' }));
  await waitFor(() => expect(decideMock).toHaveBeenCalledWith('a1', 'approve_tab'));
  expect(await screen.findByRole('link', { name: '2 permissões ativas' })).toBeInTheDocument();
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

it('a stale question says nothing was sent', async () => {
  const { ApiError } = await import('../../lib/api');
  chatMock.mockResolvedValue({ conversation: { id: 'c_p1', project_id: 'p1', ai_account_id: null }, messages: [], actions: [], host: READY, grants: [], tab_questions: [question({ id: 'q1' })] });
  answerMock.mockRejectedValue(new ApiError(409, 'A pergunta mudou na aba', 'TAB_PROMPT_CHANGED'));
  render(
    <MemoryRouter>
      <ChatPanel projectId="p1" />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Negar' }));
  expect(await screen.findByText('A aba já não mostra esta pergunta: nada foi enviado.')).toBeInTheDocument();
});

it('"Esquecer esta decisão" on a suggested answer calls the forget API', async () => {
  const choiceQuestion = question({
    id: 'q1',
    kind: 'choice',
    payload: { questions: [{ question: 'Usar worktree?', header: 'Worktree', multi_select: false, options: [{ label: 'Sim', description: '', recommended: false }, { label: 'Não', description: '', recommended: false }] }] },
    suggestion: { items: [{ question_index: 0, decision_id: 'd1', similarity: 0.9, selected: [1], source: { question: 'Usar worktree?', project_name: 'termhub', answered_at: '2026-09-20T10:00:00.000Z' } }] },
  } as unknown as Partial<TabQuestion> & { id: string });
  chatMock.mockResolvedValue({ conversation: { id: 'c_p1', project_id: 'p1', ai_account_id: null }, messages: [], actions: [], host: READY, grants: [], tab_questions: [choiceQuestion] });
  forgetDecisionMock.mockResolvedValue(undefined);
  render(
    <MemoryRouter>
      <ChatPanel projectId="p1" />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Esquecer esta decisão' }));
  await waitFor(() => expect(forgetDecisionMock).toHaveBeenCalledWith('d1'));
});

const yesNo = { question: 'Usar worktree?', header: 'Worktree', multi_select: false, options: [{ label: 'Sim', description: '', recommended: false }, { label: 'Não', description: '', recommended: false }] };
const autoAnswer = (over: Partial<NonNullable<TabQuestion['auto_answer']>> = {}): NonNullable<TabQuestion['auto_answer']> => ({
  answer: { answers: [{ selected: [0] }] },
  by: 'memory',
  reason: 'Mesma pergunta respondida antes',
  sources: [{ kind: 'decision', id: 'd1' }],
  due_at: new Date(Date.now() + 42_000).toISOString(),
  status: 'scheduled',
  ...over,
});

it('"Cancelar" on a countdown calls the API and, with the returned view, shows the card pre-selected and enabled', async () => {
  const choiceQuestion = question({ id: 'q1', kind: 'choice', payload: { questions: [yesNo] }, auto_answer: autoAnswer() } as unknown as Partial<TabQuestion> & { id: string });
  chatMock.mockResolvedValue({ conversation: { id: 'c_p1', project_id: 'p1', ai_account_id: null }, messages: [], actions: [], host: READY, grants: [], tab_questions: [choiceQuestion] });
  cancelAutoAnswerMock.mockResolvedValue({ tab_question: { ...choiceQuestion, auto_answer: autoAnswer({ status: 'cancelled' }) } });
  render(
    <MemoryRouter>
      <ChatPanel projectId="p1" />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Cancelar' }));
  await waitFor(() => expect(cancelAutoAnswerMock).toHaveBeenCalledWith('q1'));
  // The card re-renders only once the returned view lands in state: wait for it, not just for the radio.
  await waitFor(() => {
    const radio = screen.getByRole('radio', { name: 'Sim' });
    expect(radio).toBeChecked();
    expect(radio).toBeEnabled();
  });
});

it('a 409 NOT_SCHEDULED on "Cancelar" shows "A resposta automática já foi enviada."', async () => {
  const { ApiError } = await import('../../lib/api');
  const choiceQuestion = question({ id: 'q1', kind: 'choice', payload: { questions: [yesNo] }, auto_answer: autoAnswer() } as unknown as Partial<TabQuestion> & { id: string });
  chatMock.mockResolvedValue({ conversation: { id: 'c_p1', project_id: 'p1', ai_account_id: null }, messages: [], actions: [], host: READY, grants: [], tab_questions: [choiceQuestion] });
  cancelAutoAnswerMock.mockRejectedValue(new ApiError(409, 'A resposta automática já foi enviada', 'NOT_SCHEDULED'));
  render(
    <MemoryRouter>
      <ChatPanel projectId="p1" />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Cancelar' }));
  expect(await screen.findByText('A resposta automática já foi enviada.')).toBeInTheDocument();
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
const card = async () => (await screen.findByText('«api» terminou — o Claude Code sugere:')).closest('li') as HTMLElement;

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
  const other = (await screen.findByText('«web» terminou — o Claude Code sugere:')).closest('li') as HTMLElement;
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
  expect(await screen.findByText('«api» terminou — o Claude Code sugere:')).toBeInTheDocument();
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
  // The announcements (`message` with no text yet) reach the panel's fold through the stream's callback.
  let onEvent!: (e: unknown) => void;
  streamMock.mockImplementation((_reload: unknown, cb: (e: unknown) => void) => {
    onEvent = cb;
    return { connected: true };
  });
  chatMock.mockResolvedValue({
    conversation: { id: 'c1', ai_account_id: null },
    messages: [msg({ id: 'q1', text: 'um' }), msg({ id: 'a1', role: 'assistant' }), msg({ id: 'q2', text: 'dois' }), msg({ id: 'a2', role: 'assistant' })],
    actions: [],
    host: READY,
  });
  render(
    <MemoryRouter>
      <ChatPanel />
    </MemoryRouter>,
  );
  await screen.findByText('dois');
  act(() => {
    onEvent({ type: 'message', conversation_id: 'c1', message: msg({ id: 'a1', role: 'assistant' }) });
    onEvent({ type: 'message', conversation_id: 'c1', message: msg({ id: 'a2', role: 'assistant' }) });
  });
  await waitFor(() => expect(screen.getAllByText(/pensando/i)).toHaveLength(2));
});

const attachment = (over: Partial<import('../../lib/types').ChatAttachment> & { id: string }) => ({
  name: 'relatorio.pdf',
  mime: 'application/pdf',
  kind: 'pdf' as const,
  bytes: 10,
  status: 'pending' as const,
  error_code: null,
  meta: null,
  created_at: '2026-09-26T00:00:00.000Z',
  ...over,
});

it('patches an attachment inside its message when its status arrives, without refetching', async () => {
  let onEvent!: (e: unknown) => void;
  streamMock.mockImplementation((_reload: unknown, cb: (e: unknown) => void) => {
    onEvent = cb;
    return { events: [], connected: true };
  });
  chatMock.mockResolvedValue({
    conversation: { id: 'c1', project_id: null, ai_account_id: null },
    messages: [msg({ id: 'm1', role: 'user', text: 'leia', attachments: [attachment({ id: 'att1' })] })],
    actions: [],
    host: READY,
  });
  render(
    <MemoryRouter>
      <ChatPanel projectId={null} />
    </MemoryRouter>,
  );
  expect(await screen.findByText('processando…')).toBeTruthy();

  act(() => onEvent({ type: 'attachment_status', conversation_id: 'c1', attachment: attachment({ id: 'att1', status: 'ready', meta: { pages: 12 } }) }));
  await waitFor(() => expect(screen.queryByText('processando…')).toBeNull());
  expect(chatMock).toHaveBeenCalledTimes(1);

  // Another conversation's status never touches this thread.
  act(() => onEvent({ type: 'attachment_status', conversation_id: 'c_other', attachment: attachment({ id: 'att1', status: 'failed', error_code: 'ATTACHMENT_INVALID' }) }));
  expect(screen.queryByText(/falhou/)).toBeNull();
});

it('sends the uploaded attachment ids with the text, and a message with no text at all', async () => {
  chatMock.mockResolvedValue({ conversation: { id: 'c_p1', project_id: 'p1', ai_account_id: null }, messages: [], actions: [], host: READY });
  uploadMock.mockResolvedValue({ attachment: attachment({ id: 'att1', status: 'ready' }) });
  sendMock.mockResolvedValue({ message: { id: 'm2' } });
  render(
    <MemoryRouter>
      <ChatPanel projectId="p1" />
    </MemoryRouter>,
  );
  await waitFor(() => expect(chatMock).toHaveBeenCalledWith('p1'));

  fireEvent.change(screen.getByLabelText('Arquivos para anexar'), { target: { files: [new File([new Uint8Array(10)], 'relatorio.pdf', { type: 'application/pdf' })] } });
  await waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(1));
  // The upload carries the project, so the file lands in this project's conversation (spec §5.3).
  expect(uploadMock.mock.calls[0][2]).toBe('p1');
  const send = screen.getByRole('button', { name: /enviar/i }) as HTMLButtonElement;
  await waitFor(() => expect(send.disabled).toBe(false));
  fireEvent.click(send);
  await waitFor(() => expect(sendMock).toHaveBeenCalledWith('', 'p1', ['att1']));
});

it('feeds an attachment status to the chip still in the box, and only for its own conversation', async () => {
  let onEvent!: (e: unknown) => void;
  streamMock.mockImplementation((_reload: unknown, cb: (e: unknown) => void) => {
    onEvent = cb;
    return { connected: true };
  });
  chatMock.mockResolvedValue({ conversation: { id: 'c_p1', project_id: 'p1', ai_account_id: null }, messages: [], actions: [], host: READY });
  uploadMock.mockResolvedValue({ attachment: attachment({ id: 'att1' }) });
  render(
    <MemoryRouter>
      <ChatPanel projectId="p1" />
    </MemoryRouter>,
  );
  await waitFor(() => expect(chatMock).toHaveBeenCalledWith('p1'));
  fireEvent.change(screen.getByLabelText('Arquivos para anexar'), { target: { files: [new File([new Uint8Array(10)], 'relatorio.pdf', { type: 'application/pdf' })] } });
  expect(await screen.findByText('processando…')).toBeTruthy();

  act(() => onEvent({ type: 'attachment_status', conversation_id: 'c_other', attachment: attachment({ id: 'att1', status: 'failed', error_code: 'ATTACHMENT_INVALID' }) }));
  expect(screen.getByText('processando…')).toBeTruthy();
  expect(screen.queryByText(/falhou/)).toBeNull();

  act(() => onEvent({ type: 'attachment_status', conversation_id: 'c_p1', attachment: attachment({ id: 'att1', status: 'ready', meta: { pages: 2 } }) }));
  await waitFor(() => expect(screen.queryByText('processando…')).toBeNull());
  expect(screen.getByText('relatorio.pdf')).toBeTruthy();
});

it('shows the subagents toolbar button while one is active, and clicking it lists it', async () => {
  chatMock.mockResolvedValue({ conversation: { id: 'c_p1', project_id: 'p1', ai_account_id: null }, messages: [], actions: [], host: READY, subagents: [sub({ id: 's1' })] });
  render(
    <MemoryRouter>
      <ChatPanel projectId="p1" />
    </MemoryRouter>,
  );
  const button = await screen.findByRole('button', { name: 'Subagentes (1)' });
  fireEvent.click(button);
  expect(await screen.findByText('Buscar CI')).toBeInTheDocument();
});

it('the subagents panel shows the elapsed time as of when it opens, not as of when the chat mounted', async () => {
  const realNow = Date.now.bind(Date);
  let offset = 0;
  const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
  try {
    chatMock.mockResolvedValue({ conversation: { id: 'c_p1', project_id: 'p1', ai_account_id: null }, messages: [], actions: [], host: READY, subagents: [sub({ id: 's1', started_at: new Date(realNow()).toISOString() })] });
    render(
      <MemoryRouter>
        <ChatPanel projectId="p1" />
      </MemoryRouter>,
    );
    const button = await screen.findByRole('button', { name: 'Subagentes (1)' });
    offset = 10 * 60_000; // ten minutes later, the panel is opened for the first time
    fireEvent.click(button);
    expect(await screen.findByText(/há 10 min/)).toBeInTheDocument();
  } finally {
    nowSpy.mockRestore();
  }
});

it('a subagent event turning it completed drops the toolbar button once nothing is active', async () => {
  let onEvent!: (e: unknown) => void;
  streamMock.mockImplementation((_reload: unknown, cb: (e: unknown) => void) => {
    onEvent = cb;
    return { connected: true };
  });
  chatMock.mockResolvedValue({ conversation: { id: 'c_p1', project_id: 'p1', ai_account_id: null }, messages: [], actions: [], host: READY, subagents: [sub({ id: 's1' })] });
  render(
    <MemoryRouter>
      <ChatPanel projectId="p1" />
    </MemoryRouter>,
  );
  await screen.findByRole('button', { name: 'Subagentes (1)' });
  act(() => onEvent({ type: 'subagent', conversation_id: 'c_p1', subagent: sub({ id: 's1', status: 'completed', ended_at: '2026-09-21T00:01:00.000Z' }) }));
  await waitFor(() => expect(screen.queryByRole('button', { name: /Subagentes/ })).toBeNull());
});

it('Cancelar on a subagent row calls api.cancelSubagent with its id', async () => {
  chatMock.mockResolvedValue({ conversation: { id: 'c_p1', project_id: 'p1', ai_account_id: null }, messages: [], actions: [], host: READY, subagents: [sub({ id: 's1' })] });
  cancelSubagentMock.mockResolvedValue({ subagent: sub({ id: 's1', status: 'stopping' }) });
  render(
    <MemoryRouter>
      <ChatPanel projectId="p1" />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Subagentes (1)' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Cancelar Buscar CI' }));
  await waitFor(() => expect(cancelSubagentMock).toHaveBeenCalledWith('s1'));
});

it('a subagent_cancel_failed event shows "Não foi possível cancelar" on that row', async () => {
  let onEvent!: (e: unknown) => void;
  streamMock.mockImplementation((_reload: unknown, cb: (e: unknown) => void) => {
    onEvent = cb;
    return { connected: true };
  });
  chatMock.mockResolvedValue({ conversation: { id: 'c_p1', project_id: 'p1', ai_account_id: null }, messages: [], actions: [], host: READY, subagents: [sub({ id: 's1' })] });
  render(
    <MemoryRouter>
      <ChatPanel projectId="p1" />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Subagentes (1)' }));
  act(() => onEvent({ type: 'subagent_cancel_failed', conversation_id: 'c_p1', subagent_id: 's1' }));
  expect(await screen.findByText('Não foi possível cancelar')).toBeInTheDocument();
});

it('a repeated confirmation event merges a later subagent into the existing card', async () => {
  let onEvent!: (e: unknown) => void;
  streamMock.mockImplementation((_reload: unknown, cb: (e: unknown) => void) => {
    onEvent = cb;
    return { connected: true };
  });
  chatMock.mockResolvedValue({ conversation: { id: 'c_p1', project_id: 'p1', ai_account_id: null }, messages: [], actions: [], host: READY });
  render(
    <MemoryRouter>
      <ChatPanel projectId="p1" />
    </MemoryRouter>,
  );
  await waitFor(() => expect(chatMock).toHaveBeenCalled());
  act(() =>
    onEvent({ type: 'confirmation', conversation_id: 'c_p1', action_id: 'a1', tool: 'send_input', args: {}, class: 'write', machine_id: null, project_id: null, tab_id: null, summary: 'digitar `npm test`', subagent: null, created_at: '' }),
  );
  expect(await screen.findByText('digitar `npm test`')).toBeInTheDocument();
  expect(screen.queryByText(/Pedido pelo subagente/)).toBeNull();

  act(() =>
    onEvent({
      type: 'confirmation',
      conversation_id: 'c_p1',
      action_id: 'a1',
      tool: 'send_input',
      args: {},
      class: 'write',
      machine_id: null,
      project_id: null,
      tab_id: null,
      summary: 'digitar `npm test`',
      subagent: { id: 's1', description: 'Buscar CI' },
      created_at: '',
    }),
  );
  expect(await screen.findByText('Pedido pelo subagente «Buscar CI»')).toBeInTheDocument();
});

it('the toggle stays after the last active subagent completes, so the panel it opened can still be closed', async () => {
  let onEvent!: (e: unknown) => void;
  streamMock.mockImplementation((_reload: unknown, cb: (e: unknown) => void) => {
    onEvent = cb;
    return { connected: true };
  });
  chatMock.mockResolvedValue({ conversation: { id: 'c_p1', project_id: 'p1', ai_account_id: null }, messages: [], actions: [], host: READY, subagents: [sub({ id: 's1' })] });
  render(
    <MemoryRouter>
      <ChatPanel projectId="p1" />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Subagentes (1)' }));
  await screen.findByText('Buscar CI');
  act(() => onEvent({ type: 'subagent', conversation_id: 'c_p1', subagent: sub({ id: 's1', status: 'completed', ended_at: '2026-09-21T00:01:00.000Z' }) }));
  // Still open, still there, at n = 0 — and the row itself is still visible, now reading "concluído".
  expect(await screen.findByRole('button', { name: 'Subagentes (0)' })).toBeInTheDocument();
  expect(screen.getByText('Buscar CI')).toBeInTheDocument();
  expect(screen.getByText(/concluído/)).toBeInTheDocument();
});

it('Escape closes the subagents panel and returns focus to the toggle', async () => {
  chatMock.mockResolvedValue({ conversation: { id: 'c_p1', project_id: 'p1', ai_account_id: null }, messages: [], actions: [], host: READY, subagents: [sub({ id: 's1' })] });
  render(
    <MemoryRouter>
      <ChatPanel projectId="p1" />
    </MemoryRouter>,
  );
  const toggle = await screen.findByRole('button', { name: 'Subagentes (1)' });
  fireEvent.click(toggle);
  await screen.findByText('Buscar CI');
  fireEvent.keyDown(window, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByText('Buscar CI')).toBeNull());
  expect(toggle).toHaveFocus();
});

it('a click outside the popover closes it', async () => {
  chatMock.mockResolvedValue({ conversation: { id: 'c_p1', project_id: 'p1', ai_account_id: null }, messages: [], actions: [], host: READY, subagents: [sub({ id: 's1' })] });
  render(
    <MemoryRouter>
      <ChatPanel projectId="p1" />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Subagentes (1)' }));
  await screen.findByText('Buscar CI');
  fireEvent.mouseDown(document.body);
  await waitFor(() => expect(screen.queryByText('Buscar CI')).toBeNull());
});

it('once the panel is closed with nothing active, the toggle disappears', async () => {
  let onEvent!: (e: unknown) => void;
  streamMock.mockImplementation((_reload: unknown, cb: (e: unknown) => void) => {
    onEvent = cb;
    return { connected: true };
  });
  chatMock.mockResolvedValue({ conversation: { id: 'c_p1', project_id: 'p1', ai_account_id: null }, messages: [], actions: [], host: READY, subagents: [sub({ id: 's1' })] });
  render(
    <MemoryRouter>
      <ChatPanel projectId="p1" />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Subagentes (1)' }));
  act(() => onEvent({ type: 'subagent', conversation_id: 'c_p1', subagent: sub({ id: 's1', status: 'completed', ended_at: '2026-09-21T00:01:00.000Z' }) }));
  await screen.findByRole('button', { name: 'Subagentes (0)' });
  fireEvent.keyDown(window, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('button', { name: /Subagentes/ })).toBeNull());
});

it('Nova conversa closes the subagents panel too', async () => {
  chatMock
    .mockResolvedValueOnce({
      conversation: { id: 'c_p1', project_id: 'p1', ai_account_id: null },
      messages: [{ id: 'm1', conversation_id: 'c_p1', role: 'user', text: 'antigo', error_code: null, created_at: '' }],
      actions: [],
      host: READY,
      subagents: [sub({ id: 's1' })],
    })
    .mockResolvedValue({ conversation: { id: 'c_new', project_id: 'p1', ai_account_id: null }, messages: [], actions: [], host: READY, subagents: [] });
  resetMock.mockResolvedValue({ conversation: { id: 'c_new', project_id: 'p1' } });
  render(
    <MemoryRouter>
      <ChatPanel projectId="p1" />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Subagentes (1)' }));
  await screen.findByText('Buscar CI');
  fireEvent.click(screen.getByRole('button', { name: 'Nova conversa' }));
  fireEvent.click(screen.getByRole('button', { name: 'Começar de novo' }));
  await waitFor(() => expect(resetMock).toHaveBeenCalled());
  expect(screen.queryByText('Buscar CI')).toBeNull();
  expect(screen.queryByRole('button', { name: /Subagentes/ })).toBeNull();
});

it('a non-409 failure on cancel shows "Não foi possível cancelar" on that row', async () => {
  const { ApiError } = await import('../../lib/api');
  chatMock.mockResolvedValue({ conversation: { id: 'c_p1', project_id: 'p1', ai_account_id: null }, messages: [], actions: [], host: READY, subagents: [sub({ id: 's1' })] });
  cancelSubagentMock.mockRejectedValue(new ApiError(500, 'Erro interno'));
  render(
    <MemoryRouter>
      <ChatPanel projectId="p1" />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Subagentes (1)' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Cancelar Buscar CI' }));
  expect(await screen.findByText('Não foi possível cancelar')).toBeInTheDocument();
});

it('the subagents popover is a labelled dialog the toggle points at', async () => {
  chatMock.mockResolvedValue({ conversation: { id: 'c_p1', project_id: 'p1', ai_account_id: null }, messages: [], actions: [], host: READY, subagents: [sub({ id: 's1' })] });
  render(
    <MemoryRouter>
      <ChatPanel projectId="p1" />
    </MemoryRouter>,
  );
  const toggle = await screen.findByRole('button', { name: 'Subagentes (1)' });
  fireEvent.click(toggle);
  const dialog = await screen.findByRole('dialog', { name: 'Subagentes' });
  expect(toggle).toHaveAttribute('aria-expanded', 'true');
  expect(toggle.getAttribute('aria-controls')).toBe(dialog.id);
});

describe('context meter and "Compactar" (TER-315)', () => {
  /** The account-wide chat with a fill of 170k in a 200k window, and the socket's `onEvent`. */
  const renderFull = async (over: Record<string, unknown> = {}) => {
    let onEvent!: (e: unknown) => void;
    streamMock.mockImplementation((_reload: unknown, cb: (e: unknown) => void) => {
      onEvent = cb;
      return { connected: true };
    });
    chatMock.mockResolvedValue({
      conversation: { id: 'c1', project_id: null, ai_account_id: null, context_tokens: 170_000, context_window: 200_000 },
      messages: [msg({ id: 'm1', role: 'user', text: 'oi' }), msg({ id: 'm2', role: 'assistant', text: 'olá' })],
      actions: [],
      host: READY,
      ...over,
    });
    render(
      <MemoryRouter>
        <ChatPanel projectId={null} />
      </MemoryRouter>,
    );
    await screen.findByRole('meter');
    return { emit: (e: unknown) => act(() => onEvent(e)) };
  };

  it('shows the fill from GET /chat, highlighted above 80%, and follows the context event', async () => {
    const { emit } = await renderFull();
    expect(screen.getByRole('meter')).toHaveTextContent('170 mil / 200 mil · 85%');
    expect(screen.getByRole('meter').className).toContain('text-warn');
    emit({ type: 'context', conversation_id: 'c1', tokens: 40_000, window: 200_000 });
    expect(screen.getByRole('meter')).toHaveTextContent('40 mil / 200 mil · 20%');
    emit({ type: 'context', conversation_id: 'c_other', tokens: 1, window: 200_000 });
    expect(screen.getByRole('meter')).toHaveTextContent('40 mil');
  });

  it('Compactar asks the server, says it is compacting, then shows the new fill and what it did', async () => {
    const { emit } = await renderFull();
    fireEvent.click(screen.getByRole('button', { name: 'Compactar' }));
    await waitFor(() => expect(compactMock).toHaveBeenCalledWith(null));
    expect(screen.getByRole('button', { name: 'Compactando…' })).toBeDisabled();
    expect(screen.getByText('Compactando a conversa…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Nova conversa' })).toBeDisabled();
    emit({ type: 'compact', conversation_id: 'c1', state: 'started', tokens_before: null, tokens: null, error_code: null });
    emit({ type: 'context', conversation_id: 'c1', tokens: 12_000, window: 200_000 });
    emit({ type: 'compact', conversation_id: 'c1', state: 'done', tokens_before: 170_000, tokens: 12_000, error_code: null });
    expect(screen.getByRole('meter')).toHaveTextContent('12 mil / 200 mil · 6%');
    expect(screen.getByText('Conversa compactada: 170 mil → 12 mil tokens')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Compactar' })).toBeEnabled();
  });

  it('a compaction that failed says why in the status line', async () => {
    const { emit } = await renderFull();
    fireEvent.click(screen.getByRole('button', { name: 'Compactar' }));
    await waitFor(() => expect(compactMock).toHaveBeenCalled());
    emit({ type: 'compact', conversation_id: 'c1', state: 'failed', tokens_before: null, tokens: null, error_code: 'HOST_GONE' });
    expect(screen.getByText('A máquina do chat saiu do ar durante a compactação')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Compactar' })).toBeEnabled();
  });

  it('a refused compaction shows the server sentence and lets go of the button', async () => {
    await renderFull();
    const { ApiError } = await import('../../lib/api');
    compactMock.mockRejectedValueOnce(new ApiError(409, 'O concierge ainda está respondendo: compacte quando ele terminar', 'CHAT_BUSY'));
    fireEvent.click(screen.getByRole('button', { name: 'Compactar' }));
    expect(await screen.findByText('O concierge ainda está respondendo: compacte quando ele terminar')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Compactar' })).toBeEnabled();
  });

  it('Alt+Shift+C in the panel compacts', async () => {
    await renderFull();
    fireEvent.keyDown(screen.getByRole('textbox'), { code: 'KeyC', key: 'Ç', altKey: true, shiftKey: true });
    await waitFor(() => expect(compactMock).toHaveBeenCalledWith(null));
  });

  it('/compact typed in the box compacts, and nothing is sent', async () => {
    await renderFull();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '/compact' } });
    fireEvent.click(screen.getByRole('button', { name: /enviar/i }));
    await waitFor(() => expect(compactMock).toHaveBeenCalledWith(null));
    expect(sendMock).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox')).toHaveValue('');
  });

  it('a screen opened during a compaction shows it under way', async () => {
    await renderFull({ compacting: true });
    expect(screen.getByRole('button', { name: 'Compactando…' })).toBeDisabled();
  });

  it('no Compactar before the first message', async () => {
    await renderFull({ messages: [], conversation: { id: 'c1', project_id: null, ai_account_id: null, context_tokens: 5, context_window: null } });
    expect(screen.getByRole('button', { name: 'Compactar' })).toBeDisabled();
  });
});

describe('standing grants (TER-386)', () => {
  const listen = () => {
    let onEvent!: (e: unknown) => void;
    streamMock.mockImplementation((_reload: unknown, cb: (e: unknown) => void) => {
      onEvent = cb;
      return { connected: true };
    });
    return (e: unknown) => act(() => onEvent(e));
  };
  const renderPanel = () =>
    render(
      <MemoryRouter>
        <ChatPanel projectId="p1" />
      </MemoryRouter>,
    );

  it('counts the standing grants from GET /chat in the indicator', async () => {
    chatMock.mockResolvedValue({ conversation: { id: 'c_p1', project_id: 'p1', ai_account_id: null }, messages: [], actions: [], host: READY, grants: [grant({ id: 'g1' })], standing_grants: [standingGrant({ id: 'sg1' }), standingGrant({ id: 'sg2', kind: 'board' })] });
    renderPanel();
    expect(await screen.findByRole('link', { name: '3 permissões ativas' })).toBeInTheDocument();
  });

  it('"Liberar sem prazo" sends approve_project_always and shows the grant on the card', async () => {
    chatMock.mockResolvedValue({ conversation: { id: 'c_p1', project_id: 'p1', ai_account_id: null }, messages: [], actions: [action({ id: 'a1', tool: 'close_tab', args: { tab_id: 't1' }, project_id: 'p1' })], host: READY, grants: [], standing_grants: [] });
    decideMock.mockResolvedValue({ action: { id: 'a1', status: 'approved' }, standing_grant: standingGrant({ id: 'sg1' }) });
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Liberar sem prazo: fechar abas paradas neste projeto' }));
    await waitFor(() => expect(decideMock).toHaveBeenCalledWith('a1', 'approve_project_always'));
    expect(await screen.findByText('Fechar abas paradas liberado neste projeto, sem prazo')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '1 permissão ativa' })).toBeInTheDocument();
  });

  it('a standing_grant event adds (replacing the same project and kind), and a revoke from any conversation removes it', async () => {
    const emit = listen();
    chatMock.mockResolvedValue({ conversation: { id: 'c_p1', project_id: 'p1', ai_account_id: null }, messages: [], actions: [], host: READY, grants: [], standing_grants: [standingGrant({ id: 'sg1' })] });
    renderPanel();
    expect(await screen.findByRole('link', { name: '1 permissão ativa' })).toBeInTheDocument();

    emit({ type: 'standing_grant', conversation_id: 'c_p1', grant: standingGrant({ id: 'sg2', kind: 'board' }) });
    expect(await screen.findByRole('link', { name: '2 permissões ativas' })).toBeInTheDocument();

    // Same project and kind: a renewal, not a third grant.
    emit({ type: 'standing_grant', conversation_id: 'c_p1', grant: standingGrant({ id: 'sg3' }) });
    expect(screen.getByRole('link', { name: '2 permissões ativas' })).toBeInTheDocument();

    // Another project's grant, granted from another conversation, is not this panel's.
    emit({ type: 'standing_grant', conversation_id: 'c_other', grant: standingGrant({ id: 'sg_p2', project_id: 'p2' }) });
    expect(screen.getByRole('link', { name: '2 permissões ativas' })).toBeInTheDocument();

    // This project's, granted from the account-wide chat, is.
    emit({ type: 'standing_grant', conversation_id: 'c_general', grant: standingGrant({ id: 'sg4', kind: 'open_tab' }) });
    expect(await screen.findByRole('link', { name: '3 permissões ativas' })).toBeInTheDocument();
    emit({ type: 'standing_grant_revoked', conversation_id: 'c_general', grant_id: 'sg4' });
    expect(await screen.findByRole('link', { name: '2 permissões ativas' })).toBeInTheDocument();

    // A standing grant is not bound to the conversation that created it: its revoke applies here too.
    emit({ type: 'standing_grant_revoked', conversation_id: 'c_other', grant_id: 'sg3' });
    expect(await screen.findByRole('link', { name: '1 permissão ativa' })).toBeInTheDocument();
  });
});

describe('which answers are being written (spec 2026-09-29 §5)', () => {
  let onEvent!: (e: unknown) => void;
  let onReconnect!: () => Promise<void>;
  const FAILED = 'A resposta não terminou — tente de novo.';
  const SETUP_FAILED = 'O concierge não conseguiu começar a resposta. Tente de novo.';
  const at = (minute: number) => `2026-09-29T10:${String(minute).padStart(2, '0')}:00.000Z`;
  const q = (id: string, text: string, minute: number) => msg({ id, text, created_at: at(minute) });
  const a = (id: string, minute: number, text = '') => msg({ id, role: 'assistant', text, created_at: at(minute) });
  const thread = (messages: ChatMessage[], open?: string[], id = 'c1') => ({ conversation: { id, ai_account_id: null }, messages, actions: [], host: READY, ...(open ? { open_answer_ids: open } : {}) });
  const final = (id: string, minute: number, text = 'pronto') => ({ type: 'message', conversation_id: 'c1', message: a(id, minute, text) });
  const mount = () =>
    render(
      <MemoryRouter>
        <ChatPanel projectId={null} />
      </MemoryRouter>,
    );

  beforeEach(() => {
    streamMock.mockImplementation((reload: () => Promise<void>, cb: (e: unknown) => void) => {
      onReconnect = reload;
      onEvent = cb;
      return { connected: true };
    });
  });

  it('a row the server lists as open shows "pensando…" on load', async () => {
    chatMock.mockResolvedValue(thread([q('q1', 'pergunta', 0), a('a1', 1)], ['a1']));
    mount();
    expect(await screen.findByText(/pensando/i)).toBeInTheDocument();
    expect(screen.queryByText(FAILED)).toBeNull();
  });

  it('an empty row the server does not list shows as failed', async () => {
    chatMock.mockResolvedValue(thread([q('q1', 'pergunta', 0), a('a1', 1)], []));
    mount();
    expect(await screen.findByText(FAILED)).toBeInTheDocument();
    expect(screen.queryByText(/pensando/i)).toBeNull();
  });

  it('a server that sends no open_answer_ids behaves as before', async () => {
    chatMock.mockResolvedValue(thread([q('q1', 'pergunta', 0), a('a1', 1)]));
    mount();
    expect(await screen.findByText(FAILED)).toBeInTheDocument();
    expect(screen.queryByText(/pensando/i)).toBeNull();
  });

  it('a row that finished while the read was in flight stays final', async () => {
    const stale = thread([q('q1', 'pergunta', 0), a('a1', 1)], ['a1']);
    chatMock.mockResolvedValue(stale);
    mount();
    await screen.findByText(/pensando/i);
    act(() => onEvent(final('a1', 1)));
    expect(await screen.findByText('pronto')).toBeInTheDocument();
    await act(async () => {
      await onReconnect();
    });
    expect(chatMock).toHaveBeenCalledTimes(2);
    expect(screen.getByText('pronto')).toBeInTheDocument();
    expect(screen.queryByText(/pensando/i)).toBeNull();
    expect(screen.queryByText(FAILED)).toBeNull();
  });

  it('a removed row leaves the thread, and "Nova conversa" is enabled again', async () => {
    chatMock.mockResolvedValue(thread([q('q1', 'um', 0), a('a1', 1), q('q2', 'dois', 2), a('a2', 3)], ['a1', 'a2']));
    mount();
    await waitFor(() => expect(screen.getAllByText(/pensando/i)).toHaveLength(2));
    expect(screen.getByRole('button', { name: 'Nova conversa' })).toBeDisabled();
    act(() => onEvent({ type: 'message_removed', message_id: 'a1', conversation_id: 'c1' }));
    act(() => onEvent(final('a2', 3)));
    expect(await screen.findByText('pronto')).toBeInTheDocument();
    expect(screen.queryByText(/pensando/i)).toBeNull();
    // The removed row is gone, not left behind as a failed one.
    expect(screen.queryByText(FAILED)).toBeNull();
    expect(screen.getByRole('button', { name: 'Nova conversa' })).toBeEnabled();
  });

  it('"Nova conversa" is disabled while an older row is still open', async () => {
    chatMock.mockResolvedValue(thread([q('q1', 'um', 0), a('a1', 1), q('q2', 'dois', 2), a('a2', 3, 'já respondida')], ['a1']));
    mount();
    await screen.findByText('já respondida');
    expect(screen.getByText(/pensando/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Nova conversa' })).toBeDisabled();
  });

  it('a run that could not start re-reads the conversation and says so', async () => {
    chatMock.mockResolvedValue(thread([q('q1', 'pergunta', 0)], []));
    mount();
    await screen.findByText('pergunta');
    expect(chatMock).toHaveBeenCalledTimes(1);
    // Another conversation's failure is not this screen's to say or to re-read.
    act(() => onEvent({ type: 'run_finished', message_id: null, ok: false, error_code: 'SETUP_FAILED', conversation_id: 'c9' }));
    expect(chatMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(SETUP_FAILED)).toBeNull();
    let reread!: (value: unknown) => void;
    chatMock.mockImplementationOnce(() => new Promise((resolve) => (reread = resolve)));
    act(() => onEvent({ type: 'run_finished', message_id: null, ok: false, error_code: 'SETUP_FAILED', conversation_id: 'c1' }));
    expect(chatMock).toHaveBeenCalledTimes(2);
    await act(async () => {
      reread(thread([q('q1', 'pergunta', 0)], []));
    });
    // Still said once the re-read has landed: the read never clears it.
    expect(screen.getByText(SETUP_FAILED)).toBeInTheDocument();
    expect(screen.getByText('pergunta')).toBeInTheDocument();
  });

  it('a deleted newest answer leaves on the next re-read, even with no message_removed', async () => {
    chatMock.mockResolvedValueOnce(thread([q('q1', 'pergunta', 0), a('a1', 1)], ['a1']));
    mount();
    await screen.findByText(/pensando/i);
    expect(screen.getByRole('button', { name: 'Nova conversa' })).toBeDisabled();
    // The server deleted a1 (a missed message_removed, or a server that predates it) and re-read shows q1 alone.
    chatMock.mockResolvedValue(thread([q('q1', 'pergunta', 0)], []));
    await act(async () => {
      await onReconnect();
    });
    expect(screen.queryByText(/pensando/i)).toBeNull();
    expect(screen.queryByText(FAILED)).toBeNull();
    expect(screen.getByRole('button', { name: 'Nova conversa' })).toBeEnabled();
    // Closed for good: a late start of that row does not bring a started mark back.
    act(() => onEvent({ type: 'run_started', message_id: 'a1', conversation_id: 'c1' }));
    expect(screen.getByRole('button', { name: 'Nova conversa' })).toBeEnabled();
  });

  it('the first read keeps what an untagged event streamed before it (a server with no conversation tags)', async () => {
    let resolveLoad!: (value: unknown) => void;
    chatMock.mockImplementationOnce(() => new Promise((resolve) => (resolveLoad = resolve)));
    mount();
    act(() => onEvent({ type: 'delta', message_id: 'a1', delta: 'começo da resposta' }));
    await act(async () => {
      resolveLoad(thread([q('q1', 'pergunta', 0), a('a1', 1)]));
    });
    expect(await screen.findByText('começo da resposta')).toBeInTheDocument();
  });

  it('lets go of what streamed for a row the re-read shows final, as the phone does (pruneLive)', async () => {
    chatMock.mockResolvedValueOnce(thread([q('q1', 'pergunta', 0), a('a1', 1)], ['a1']));
    mount();
    await screen.findByText(/pensando/i);
    act(() => onEvent({ type: 'delta', message_id: 'a1', delta: 'meio da resposta', conversation_id: 'c1' }));
    expect(await screen.findByText('meio da resposta')).toBeInTheDocument();
    // The socket dropped mid-answer and the server closed the row with no text (its host went away).
    chatMock.mockResolvedValue(thread([q('q1', 'pergunta', 0), msg({ id: 'a1', role: 'assistant', text: '', error_code: 'HOST_GONE', created_at: at(1) })], []));
    await act(async () => {
      await onReconnect();
    });
    expect(screen.getByText(/saiu do ar no meio da resposta/)).toBeInTheDocument();
    expect(screen.queryByText('meio da resposta')).toBeNull();
    expect(screen.queryByText(/pensando/i)).toBeNull();
  });

  it('keeps a row whose message arrived while the re-read was in flight', async () => {
    chatMock.mockResolvedValueOnce(thread([q('q1', 'um', 0), a('a1', 1, 'resposta um')], []));
    mount();
    await screen.findByText('resposta um');
    let reread!: (value: unknown) => void;
    chatMock.mockImplementationOnce(() => new Promise((resolve) => (reread = resolve)));
    let pending!: Promise<void>;
    act(() => {
      pending = onReconnect();
    });
    act(() => {
      onEvent({ type: 'message', conversation_id: 'c1', message: q('q2', 'dois', 2) });
      onEvent({ type: 'message', conversation_id: 'c1', message: a('a2', 3) });
    });
    await act(async () => {
      reread(thread([q('q1', 'um', 0), a('a1', 1, 'resposta um')], []));
      await pending;
    });
    expect(screen.getByText('dois')).toBeInTheDocument();
    expect(screen.getByText(/pensando/i)).toBeInTheDocument();
  });

  it('another conversation replaces the thread', async () => {
    chatMock
      .mockResolvedValueOnce(thread([q('q1', 'antiga', 0), a('a1', 1, 'resposta antiga')], []))
      .mockResolvedValue(thread([], [], 'c2'));
    resetMock.mockResolvedValue({ conversation: { id: 'c2' } });
    mount();
    await screen.findByText('resposta antiga');
    fireEvent.click(screen.getByRole('button', { name: 'Nova conversa' }));
    fireEvent.click(screen.getByRole('button', { name: 'Começar de novo' }));
    await waitFor(() => expect(resetMock).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText('resposta antiga')).toBeNull());
    expect(screen.queryByText('antiga')).toBeNull();
  });

  it('a final message held before the panel knew its conversation reaches the thread', async () => {
    let resolveLoad!: (value: unknown) => void;
    chatMock.mockImplementationOnce(() => new Promise((resolve) => (resolveLoad = resolve)));
    mount();
    act(() => onEvent(final('a1', 1)));
    await act(async () => {
      resolveLoad(thread([q('q1', 'pergunta', 0), a('a1', 1)], ['a1']));
    });
    expect(await screen.findByText('pronto')).toBeInTheDocument();
    expect(screen.queryByText(/pensando/i)).toBeNull();
    expect(screen.queryByText(FAILED)).toBeNull();
  });
});

describe('pending cards at hand (TER-477)', () => {
  const T = (m: number) => new Date(Date.parse('2026-09-30T00:00:00.000Z') + m * 60_000).toISOString();
  let onEvent!: (e: unknown) => void;
  beforeEach(() => {
    streamMock.mockImplementation((_reload: unknown, cb: (e: unknown) => void) => {
      onEvent = cb;
      return { connected: true };
    });
  });
  const mount = (actions: ChatAction[], messages: ChatMessage[] = []) => {
    chatMock.mockResolvedValue({ conversation: { id: 'c1', ai_account_id: null }, messages, actions, host: READY });
    return render(
      <MemoryRouter>
        <ChatPanel projectId={null} />
      </MemoryRouter>,
    );
  };

  it('an action_status event turns a pending card stale, live; an unknown id or another conversation changes nothing', async () => {
    mount([action({ id: 'a1' })]);
    await screen.findByRole('button', { name: 'Autorizar' });
    act(() => onEvent({ type: 'action_status', conversation_id: 'c_other', user_id: 'u1', action_id: 'a1', status: 'failed', error_code: 'TAB_GONE' }));
    act(() => onEvent({ type: 'action_status', conversation_id: 'c1', user_id: 'u1', action_id: 'a9', status: 'failed', error_code: 'TAB_GONE' }));
    expect(screen.getByRole('button', { name: 'Autorizar' })).toBeInTheDocument();
    act(() => onEvent({ type: 'action_status', conversation_id: 'c1', user_id: 'u1', action_id: 'a1', status: 'failed', error_code: 'TAB_GONE' }));
    expect(await screen.findByText('Expirou: a aba foi fechada')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Autorizar' })).toBeNull();
    // Nothing waits any more: the bar is gone.
    expect(screen.queryByRole('button', { name: /pendente/ })).toBeNull();
  });

  it('a confirmation for a card already on screen brings it to the end of the thread', async () => {
    mount([action({ id: 'a1', created_at: T(1) })], [msg({ id: 'm1', text: 'primeira', created_at: T(0) }), msg({ id: 'm2', text: 'segunda', created_at: T(2) })]);
    await screen.findByRole('button', { name: 'Autorizar' });
    const card = () => document.querySelector('[data-chat-card="a1"]')!;
    const follows = (a: Node, b: Node) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(follows(card(), screen.getByText('segunda'))).toBe(true);
    act(() =>
      onEvent({ type: 'confirmation', conversation_id: 'c1', action_id: 'a1', tool: 'send_input', args: {}, class: 'write', machine_id: null, project_id: null, tab_id: 't1', summary: action({ id: 'a1' }).summary, created_at: T(1), surfaced_at: T(3), resurfaced: true }),
    );
    await waitFor(() => expect(follows(screen.getByText('segunda'), card())).toBe(true));
    // Moved, never duplicated.
    expect(document.querySelectorAll('[data-chat-card="a1"]')).toHaveLength(1);
  });

  it('"Propor de novo" on an expired card asks the concierge in this conversation', async () => {
    mount([action({ id: 'a1', status: 'expired' })]);
    fireEvent.click(await screen.findByRole('button', { name: 'Propor de novo' }));
    await waitFor(() => expect(sendMock).toHaveBeenCalledWith(`Proponha de novo: ${action({ id: 'a1' }).summary}`));
  });

  it('shows the pending bar and approves only the reversible cards through the batch call', async () => {
    decideManyMock.mockResolvedValue({ actions: [{ id: 'a1', status: 'approved' }, { id: 'a3', status: 'approved' }], skipped: [], queued: false });
    mount([action({ id: 'a1' }), action({ id: 'a2', class: 'irreversible', summary: 'fechar a aba X' }), action({ id: 'a3', summary: 'mover o card TER-1' })]);
    expect(await screen.findByRole('button', { name: /3 pendentes/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Aprovar as reversíveis (2)' }));
    await waitFor(() => expect(decideManyMock).toHaveBeenCalledWith([{ id: 'a1', decision: 'approve' }, { id: 'a3', decision: 'approve' }]));
    expect(await screen.findByRole('button', { name: /1 pendente$/ })).toBeInTheDocument();
  });
});

describe('replies (TER-447)', () => {
  const thread = [
    msg({ id: 'm0', role: 'user', text: 'abre a aba', created_at: '2026-09-21T00:00:00.000Z' }),
    msg({ id: 'm1', role: 'assistant', text: 'Abri a aba **build**', created_at: '2026-09-21T00:00:01.000Z' }),
  ];

  it('"Responder" quotes the row in the composer and sends reply_to_id; a failed send brings the quote back', async () => {
    const { ApiError } = await import('../../lib/api');
    chatMock.mockResolvedValue({ conversation: { id: 'c_p1', project_id: 'p1', ai_account_id: null }, messages: thread, actions: [], host: READY });
    sendMock.mockRejectedValueOnce(new ApiError(409, 'A mensagem citada não está mais disponível. Cancele a citação e envie de novo.', 'REPLY_UNAVAILABLE'));
    render(
      <MemoryRouter>
        <ChatPanel projectId="p1" />
      </MemoryRouter>,
    );
    const answer = (await screen.findByText('Abri a aba', { exact: false })).closest('li')!;
    fireEvent.click(within(answer).getByRole('button', { name: 'Responder' }));
    expect(screen.getByText('Respondendo a Concierge')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'faz de novo' } });
    fireEvent.click(screen.getByRole('button', { name: /enviar/i }));
    await waitFor(() => expect(sendMock).toHaveBeenCalledWith('faz de novo', 'p1', [], 'm1'));
    expect(await screen.findByText(/Cancele a citação/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Respondendo a Concierge')).toBeInTheDocument());

    sendMock.mockResolvedValueOnce({ conversation_id: 'c_p1', user_message_id: 'm2', assistant_message_id: 'm3' });
    fireEvent.click(screen.getByRole('button', { name: /enviar/i }));
    await waitFor(() => expect(sendMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText('Respondendo a Concierge')).toBeNull());
  });

  it('"Responder" on a confirmation card quotes it and sends reply_to_card (TER-849)', async () => {
    chatMock.mockResolvedValue({ conversation: { id: 'c_p1', project_id: 'p1', ai_account_id: null }, messages: thread, actions: [action({ id: 'a1' })], host: READY });
    sendMock.mockResolvedValueOnce({ conversation_id: 'c_p1', user_message_id: 'm2', assistant_message_id: 'm3' });
    const { container } = render(
      <MemoryRouter>
        <ChatPanel projectId="p1" />
      </MemoryRouter>,
    );
    await screen.findByText('Abri a aba', { exact: false });
    const card = container.querySelector<HTMLElement>('[data-chat-card="a1"]')!;
    fireEvent.click(within(card).getByRole('button', { name: 'Responder' }));
    expect(screen.getByText('Respondendo à confirmação')).toBeInTheDocument();
    expect(screen.getByText('digitar npm test na aba Terminal 2 do projeto reactivando, no macbook m3')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'por que essa aba?' } });
    fireEvent.click(screen.getByRole('button', { name: /enviar/i }));
    await waitFor(() => expect(sendMock).toHaveBeenCalledWith('por que essa aba?', 'p1', [], { kind: 'action', id: 'a1' }));
  });

  it('"Responder no chat" on a tab question card quotes what it asks (TER-849)', async () => {
    chatMock.mockResolvedValue({ conversation: { id: 'c_p1', project_id: 'p1', ai_account_id: null }, messages: thread, actions: [], host: READY, grants: [], tab_questions: [question({ id: 'q1' })] });
    sendMock.mockResolvedValueOnce({ conversation_id: 'c_p1', user_message_id: 'm2', assistant_message_id: 'm3' });
    render(
      <MemoryRouter>
        <ChatPanel projectId="p1" />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Responder no chat' }));
    expect(screen.getByText('Respondendo à pergunta da aba')).toBeInTheDocument();
    expect(screen.getByText('Permissão para usar Bash')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'pode permitir' } });
    fireEvent.click(screen.getByRole('button', { name: /enviar/i }));
    await waitFor(() => expect(sendMock).toHaveBeenCalledWith('pode permitir', 'p1', [], { kind: 'tab_question', id: 'q1' }));
  });

  it("a click on a card's quote scrolls to the card (TER-849)", async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const replies = [...thread, msg({ id: 'm2', role: 'user', text: 'por quê?', created_at: '2026-09-21T00:00:02.000Z', reply_to: { id: null, role: 'assistant', excerpt: 'digitar npm test', card: { kind: 'action', id: 'a1' } } })];
    chatMock.mockResolvedValue({ conversation: { id: 'c_p1', project_id: 'p1', ai_account_id: null }, messages: replies, actions: [action({ id: 'a1' })], host: READY });
    const { container } = render(
      <MemoryRouter>
        <ChatPanel projectId="p1" />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Ver card original: Confirmação, digitar npm test' }));
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.contexts[0]).toBe(container.querySelector('[data-chat-card="a1"]'));
  });

  it('a click on a quote scrolls to the original and rings it; an original that is not loaded says so', async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const replies = [
      ...thread,
      msg({ id: 'm2', role: 'user', text: 'faz de novo', created_at: '2026-09-21T00:00:02.000Z', reply_to: { id: 'm1', role: 'assistant', excerpt: 'Abri a aba build' } }),
      msg({ id: 'm4', role: 'user', text: 'e aquela?', created_at: '2026-09-21T00:00:03.000Z', reply_to: { id: 'old', role: 'user', excerpt: 'uma antiga' } }),
    ];
    chatMock.mockResolvedValue({ conversation: { id: 'c_p1', project_id: 'p1', ai_account_id: null }, messages: replies, actions: [], host: READY });
    const { container } = render(
      <MemoryRouter>
        <ChatPanel projectId="p1" />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Ver mensagem original: Concierge, Abri a aba build' }));
    const original = container.querySelector('[data-message-id="m1"]')!;
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.contexts[0]).toBe(original);
    expect(original.className).toContain('ring-accent/60');

    fireEvent.click(screen.getByRole('button', { name: 'Ver mensagem original: Você, uma antiga' }));
    expect(screen.getByText('Mensagem original indisponível')).toBeInTheDocument();
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });
});
