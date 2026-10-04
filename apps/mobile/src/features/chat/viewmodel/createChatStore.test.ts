// The chat store (design spec §6) over the real `HttpMobileApi`, the in-memory `MockTransport`
// and its fake socket, with an enrolled, unlocked session store built over the same mock.
import * as SecureStore from 'expo-secure-store';
import { chatResponse, type TChatEvent, type TChatMessage, type TChatStandingGrant } from '@/services/api/contract';
import { ApiError } from '@/services/api/errors';
import { mmkv } from '@/services/storage';
import { appBackgrounded, messageSent } from '@/features/shared/signals';
import { PERSIST_INTERVAL_MS } from './throttled-storage';
import { emptyFold } from '../model/live';
import { createChatStore } from './createChatStore';
import { enrol, PIN, setupSession } from '../../../../test/helpers/enrolled-session';

const secureItems = (SecureStore as unknown as { __items: Map<string, string> }).__items;
// Captured before any test installs fake timers: drains every pending microtask (a `void`-started wipe).
const realSetImmediate = setImmediate;
const flush = () => new Promise<void>((resolve) => realSetImmediate(() => resolve()));

type ChatStore = ReturnType<typeof createChatStore>;
type Handlers = Parameters<ReturnType<typeof setupSession>['api']['events']>[1];

const opened: ChatStore[] = [];

async function setup() {
  const ctx = setupSession();
  await enrol(ctx);
  // Call-through spy: the real socket stays, the test also gets the handlers the store registered.
  const events = jest.spyOn(ctx.api, 'events');
  const chat = createChatStore({ api: ctx.api, session: () => ctx.store.getState() });
  opened.push(chat);
  const handlers = (): Handlers => events.mock.calls[0]![1];
  return { ...ctx, chat, events, handlers };
}

/** Opens a conversation and lets the fake socket connect (its `hello` is on a 0 ms timer). */
async function openAndConnect(chat: ChatStore, projectId: string | null) {
  await chat.getState().open(projectId);
  await jest.advanceTimersByTimeAsync(0);
  expect(chat.getState().connected).toBe(true);
}

const slot = (chat: ChatStore, projectId: string | null) => chat.getState().conversations[projectId ?? '']!;

function decision(conversationId: string, actionId: string, status: 'approved' | 'denied'): TChatEvent {
  return { type: 'decision', user_id: 'u1', conversation_id: conversationId, action_id: actionId, status };
}

beforeEach(() => {
  jest.useFakeTimers();
  mmkv.clearAll();
  secureItems.clear();
});

