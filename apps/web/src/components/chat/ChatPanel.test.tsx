// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ChatPanel } from './ChatPanel';
import type { ChatAction, ChatGrant, ChatMessage } from '../../lib/types';

const chatMock = vi.fn();
const sendMock = vi.fn();
const streamMock = vi.fn();
const decideMock = vi.fn();
const setHostMock = vi.fn();
const machinesMock = vi.fn();
const accountsMock = vi.fn();
const resetMock = vi.fn();
const revokeMock = vi.fn();

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
      setChatHost: (...a: unknown[]) => setHostMock(...a),
      resetChat: (...a: unknown[]) => resetMock(...a),
      revokeChatGrant: (...a: unknown[]) => revokeMock(...a),
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
  setHostMock.mockReset();
  machinesMock.mockReset();
  accountsMock.mockReset();
  resetMock.mockReset();
  revokeMock.mockReset();
  accountsMock.mockResolvedValue({ accounts: [] });
  auth.state = { user: { id: 'u1' }, viewAs: null };
  chatMock.mockResolvedValue({ conversation: { id: 'c1', title: null, model: null, review_mode: false, last_message_at: null }, messages: [msg({ id: 'm1', role: 'user', text: 'oi' })], actions: [] });
  sendMock.mockResolvedValue({ message: msg({ id: 'm3', role: 'assistant', text: 'pronto' }) });
  streamMock.mockReturnValue({ events: [], connected: true });
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
    return { events: [{ type: 'delta', conversation_id: 'c_other', message_id: 'm9', delta: 'VAZOU' }], connected: true };
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
  await waitFor(() => expect(chatMock).toHaveBeenCalled());
  expect(screen.queryByText('VAZOU')).toBeNull();
  onEvent({ type: 'confirmation', conversation_id: 'c_other', action_id: 'a9', tool: 'send_input', args: {}, class: 'write', machine_id: null, project_id: null, tab_id: null, summary: 'NÃO É DAQUI', created_at: '' });
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
    // Both deltas sit in the buffer before the load ever resolves — this is what proves the buffered
    // `events` filter (not just the live `onEvent` gate) re-admits the panel's own conversation once
    // its id becomes known, instead of having dropped it for good.
    return {
      events: [
        { type: 'delta', conversation_id: 'c_other', message_id: 'm9', delta: 'VAZOU' },
        { type: 'delta', conversation_id: 'c_p1', message_id: 'm1', delta: 'chegou' },
      ],
      connected: true,
    };
  });
  render(
    <MemoryRouter>
      <ChatPanel projectId="p1" />
    </MemoryRouter>,
  );

  // A live push of another conversation's confirmation, delivered while conversationId is still null.
  onEvent({ type: 'confirmation', conversation_id: 'c_other', action_id: 'a9', tool: 'send_input', args: {}, class: 'write', machine_id: null, project_id: null, tab_id: null, summary: 'NÃO É DAQUI', created_at: '' });
  expect(screen.queryByText('NÃO É DAQUI')).toBeNull();
  expect(screen.queryByText('VAZOU')).toBeNull();

  resolveLoad({
    conversation: { id: 'c_p1', project_id: 'p1', ai_account_id: null },
    messages: [{ id: 'm1', conversation_id: 'c_p1', role: 'assistant', text: '', error_code: null, created_at: '' }],
    actions: [],
    host: READY,
  });

  // Now that the panel knows its own id, the buffered delta of its own conversation reappears...
  expect(await screen.findByText('chegou')).toBeTruthy();
  // ...but the foreign one, tagged for c_other, never does — neither live nor from the buffer.
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

it('the strip from GET /chat revokes a grant', async () => {
  chatMock.mockResolvedValue({ conversation: { id: 'c_p1', project_id: 'p1', ai_account_id: null }, messages: [], actions: [], host: READY, grants: [grant({ id: 'g1' })] });
  revokeMock.mockResolvedValue({ grant: grant({ id: 'g1' }) });
  render(
    <MemoryRouter>
      <ChatPanel projectId="p1" />
    </MemoryRouter>,
  );
  expect(await screen.findByText(/Enviando direto para a aba Terminal 1 até/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Revogar' }));
  await waitFor(() => expect(revokeMock).toHaveBeenCalledWith('g1'));
  await waitFor(() => expect(screen.queryByText(/Enviando direto para/)).toBeNull());
});

it('"Permitir sempre nesta aba" on a pending card records the grant and shows it on the strip and the card', async () => {
  chatMock.mockResolvedValue({ conversation: { id: 'c_p1', project_id: 'p1', ai_account_id: null }, messages: [], actions: [action({ id: 'a1' })], host: READY, grants: [] });
  decideMock.mockResolvedValue({ action: { id: 'a1', status: 'approved' }, grant: grant({ id: 'g1' }) });
  render(
    <MemoryRouter>
      <ChatPanel projectId="p1" />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Permitir sempre nesta aba' }));
  await waitFor(() => expect(decideMock).toHaveBeenCalledWith('a1', 'approve_tab'));
  expect(await screen.findByText(/Enviando direto para a aba Terminal 1 até/)).toBeInTheDocument();
  expect(screen.getByText(/^Permitido nesta aba até/)).toBeInTheDocument();
});

it('a grant event adds the strip, a grant_revoked removes it, a granted_action appends a card, and events of another conversation are ignored', async () => {
  let onEvent!: (e: unknown) => void;
  streamMock.mockImplementation((_reload: unknown, cb: (e: unknown) => void) => {
    onEvent = cb;
    return { events: [], connected: true };
  });
  chatMock.mockResolvedValue({ conversation: { id: 'c_p1', project_id: 'p1', ai_account_id: null }, messages: [], actions: [], host: READY, grants: [] });
  render(
    <MemoryRouter>
      <ChatPanel projectId="p1" />
    </MemoryRouter>,
  );
  await waitFor(() => expect(chatMock).toHaveBeenCalled());

  onEvent({ type: 'grant', conversation_id: 'c_other', grant: grant({ id: 'g_other' }) });
  expect(screen.queryByText(/Enviando direto para/)).toBeNull();

  onEvent({ type: 'grant', conversation_id: 'c_p1', grant: grant({ id: 'g1' }) });
  expect(await screen.findByText(/Enviando direto para a aba Terminal 1 até/)).toBeInTheDocument();

  onEvent({ type: 'granted_action', conversation_id: 'c_p1', action: action({ id: 'a2', status: 'executed', grant_id: 'g1' }) });
  expect(await screen.findByText('Executado · aba confiada')).toBeInTheDocument();

  onEvent({ type: 'grant_revoked', conversation_id: 'c_p1', grant_id: 'g1' });
  await waitFor(() => expect(screen.queryByText(/Enviando direto para/)).toBeNull());
});
