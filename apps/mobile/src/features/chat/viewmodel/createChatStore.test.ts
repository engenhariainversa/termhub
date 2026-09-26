// The chat store (design spec §6) over the real `HttpMobileApi`, the in-memory `MockTransport`
// and its fake socket, with an enrolled, unlocked session store built over the same mock.
import * as SecureStore from 'expo-secure-store';
import type { TChatEvent } from '@/services/api/contract';
import { ApiError } from '@/services/api/errors';
import { mmkv } from '@/services/storage';
import { appBackgrounded } from '@/features/shared/signals';
import { PERSIST_INTERVAL_MS } from './throttled-storage';
import { foldLive } from '../model/live';
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

it('a reconnect re-reads the conversation and empties live', async () => {
  const { chat, api, controls, handlers } = await setup();
  await openAndConnect(chat, 'p-termhub');
  handlers().onEvent({ type: 'delta', user_id: 'u1', conversation_id: 'c-termhub', message_id: 'm-x', delta: 'meio' });
  expect(chat.getState().live).toHaveLength(1);

  const read = jest.spyOn(api, 'chat');
  controls.dropSocket();
  expect(chat.getState().connected).toBe(false);

  await jest.advanceTimersByTimeAsync(2000); // the socket's first backoff step (1 s), then its connect tick
  expect(chat.getState().connected).toBe(true);
  expect(read).toHaveBeenCalledWith(expect.anything(), 'p-termhub');
  expect(chat.getState().live).toEqual([]);
});

it('send answers at once and the thread grows only through events; deltas fold into foldLive(live)', async () => {
  const { chat, api } = await setup();
  await openAndConnect(chat, 'p-termhub');
  const read = jest.spyOn(api, 'chat');
  const sent = jest.spyOn(api, 'sendMessage');

  await expect(chat.getState().send('  roda o teste  ')).resolves.toBe(true);
  expect(sent).toHaveBeenCalledWith(expect.anything(), { text: 'roda o teste', project_id: 'p-termhub' });
  expect(chat.getState().sending).toBe(false);
  expect(slot(chat, 'p-termhub').messages).toHaveLength(4); // nothing appended locally
  const { assistant_message_id: assistantId } = await sent.mock.results[0]!.value;

  await jest.advanceTimersToNextTimerAsync(); // the user's row
  expect(slot(chat, 'p-termhub').messages).toHaveLength(5);
  expect(read).toHaveBeenCalledTimes(1); // a `message` event re-reads the thread

  await jest.advanceTimersToNextTimerAsync(); // the empty assistant row: "pensando…"
  expect(slot(chat, 'p-termhub').messages).toHaveLength(6);
  expect(foldLive(chat.getState().live).started.has(assistantId)).toBe(true);

  await jest.advanceTimersToNextTimerAsync();
  await jest.advanceTimersToNextTimerAsync();
  const streaming = foldLive(chat.getState().live).deltas.get(assistantId);
  expect(streaming).toBeTruthy();

  await jest.advanceTimersByTimeAsync(5000);
  const final = slot(chat, 'p-termhub').messages.find((m) => m.id === assistantId)!;
  expect(final.text).toBe('Rodei `npm test` no jarvis: 1066 testes passaram, 137 pulados. Nada quebrou.');
  expect(final.text.startsWith(streaming!)).toBe(true);
  expect(foldLive(chat.getState().live).deltas.has(assistantId)).toBe(false);
  expect(chat.getState().live).toEqual([]);
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
  const read = jest.spyOn(api, 'chat');

  handlers().onEvent({ type: 'delta', user_id: 'u1', conversation_id: 'c-opapingou', message_id: 'm1', delta: 'x' });
  handlers().onEvent(decision('c-opapingou', 'a-termhub-1', 'denied'));
  handlers().onEvent({
    type: 'message',
    user_id: 'u1',
    conversation_id: 'c-opapingou',
    message: { id: 'm2', conversation_id: 'c-opapingou', role: 'user', text: 'oi', usage: null, error_code: null, created_at: new Date().toISOString() },
  });

  expect(chat.getState().live).toEqual([]);
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
  expect(chat.getState()).toMatchObject({ projects: [], conversations: {}, live: [], connected: false, activeProject: undefined });
});

it('persists projects and each conversation, never live or transient state', async () => {
  const { chat, api, handlers } = await setup();
  await chat.getState().loadProjects();
  await openAndConnect(chat, 'p-termhub');
  handlers().onEvent({ type: 'delta', user_id: 'u1', conversation_id: 'c-termhub', message_id: 'm-x', delta: 'meio' });
  await jest.advanceTimersByTimeAsync(PERSIST_INTERVAL_MS); // the throttled write lands

  const saved = JSON.parse(mmkv.getString('chat')!).state;
  expect(Object.keys(saved).sort()).toEqual(['conversations', 'projects']);
  expect(Object.keys(saved.conversations['p-termhub']).sort()).toEqual(['actions', 'conversation', 'grants', 'host', 'messages', 'tabQuestions', 'tabSuggestions']);

  // A cold start shows the thread before any fetch.
  const again = createChatStore({ api, session: () => ({ phase: 'locked', auth: () => { throw new Error('LOCKED'); }, handleApiError: () => false, requestPinProof: async () => { throw new Error('CANCELLED'); }, requestPinProofs: async () => { throw new Error('CANCELLED'); } }) });
  opened.push(again);
  expect(again.getState().projects).toHaveLength(3);
  expect(slot(again, 'p-termhub')).toMatchObject({ loaded: false, error: null, conversation: { id: 'c-termhub' } });
  expect(slot(again, 'p-termhub').messages).toHaveLength(4);
  expect(again.getState().live).toEqual([]);
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

it('answerTabQuestion answers over the mock and the card turns answered; a second answer reads "A pergunta mudou na aba"', async () => {
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
  expect(chat.getState().questionErrors[q.id]).toBe('A pergunta mudou na aba');
  expect(chat.getState().error).toBeNull();
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
  expect(chat.getState().questionErrors).toEqual({ q1: 'A pergunta mudou na aba', q2: 'Não foi possível responder na aba' });
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

it('a delta is one set and no MMKV write; the persisted slice lands within 2 s, once, without live', async () => {
  const { chat, handlers } = await setup();
  await openAndConnect(chat, 'p-termhub');
  await jest.advanceTimersByTimeAsync(PERSIST_INTERVAL_MS); // the open's own writes
  const writes = jest.spyOn(mmkv, 'set');
  const chatWrites = () => writes.mock.calls.filter(([name]) => name === 'chat');
  const sets = jest.fn();
  const unsubscribe = chat.subscribe(sets);

  for (let i = 0; i < 20; i++) handlers().onEvent({ type: 'delta', user_id: 'u1', conversation_id: 'c-termhub', message_id: 'm-x', delta: `t${i}` });
  unsubscribe();
  expect(sets).toHaveBeenCalledTimes(20);
  expect(chatWrites()).toHaveLength(0);

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