afterEach(() => {
  while (opened.length) opened.pop()!.getState().close();
  // Stores of earlier tests stay subscribed to the signal: drain what they left pending now, so a
  // later test's write count is its own (the next beforeEach clears MMKV anyway).
  appBackgrounded.emit();
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

it('loadProjects fills the three projects', async () => {
  const { chat } = await setup();
  await chat.getState().loadProjects();
  const { projects, loadingProjects } = chat.getState();
  expect(projects.map((p) => p.id).sort()).toEqual(['p-opapingou', 'p-reactivando', 'p-termhub']);
  expect(projects.find((p) => p.id === 'p-termhub')!.pending_confirmations).toBe(2);
  expect(loadingProjects).toBe(false);
});

describe('setFavorite (TER-541)', () => {
  const place = (chat: ChatStore, id: string) => chat.getState().projects.find((p) => p.id === id)!.favorite_position;

  it('pins at once, before the server answers, and the server keeps it', async () => {
    const { chat, api, store } = await setup();
    await chat.getState().loadProjects();
    const pending = chat.getState().setFavorite('p-termhub', true);
    expect(place(chat, 'p-termhub')).toBe(0);
    await pending;
    const { projects } = await api.chatProjects(store.getState().auth());
    expect(projects.find((p) => p.id === 'p-termhub')!.favorite_position).toBe(0);
  });

  it('puts a second pin after the first, and unpinning clears the place', async () => {
    const { chat } = await setup();
    await chat.getState().loadProjects();
    await chat.getState().setFavorite('p-termhub', true);
    await chat.getState().setFavorite('p-opapingou', true);
    expect(place(chat, 'p-opapingou')).toBe(1);
    await chat.getState().setFavorite('p-termhub', false);
    expect(place(chat, 'p-termhub')).toBeNull();
  });

  it('puts the row back and says why when the server refuses', async () => {
    const { chat, api } = await setup();
    await chat.getState().loadProjects();
    jest.spyOn(api, 'setProjectFavorite').mockRejectedValueOnce(new ApiError(404, 'NOT_FOUND', 'Projeto não encontrado'));
    await chat.getState().setFavorite('p-termhub', true);
    expect(place(chat, 'p-termhub')).toBeNull();
    expect(chat.getState().error).toBe('Projeto não encontrado');
  });

  it('a list read that started before the tap does not undo the pin', async () => {
    const { chat, api } = await setup();
    await chat.getState().loadProjects();
    const before = chat.getState().projects;
    let answer!: (v: { projects: typeof before }) => void;
    jest.spyOn(api, 'chatProjects').mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    const load = chat.getState().loadProjects({ quiet: true });
    await chat.getState().setFavorite('p-termhub', true);
    answer({ projects: before }); // read before the pin landed
    await load;
    expect(place(chat, 'p-termhub')).toBe(0);
  });

  it('pin, unpin, pin: an early failure does not undo the last tap, and the server ends pinned', async () => {
    const { chat, api, store } = await setup();
    await chat.getState().loadProjects();
    const real = api.setProjectFavorite.bind(api);
    let first = true;
    jest.spyOn(api, 'setProjectFavorite').mockImplementation(async (...args) => {
      if (first) {
        first = false;
        throw new ApiError(503, 'UNAVAILABLE', 'Fora do ar');
      }
      return real(...args);
    });
    await Promise.all([chat.getState().setFavorite('p-termhub', true), chat.getState().setFavorite('p-termhub', false), chat.getState().setFavorite('p-termhub', true)]);
    expect(place(chat, 'p-termhub')).not.toBeNull();
    const { projects } = await api.chatProjects(store.getState().auth());
    expect(projects.find((p) => p.id === 'p-termhub')!.favorite_position).not.toBeNull();
  });

  it('a pin that fails after a later unpin does not undo the unpin', async () => {
    const { chat, api } = await setup();
    await chat.getState().loadProjects();
    let failPin!: (e: unknown) => void;
    jest.spyOn(api, 'setProjectFavorite').mockImplementationOnce(() => new Promise<void>((_, reject) => (failPin = reject)));
    const pin = chat.getState().setFavorite('p-termhub', true);
    // Writes go one at a time per project: the unpin waits behind the pin that is about to fail.
    const unpin = chat.getState().setFavorite('p-termhub', false);
    await Promise.resolve(); // the chained write starts on the next microtask
    failPin(new ApiError(503, 'UNAVAILABLE', 'Fora do ar'));
    await Promise.all([pin, unpin]);
    expect(place(chat, 'p-termhub')).toBeNull();
  });
});

it('loadProjects({ quiet }) refreshes the list in the background: no spinner, and the banner is left alone (spec 2026-09-28 iPad §2.3)', async () => {
  const { chat, api } = await setup();
  const spun: boolean[] = [];
  const unsubscribe = chat.subscribe((s) => spun.push(s.loadingProjects));
  // The open pane's own failure: a background refresh must neither clear it nor replace it.
  chat.setState({ error: 'Falha no chat' });

  await chat.getState().loadProjects({ quiet: true });
  expect(chat.getState().projects.map((p) => p.id).sort()).toEqual(['p-opapingou', 'p-reactivando', 'p-termhub']);
  expect(chat.getState().error).toBe('Falha no chat');

  jest.spyOn(api, 'chatProjects').mockRejectedValueOnce(new Error('network down'));
  await chat.getState().loadProjects({ quiet: true });
  expect(chat.getState().error).toBe('Falha no chat');
  expect(chat.getState().projects).toHaveLength(3); // the last good list stays

  unsubscribe();
  expect(spun).not.toContain(true);
});

it('an open tab question counts as pending in the projects list, as on the server (spec 2026-09-26 §4.9)', async () => {
  const { chat } = await setup();
  await openAndConnect(chat, 'p-termhub');
  await chat.getState().send('tem alguma pergunta?');
  await jest.advanceTimersByTimeAsync(5000);
  await chat.getState().loadProjects();
  // The two seeded pending actions (the grouped-confirmation fixture), plus the question the tab just asked.
  expect(chat.getState().projects.find((p) => p.id === 'p-termhub')!.pending_confirmations).toBe(3);
});

it("open('p-termhub') loads the thread and subscribes once for the whole app", async () => {
  const { chat, events } = await setup();
  await openAndConnect(chat, 'p-termhub');

  const s = slot(chat, 'p-termhub');
  expect(s).toMatchObject({ loaded: true, error: null, conversation: { id: 'c-termhub', project_id: 'p-termhub' } });
  expect(s.messages).toHaveLength(4);
  expect(s.actions).toEqual([expect.objectContaining({ id: 'a-termhub-1', status: 'pending' }), expect.objectContaining({ id: 'a-termhub-2', status: 'pending' })]);
  expect(s.host).toMatchObject({ kind: 'ready', machine: { name: 'jarvis' } });
  expect(chat.getState().activeProject).toBe('p-termhub');

  await chat.getState().open(null);
  expect(slot(chat, null).conversation?.id).toBe('c-general');
  expect(chat.getState().activeProject).toBeNull();
  expect(events).toHaveBeenCalledTimes(1);
});

it('a reconnect re-reads the conversation and keeps what streamed for a row the re-read does not show finished', async () => {
  const { chat, api, controls, handlers } = await setup();
  await openAndConnect(chat, 'p-termhub');
  handlers().onEvent({ type: 'delta', user_id: 'u1', conversation_id: 'c-termhub', message_id: 'm-x', delta: 'meio' });
  expect(chat.getState().live.deltas.get('m-x')).toBe('meio');

  const read = jest.spyOn(api, 'chat');
  controls.dropSocket();
  expect(chat.getState().connected).toBe(false);

  await jest.advanceTimersByTimeAsync(2000); // the socket's first backoff step (1 s), then its connect tick
  expect(chat.getState().connected).toBe(true);
  expect(read).toHaveBeenCalledWith(expect.anything(), 'p-termhub');
  expect(chat.getState().live.deltas.get('m-x')).toBe('meio');
});

it('a mid-stream reconnect keeps the streamed text of a row the re-read still shows unanswered, and drops it once the row has its text (Review Focus #5)', async () => {
  const { chat, api, controls, handlers } = await setup();
  const rows = () => slot(chat, 'p-termhub').messages;
  let openRow: TChatMessage = { id: 'm-open', conversation_id: 'c-termhub', role: 'assistant', text: '', usage: null, error_code: null, created_at: new Date().toISOString() };
  const real = api.chat.bind(api);
  jest.spyOn(api, 'chat').mockImplementation(async (auth, projectId) => {
    const res = await real(auth, projectId);
    return projectId === 'p-termhub' ? { ...res, messages: [...res.messages, openRow] } : res;
  });
  await openAndConnect(chat, 'p-termhub');
  handlers().onEvent({ type: 'delta', user_id: 'u1', conversation_id: 'c-termhub', message_id: 'm-open', delta: 'meio da' });

  controls.dropSocket();
  await jest.advanceTimersByTimeAsync(2000);
  expect(chat.getState().connected).toBe(true);
  expect(rows().find((m) => m.id === 'm-open')?.text).toBe('');
  expect(chat.getState().live.deltas.get('m-open')).toBe('meio da');
  expect(chat.getState().live.started.has('m-open')).toBe(true);

  // The next re-read has the row's final text: the row carries it now, the fold lets go.
  openRow = { ...openRow, text: 'meio da resposta' };
  controls.dropSocket();
  await jest.advanceTimersByTimeAsync(2000);
  expect(chat.getState().connected).toBe(true);
  expect(rows().find((m) => m.id === 'm-open')?.text).toBe('meio da resposta');
  // Changed on purpose (spec 2026-09-29 §5): the fold lets go and also remembers the row as closed.
  expect(chat.getState().live).toEqual({ ...emptyFold(), closed: chat.getState().live.closed });
  expect(chat.getState().live.closed.has('m-open')).toBe(true);
});

it('a re-read in flight never drops a row that a message event merged meanwhile; untouched rows keep their objects', async () => {
  const { chat, api, handlers } = await setup();
  await openAndConnect(chat, 'p-termhub');
  const rows = () => slot(chat, 'p-termhub').messages;
  const before = rows();
  const real = api.chat.bind(api);
  let release!: () => void;
  jest.spyOn(api, 'chat').mockImplementation(async (auth, projectId) => {
    const res = await real(auth, projectId);
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return res;
  });

  const refreshing = chat.getState().refresh('p-termhub');
  await flush(); // the GET's snapshot is taken; its answer is held back
  const fresh: TChatMessage = { id: 'm-new', conversation_id: 'c-termhub', role: 'assistant', text: 'oi', usage: null, error_code: null, created_at: new Date().toISOString() };
  handlers().onEvent({ type: 'message', user_id: 'u1', conversation_id: 'c-termhub', message: fresh });
  expect(rows().at(-1)).toEqual(fresh);

  release();
  await refreshing;
  expect(slot(chat, 'p-termhub').loaded).toBe(true);
  const after = rows();
  expect(after).toHaveLength(5);
  expect(after.find((m) => m.id === 'm-new')).toEqual(fresh);
  expect(after[0]).toBe(before[0]);
  expect(after[3]).toBe(before[3]);
});

it('retrySend refuses while another send is in flight and keeps the failed row', async () => {
  const { chat, api } = await setup();
  await openAndConnect(chat, 'p-termhub');
  const rows = () => slot(chat, 'p-termhub').messages;
  const sent = jest.spyOn(api, 'sendMessage').mockRejectedValueOnce(new ApiError(409, 'HOST_OFFLINE', 'A máquina do chat está offline.'));
  await chat.getState().send('oi');
  const failed = rows().at(-1)!;
  expect(failed.local).toBe('failed');

  sent.mockImplementationOnce(() => new Promise(() => undefined)); // a send that never answers
  void chat.getState().send('outra');
  expect(chat.getState().sending).toBe(true);
  await expect(chat.getState().retrySend(failed.id)).resolves.toBe(false);
  expect(rows()).toContain(failed);
  expect(sent).toHaveBeenCalledTimes(2);
});

it('send shows the row at once, renamed on accept; the thread then grows through events merged by id, with no re-read', async () => {
  const { chat, api } = await setup();
  await openAndConnect(chat, 'p-termhub');
  const read = jest.spyOn(api, 'chat');
  const sent = jest.spyOn(api, 'sendMessage');

  await expect(chat.getState().send('  roda o teste  ')).resolves.toBe(true);
  expect(sent).toHaveBeenCalledWith(expect.anything(), { text: 'roda o teste', project_id: 'p-termhub' });
  expect(chat.getState().sending).toBe(false);
  const { user_message_id: userId, assistant_message_id: assistantId } = await sent.mock.results[0]!.value;
  const rows = () => slot(chat, 'p-termhub').messages;
  expect(rows()).toHaveLength(5); // the person's row, already under the server's id
  expect(rows()[4]).toMatchObject({ id: userId, role: 'user', text: 'roda o teste' });
  expect(rows()[4]!.local).toBeUndefined();

  await jest.advanceTimersToNextTimerAsync(); // the server's echo of that row
  expect(rows()).toHaveLength(5); // merged by id, not appended
  expect(read).not.toHaveBeenCalled(); // a `message` event no longer re-reads the thread

  await jest.advanceTimersToNextTimerAsync(); // the empty assistant row: "pensando…"
  expect(rows()).toHaveLength(6);
  expect(chat.getState().live.started.has(assistantId)).toBe(true);

  await jest.advanceTimersToNextTimerAsync();
  await jest.advanceTimersToNextTimerAsync();
  const streaming = chat.getState().live.deltas.get(assistantId);
  expect(streaming).toBeTruthy();

  await jest.advanceTimersByTimeAsync(5000);
  const final = rows().find((m) => m.id === assistantId)!;
  expect(final.text).toBe('Rodei `npm test` no jarvis: 1066 testes passaram, 137 pulados. Nada quebrou.');
  expect(final.text.startsWith(streaming!)).toBe(true);
  // Changed on purpose (spec 2026-09-29 §5): nothing streamed or started is left, and the row is closed.
  expect(chat.getState().live).toEqual({ ...emptyFold(), closed: chat.getState().live.closed });
  expect(chat.getState().live.closed.has(assistantId)).toBe(true);
  expect(read).not.toHaveBeenCalled();
});

it('the local row is shown while the 202 is in flight, and dropped without a duplicate when the echo lands first (Review Focus #5)', async () => {
  const { chat, api, handlers } = await setup();
  await openAndConnect(chat, 'p-termhub');
  const rows = () => slot(chat, 'p-termhub').messages;
  const real = api.sendMessage.bind(api);
  let seenWhileInFlight: ReturnType<typeof rows> = [];
  jest.spyOn(api, 'sendMessage').mockImplementation(async (auth, body) => {
    seenWhileInFlight = rows();
    const res = await real(auth, body);
    // The socket's echo of the person's row arrives before the HTTP answer does.
    handlers().onEvent({
      type: 'message',
      user_id: 'u1',
      conversation_id: 'c-termhub',
      message: { id: res.user_message_id, conversation_id: 'c-termhub', role: 'user', text: body.text, usage: null, error_code: null, created_at: new Date().toISOString() },
    });
    return res;
  });

  await expect(chat.getState().send('oi')).resolves.toBe(true);
  expect(seenWhileInFlight.at(-1)).toMatchObject({ role: 'user', text: 'oi', local: 'sending' });
  expect(seenWhileInFlight.at(-1)!.id.startsWith('local:')).toBe(true);

  const mine = rows().filter((m) => m.role === 'user' && m.text === 'oi');
  expect(mine).toHaveLength(1);
  expect(mine[0]!.id.startsWith('local:')).toBe(false);
  expect(mine[0]!.local).toBeUndefined();

  await jest.advanceTimersByTimeAsync(5000); // the mock's own echo and answer
  expect(rows().filter((m) => m.role === 'user' && m.text === 'oi')).toHaveLength(1);
});

it('a failed send keeps the row with its reason; it survives a re-read and is never persisted; retrySend sends its text again', async () => {
  const { chat, api } = await setup();
  await openAndConnect(chat, 'p-termhub');
  const rows = () => slot(chat, 'p-termhub').messages;
  const sent = jest.spyOn(api, 'sendMessage').mockRejectedValueOnce(new ApiError(409, 'HOST_OFFLINE', 'A máquina do chat está offline.'));

  await expect(chat.getState().send('oi')).resolves.toBe(false);
  const failed = rows().at(-1)!;
  expect(failed).toMatchObject({ role: 'user', text: 'oi', local: 'failed', local_error: 'A máquina do chat está offline.' });
  expect(chat.getState().error).toBe('A máquina do chat está offline.');

  await chat.getState().refresh('p-termhub');
  expect(rows().at(-1)).toBe(failed);

  await jest.advanceTimersByTimeAsync(PERSIST_INTERVAL_MS);
  const saved = JSON.parse(mmkv.getString('chat')!).state as { conversations: Record<string, { messages: Array<{ id: string }> }> };
  expect(saved.conversations['p-termhub']!.messages.some((m) => m.id.startsWith('local:'))).toBe(false);

  await expect(chat.getState().retrySend(failed.id)).resolves.toBe(true);
  expect(sent).toHaveBeenLastCalledWith(expect.anything(), { text: 'oi', project_id: 'p-termhub' });
  const mine = rows().filter((m) => m.text === 'oi');
  expect(mine).toHaveLength(1);
  expect(mine[0]!.local).toBeUndefined();
});

it('a message event replaces only the row that changed; unchanged rows keep their objects', async () => {
  const { chat, api, handlers } = await setup();
  await openAndConnect(chat, 'p-termhub');
  const read = jest.spyOn(api, 'chat');
  const before = slot(chat, 'p-termhub').messages;

  handlers().onEvent({ type: 'message', user_id: 'u1', conversation_id: 'c-termhub', message: { ...before[0]! } });
  expect(slot(chat, 'p-termhub').messages).toBe(before);

  handlers().onEvent({ type: 'message', user_id: 'u1', conversation_id: 'c-termhub', message: { ...before[1]!, text: 'editado' } });
  const after = slot(chat, 'p-termhub').messages;
  expect(after).not.toBe(before);
  expect(after[0]).toBe(before[0]);
  expect(after[1]!.text).toBe('editado');
  expect(after[2]).toBe(before[2]);
  expect(read).not.toHaveBeenCalled();
});

it('a second send while the first answer is still being written goes through', async () => {
  const { chat, api } = await setup();
  await openAndConnect(chat, 'p-termhub');
  const sent = jest.spyOn(api, 'sendMessage').mockResolvedValue({ conversation_id: 'c1', user_message_id: 'q', assistant_message_id: 'a' } as never);
  await expect(chat.getState().send('primeira')).resolves.toBe(true);
  // No run_finished yet: the first answer is still pending, and the box takes the next message.
  await expect(chat.getState().send('segunda')).resolves.toBe(true);
  expect(sent).toHaveBeenCalledTimes(2);
  expect(chat.getState().error).toBeNull();
});

it('a 409 CHAT_BUSY says the chat is still answering; other errors show their own text', async () => {
  const { chat, api } = await setup();
  await openAndConnect(chat, 'p-termhub');
  const sent = jest.spyOn(api, 'sendMessage').mockRejectedValueOnce(new ApiError(409, 'CHAT_BUSY', 'ocupado'));

  await expect(chat.getState().send('oi')).resolves.toBe(false);
  expect(chat.getState()).toMatchObject({ sending: false, error: 'O chat ainda está respondendo. Aguarde.' });

  sent.mockRejectedValueOnce(new ApiError(409, 'HOST_OFFLINE', 'A máquina do chat está offline.'));
  await chat.getState().send('oi');
  expect(chat.getState().error).toBe('A máquina do chat está offline.');
});

const markIrreversible = (chat: ChatStore, projectId: string, id: string) =>
  chat.setState((s) => ({
    conversations: { ...s.conversations, [projectId]: { ...s.conversations[projectId]!, actions: s.conversations[projectId]!.actions.map((a) => (a.id === id ? { ...a, class: 'irreversible' as const } : a)) } },
  }));

it("decide(id, 'approve') on a write card approves at once, with no PIN sheet and no proof", async () => {
  const { chat, store, api } = await setup();
  await openAndConnect(chat, 'p-termhub');
  const decide = jest.spyOn(api, 'decide');
  await chat.getState().decide('a-termhub-1', 'approve');
  expect(store.getState().pinPrompt).toBeNull();
  expect(decide).toHaveBeenCalledWith(expect.anything(), 'a-termhub-1', { decision: 'approve' });
  expect(slot(chat, 'p-termhub').actions[0]!.status).toBe('approved');
  expect(chat.getState()).toMatchObject({ decidingId: null, error: null });
});

it("decide(id, 'approve') on an irreversible card asks requestPinProof(id) and, once resolved, the card is approved", async () => {
  const { chat, store } = await setup();
  await openAndConnect(chat, 'p-termhub');
  markIrreversible(chat, 'p-termhub', 'a-termhub-1');
  const deciding = chat.getState().decide('a-termhub-1', 'approve');
  expect(store.getState().pinPrompt).toEqual({ actionId: 'a-termhub-1', decision: 'approve' });
  await store.getState().resolvePinPrompt(PIN);
  await deciding;
  expect(slot(chat, 'p-termhub').actions[0]!.status).toBe('approved');
});

it('a PIN_REQUIRED answer to a silent approval opens the PIN sheet for the same action and word', async () => {
  const { chat, store, api } = await setup();
  await openAndConnect(chat, 'p-termhub');
  jest.spyOn(api, 'decide').mockRejectedValueOnce(new ApiError(401, 'PIN_REQUIRED', 'Confirme com o PIN para autorizar esta ação.'));
  const deciding = chat.getState().decide('a-termhub-1', 'approve');
  await jest.advanceTimersByTimeAsync(0);
  expect(store.getState().pinPrompt).toEqual({ actionId: 'a-termhub-1', decision: 'approve' });
  expect(chat.getState().error).toBeNull();
  await store.getState().resolvePinPrompt(PIN);
  await deciding;
  expect(slot(chat, 'p-termhub').actions[0]!.status).toBe('approved');
});

it('a VALIDATION answer to a silent approval (old-schema rollback) also opens the PIN sheet', async () => {
  const { chat, store, api } = await setup();
  await openAndConnect(chat, 'p-termhub');
  jest.spyOn(api, 'decide').mockRejectedValueOnce(new ApiError(400, 'VALIDATION', 'Dados inválidos'));
  const deciding = chat.getState().decide('a-termhub-1', 'approve');
  await jest.advanceTimersByTimeAsync(0);
  expect(store.getState().pinPrompt).toEqual({ actionId: 'a-termhub-1', decision: 'approve' });
  expect(chat.getState().error).toBeNull();
  await store.getState().resolvePinPrompt(PIN);
  await deciding;
  expect(slot(chat, 'p-termhub').actions[0]!.status).toBe('approved');
});

it('a PIN_REQUIRED fallback is dropped when the conversation is left before the PIN sheet opens', async () => {
  const { chat, store, api } = await setup();
  await openAndConnect(chat, 'p-termhub');
  jest.spyOn(api, 'decide').mockRejectedValueOnce(new ApiError(401, 'PIN_REQUIRED', 'Confirme com o PIN para autorizar esta ação.'));
  const deciding = chat.getState().decide('a-termhub-1', 'approve');
  chat.getState().close(); // leaves the conversation before the rejection is handled
  await deciding;
  expect(store.getState().pinPrompt).toBeNull();
});

it("decide(id, 'approve_tab') asks the PIN for approve_tab and, once resolved, the tab is trusted", async () => {
  const { chat, store } = await setup();
  await openAndConnect(chat, 'p-termhub');
  const deciding = chat.getState().decide('a-termhub-1', 'approve_tab');
  expect(store.getState().pinPrompt).toEqual({ actionId: 'a-termhub-1', decision: 'approve_tab' });
  await store.getState().resolvePinPrompt(PIN);
  await deciding;
  expect(slot(chat, 'p-termhub').actions[0]!.status).toBe('approved');
  expect(slot(chat, 'p-termhub').grants).toEqual([expect.objectContaining({ tab_id: 't-api', source_action_id: 'a-termhub-1' })]);
});

it("decide(id, 'approve_project') asks the PIN for approve_project and, once resolved, the project is trusted (a-termhub-2 is move_task, a board tool)", async () => {
  const { chat, store } = await setup();
  await openAndConnect(chat, 'p-termhub');
  const deciding = chat.getState().decide('a-termhub-2', 'approve_project');
  expect(store.getState().pinPrompt).toEqual({ actionId: 'a-termhub-2', decision: 'approve_project' });
  await store.getState().resolvePinPrompt(PIN);
  await deciding;
  expect(slot(chat, 'p-termhub').actions.find((a) => a.id === 'a-termhub-2')!.status).toBe('approved');
  expect(slot(chat, 'p-termhub').projectGrants).toEqual([expect.objectContaining({ project_id: 'p-termhub', source_action_id: 'a-termhub-2' })]);
});

it("decide(id, 'approve_tab_terminal') asks the PIN for that word and, once resolved, the tab's keys and shell are granted", async () => {
  const { chat, store } = await setup();
  await openAndConnect(chat, 'p-termhub');
  const deciding = chat.getState().decide('a-termhub-1', 'approve_tab_terminal');
  expect(store.getState().pinPrompt).toEqual({ actionId: 'a-termhub-1', decision: 'approve_tab_terminal' });
  await store.getState().resolvePinPrompt(PIN);
  await deciding;
  expect(slot(chat, 'p-termhub').actions[0]!.status).toBe('approved');
  expect(slot(chat, 'p-termhub').grants).toEqual([expect.objectContaining({ tab_id: 't-api', tool: 'terminal', source_action_id: 'a-termhub-1' })]);
});

it("decide(id, 'approve_project_all') asks the PIN for that word and, once resolved, the whole project is granted", async () => {
  const { chat, store } = await setup();
  await openAndConnect(chat, 'p-termhub');
  const deciding = chat.getState().decide('a-termhub-1', 'approve_project_all');
  expect(store.getState().pinPrompt).toEqual({ actionId: 'a-termhub-1', decision: 'approve_project_all' });
  await store.getState().resolvePinPrompt(PIN);
  await deciding;
  expect(slot(chat, 'p-termhub').actions[0]!.status).toBe('approved');
  expect(slot(chat, 'p-termhub').projectGrants).toEqual([expect.objectContaining({ project_id: 'p-termhub', scope: 'all', source_action_id: 'a-termhub-1' })]);
});

it('project_grant / project_grant_revoked events update the slot', async () => {
  const { chat, handlers } = await setup();
  await openAndConnect(chat, 'p-termhub');
  const pg = { id: 'pg1', project_id: 'p-termhub', project_name: 'termhub', source_action_id: 'a-termhub-2', created_at: new Date().toISOString(), expires_at: '2099-01-01T00:00:00.000Z', scope: 'board' as const };
  handlers().onEvent({ type: 'project_grant', user_id: 'u1', conversation_id: 'c-termhub', grant: pg });
  expect(slot(chat, 'p-termhub').projectGrants).toEqual([pg]);
  handlers().onEvent({ type: 'project_grant_revoked', user_id: 'u1', conversation_id: 'c-termhub', grant_id: pg.id });
  expect(slot(chat, 'p-termhub').projectGrants).toEqual([]);
});

it('revokeGrant drops a project grant too', async () => {
  const { chat, store } = await setup();
  await openAndConnect(chat, 'p-termhub');
  const deciding = chat.getState().decide('a-termhub-2', 'approve_project');
  await store.getState().resolvePinPrompt(PIN);
  await deciding;
  const [pg] = slot(chat, 'p-termhub').projectGrants;
  await chat.getState().revokeGrant(pg!.id);
  expect(slot(chat, 'p-termhub').projectGrants).toEqual([]);
  expect(chat.getState()).toMatchObject({ revokingId: null, error: null });
});

it('reset clears project grants too', async () => {
  const { chat, store } = await setup();
  await openAndConnect(chat, 'p-termhub');
  const deciding = chat.getState().decide('a-termhub-2', 'approve_project');
  await store.getState().resolvePinPrompt(PIN);
  await deciding;
  expect(slot(chat, 'p-termhub').projectGrants).toHaveLength(1);
  await chat.getState().reset();
  expect(slot(chat, 'p-termhub').projectGrants).toEqual([]);
});

const standing = (patch: Partial<TChatStandingGrant> = {}): TChatStandingGrant => ({ id: 'sg1', project_id: 'p-termhub', project_name: 'termhub', kind: 'close_tab', source_action_id: 'a-termhub-1', created_at: new Date().toISOString(), ...patch });

it("decide(id, 'approve_project_always') asks the PIN for that word and, once resolved, the standing grant is in the slot (TER-386)", async () => {
  const { chat, store } = await setup();
  await openAndConnect(chat, 'p-termhub');
  const deciding = chat.getState().decide('a-termhub-2', 'approve_project_always');
  // The sheet's title is the card's button label, kind included (a move_task card is "mexer no quadro").
  expect(store.getState().pinPrompt).toEqual({ actionId: 'a-termhub-2', decision: 'approve_project_always', title: 'Liberar sem prazo: mexer no quadro neste projeto' });
  await store.getState().resolvePinPrompt(PIN);
  await deciding;
  await jest.advanceTimersByTimeAsync(0); // the re-read
  expect(slot(chat, 'p-termhub').actions.find((a) => a.id === 'a-termhub-2')!.status).toBe('approved');
  expect(slot(chat, 'p-termhub').standingGrants).toEqual([expect.objectContaining({ project_id: 'p-termhub', kind: 'board', source_action_id: 'a-termhub-2' })]);
  expect(slot(chat, 'p-termhub').projectGrants).toEqual([]);
});

it('standing_grant applies to the slots that show it, whatever conversation it came from; standing_grant_revoked removes it everywhere (TER-386)', async () => {
  const { chat, handlers } = await setup();
  await openAndConnect(chat, null);
  await chat.getState().open('p-termhub');
  // Tagged with the account-wide conversation, but it trusts p-termhub: both slots show it.
  const g = standing();
  handlers().onEvent({ type: 'standing_grant', user_id: 'u1', conversation_id: 'c-general', grant: g });
  expect(slot(chat, 'p-termhub').standingGrants).toEqual([g]);
  expect(slot(chat, null).standingGrants).toEqual([g]);
  // Another project's grant: only the account-wide chat shows it.
  const other = standing({ id: 'sg2', project_id: 'p-opapingou', project_name: 'opapingou' });
  handlers().onEvent({ type: 'standing_grant', user_id: 'u1', conversation_id: 'c-general', grant: other });
  expect(slot(chat, 'p-termhub').standingGrants).toEqual([g]);
  expect(slot(chat, null).standingGrants).toEqual([g, other]);
  // A re-grant of the same kind on the same project replaces the older one.
  const again = standing({ id: 'sg3' });
  handlers().onEvent({ type: 'standing_grant', user_id: 'u1', conversation_id: 'c-termhub', grant: again });
  expect(slot(chat, 'p-termhub').standingGrants).toEqual([again]);
  expect(slot(chat, null).standingGrants).toEqual([other, again]);
  handlers().onEvent({ type: 'standing_grant_revoked', user_id: 'u1', conversation_id: 'c-termhub', grant_id: 'sg3' });
  expect(slot(chat, 'p-termhub').standingGrants).toEqual([]);
  expect(slot(chat, null).standingGrants).toEqual([other]);
});

it('revokeGrant drops a standing grant too, and a reset keeps standing grants (TER-386)', async () => {
  const { chat, store } = await setup();
  await openAndConnect(chat, 'p-termhub');
  const deciding = chat.getState().decide('a-termhub-2', 'approve_project_always');
  await store.getState().resolvePinPrompt(PIN);
  await deciding;
  await jest.advanceTimersByTimeAsync(0);
  expect(slot(chat, 'p-termhub').standingGrants).toHaveLength(1);
  // "Nova conversa" does not end a standing grant: it is not bound to the conversation — the slot
  // never drops it, not even between the reset and its re-read.
  const seen: number[] = [];
  const unsubscribe = chat.subscribe((s) => seen.push(s.conversations['p-termhub']!.standingGrants.length));
  await chat.getState().reset();
  unsubscribe();
  expect(seen.length).toBeGreaterThan(0);
  expect(seen).not.toContain(0);
  const [sg] = slot(chat, 'p-termhub').standingGrants;
  expect(sg).toMatchObject({ kind: 'board', project_id: 'p-termhub' });
  await chat.getState().revokeGrant(sg!.id);
  expect(slot(chat, 'p-termhub').standingGrants).toEqual([]);
  expect(chat.getState()).toMatchObject({ revokingId: null, error: null });
});

it('revokeGrant(id) drops the grant', async () => {
  const { chat, store } = await setup();
  await openAndConnect(chat, 'p-termhub');
  const deciding = chat.getState().decide('a-termhub-1', 'approve_tab');
  await store.getState().resolvePinPrompt(PIN);
  await deciding;
  const [g] = slot(chat, 'p-termhub').grants;
  await chat.getState().revokeGrant(g!.id);
  expect(slot(chat, 'p-termhub').grants).toEqual([]);
  expect(chat.getState()).toMatchObject({ revokingId: null, error: null });
});

it('revokeGrant of a grant already revoked elsewhere (409) drops it quietly; another failure shows its text and keeps it', async () => {
  const { chat, api, store } = await setup();
  await openAndConnect(chat, 'p-termhub');
  const deciding = chat.getState().decide('a-termhub-1', 'approve_tab');
  await store.getState().resolvePinPrompt(PIN);
  await deciding;
  const [g] = slot(chat, 'p-termhub').grants;

  jest.spyOn(api, 'revokeGrant').mockRejectedValueOnce(new ApiError(500, 'INTERNAL', 'Falhou.'));
  await chat.getState().revokeGrant(g!.id);
  expect(slot(chat, 'p-termhub').grants).toHaveLength(1);
  expect(chat.getState()).toMatchObject({ revokingId: null, error: 'Falhou.' });

  jest.spyOn(api, 'revokeGrant').mockRejectedValueOnce(new ApiError(409, 'CONFLICT', 'Esta permissão já foi revogada'));
  await chat.getState().revokeGrant(g!.id);
  expect(slot(chat, 'p-termhub').grants).toEqual([]);
  expect(chat.getState()).toMatchObject({ revokingId: null, error: null });
});

it("decide(id, 'approve') performs the decision inside the prompt: a wrong PIN leaves the sheet open with the error, the card pending; the right one approves", async () => {
  const { chat, store, api } = await setup();
  await openAndConnect(chat, 'p-termhub');
  markIrreversible(chat, 'p-termhub', 'a-termhub-1');
  const decide = jest.spyOn(api, 'decide');

  let done = false;
  const deciding = chat.getState().decide('a-termhub-1', 'approve').then(() => (done = true));
  await store.getState().resolvePinPrompt('000000');
  // the mock checked the (wrong) proof and answered PIN_INVALID, which stayed inside the prompt
  expect(decide).toHaveBeenCalledTimes(1);
  expect(decide).toHaveBeenLastCalledWith(expect.anything(), 'a-termhub-1', { decision: 'approve', challenge: expect.any(String), pin_proof: expect.any(String) });
  await expect(decide.mock.results[0]!.value).rejects.toMatchObject({ code: 'PIN_INVALID' });
  expect(store.getState()).toMatchObject({ pinPrompt: { actionId: 'a-termhub-1' }, error: 'PIN incorreto.', attemptsLeft: 2, busy: false });
  expect(done).toBe(false);
  expect(slot(chat, 'p-termhub').actions[0]!.status).toBe('pending');
  expect(chat.getState()).toMatchObject({ decidingId: 'a-termhub-1', error: null });

  await store.getState().resolvePinPrompt(PIN);
  await deciding;
  expect(decide).toHaveBeenCalledTimes(2);
  expect(store.getState()).toMatchObject({ pinPrompt: null, error: null, attemptsLeft: null });
  expect(slot(chat, 'p-termhub').actions[0]!.status).toBe('approved');
  expect(chat.getState()).toMatchObject({ decidingId: null, error: null });
});

it('decideMany of denials only sends one batch with no PIN prompt', async () => {
  const { chat, store, api } = await setup();
  await openAndConnect(chat, 'p-termhub');
  const decideMany = jest.spyOn(api, 'decideMany');
  const challenge = jest.spyOn(api, 'challenge');

  await chat.getState().decideMany([
    { id: 'a-termhub-1', decision: 'deny' },
    { id: 'a-termhub-2', decision: 'deny' },
  ]);
  expect(decideMany).toHaveBeenCalledTimes(1);
  expect(decideMany).toHaveBeenCalledWith(expect.anything(), { decisions: [{ id: 'a-termhub-1', decision: 'deny' }, { id: 'a-termhub-2', decision: 'deny' }] });
  expect(challenge).not.toHaveBeenCalled();
  expect(store.getState().pinPrompt).toBeNull();
  expect(slot(chat, 'p-termhub').actions.map((a) => a.status)).toEqual(['denied', 'denied']);
  expect(chat.getState()).toMatchObject({ decidingId: null, error: null });
});

it('decideMany of write approvals sends one batch with no PIN prompt and no proof (TER-92)', async () => {
  const { chat, store, api } = await setup();
  await openAndConnect(chat, 'p-termhub');
  const decideMany = jest.spyOn(api, 'decideMany');
  const challenge = jest.spyOn(api, 'challenge');

  await chat.getState().decideMany([
    { id: 'a-termhub-1', decision: 'approve' },
    { id: 'a-termhub-2', decision: 'deny' },
  ]);
  expect(decideMany).toHaveBeenCalledTimes(1);
  expect(decideMany).toHaveBeenCalledWith(expect.anything(), { decisions: [{ id: 'a-termhub-1', decision: 'approve' }, { id: 'a-termhub-2', decision: 'deny' }] });
  expect(challenge).not.toHaveBeenCalled();
  expect(store.getState().pinPrompt).toBeNull();
  expect(slot(chat, 'p-termhub').actions.map((a) => a.status)).toEqual(['approved', 'denied']);
  expect(chat.getState()).toMatchObject({ decidingId: null, error: null });
});

it('a PIN_REQUIRED answer to a silent batch opens the PIN sheet for every approval (TER-92)', async () => {
  const { chat, store, api } = await setup();
  await openAndConnect(chat, 'p-termhub');
  const decideMany = jest.spyOn(api, 'decideMany').mockRejectedValueOnce(new ApiError(401, 'PIN_REQUIRED', 'Confirme com o PIN para autorizar esta ação.'));

  const deciding = chat.getState().decideMany([
    { id: 'a-termhub-1', decision: 'approve' },
    { id: 'a-termhub-2', decision: 'approve' },
  ]);
  await jest.advanceTimersByTimeAsync(0);
  expect(store.getState().pinPrompt).toEqual({ actionId: 'a-termhub-1', actionIds: ['a-termhub-1', 'a-termhub-2'], decision: 'approve' });
  await store.getState().resolvePinPrompt(PIN);
  await deciding;
  expect(decideMany).toHaveBeenCalledTimes(2);
  expect(decideMany).toHaveBeenLastCalledWith(expect.anything(), {
    decisions: [
      { id: 'a-termhub-1', decision: 'approve', challenge: expect.any(String), pin_proof: expect.any(String) },
      { id: 'a-termhub-2', decision: 'approve', challenge: expect.any(String), pin_proof: expect.any(String) },
    ],
  });
  expect(slot(chat, 'p-termhub').actions.map((a) => a.status)).toEqual(['approved', 'approved']);
});

it('decideMany with an irreversible approval asks the PIN once and sends one body carrying the proofs', async () => {
  const { chat, store, api } = await setup();
  await openAndConnect(chat, 'p-termhub');
  markIrreversible(chat, 'p-termhub', 'a-termhub-1');
  const decideMany = jest.spyOn(api, 'decideMany');
  const requestPinProofs = jest.spyOn(store.getState(), 'requestPinProofs');

  const deciding = chat.getState().decideMany([
    { id: 'a-termhub-1', decision: 'approve' },
    { id: 'a-termhub-2', decision: 'deny' },
  ]);
  expect(requestPinProofs).toHaveBeenCalledWith(['a-termhub-1'], expect.any(Function), 'approve');
  expect(chat.getState().decidingId).toBe('a-termhub-1');

  // A wrong PIN stays inside the prompt; the batch stays pending.
  await store.getState().resolvePinPrompt('000000');
  expect(store.getState()).toMatchObject({ pinPrompt: { actionId: 'a-termhub-1' }, error: 'PIN incorreto.', attemptsLeft: 2 });
  expect(slot(chat, 'p-termhub').actions.map((a) => a.status)).toEqual(['pending', 'pending']);

  await store.getState().resolvePinPrompt(PIN);
  await deciding;
  expect(decideMany).toHaveBeenLastCalledWith(expect.anything(), {
    decisions: [
      { id: 'a-termhub-1', decision: 'approve', challenge: expect.any(String), pin_proof: expect.any(String) },
      { id: 'a-termhub-2', decision: 'deny' },
    ],
  });
  expect(slot(chat, 'p-termhub').actions.map((a) => a.status)).toEqual(['approved', 'denied']);
  expect(chat.getState()).toMatchObject({ decidingId: null, error: null });
});

it('decideMany: a cancelled prompt shows nothing; a 409 says so like decide', async () => {
  const { chat, store, api } = await setup();
  await openAndConnect(chat, 'p-termhub');
  markIrreversible(chat, 'p-termhub', 'a-termhub-1');
  const decideMany = jest.spyOn(api, 'decideMany');

  const deciding = chat.getState().decideMany([
    { id: 'a-termhub-1', decision: 'approve' },
    { id: 'a-termhub-2', decision: 'approve' },
  ]);
  expect(store.getState().pinPrompt).toEqual({ actionId: 'a-termhub-1', actionIds: ['a-termhub-1', 'a-termhub-2'], decision: 'approve' });
  store.getState().cancelPinPrompt();
  await deciding;
  expect(decideMany).not.toHaveBeenCalled();
  expect(chat.getState()).toMatchObject({ decidingId: null, error: null });

  await chat.getState().decide('a-termhub-1', 'deny');
  await chat.getState().decide('a-termhub-2', 'deny');
  await chat.getState().decideMany([{ id: 'a-termhub-1', decision: 'deny' }]);
  expect(chat.getState()).toMatchObject({ decidingId: null, error: 'Essa ação já foi decidida.' });
});

it('decide never moves a card backwards: a re-read that already says executed wins over the late HTTP answer', async () => {
  const { chat, api } = await setup();
  await openAndConnect(chat, 'p-termhub');
  const realDecide = api.decide.bind(api);
  jest.spyOn(api, 'decide').mockImplementation(async (auth, id, body) => {
    await realDecide(auth, id, body);
    // A re-read lands before the slow HTTP answer: the action already ran.
    const state = chat.getState();
    const slotNow = state.conversations['p-termhub']!;
    chat.setState({
      conversations: { ...state.conversations, 'p-termhub': { ...slotNow, actions: slotNow.actions.map((a) => ({ ...a, status: 'executed' as const })) } },
    });
  });

  await chat.getState().decide('a-termhub-1', 'deny');
  expect(slot(chat, 'p-termhub').actions[0]!.status).toBe('executed');
});

it('a cancelled PIN prompt leaves the card pending and shows nothing', async () => {
  const { chat, store, api } = await setup();
  await openAndConnect(chat, 'p-termhub');
  markIrreversible(chat, 'p-termhub', 'a-termhub-1');
  const decide = jest.spyOn(api, 'decide');

  const deciding = chat.getState().decide('a-termhub-1', 'approve');
  store.getState().cancelPinPrompt();
  await deciding;
  expect(decide).not.toHaveBeenCalled();
  expect(slot(chat, 'p-termhub').actions[0]!.status).toBe('pending');
  expect(chat.getState()).toMatchObject({ decidingId: null, error: null });
});

it('a decision event updates the card by id and is idempotent; a repeated confirmation adds one card', async () => {
  const { chat, handlers } = await setup();
  await openAndConnect(chat, 'p-termhub');

  handlers().onEvent(decision('c-termhub', 'a-termhub-1', 'approved'));
  handlers().onEvent(decision('c-termhub', 'a-termhub-1', 'approved'));
  expect(slot(chat, 'p-termhub').actions).toEqual([expect.objectContaining({ id: 'a-termhub-1', status: 'approved' }), expect.objectContaining({ id: 'a-termhub-2', status: 'pending' })]);

  const confirmation: TChatEvent = {
    type: 'confirmation',
    user_id: 'u1',
    conversation_id: 'c-termhub',
    action_id: 'a-new',
    tool: 'send_input',
    args: {},
    class: 'write',
    machine_id: 'm-jarvis',
    project_id: 'p-termhub',
    tab_id: 't-api',
    summary: 'digitar comando na aba api',
    created_at: new Date().toISOString(),
  };
  handlers().onEvent(confirmation);
  handlers().onEvent(confirmation);
  const actions = slot(chat, 'p-termhub').actions;
  expect(actions.filter((a) => a.id === 'a-new')).toEqual([expect.objectContaining({ status: 'pending', summary: 'digitar comando na aba api' })]);
});

it("decide(id, 'deny') needs no prompt; deciding it again is a 409 that says so", async () => {
  const { chat, store, api } = await setup();
  await openAndConnect(chat, 'p-termhub');
  const decide = jest.spyOn(api, 'decide');
  const challenge = jest.spyOn(api, 'challenge');

  await chat.getState().decide('a-termhub-1', 'deny');
  expect(decide).toHaveBeenCalledWith(expect.anything(), 'a-termhub-1', { decision: 'deny' });
  expect(challenge).not.toHaveBeenCalled();
  expect(store.getState().pinPrompt).toBeNull();
  expect(slot(chat, 'p-termhub').actions[0]!.status).toBe('denied');

  await chat.getState().decide('a-termhub-1', 'deny');
  expect(chat.getState()).toMatchObject({ decidingId: null, error: 'Essa ação já foi decidida.' });
});

it('events of another conversation never touch the open one', async () => {
  const { chat, api, handlers } = await setup();
  await openAndConnect(chat, 'p-termhub');
  const before = slot(chat, 'p-termhub');
  const liveBefore = chat.getState().live;
  const read = jest.spyOn(api, 'chat');

  handlers().onEvent({ type: 'delta', user_id: 'u1', conversation_id: 'c-opapingou', message_id: 'm1', delta: 'x' });
  handlers().onEvent(decision('c-opapingou', 'a-termhub-1', 'denied'));
  handlers().onEvent({
    type: 'message',
    user_id: 'u1',
    conversation_id: 'c-opapingou',
    message: { id: 'm2', conversation_id: 'c-opapingou', role: 'user', text: 'oi', usage: null, error_code: null, created_at: new Date().toISOString() },
  });

  // Changed on purpose (spec 2026-09-29 §5): the load closes the thread's answered rows, so the fold
  // is no longer empty; the other conversation's events still leave it as it was, object and all.
  expect(chat.getState().live).toBe(liveBefore);
  expect(chat.getState().live).toEqual({ ...emptyFold(), closed: liveBefore.closed });
  expect(slot(chat, 'p-termhub')).toBe(before);
  expect(read).not.toHaveBeenCalled();
});

it('reset empties the thread on a new conversation', async () => {
  const { chat } = await setup();
  await openAndConnect(chat, 'p-termhub');
  await chat.getState().reset();
  const s = slot(chat, 'p-termhub');
  expect(s.messages).toEqual([]);
  expect(s.conversation?.id).not.toBe('c-termhub');
});

it('openByRoute resolves a conversation id, a project id and general; anything else opens the account-wide chat with an error', async () => {
  const { chat } = await setup();
  await chat.getState().loadProjects();
  await chat.getState().openByRoute('p-opapingou');
  expect(chat.getState().activeProject).toBe('p-opapingou');

  await chat.getState().openByRoute('general');
  expect(chat.getState()).toMatchObject({ activeProject: null, error: null });

  await chat.getState().openByRoute('c-opapingou'); // loaded above: a known conversation id
  expect(chat.getState().conversationIdToProject('c-opapingou')).toBe('p-opapingou');
  expect(chat.getState().activeProject).toBe('p-opapingou');

  await chat.getState().openByRoute('c-nowhere');
  expect(chat.getState()).toMatchObject({ activeProject: null, error: 'Conversa não encontrada.' });
});

it('loadHostOptions lists the machines and setHost re-reads the account-wide chat', async () => {
  const { chat } = await setup();
  await openAndConnect(chat, null);
  await chat.getState().loadHostOptions();
  expect(chat.getState().hostOptions?.machines.map((m) => m.name)).toEqual(['jarvis', 'hulk']);

  await chat.getState().setHost('m-hulk');
  expect(slot(chat, null).host).toEqual({ kind: 'offline', machine: { id: 'm-hulk', name: 'hulk' } });
  await chat.getState().setHost('m-jarvis', 'acc-1');
  expect(slot(chat, null).host).toMatchObject({ kind: 'ready', account: { kind: 'chosen', label: 'Claude Pedro' } });
});

it('a 4400 close asks to update the app', async () => {
  const { chat, handlers } = await setup();
  await openAndConnect(chat, 'p-termhub');
  handlers().onClose(4400, true);
  expect(chat.getState()).toMatchObject({ connected: false, error: 'Atualize o app para continuar.' });
});

it('a 1008 close only marks the socket disconnected: the session is not wiped', async () => {
  const { chat, store, handlers } = await setup();
  await openAndConnect(chat, 'p-termhub');
  handlers().onClose(1008, false);
  await flush();
  expect(chat.getState()).toMatchObject({ connected: false, error: null, activeProject: 'p-termhub' });
  expect(store.getState().phase).toBe('unlocked');
});

it('a 1006 close (a refused upgrade) only marks the socket disconnected: the session is not wiped', async () => {
  const { chat, store, handlers } = await setup();
  await openAndConnect(chat, 'p-termhub');
  handlers().onClose(1006, false);
  await flush();
  expect(chat.getState()).toMatchObject({ connected: false, error: null, activeProject: 'p-termhub' });
  expect(store.getState().phase).toBe('unlocked');
});

it('a 4401 close wipes the session, and sessionEnded resets the store and closes the socket', async () => {
  const { chat, store, controls } = await setup();
  await chat.getState().loadProjects();
  await openAndConnect(chat, 'p-termhub');

  controls.revokeNow();
  await jest.advanceTimersByTimeAsync(0);
  await flush();
  expect(store.getState().phase).toBe('new');
  expect(chat.getState()).toMatchObject({ projects: [], conversations: {}, connected: false, activeProject: undefined });
  expect(chat.getState().live).toEqual(emptyFold());
});

it('persists projects and each conversation, never live or transient state', async () => {
  const { chat, api, handlers } = await setup();
  await chat.getState().loadProjects();
  await openAndConnect(chat, 'p-termhub');
  handlers().onEvent({ type: 'delta', user_id: 'u1', conversation_id: 'c-termhub', message_id: 'm-x', delta: 'meio' });
  await jest.advanceTimersByTimeAsync(PERSIST_INTERVAL_MS); // the throttled write lands

  const saved = JSON.parse(mmkv.getString('chat')!).state;
  expect(Object.keys(saved).sort()).toEqual(['conversations', 'projects']);
  expect(Object.keys(saved.conversations['p-termhub']).sort()).toEqual(['actions', 'conversation', 'grants', 'host', 'messages', 'projectGrants', 'standingGrants', 'subagents', 'tabLimits', 'tabQuestions', 'tabSuggestions']);

  // A cold start shows the thread before any fetch.
  const again = createChatStore({ api, session: () => ({ phase: 'locked', auth: () => { throw new Error('LOCKED'); }, handleApiError: () => false, requestPinProof: async () => { throw new Error('CANCELLED'); }, requestPinProofs: async () => { throw new Error('CANCELLED'); }, tokenStale: () => true, renewToken: async () => null }) });
  opened.push(again);
  expect(again.getState().projects).toHaveLength(3);
  expect(slot(again, 'p-termhub')).toMatchObject({ loaded: false, error: null, conversation: { id: 'c-termhub' } });
  expect(slot(again, 'p-termhub').messages).toHaveLength(4);
  expect(again.getState().live).toEqual(emptyFold());
});

it('subscribeEvents delivers every raw event, of any conversation, ahead of the open one\'s filter; unsubscribe stops it', async () => {
  const { chat, handlers } = await setup();
  await openAndConnect(chat, 'p-termhub');

  const seen: TChatEvent[] = [];
  const unsubscribe = chat.getState().subscribeEvents((e) => seen.push(e));

  handlers().onEvent(decision('c-opapingou', 'a-x', 'approved')); // belongs to another conversation
  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({ type: 'decision', conversation_id: 'c-opapingou' });

  unsubscribe();
  handlers().onEvent(decision('c-opapingou', 'a-y', 'denied'));
  expect(seen).toHaveLength(1); // no more events after unsubscribing
});

it('refresh(projectId) re-reads that slot without switching activeProject, touching live, or opening a socket', async () => {
  const { chat, api, events } = await setup();
  await openAndConnect(chat, 'p-termhub');
  const liveBefore = chat.getState().live;
  const socketCallsBefore = events.mock.calls.length;
  const read = jest.spyOn(api, 'chat');

  await chat.getState().refresh(null);

  expect(read).toHaveBeenCalledWith(expect.anything(), null);
  expect(chat.getState().activeProject).toBe('p-termhub'); // untouched
  expect(chat.getState().live).toBe(liveBefore); // untouched
  expect(events.mock.calls).toHaveLength(socketCallsBefore); // no new socket connection
  expect(slot(chat, null)).toMatchObject({ loaded: true, error: null, conversation: { id: 'c-general' } });
  expect(slot(chat, null).host).toMatchObject({ kind: 'ready', machine: { name: 'jarvis' } });
});

it('answerTabQuestion answers over the mock and the card turns answered; a second answer says nothing was sent', async () => {
  const { chat } = await setup();
  await openAndConnect(chat, 'p-termhub');
  await chat.getState().send('tem alguma pergunta?');
  await jest.advanceTimersByTimeAsync(5000);
  const q = slot(chat, 'p-termhub').tabQuestions.find((x) => x.status === 'open')!;
  expect(q).toMatchObject({ kind: 'choice', tab_name: 'api' });

  await chat.getState().answerTabQuestion(q.id, { answers: [{ selected: [0] }] });
  await jest.advanceTimersByTimeAsync(0);
  await flush();
  expect(slot(chat, 'p-termhub').tabQuestions.find((x) => x.id === q.id)?.status).toBe('answered');
  expect(chat.getState().answeringQuestionIds).toEqual([]);

  await chat.getState().answerTabQuestion(q.id, { answers: [{ selected: [0] }] });
  // A stale card says so in the card, not in the screen's banner (spec 2026-09-26 §4.13).
  expect(chat.getState().questionErrors[q.id]).toBe('A aba já não mostra esta pergunta: nada foi enviado.');
  expect(chat.getState().error).toBeNull();
});

describe('cancelAutoAnswer (concierge memory spec 2026-09-26 §6)', () => {
  it('replaces the question in the store with the API response, and clears the busy flag', async () => {
    const { chat, api } = await setup();
    await openAndConnect(chat, 'p-termhub');
    await chat.getState().send('tem alguma pergunta?');
    await jest.advanceTimersByTimeAsync(5000);
    const q = slot(chat, 'p-termhub').tabQuestions.find((x) => x.status === 'open')!;
    const cancelled = { ...q, auto_answer: { answer: { answers: [{ selected: [0] }] }, by: 'memory', reason: 'x', sources: [], due_at: '2026-09-24T12:00:42.000Z', status: 'cancelled' } };
    jest.spyOn(api, 'cancelAutoAnswer').mockResolvedValueOnce({ tab_question: cancelled });

    await chat.getState().cancelAutoAnswer(q.id);

    expect(slot(chat, 'p-termhub').tabQuestions.find((x) => x.id === q.id)).toEqual(cancelled);
    expect(chat.getState().answeringQuestionIds).toEqual([]);
    expect(chat.getState().questionErrors).toEqual({});
  });

  it('409 NOT_SCHEDULED reads as its own sentence, on the card, not the banner', async () => {
    const { chat, api } = await setup();
    await openAndConnect(chat, 'p-termhub');
    jest.spyOn(api, 'cancelAutoAnswer').mockRejectedValueOnce(new ApiError(409, 'NOT_SCHEDULED', 'Não há resposta automática em contagem nesta pergunta'));

    await chat.getState().cancelAutoAnswer('q1');

    expect(chat.getState().questionErrors).toEqual({ q1: 'A resposta automática já foi enviada.' });
    expect(chat.getState().error).toBeNull();
  });

  it('any other failure shows the server\'s own message', async () => {
    const { chat, api } = await setup();
    await openAndConnect(chat, 'p-termhub');
    jest.spyOn(api, 'cancelAutoAnswer').mockRejectedValueOnce(new ApiError(404, 'NOT_FOUND', 'Pergunta não encontrada'));

    await chat.getState().cancelAutoAnswer('q1');

    expect(chat.getState().questionErrors).toEqual({ q1: 'Pergunta não encontrada' });
  });
});

it('loadTabQuestionScreen answers the excerpt while open, null once it is not', async () => {
  const { chat } = await setup();
  await openAndConnect(chat, 'p-termhub');
  await chat.getState().send('preciso da sua permissão');
  await jest.advanceTimersByTimeAsync(5000);
  const q = slot(chat, 'p-termhub').tabQuestions.find((x) => x.kind === 'permission')!;
  expect(await chat.getState().loadTabQuestionScreen(q.id)).toContain('Do you want to proceed?');
  await chat.getState().answerTabQuestion(q.id, { allow: true });
  expect(await chat.getState().loadTabQuestionScreen(q.id)).toBeNull();
});

it('keeps the tab questions of a slot across a restart (persisted with the thread)', async () => {
  const { chat } = await setup();
  await openAndConnect(chat, 'p-termhub');
  await chat.getState().send('tem alguma pergunta?');
  await jest.advanceTimersByTimeAsync(5000);
  const saved = JSON.parse(mmkv.getString('chat')!).state as { conversations: Record<string, { tabQuestions?: unknown[] }> };
  expect(saved.conversations['p-termhub']!.tabQuestions!.length).toBeGreaterThan(0);
});

it('sendTabSuggestion sends over the mock and the card reads as sent; a second send reads "A sugestão mudou na aba"', async () => {
  const { chat } = await setup();
  await openAndConnect(chat, 'p-termhub');
  await chat.getState().send('alguma sugestão?');
  await jest.advanceTimersByTimeAsync(5000);
  const s = slot(chat, 'p-termhub').tabSuggestions.find((x) => x.status === 'open')!;
  expect(s).toMatchObject({ kind: 'suggestion', tab_name: 'api', payload: { text: 'commit it' } });
  expect(s.payload.context).toBe('Criei o arquivo notes.txt com a linha hello.\n\nQuer que eu faça o commit?');

  await chat.getState().sendTabSuggestion(s.id, 'commit it and push');
  await jest.advanceTimersByTimeAsync(0);
  await flush();
  expect(slot(chat, 'p-termhub').tabSuggestions.find((x) => x.id === s.id)).toMatchObject({ status: 'answered', answer: { text: 'commit it and push' } });
  expect(chat.getState().busySuggestionIds).toEqual([]);

  await chat.getState().sendTabSuggestion(s.id, 'commit it');
  expect(chat.getState().suggestionErrors[s.id]).toBe('A sugestão mudou na aba');
  expect(chat.getState().error).toBeNull();
});

it('dismissTabSuggestion closes the card as dismissed', async () => {
  const { chat } = await setup();
  await openAndConnect(chat, 'p-termhub');
  await chat.getState().send('alguma sugestão?');
  await jest.advanceTimersByTimeAsync(5000);
  const s = slot(chat, 'p-termhub').tabSuggestions.find((x) => x.status === 'open')!;
  await chat.getState().dismissTabSuggestion(s.id);
  await jest.advanceTimersByTimeAsync(0);
  await flush();
  expect(slot(chat, 'p-termhub').tabSuggestions.find((x) => x.id === s.id)?.status).toBe('dismissed');
});

it('a failed answer is that card\'s error, never the banner; trying again clears it (spec 2026-09-26 §4.13)', async () => {
  const { chat, api } = await setup();
  await openAndConnect(chat, 'p-termhub');
  const call = jest.spyOn(api, 'answerTabQuestion').mockRejectedValueOnce(new ApiError(409, 'TAB_PROMPT_CHANGED', 'A pergunta mudou na aba'));
  await chat.getState().answerTabQuestion('q1', { allow: true });
  call.mockRejectedValueOnce(new ApiError(502, 'MACHINE_OFFLINE', 'Não foi possível responder na aba'));
  await chat.getState().answerTabQuestion('q2', { allow: true });
  expect(chat.getState().questionErrors).toEqual({ q1: 'A aba já não mostra esta pergunta: nada foi enviado.', q2: 'Não foi possível responder na aba' });
  expect(chat.getState().error).toBeNull();
  call.mockResolvedValueOnce(undefined);
  await chat.getState().answerTabQuestion('q1', { allow: true });
  expect(chat.getState().questionErrors).toEqual({ q2: 'Não foi possível responder na aba' });
});

it('two different cards can be answered at once; the same card is never sent twice', async () => {
  const { chat, api } = await setup();
  await openAndConnect(chat, 'p-termhub');
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const call = jest.spyOn(api, 'answerTabQuestion').mockImplementation(() => gate);
  const a = chat.getState().answerTabQuestion('q1', { allow: true });
  const b = chat.getState().answerTabQuestion('q2', { allow: true });
  const again = chat.getState().answerTabQuestion('q1', { allow: false });
  expect(chat.getState().answeringQuestionIds).toEqual(['q1', 'q2']);
  expect(call).toHaveBeenCalledTimes(2);
  release();
  await Promise.all([a, b, again]);
  expect(chat.getState().answeringQuestionIds).toEqual([]);
});

it('suggestions too: per card busy, per card error', async () => {
  const { chat, api } = await setup();
  await openAndConnect(chat, 'p-termhub');
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const send = jest.spyOn(api, 'sendTabSuggestion').mockImplementation(() => gate);
  jest.spyOn(api, 'dismissTabSuggestion').mockRejectedValueOnce(new ApiError(409, 'TAB_PROMPT_CHANGED', 'A sugestão mudou na aba'));
  const sending = chat.getState().sendTabSuggestion('s1', 'commit it');
  expect(chat.getState().busySuggestionIds).toEqual(['s1']);
  await chat.getState().sendTabSuggestion('s1', 'commit it'); // the same card: ignored
  expect(send).toHaveBeenCalledTimes(1);
  await chat.getState().dismissTabSuggestion('s2'); // another card: goes through
  expect(chat.getState().suggestionErrors).toEqual({ s2: 'A sugestão mudou na aba' });
  release();
  await sending;
  expect(chat.getState().busySuggestionIds).toEqual([]);
  expect(chat.getState().error).toBeNull();
});

it('answerTabLimit swaps over the mock: the card arrives, then reads as swapped; a second answer is that card\'s error (TER-589)', async () => {
  const { chat } = await setup();
  await openAndConnect(chat, 'p-termhub');
  await chat.getState().send('bateu o limite?');
  await jest.advanceTimersByTimeAsync(5000);
  const l = slot(chat, 'p-termhub').tabLimits.find((x) => x.status === 'open')!;
  expect(l).toMatchObject({ tab_name: 'api', payload: { account: { label: 'Claude Pedro' }, candidates: [{ id: 'acc-2', label: 'Claude Trabalho' }] } });

  await chat.getState().answerTabLimit(l.id, 'acc-2');
  await jest.advanceTimersByTimeAsync(0);
  await flush();
  expect(slot(chat, 'p-termhub').tabLimits.find((x) => x.id === l.id)).toMatchObject({ status: 'swapped', result: 'acc-2' });
  expect(chat.getState().busyLimitIds).toEqual([]);

  await chat.getState().answerTabLimit(l.id, null);
  expect(chat.getState().limitErrors[l.id]).toBe('Este aviso já foi respondido ou expirou');
  expect(chat.getState().error).toBeNull();
});

it('usage-limit cards: per card busy, a failed swap keeps the card open with its error, a later try clears it', async () => {
  const { chat, api } = await setup();
  await openAndConnect(chat, 'p-termhub');
  let release!: () => void;
  const gate = new Promise<never>((_resolve, reject) => (release = () => reject(new ApiError(409, 'CONFLICT', 'A máquina jarvis está offline'))));
  const answer = jest.spyOn(api, 'answerTabLimit').mockImplementation(() => gate);
  const swapping = chat.getState().answerTabLimit('l1', 'acc-2');
  expect(chat.getState().busyLimitIds).toEqual(['l1']);
  await chat.getState().answerTabLimit('l1', null); // the same card: ignored
  expect(answer).toHaveBeenCalledTimes(1);
  release();
  await swapping;
  expect(chat.getState().busyLimitIds).toEqual([]);
  expect(chat.getState().limitErrors).toEqual({ l1: 'A máquina jarvis está offline' });
  expect(chat.getState().error).toBeNull();

  answer.mockRejectedValueOnce(new Error('network down'));
  await chat.getState().answerTabLimit('l2', null);
  expect(chat.getState().limitErrors.l2).toBe('Não foi possível falar com o servidor. Tente de novo.');
});

it('GET chat fills subagents; a message that starts one is reflected there too (spec 2026-09-26 panel §4)', async () => {
  const { chat } = await setup();
  await openAndConnect(chat, 'p-termhub');
  expect(slot(chat, 'p-termhub').subagents).toEqual([]);

  await chat.getState().send('chame uma subagente para isso');
  await jest.advanceTimersByTimeAsync(5000);
  expect(slot(chat, 'p-termhub').subagents).toEqual([expect.objectContaining({ status: 'running' })]);

  // A fresh GET (a re-open) still lists it: the server's `subagents` array, not only the live event.
  await chat.getState().refresh('p-termhub');
  expect(slot(chat, 'p-termhub').subagents).toEqual([expect.objectContaining({ status: 'running' })]);
});

it("cancelSubagent calls the client; the row turns stopping right away and stopped once the mock's cancel settles", async () => {
  const { chat, api } = await setup();
  await openAndConnect(chat, 'p-termhub');
  await chat.getState().send('chame uma subagente para isso');
  await jest.advanceTimersByTimeAsync(5000);
  const sub = slot(chat, 'p-termhub').subagents[0]!;
  const cancel = jest.spyOn(api, 'cancelSubagent');

  await chat.getState().cancelSubagent(sub.id);
  expect(cancel).toHaveBeenCalledWith(expect.anything(), sub.id);
  expect(slot(chat, 'p-termhub').subagents[0]!.status).toBe('stopping');

  await jest.advanceTimersByTimeAsync(5000);
  expect(slot(chat, 'p-termhub').subagents[0]!.status).toBe('stopped');
});

it('a non-409 cancel failure marks the row cancelFailed, never the banner; a 409 (already at rest) reloads instead', async () => {
  const { chat, api } = await setup();
  await openAndConnect(chat, 'p-termhub');
  await chat.getState().send('chame uma subagente para isso');
  await jest.advanceTimersByTimeAsync(5000);
  const sub = slot(chat, 'p-termhub').subagents[0]!;

  jest.spyOn(api, 'cancelSubagent').mockRejectedValueOnce(new ApiError(500, 'INTERNAL', 'Falhou.'));
  await chat.getState().cancelSubagent(sub.id);
  expect(slot(chat, 'p-termhub').cancelFailed).toEqual([sub.id]);
  expect(chat.getState().error).toBeNull();

  const read = jest.spyOn(api, 'chat');
  jest.spyOn(api, 'cancelSubagent').mockRejectedValueOnce(new ApiError(409, 'SUBAGENT_NOT_RUNNING', 'Este subagente não está rodando.'));
  await chat.getState().cancelSubagent(sub.id);
  expect(read).toHaveBeenCalled();
  // The stale mark survives the reread: nothing published a fresh `subagent` event for this click.
  expect(slot(chat, 'p-termhub').cancelFailed).toEqual([sub.id]);
});

it('keeps the subagents of a slot across a restart (persisted with the thread)', async () => {
  const { chat } = await setup();
  await openAndConnect(chat, 'p-termhub');
  await chat.getState().send('chame uma subagente para isso');
  await jest.advanceTimersByTimeAsync(5000);
  const saved = JSON.parse(mmkv.getString('chat')!).state as { conversations: Record<string, { subagents?: unknown[] }> };
  expect(saved.conversations['p-termhub']!.subagents!.length).toBe(1);
});

it('a delta is one set and no MMKV write; the persisted slice lands within 2 s, once, without live', async () => {
  const { chat, handlers } = await setup();
  await openAndConnect(chat, 'p-termhub');
  await jest.advanceTimersByTimeAsync(PERSIST_INTERVAL_MS); // the open's own writes
  const writes = jest.spyOn(mmkv, 'set');
  const chatWrites = () => writes.mock.calls.filter(([name]) => name === 'chat');
  const sets = jest.fn();
  const unsubscribe = chat.subscribe(sets);
  const slotBefore = slot(chat, 'p-termhub');

  for (let i = 0; i < 20; i++) handlers().onEvent({ type: 'delta', user_id: 'u1', conversation_id: 'c-termhub', message_id: 'm-x', delta: `t${i}` });
  unsubscribe();
  expect(sets).toHaveBeenCalledTimes(20);
  expect(chatWrites()).toHaveLength(0);
  // A delta touches `live` alone: the slot (and every row in it) keeps its reference.
  expect(slot(chat, 'p-termhub')).toBe(slotBefore);

  await jest.advanceTimersByTimeAsync(PERSIST_INTERVAL_MS);
  expect(chatWrites()).toHaveLength(1);
  const saved = JSON.parse(mmkv.getString('chat')!).state;
  expect(Object.keys(saved).sort()).toEqual(['conversations', 'projects']);
});

it('run_finished and the app going to the background flush the persisted slice at once', async () => {
  const { chat, handlers } = await setup();
  await openAndConnect(chat, 'p-termhub');
  await jest.advanceTimersByTimeAsync(PERSIST_INTERVAL_MS);
  const writes = jest.spyOn(mmkv, 'set');
  const chatWrites = () => writes.mock.calls.filter(([name]) => name === 'chat');

  handlers().onEvent({ type: 'delta', user_id: 'u1', conversation_id: 'c-termhub', message_id: 'm-x', delta: 'a' });
  handlers().onEvent({ type: 'run_finished', user_id: 'u1', conversation_id: 'c-termhub', message_id: 'm-x', ok: true, error_code: null });
  expect(chatWrites()).toHaveLength(1);

  handlers().onEvent({ type: 'delta', user_id: 'u1', conversation_id: 'c-termhub', message_id: 'm-y', delta: 'b' });
  appBackgrounded.emit();
  expect(chatWrites()).toHaveLength(2);
});

describe('attachments', () => {
  const attachment = { id: 'att1', name: 'relatorio.pdf', mime: 'application/pdf', kind: 'pdf' as const, bytes: 10, status: 'ready' as const, error_code: null, meta: null, created_at: '2026-09-26T00:00:00.000Z' };

  it('send posts the attachment ids, lets the text be empty, and shows them on the optimistic row', async () => {
    const { chat, api } = await setup();
    await openAndConnect(chat, 'p-termhub');
    // A real upload into the mock: the mock's send refuses an id it does not know (409).
    const uploaded = await chat.getState().uploadAttachment({ uri: 'file:///tmp/relatorio.pdf', name: 'relatorio.pdf', mime: 'application/pdf', bytes: 10 }, () => undefined);
    const send = jest.spyOn(api, 'sendMessage');
    const sending = chat.getState().send('', [uploaded]);
    expect(slot(chat, 'p-termhub').messages.at(-1)).toMatchObject({ role: 'user', text: '', local: 'sending', attachments: [uploaded] });
    expect(await sending).toBe(true);
    expect(send).toHaveBeenCalledWith(expect.anything(), { text: '', project_id: 'p-termhub', attachment_ids: [uploaded.id] });
    expect(slot(chat, 'p-termhub').messages.at(-1)).toMatchObject({ role: 'user', text: '', attachments: [uploaded] });
    expect(slot(chat, 'p-termhub').messages.at(-1)!.local).toBeUndefined();
  });

  it('send refuses a message with neither text nor attachments', async () => {
    const { chat, api } = await setup();
    await openAndConnect(chat, 'p-termhub');
    const send = jest.spyOn(api, 'sendMessage');
    expect(await chat.getState().send('   ', [])).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('uploadAttachment and deleteAttachment go to the api for the open conversation; a 404 or 409 on delete is swallowed', async () => {
    const { chat, api } = await setup();
    await openAndConnect(chat, 'p-termhub');
    const upload = jest.spyOn(api, 'uploadAttachment').mockResolvedValue(attachment);
    const remove = jest.spyOn(api, 'deleteAttachment').mockResolvedValue(undefined);
    const progress = jest.fn();
    await expect(chat.getState().uploadAttachment({ uri: 'file:///x', name: 'relatorio.pdf', mime: 'application/pdf', bytes: 10 }, progress)).resolves.toEqual(attachment);
    expect(upload).toHaveBeenCalledWith(expect.anything(), { uri: 'file:///x', name: 'relatorio.pdf', mime: 'application/pdf', bytes: 10 }, 'p-termhub', progress);
    await chat.getState().deleteAttachment('att1');
    expect(remove).toHaveBeenCalledWith(expect.anything(), 'att1');

    remove.mockRejectedValueOnce(new ApiError(404, 'NOT_FOUND', 'Anexo não encontrado.'));
    await expect(chat.getState().deleteAttachment('att1')).resolves.toBeUndefined();
    remove.mockRejectedValueOnce(new ApiError(409, 'CONFLICT', 'Este anexo já foi enviado'));
    await expect(chat.getState().deleteAttachment('att1')).resolves.toBeUndefined();
    remove.mockRejectedValueOnce(new ApiError(500, 'INTERNAL', 'x'));
    await expect(chat.getState().deleteAttachment('att1')).rejects.toMatchObject({ status: 500 });
  });

  it('attachment_status of the open conversation is kept by id for the composer chips; another conversation is ignored; open and close start over', async () => {
    const { chat, handlers } = await setup();
    await openAndConnect(chat, 'p-termhub');
    expect(chat.getState().attachmentStatuses).toEqual({});
    const heard = { ...attachment, status: 'failed' as const, error_code: 'ATTACHMENT_INVALID' };
    handlers().onEvent({ type: 'attachment_status', user_id: 'u1', conversation_id: 'c-termhub', attachment: heard });
    handlers().onEvent({ type: 'attachment_status', user_id: 'u1', conversation_id: 'c-opapingou', attachment: { ...attachment, id: 'elsewhere' } });
    expect(chat.getState().attachmentStatuses).toEqual({ att1: heard });
    handlers().onEvent({ type: 'attachment_status', user_id: 'u1', conversation_id: 'c-termhub', attachment: { ...heard, status: 'ready', error_code: null } });
    expect(chat.getState().attachmentStatuses.att1).toMatchObject({ status: 'ready' });

    await openAndConnect(chat, 'p-opapingou');
    expect(chat.getState().attachmentStatuses).toEqual({});
    handlers().onEvent({ type: 'attachment_status', user_id: 'u1', conversation_id: 'c-opapingou', attachment: heard });
    expect(chat.getState().attachmentStatuses).toEqual({ att1: heard });
    chat.getState().close();
    expect(chat.getState().attachmentStatuses).toEqual({});
  });

  it('attachmentSource signs the download url for the open session', async () => {
    const { chat } = await setup();
    await openAndConnect(chat, 'p-termhub');
    const source = await chat.getState().attachmentSource('att1');
    expect(source.uri).toBe('https://termhub.dev/api/m/v1/chat/attachments/att1');
    expect(source.headers.Authorization).toMatch(/^Bearer /);
    expect(source.headers.DPoP).toBeTruthy();
  });

  it('attachmentSource renews a stale token first and signs with the new one', async () => {
    const { chat, store } = await setup();
    await openAndConnect(chat, 'p-termhub');
    const state = store.getState();
    jest.spyOn(state, 'tokenStale').mockReturnValue(true);
    const renew = jest.spyOn(state, 'renewToken');
    const pending = chat.getState().attachmentSource('att1');
    await jest.advanceTimersByTimeAsync(0);
    const source = await pending;
    expect(renew).toHaveBeenCalledTimes(1);
    const fresh = await renew.mock.results[0]!.value;
    expect(fresh).toBeTruthy();
    expect(source.headers.Authorization).toBe(`Bearer ${fresh}`);
  });

  it('attachmentSource does not renew a fresh token', async () => {
    const { chat, store } = await setup();
    await openAndConnect(chat, 'p-termhub');
    const renew = jest.spyOn(store.getState(), 'renewToken');
    await chat.getState().attachmentSource('att1');
    expect(renew).not.toHaveBeenCalled();
  });

  it('thumbnails appearing together with a stale token share one renewal', async () => {
    const { chat, store, api } = await setup();
    await openAndConnect(chat, 'p-termhub');
    jest.spyOn(store.getState(), 'tokenStale').mockReturnValue(true);
    const token = jest.spyOn(api, 'token');
    const all = Promise.all(['a1', 'a2', 'a3'].map((id) => chat.getState().attachmentSource(id)));
    await jest.advanceTimersByTimeAsync(0);
    await all;
    expect(token).toHaveBeenCalledTimes(1);
  });
});

it('forgetDecision(decisionId) calls DELETE over the mock; a repeat or an unknown id is still fine (the server is idempotent)', async () => {
  const { chat, api } = await setup();
  const spy = jest.spyOn(api, 'forgetChatDecision');
  await chat.getState().forgetDecision('d-worktree'); // one of the seeded fixtures
  expect(spy).toHaveBeenCalledWith(expect.anything(), 'd-worktree');
  await chat.getState().forgetDecision('d-worktree'); // already gone
  await chat.getState().forgetDecision('nope'); // never existed
  expect(chat.getState().error).toBeNull();
});

it('forgetDecision surfaces "Não foi possível esquecer a decisão" on a non-session failure (the card already cleared itself optimistically)', async () => {
  const { chat, api } = await setup();
  jest.spyOn(api, 'forgetChatDecision').mockRejectedValueOnce(new ApiError(500, 'INTERNAL_ERROR', 'Erro interno do servidor'));
  await chat.getState().forgetDecision('d-worktree');
  expect(chat.getState().error).toBe('Não foi possível esquecer a decisão');
});

describe('run state (spec 2026-09-29 §5)', () => {
  const answer = (id: string, text = ''): TChatMessage => ({ id, conversation_id: 'c-termhub', role: 'assistant', text, usage: null, error_code: null, created_at: new Date().toISOString() });

  /** `api.chat` for p-termhub with `patch` applied to the mock's answer; the other slots answer as they are. */
  function serve(api: ReturnType<typeof setupSession>['api'], patch: (res: Awaited<ReturnType<typeof api.chat>>) => Awaited<ReturnType<typeof api.chat>>) {
    const real = api.chat.bind(api);
    return jest.spyOn(api, 'chat').mockImplementation(async (auth, projectId) => {
      const res = await real(auth, projectId);
      return projectId === 'p-termhub' ? patch(res) : res;
    });
  }

  it('a refresh marks the rows the server lists as open', async () => {
    const { chat, api } = await setup();
    await openAndConnect(chat, 'p-termhub');
    serve(api, (res) => ({ ...res, messages: [...res.messages, answer('a1')], open_answer_ids: ['a1'] }));

    await chat.getState().refresh('p-termhub');
    expect(slot(chat, 'p-termhub').messages.at(-1)?.id).toBe('a1');
    expect(chat.getState().live.started.has('a1')).toBe(true);
  });

  it('a refresh against a server that sends no open_answer_ids marks nothing, and still closes what the snapshot shows answered', async () => {
    const { chat, api } = await setup();
    await openAndConnect(chat, 'p-termhub');
    const answered = slot(chat, 'p-termhub').messages.find((m) => m.role === 'assistant' && m.text)!;
    expect(answered).toBeDefined();
    chat.setState({ live: emptyFold() }); // forget what the first read closed: this read must close it again
    // The path an older server takes: its JSON has no `open_answer_ids`, and the contract fills the default.
    serve(api, (res) => {
      const { open_answer_ids: _ids, ...older } = res;
      return chatResponse.parse({ ...older, messages: [...res.messages, answer('a1')] });
    });

    await chat.getState().refresh('p-termhub');
    expect(slot(chat, 'p-termhub').error).toBeNull();
    expect(slot(chat, 'p-termhub').messages.at(-1)?.id).toBe('a1');
    expect(chat.getState().live.started.size).toBe(0);
    expect(chat.getState().live.closed.has(answered.id)).toBe(true);
  });

  it('a refresh of another conversation starts from an empty fold, then seeds', async () => {
    const { chat, api, handlers } = await setup();
    await openAndConnect(chat, 'p-termhub');
    handlers().onEvent({ type: 'delta', user_id: 'u1', conversation_id: 'c-termhub', message_id: 'm-x', delta: 'meio' });
    handlers().onEvent({ type: 'message_removed', user_id: 'u1', conversation_id: 'c-termhub', message_id: 'a2' });
    expect(chat.getState().live.removed.has('a2')).toBe(true);
    // A reset elsewhere: the next read is another conversation, which happens to reuse nothing.
    serve(api, (res) => ({ ...res, conversation: { ...res.conversation, id: 'c-termhub-2' }, messages: [{ ...answer('a2'), conversation_id: 'c-termhub-2' }], open_answer_ids: ['a2'] }));

    await chat.getState().refresh('p-termhub');
    const { live } = chat.getState();
    expect(live.deltas.size).toBe(0);
    expect(live.removed.size).toBe(0);
    expect(live.closed.size).toBe(0);
    expect([...live.started]).toEqual(['a2']);
    expect(slot(chat, 'p-termhub').messages.map((m) => m.id)).toEqual(['a2']);
  });

  it('a row that ended while the refresh was in flight stays final', async () => {
    const { chat, api, handlers } = await setup();
    await openAndConnect(chat, 'p-termhub');
    handlers().onEvent({ type: 'message', user_id: 'u1', conversation_id: 'c-termhub', message: answer('a1') });
    expect(chat.getState().live.started.has('a1')).toBe(true);

    const real = api.chat.bind(api);
    let release!: () => void;
    jest.spyOn(api, 'chat').mockImplementation(async (auth, projectId) => {
      const res = await real(auth, projectId);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      // The snapshot was taken before the answer ended: `a1` is still empty, and listed as open.
      return { ...res, messages: [...res.messages, answer('a1')], open_answer_ids: ['a1'] };
    });
    const refreshing = chat.getState().refresh('p-termhub');
    await flush();
    handlers().onEvent({ type: 'message', user_id: 'u1', conversation_id: 'c-termhub', message: answer('a1', 'pronto') });

    release();
    await refreshing;
    expect(slot(chat, 'p-termhub').messages.find((m) => m.id === 'a1')?.text).toBe('pronto');
    expect(chat.getState().live.started.has('a1')).toBe(false);
  });

  it('a removed row leaves the thread and a later snapshot does not bring it back', async () => {
    const { chat, api, handlers } = await setup();
    await openAndConnect(chat, 'p-termhub');
    handlers().onEvent({ type: 'message', user_id: 'u1', conversation_id: 'c-termhub', message: answer('a1') });
    expect(slot(chat, 'p-termhub').messages.some((m) => m.id === 'a1')).toBe(true);

    handlers().onEvent({ type: 'message_removed', user_id: 'u1', conversation_id: 'c-termhub', message_id: 'a1' });
    expect(slot(chat, 'p-termhub').messages.some((m) => m.id === 'a1')).toBe(false);
    expect(chat.getState().live.started.has('a1')).toBe(false);

    // A snapshot older than the deletion still lists the row, open.
    serve(api, (res) => ({ ...res, messages: [...res.messages, answer('a1')], open_answer_ids: ['a1'] }));
    await chat.getState().refresh('p-termhub');
    expect(slot(chat, 'p-termhub').messages.some((m) => m.id === 'a1')).toBe(false);
    expect(chat.getState().live.started.has('a1')).toBe(false);
  });

  it('a row the snapshot lacks, whose event did not arrive during the read, leaves the thread and is closed', async () => {
    const { chat, api, handlers } = await setup();
    await openAndConnect(chat, 'p-termhub');
    // Announced, then deleted while the socket was down: its `message_removed` never reached the phone.
    handlers().onEvent({ type: 'message', user_id: 'u1', conversation_id: 'c-termhub', message: answer('a1') });
    expect(chat.getState().live.started.has('a1')).toBe(true);

    const read = jest.spyOn(api, 'chat');
    await chat.getState().refresh('p-termhub');
    expect(read).toHaveBeenCalled();
    expect(slot(chat, 'p-termhub').messages.some((m) => m.id === 'a1')).toBe(false);
    expect(chat.getState().live.started.has('a1')).toBe(false);
    expect(chat.getState().live.closed.has('a1')).toBe(true);
  });

  it('a row the server accepted (its 202) while a read was in flight survives that read', async () => {
    const { chat, api } = await setup();
    await openAndConnect(chat, 'p-termhub');
    const real = api.chat.bind(api);
    let release!: () => void;
    jest.spyOn(api, 'chat').mockImplementation(async (auth, projectId) => {
      const res = await real(auth, projectId);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      // The snapshot was taken before the send: it does not have the person's row.
      return { ...res, messages: res.messages.filter((m) => m.id !== 'u-new') };
    });
    jest.spyOn(api, 'sendMessage').mockResolvedValueOnce({ conversation_id: 'c-termhub', user_message_id: 'u-new', assistant_message_id: 'a-new' } as never);
    const refreshing = chat.getState().refresh('p-termhub');
    await flush();
    await chat.getState().send('oi de novo');
    expect(slot(chat, 'p-termhub').messages.at(-1)).toMatchObject({ id: 'u-new', text: 'oi de novo' });

    release();
    await refreshing;
    expect(slot(chat, 'p-termhub').messages.some((m) => m.id === 'u-new')).toBe(true);
  });

  it('a run that could not start refreshes the conversation and says so', async () => {
    const { chat, api, handlers } = await setup();
    await openAndConnect(chat, 'p-termhub');
    const read = jest.spyOn(api, 'chat');

    handlers().onEvent({ type: 'run_finished', user_id: 'u1', conversation_id: 'c-opapingou', message_id: null, ok: false, error_code: 'SETUP_FAILED' });
    await flush();
    expect(read).not.toHaveBeenCalled();
    expect(chat.getState().error).toBeNull();

    handlers().onEvent({ type: 'run_finished', user_id: 'u1', conversation_id: 'c-termhub', message_id: null, ok: false, error_code: 'SETUP_FAILED' });
    await flush();
    await flush();
    expect(read).toHaveBeenCalledWith(expect.anything(), 'p-termhub');
    expect(chat.getState().error).toBe('O concierge não conseguiu começar a resposta. Tente de novo.');
  });

  it('the line of a run that could not start stays on its conversation: another project opened before the read resolves shows nothing', async () => {
    const { chat, api, handlers } = await setup();
    await openAndConnect(chat, 'p-termhub');
    const real = api.chat.bind(api);
    let release!: () => void;
    jest.spyOn(api, 'chat').mockImplementation(async (auth, projectId) => {
      const res = await real(auth, projectId);
      if (projectId === 'p-termhub') {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return res;
    });

    handlers().onEvent({ type: 'run_finished', user_id: 'u1', conversation_id: 'c-termhub', message_id: null, ok: false, error_code: 'SETUP_FAILED' });
    await flush();
    await chat.getState().open('p-opapingou');
    release();
    await flush();
    await flush();
    expect(chat.getState().activeProject).toBe('p-opapingou');
    expect(chat.getState().error).toBeNull();
  });

  it('events that arrive before the first read gives the slot its conversation are held and replayed after it', async () => {
    const { chat, api, handlers } = await setup();
    const real = api.chat.bind(api);
    // The open's read and the one the socket's first connect starts: both are held, then both let go.
    const held: (() => void)[] = [];
    const release = () => held.splice(0).forEach((resolve) => resolve());
    let snapshotTaken = false;
    jest.spyOn(api, 'chat').mockImplementation(async (auth, projectId) => {
      const res = await real(auth, projectId);
      snapshotTaken = true;
      await new Promise<void>((resolve) => held.push(resolve));
      // Taken before the answer ended: `a1` is still empty, and listed as open.
      return { ...res, messages: [...res.messages, answer('a1')], open_answer_ids: ['a1'] };
    });

    const opening = chat.getState().open('p-termhub');
    await jest.advanceTimersByTimeAsync(0); // the socket connects
    await flush();
    expect(snapshotTaken).toBe(true);
    expect(slot(chat, 'p-termhub').conversation).toBeNull();
    handlers().onEvent({ type: 'delta', user_id: 'u1', conversation_id: 'c-termhub', message_id: 'a1', delta: 'pro' });
    handlers().onEvent({ type: 'message', user_id: 'u1', conversation_id: 'c-termhub', message: answer('a1', 'pronto') });
    handlers().onEvent({ type: 'delta', user_id: 'u1', conversation_id: 'c-opapingou', message_id: 'o1', delta: 'x' });

    release();
    await opening;
    expect(slot(chat, 'p-termhub').messages.find((m) => m.id === 'a1')?.text).toBe('pronto');
    expect(chat.getState().live.started.has('a1')).toBe(false);
    expect(chat.getState().live.deltas.size).toBe(0);
  });
});

describe('replies (TER-447)', () => {
  it('send carries the reference: on the optimistic row, in the body, and on the stored message', async () => {
    const { chat, api } = await setup();
    await openAndConnect(chat, 'p-termhub');
    const original = slot(chat, 'p-termhub').messages.find((m) => m.role === 'assistant' && m.text)!;
    const ref = { id: original.id, role: 'assistant' as const, excerpt: 'Abri a aba' };
    const sent = jest.spyOn(api, 'sendMessage');
    const sending = chat.getState().send('faz de novo', [], ref);
    expect(slot(chat, 'p-termhub').messages.at(-1)).toMatchObject({ text: 'faz de novo', local: 'sending', reply_to: ref });
    expect(await sending).toBe(true);
    expect(sent).toHaveBeenCalledWith(expect.anything(), { text: 'faz de novo', project_id: 'p-termhub', reply_to_id: original.id });
    await jest.advanceTimersByTimeAsync(2000);
    const stored = slot(chat, 'p-termhub').messages.find((m) => m.text === 'faz de novo')!;
    expect(stored.local).toBeUndefined();
    expect(stored.reply_to?.id).toBe(original.id);
  });

  it('a plain send has no reply_to_id, and a failed reply is retried as the same reply', async () => {
    const { chat, api } = await setup();
    await openAndConnect(chat, 'p-termhub');
    const original = slot(chat, 'p-termhub').messages.find((m) => m.role === 'assistant' && m.text)!;
    const sent = jest.spyOn(api, 'sendMessage').mockRejectedValueOnce(new ApiError(409, 'HOST_OFFLINE', 'A máquina do chat está offline.'));
    await expect(chat.getState().send('faz de novo', [], { id: original.id, role: 'assistant', excerpt: 'x' })).resolves.toBe(false);
    const failed = slot(chat, 'p-termhub').messages.at(-1)!;
    await expect(chat.getState().retrySend(failed.id)).resolves.toBe(true);
    expect(sent).toHaveBeenLastCalledWith(expect.anything(), { text: 'faz de novo', project_id: 'p-termhub', reply_to_id: original.id });
    await chat.getState().send('oi');
    expect(sent).toHaveBeenLastCalledWith(expect.anything(), { text: 'oi', project_id: 'p-termhub' });
  });

  it('a reply to a card (TER-849) goes as reply_to_card, keeps the card on its row, and is retried as the same reply', async () => {
    const { chat, api } = await setup();
    await openAndConnect(chat, 'p-termhub');
    const ref = { id: 'a-termhub-1', role: 'assistant' as const, excerpt: 'digitar npm test', card: 'action' as const };
    const sent = jest.spyOn(api, 'sendMessage').mockRejectedValueOnce(new ApiError(409, 'HOST_OFFLINE', 'A máquina do chat está offline.'));
    await expect(chat.getState().send('por quê?', [], ref)).resolves.toBe(false);
    const failed = slot(chat, 'p-termhub').messages.at(-1)!;
    expect(failed.reply_to).toEqual({ id: null, role: 'assistant', excerpt: 'digitar npm test', card: { kind: 'action', id: 'a-termhub-1' } });
    await expect(chat.getState().retrySend(failed.id)).resolves.toBe(true);
    expect(sent).toHaveBeenLastCalledWith(expect.anything(), { text: 'por quê?', project_id: 'p-termhub', reply_to_card: { kind: 'action', id: 'a-termhub-1' } });
    await jest.advanceTimersByTimeAsync(2000);
    const stored = slot(chat, 'p-termhub').messages.find((m) => m.text === 'por quê?' && m.local === undefined)!;
    expect(stored.reply_to?.card).toEqual({ kind: 'action', id: 'a-termhub-1' });
  });

  it('the mock refuses a reply to a message it does not have, with the server\'s sentence', async () => {
    const { chat } = await setup();
    await openAndConnect(chat, 'p-termhub');
    await expect(chat.getState().send('faz de novo', [], { id: 'nope', role: 'assistant', excerpt: 'x' })).resolves.toBe(false);
    expect(chat.getState().error).toBe('A mensagem citada não está mais disponível. Cancele a citação e envie de novo.');
  });
});

it('announces a message the server accepted, never a failed one (permission prompts spec §3.1)', async () => {
  const { chat, api } = await setup();
  await openAndConnect(chat, 'p-termhub');
  const sent = jest.fn();
  const off = messageSent.subscribe(sent);
  jest.spyOn(api, 'sendMessage').mockRejectedValueOnce(new ApiError(409, 'HOST_OFFLINE', 'A máquina do chat está offline.'));
  await chat.getState().send('oi');
  expect(sent).not.toHaveBeenCalled();
  await expect(chat.getState().send('de novo')).resolves.toBe(true);
  expect(sent).toHaveBeenCalledTimes(1);
  off();
});
