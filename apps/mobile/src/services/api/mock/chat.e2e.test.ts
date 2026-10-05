// End-to-end: `HttpMobileApi` (Task 6) over `MockTransport`'s chat routes, the fake socket and
// notifications (this task) — chat, streaming, decisions and their notifications, exactly as
// design spec §4.2's "Chat"/"Events"/"Controls" bullets describe them.
import { fromB64url } from '../../crypto/encoding';
import { decisionProof, pinProof } from '../../crypto/pin';
import { SoftwareDeviceKey } from '../../key/software';
import { createHttpMobileApi } from '../client';
import type { TChatEvent } from '../contract';
import { createMockTransport } from './transport';

const START = Date.parse('2026-09-24T12:00:00Z');
const APP = 'ios/0.1.0+1';
const APP_VERSION = '0.1.0+1';
const DEVICE = { platform: 'ios' as const, model: 'iPhone15,2', os_version: '18.1', name: 'iPhone de teste' };

function makeApi(clock: { value: number }) {
  const transport = createMockTransport({ latency: [0, 0], now: () => clock.value });
  const key = new SoftwareDeviceKey();
  const api = createHttpMobileApi({
    transport,
    baseUrl: 'https://termhub.dev',
    app: APP,
    key,
    onTokenExpired: async () => null,
    now: () => clock.value,
  });
  return { transport, api, key };
}

async function enrol(clock: { value: number }) {
  const { transport, api, key } = makeApi(clock);
  const jwk = await key.create();
  const req = await api.requestDevice({ email: 'chat@x.com', public_key: jwk, device: DEVICE, app_version: APP_VERSION });
  transport.controls.approve(req.request_id);
  const act = await api.activate({ request_id: req.request_id, request_secret: req.request_secret });
  const secret = fromB64url(act.pin_secret);
  return { transport, api, auth: { accessToken: act.access_token }, deviceId: act.device_id, secret };
}

/** Collects every event `api.events` delivers, plus the socket's own lifecycle, into arrays the
 * test can assert on synchronously after advancing the fake timers. */
function collectEvents(api: ReturnType<typeof createHttpMobileApi>, auth: { accessToken: string }) {
  const events: TChatEvent[] = [];
  const closes: Array<{ code: number; final: boolean }> = [];
  let reconnects = 0;
  const close = api.events(auth, {
    onEvent: (e) => events.push(e),
    onReconnect: () => {
      reconnects += 1;
    },
    onClose: (code, final) => closes.push({ code, final }),
  });
  return { events, closes, reconnectCount: () => reconnects, close };
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

it('lists projects with the fixed pending confirmations on termhub', async () => {
  const clock = { value: START };
  const { api, auth } = await enrol(clock);

  const { projects } = await api.chatProjects(auth);
  expect(projects.map((p) => p.id).sort()).toEqual(['p-opapingou', 'p-reactivando', 'p-termhub']);
  const termhub = projects.find((p) => p.id === 'p-termhub')!;
  expect(termhub.pending_confirmations).toBe(2);
  expect(termhub.busy).toBe(false);
});

describe('project favorites (TER-541)', () => {
  const places = async (api: ReturnType<typeof createHttpMobileApi>, auth: { accessToken: string }) =>
    Object.fromEntries((await api.chatProjects(auth)).projects.map((p) => [p.id, p.favorite_position]));

  it('starts with nothing pinned', async () => {
    const { api, auth } = await enrol({ value: START });
    expect(await places(api, auth)).toEqual({ 'p-termhub': null, 'p-opapingou': null, 'p-reactivando': null });
  });

  it('pins last, ignores a repeat, and closes the gap on unpin', async () => {
    const { api, auth } = await enrol({ value: START });
    await api.setProjectFavorite(auth, 'p-reactivando', true);
    await api.setProjectFavorite(auth, 'p-termhub', true);
    await api.setProjectFavorite(auth, 'p-termhub', true);
    expect(await places(api, auth)).toEqual({ 'p-termhub': 1, 'p-opapingou': null, 'p-reactivando': 0 });
    await api.setProjectFavorite(auth, 'p-reactivando', false);
    expect(await places(api, auth)).toEqual({ 'p-termhub': 0, 'p-opapingou': null, 'p-reactivando': null });
  });

  it('answers 404 for an unknown project', async () => {
    const { api, auth } = await enrol({ value: START });
    await expect(api.setProjectFavorite(auth, 'p-nope', true)).rejects.toMatchObject({ status: 404 });
  });
});

it('GET chat answers the conversation, its two pending actions and a ready host', async () => {
  const clock = { value: START };
  const { api, auth } = await enrol(clock);

  const chat = await api.chat(auth, 'p-termhub');
  expect(chat.conversation.project_id).toBe('p-termhub');
  expect(chat.messages.length).toBeGreaterThanOrEqual(3);
  expect(chat.actions).toHaveLength(2);
  expect(chat.actions[0]).toMatchObject({ id: 'a-termhub-1', status: 'pending', class: 'write' });
  expect(chat.actions[1]).toMatchObject({ id: 'a-termhub-2', status: 'pending', tool: 'move_task' });
  // Like a real row: the proposal's own args name the tab the row targets.
  expect(chat.actions[0]!.args).toMatchObject({ tab_id: chat.actions[0]!.tab_id });
  expect(chat.host).toEqual({
    kind: 'ready',
    machine: { id: 'm-jarvis', name: 'jarvis' },
    configDir: null,
    account: { kind: 'default' },
    sessionAtStake: false,
  });
});

it('streams a busy window, deltas and the final message for a normal reply', async () => {
  const clock = { value: START };
  const { api, auth } = await enrol(clock);
  const collected = collectEvents(api, auth);

  // The socket's connect tick: `hello` is consumed by `createChatSocket` itself (it feeds the
  // clock-skew correction, `onReconnect` is the app-visible signal) and never reaches `onEvent`.
  await jest.advanceTimersByTimeAsync(0);
  expect(collected.events).toHaveLength(0);
  expect(collected.reconnectCount()).toBe(1);

  const accepted = await api.sendMessage(auth, { text: 'roda o teste', project_id: 'p-termhub' });
  expect(accepted).toMatchObject({ conversation_id: expect.any(String), user_message_id: expect.any(String), assistant_message_id: expect.any(String) });

  const { projects } = await api.chatProjects(auth);
  expect(projects.find((p) => p.id === 'p-termhub')!.busy).toBe(true);

  await jest.advanceTimersByTimeAsync(5000);

  // `hello` and `automation` are not chat-bound: they carry no user or conversation id.
  const own = collected.events.filter((e): e is Exclude<TChatEvent, { type: 'hello' | 'automation' }> => e.type !== 'hello' && e.type !== 'automation');
  const messages = own.filter((e): e is Extract<TChatEvent, { type: 'message' }> => e.type === 'message');
  const deltas = own.filter((e): e is Extract<TChatEvent, { type: 'delta' }> => e.type === 'delta');
  expect(messages).toHaveLength(3); // user row, empty assistant row, final assistant row
  expect(messages[0]!.message.role).toBe('user');
  expect(messages[0]!.message.text).toBe('roda o teste');
  expect(messages[1]!.message.role).toBe('assistant');
  expect(messages[1]!.message.text).toBe('');
  expect(deltas.length).toBeGreaterThanOrEqual(3);
  const finalMessage = messages[2]!.message;
  expect(finalMessage.text).toBe('Rodei `npm test` no jarvis: 1066 testes passaram, 137 pulados. Nada quebrou.');
  expect(finalMessage.error_code).toBeNull();
  // Every event carries user_id and its conversation_id (ruling 4).
  for (const e of own) {
    expect(e.user_id).toBe('u1');
    expect(e.conversation_id).toBe(accepted.conversation_id);
  }

  const busyAfter = await api.chatProjects(auth);
  expect(busyAfter.projects.find((p) => p.id === 'p-termhub')!.busy).toBe(false);

  collected.close();
});

it('a message containing erro ends with HOST_GONE and empty text', async () => {
  const clock = { value: START };
  const { api, auth } = await enrol(clock);
  const collected = collectEvents(api, auth);
  await jest.advanceTimersByTimeAsync(0);

  await api.sendMessage(auth, { text: 'isso vai dar erro', project_id: 'p-termhub' });
  await jest.advanceTimersByTimeAsync(5000);

  const messages = collected.events.filter((e): e is Extract<TChatEvent, { type: 'message' }> => e.type === 'message');
  const finalMessage = messages[messages.length - 1]!.message;
  expect(finalMessage.role).toBe('assistant');
  expect(finalMessage.text).toBe('');
  expect(finalMessage.error_code).toBe('HOST_GONE');

  collected.close();
});

it('a message containing confirma raises a confirmation event and a pending action', async () => {
  const clock = { value: START };
  const { api, auth } = await enrol(clock);
  const collected = collectEvents(api, auth);
  await jest.advanceTimersByTimeAsync(0);

  await api.sendMessage(auth, { text: 'preciso que você confirma isso', project_id: 'p-termhub' });
  await jest.advanceTimersByTimeAsync(5000);

  const confirmation = collected.events.find((e): e is Extract<TChatEvent, { type: 'confirmation' }> => e.type === 'confirmation');
  expect(confirmation).toBeDefined();
  expect(confirmation!.class).toBe('write');

  const chat = await api.chat(auth, 'p-termhub');
  const created = chat.actions.find((a) => a.id === confirmation!.action_id);
  expect(created).toMatchObject({ status: 'pending', class: 'write', tab_id: 't-api' });
  expect(created!.args).toMatchObject({ tab_id: 't-api' });

  collected.close();
});

it('a message containing subagente starts one running, listed in GET chat; cancel round-trip settles it to stopped', async () => {
  const clock = { value: START };
  const { api, auth } = await enrol(clock);
  const collected = collectEvents(api, auth);
  await jest.advanceTimersByTimeAsync(0);

  await api.sendMessage(auth, { text: 'chame uma subagente para isso', project_id: 'p-termhub' });
  await jest.advanceTimersByTimeAsync(5000);

  const started = collected.events.find((e): e is Extract<TChatEvent, { type: 'subagent' }> => e.type === 'subagent');
  expect(started).toBeDefined();
  expect(started!.subagent.status).toBe('running');

  const chat = await api.chat(auth, 'p-termhub');
  expect(chat.subagents).toEqual([started!.subagent]);
  // Another conversation's panel never sees it.
  expect((await api.chat(auth, null)).subagents).toEqual([]);

  const cancelled = await api.cancelSubagent(auth, started!.subagent.id);
  expect(cancelled.status).toBe('stopping');
  const stoppingEvent = collected.events.find((e): e is Extract<TChatEvent, { type: 'subagent' }> => e.type === 'subagent' && e.subagent.status === 'stopping');
  expect(stoppingEvent).toBeDefined();

  await jest.advanceTimersByTimeAsync(5000);
  const stoppedEvent = collected.events.find((e): e is Extract<TChatEvent, { type: 'subagent' }> => e.type === 'subagent' && e.subagent.status === 'stopped');
  expect(stoppedEvent).toBeDefined();
  expect((await api.chat(auth, 'p-termhub')).subagents[0]).toMatchObject({ id: started!.subagent.id, status: 'stopped' });

  collected.close();
});

it('cancelSubagent 404s for an unknown id, 409s for one already at rest', async () => {
  const clock = { value: START };
  const { api, auth } = await enrol(clock);

  await expect(api.cancelSubagent(auth, 'nope')).rejects.toMatchObject({ status: 404 });

  await api.sendMessage(auth, { text: 'chame uma subagente para isso', project_id: 'p-termhub' });
  await jest.advanceTimersByTimeAsync(5000);
  const [subagent] = (await api.chat(auth, 'p-termhub')).subagents;
  await api.cancelSubagent(auth, subagent!.id); // running -> stopping
  await expect(api.cancelSubagent(auth, subagent!.id)).rejects.toMatchObject({ status: 409, code: 'SUBAGENT_NOT_RUNNING' });
});

it('decides an action: approve resolves and emits decision, repeating it is 409, bad proofs are 401', async () => {
  const clock = { value: START };
  const { api, auth, deviceId, secret } = await enrol(clock);
  const collected = collectEvents(api, auth);
  await jest.advanceTimersByTimeAsync(0);

  // --- negative paths on the fixture's pending action, which must stay pending throughout ---
  const wrongPurpose = await api.challenge({ device_id: deviceId, purpose: 'refresh' });
  await expect(
    api.decide(auth, 'a-termhub-1', {
      decision: 'approve',
      challenge: wrongPurpose.challenge,
      pin_proof: decisionProof(secret, wrongPurpose.challenge, 'a-termhub-1', 'approve'),
    }),
  ).rejects.toMatchObject({ status: 401, code: 'PIN_INVALID' });

  const boundChallenge = await api.challenge({ device_id: deviceId, purpose: 'decision', action_id: 'a-termhub-1' });
  await expect(
    api.decide(auth, 'a-termhub-1', {
      decision: 'approve',
      challenge: boundChallenge.challenge,
      pin_proof: decisionProof(secret, boundChallenge.challenge, 'some-other-action', 'approve'),
    }),
  ).rejects.toMatchObject({ status: 401, code: 'PIN_INVALID' });

  const stillPending = await api.chat(auth, 'p-termhub');
  expect(stillPending.actions.find((a) => a.id === 'a-termhub-1')!.status).toBe('pending');

  // deny needs nothing beyond the normal auth
  await api.decide(auth, 'a-termhub-1', { decision: 'deny' });
  const denyEvent = collected.events.find((e): e is Extract<TChatEvent, { type: 'decision' }> => e.type === 'decision' && e.action_id === 'a-termhub-1');
  expect(denyEvent?.status).toBe('denied');

  // --- positive path on a freshly-raised confirmation ---
  await api.sendMessage(auth, { text: 'confirma essa ação', project_id: 'p-termhub' });
  await jest.advanceTimersByTimeAsync(5000);
  const confirmation = collected.events.find((e): e is Extract<TChatEvent, { type: 'confirmation' }> => e.type === 'confirmation')!;
  const actionId = confirmation.action_id;

  const chal = await api.challenge({ device_id: deviceId, purpose: 'decision', action_id: actionId });
  const proof = decisionProof(secret, chal.challenge, actionId, 'approve');
  await api.decide(auth, actionId, { decision: 'approve', challenge: chal.challenge, pin_proof: proof });

  const approveEvent = collected.events.find((e): e is Extract<TChatEvent, { type: 'decision' }> => e.type === 'decision' && e.action_id === actionId);
  expect(approveEvent?.status).toBe('approved');

  await expect(api.decide(auth, actionId, { decision: 'approve', challenge: chal.challenge, pin_proof: proof })).rejects.toMatchObject({
    status: 409,
    code: 'ALREADY_DECIDED',
  });

  collected.close();
});

it('approve on a write card resolves with no proof and broadcasts an approved decision (TER-92)', async () => {
  const clock = { value: START };
  const { api, auth } = await enrol(clock);
  const collected = collectEvents(api, auth);
  await jest.advanceTimersByTimeAsync(0);

  await api.decide(auth, 'a-termhub-1', { decision: 'approve' });

  const approveEvent = collected.events.find((e): e is Extract<TChatEvent, { type: 'decision' }> => e.type === 'decision' && e.action_id === 'a-termhub-1');
  expect(approveEvent?.status).toBe('approved');
  const chat = await api.chat(auth, 'p-termhub');
  expect(chat.actions.find((a) => a.id === 'a-termhub-1')!.status).toBe('approved');

  collected.close();
});

it('decideMany: write approvals go with no proof (TER-92), one decision event each', async () => {
  const clock = { value: START };
  const { api, auth } = await enrol(clock);
  const collected = collectEvents(api, auth);
  await jest.advanceTimersByTimeAsync(0);

  await api.decideMany(auth, { decisions: [{ id: 'a-termhub-1', decision: 'approve' }, { id: 'a-termhub-2', decision: 'deny' }] });
  const statuses = Object.fromEntries((await api.chat(auth, 'p-termhub')).actions.map((a) => [a.id, a.status]));
  expect(statuses).toEqual({ 'a-termhub-1': 'approved', 'a-termhub-2': 'denied' });
  const decisions = collected.events.filter((e): e is Extract<TChatEvent, { type: 'decision' }> => e.type === 'decision');
  expect(decisions.map((e) => [e.action_id, e.status])).toEqual([
    ['a-termhub-1', 'approved'],
    ['a-termhub-2', 'denied'],
  ]);

  collected.close();
});

it('decideMany: a wrong proof decides nothing; then one approval proven and one denial decide both, one decision event each', async () => {
  const clock = { value: START };
  const { api, auth, deviceId, secret } = await enrol(clock);
  const collected = collectEvents(api, auth);
  await jest.advanceTimersByTimeAsync(0);
  const statuses = async () => Object.fromEntries((await api.chat(auth, 'p-termhub')).actions.map((a) => [a.id, a.status]));

  const bad = await api.challenge({ device_id: deviceId, purpose: 'decision', action_id: 'a-termhub-1' });
  await expect(
    api.decideMany(auth, {
      decisions: [
        { id: 'a-termhub-1', decision: 'approve', challenge: bad.challenge, pin_proof: decisionProof(secret, bad.challenge, 'a-termhub-2', 'approve') },
        { id: 'a-termhub-2', decision: 'deny' },
      ],
    }),
  ).rejects.toMatchObject({ status: 401, code: 'PIN_INVALID' });
  expect(await statuses()).toEqual({ 'a-termhub-1': 'pending', 'a-termhub-2': 'pending' });
  expect(collected.events.filter((e) => e.type === 'decision')).toEqual([]);

  const chal = await api.challenge({ device_id: deviceId, purpose: 'decision', action_id: 'a-termhub-1' });
  await api.decideMany(auth, {
    decisions: [
      { id: 'a-termhub-1', decision: 'approve', challenge: chal.challenge, pin_proof: decisionProof(secret, chal.challenge, 'a-termhub-1', 'approve') },
      { id: 'a-termhub-2', decision: 'deny' },
    ],
  });
  expect(await statuses()).toEqual({ 'a-termhub-1': 'approved', 'a-termhub-2': 'denied' });
  const decisions = collected.events.filter((e): e is Extract<TChatEvent, { type: 'decision' }> => e.type === 'decision');
  expect(decisions.map((e) => [e.action_id, e.status])).toEqual([
    ['a-termhub-1', 'approved'],
    ['a-termhub-2', 'denied'],
  ]);

  // Nothing left to decide: 409, like the server.
  await expect(api.decideMany(auth, { decisions: [{ id: 'a-termhub-2', decision: 'deny' }] })).rejects.toMatchObject({ status: 409 });

  collected.close();
});

it('approve_tab approves and trusts the tab with a proof for approve_tab only; revokeGrant ends it once', async () => {
  const clock = { value: START };
  const { api, auth, deviceId, secret } = await enrol(clock);
  const collected = collectEvents(api, auth);
  await jest.advanceTimersByTimeAsync(0);

  // A proof signed for `approve` cannot be spent on `approve_tab`.
  const first = await api.challenge({ device_id: deviceId, purpose: 'decision', action_id: 'a-termhub-1' });
  await expect(
    api.decide(auth, 'a-termhub-1', { decision: 'approve_tab', challenge: first.challenge, pin_proof: decisionProof(secret, first.challenge, 'a-termhub-1', 'approve') }),
  ).rejects.toMatchObject({ status: 401, code: 'PIN_INVALID' });
  expect((await api.chat(auth, 'p-termhub')).grants).toEqual([]);

  const chal = await api.challenge({ device_id: deviceId, purpose: 'decision', action_id: 'a-termhub-1' });
  await api.decide(auth, 'a-termhub-1', { decision: 'approve_tab', challenge: chal.challenge, pin_proof: decisionProof(secret, chal.challenge, 'a-termhub-1', 'approve_tab') });

  const chat = await api.chat(auth, 'p-termhub');
  expect(chat.actions.find((a) => a.id === 'a-termhub-1')!.status).toBe('approved');
  expect(chat.grants).toEqual([expect.objectContaining({ tab_id: 't-api', tool: 'send_input', source_action_id: 'a-termhub-1', tab_name: 'api' })]);
  const grantId = chat.grants[0]!.id;
  // Only the conversation that granted it sees it.
  expect((await api.chat(auth, null)).grants).toEqual([]);

  await api.revokeGrant(auth, grantId);
  expect((await api.chat(auth, 'p-termhub')).grants).toEqual([]);
  await expect(api.revokeGrant(auth, grantId)).rejects.toMatchObject({ status: 409 });
  await expect(api.revokeGrant(auth, 'nope')).rejects.toMatchObject({ status: 404 });

  const own = collected.events.filter((e) => e.type === 'decision' || e.type === 'grant' || e.type === 'grant_revoked');
  expect(own.map((e) => e.type)).toEqual(['decision', 'grant', 'grant_revoked']);
  expect(own[1]).toMatchObject({ type: 'grant', conversation_id: 'c-termhub', grant: { id: grantId, tab_id: 't-api' } });
  expect(own[2]).toMatchObject({ type: 'grant_revoked', conversation_id: 'c-termhub', grant_id: grantId });

  collected.close();
});

it('approve_tab on an action that is not send_input to a tab is 400 GRANT_NOT_ALLOWED, before the challenge is spent', async () => {
  const clock = { value: START };
  const { api, auth, deviceId, secret } = await enrol(clock);
  const collected = collectEvents(api, auth);
  await jest.advanceTimersByTimeAsync(0);
  // The account-wide chat's confirmation has no tab.
  await api.sendMessage(auth, { text: 'confirma essa ação', project_id: null });
  await jest.advanceTimersByTimeAsync(5000);
  const { action_id: actionId } = collected.events.find((e): e is Extract<TChatEvent, { type: 'confirmation' }> => e.type === 'confirmation')!;

  const chal = await api.challenge({ device_id: deviceId, purpose: 'decision', action_id: actionId });
  await expect(
    api.decide(auth, actionId, { decision: 'approve_tab', challenge: chal.challenge, pin_proof: decisionProof(secret, chal.challenge, actionId, 'approve_tab') }),
  ).rejects.toMatchObject({ status: 400, code: 'GRANT_NOT_ALLOWED' });
  // the same challenge still approves it plainly
  await api.decide(auth, actionId, { decision: 'approve', challenge: chal.challenge, pin_proof: decisionProof(secret, chal.challenge, actionId, 'approve') });
  expect((await api.chat(auth, null)).grants).toEqual([]);

  collected.close();
});

it('approve_project approves and trusts the project\'s board with a proof for approve_project only; revokeGrant ends it once', async () => {
  const clock = { value: START };
  const { transport, api, auth, deviceId, secret } = await enrol(clock);
  const collected = collectEvents(api, auth);
  await jest.advanceTimersByTimeAsync(0);
  const fetches = jest.spyOn(transport, 'fetch');

  // a-termhub-2 is the fixture's move_task (a board tool) on p-termhub.
  // A proof signed for `approve` cannot be spent on `approve_project`.
  const first = await api.challenge({ device_id: deviceId, purpose: 'decision', action_id: 'a-termhub-2' });
  await expect(
    api.decide(auth, 'a-termhub-2', { decision: 'approve_project', challenge: first.challenge, pin_proof: decisionProof(secret, first.challenge, 'a-termhub-2', 'approve') }),
  ).rejects.toMatchObject({ status: 401, code: 'PIN_INVALID' });
  expect((await api.chat(auth, 'p-termhub')).project_grants).toEqual([]);

  const chal = await api.challenge({ device_id: deviceId, purpose: 'decision', action_id: 'a-termhub-2' });
  await api.decide(auth, 'a-termhub-2', { decision: 'approve_project', challenge: chal.challenge, pin_proof: decisionProof(secret, chal.challenge, 'a-termhub-2', 'approve_project') });
  // The decision answers the grant under the server's own key, `project_grant` (routes/m-chat.ts).
  const decided = fetches.mock.calls.findLastIndex(([input]) => input.url.endsWith('/chat/actions/a-termhub-2/decision'));
  const decisionBody = JSON.parse((await fetches.mock.results[decided]!.value).text);
  expect(decisionBody.project_grant).toMatchObject({ project_id: 'p-termhub', scope: 'board', source_action_id: 'a-termhub-2' });
  expect(decisionBody.grant).toBeUndefined();

  const chat = await api.chat(auth, 'p-termhub');
  expect(chat.actions.find((a) => a.id === 'a-termhub-2')!.status).toBe('approved');
  expect(chat.project_grants).toEqual([expect.objectContaining({ project_id: 'p-termhub', project_name: 'termhub', source_action_id: 'a-termhub-2' })]);
  const grantId = chat.project_grants[0]!.id;
  // Only the conversation that granted it sees it.
  expect((await api.chat(auth, null)).project_grants).toEqual([]);

  await api.revokeGrant(auth, grantId);
  expect((await api.chat(auth, 'p-termhub')).project_grants).toEqual([]);
  await expect(api.revokeGrant(auth, grantId)).rejects.toMatchObject({ status: 409 });
  await expect(api.revokeGrant(auth, 'nope')).rejects.toMatchObject({ status: 404 });

  const own = collected.events.filter((e) => e.type === 'decision' || e.type === 'project_grant' || e.type === 'project_grant_revoked');
  expect(own.map((e) => e.type)).toEqual(['decision', 'project_grant', 'project_grant_revoked']);
  expect(own[1]).toMatchObject({ type: 'project_grant', conversation_id: 'c-termhub', grant: { id: grantId, project_id: 'p-termhub' } });
  expect(own[2]).toMatchObject({ type: 'project_grant_revoked', conversation_id: 'c-termhub', grant_id: grantId });

  collected.close();
});

it('approve_project on a tool outside the board set, or with no resolvable project, is 400 GRANT_NOT_ALLOWED before the challenge is spent', async () => {
  const clock = { value: START };
  const { api, auth, deviceId, secret } = await enrol(clock);
  await jest.advanceTimersByTimeAsync(0);

  // a-termhub-1 is send_input, not a board tool.
  const chal = await api.challenge({ device_id: deviceId, purpose: 'decision', action_id: 'a-termhub-1' });
  await expect(
    api.decide(auth, 'a-termhub-1', { decision: 'approve_project', challenge: chal.challenge, pin_proof: decisionProof(secret, chal.challenge, 'a-termhub-1', 'approve_project') }),
  ).rejects.toMatchObject({ status: 400, code: 'GRANT_NOT_ALLOWED' });
  // the same challenge still approves it plainly
  await api.decide(auth, 'a-termhub-1', { decision: 'approve', challenge: chal.challenge, pin_proof: decisionProof(secret, chal.challenge, 'a-termhub-1', 'approve') });
  expect((await api.chat(auth, 'p-termhub')).project_grants).toEqual([]);
});

/** A pending card in the termhub conversation, seeded through the mock's test control. */
function seedCard(transport: ReturnType<typeof makeApi>['transport'], id: string, patch: { tool: string; args: Record<string, unknown>; tab_id: string | null; project_id?: string | null }) {
  transport.controls.seedAction({
    id,
    conversation_id: 'c-termhub',
    class: 'write',
    status: 'pending',
    machine_id: 'm-jarvis',
    project_id: 'p-termhub',
    grant_id: null,
    summary: `card ${id}`,
    created_at: new Date(START).toISOString(),
    ...patch,
  });
}

it('approve_tab_terminal on a send_key card grants the tab with tool "terminal", and needs a proof for that word (TER-325)', async () => {
  const clock = { value: START };
  const { transport, api, auth, deviceId, secret } = await enrol(clock);
  const collected = collectEvents(api, auth);
  await jest.advanceTimersByTimeAsync(0);
  seedCard(transport, 'a-key', { tool: 'send_key', args: { tab_id: 't-api', key: '1' }, tab_id: 't-api' });

  // A proof signed for `approve_tab` cannot be spent on `approve_tab_terminal`.
  const first = await api.challenge({ device_id: deviceId, purpose: 'decision', action_id: 'a-key' });
  await expect(
    api.decide(auth, 'a-key', { decision: 'approve_tab_terminal', challenge: first.challenge, pin_proof: decisionProof(secret, first.challenge, 'a-key', 'approve_tab') }),
  ).rejects.toMatchObject({ status: 401, code: 'PIN_INVALID' });

  const chal = await api.challenge({ device_id: deviceId, purpose: 'decision', action_id: 'a-key' });
  await api.decide(auth, 'a-key', { decision: 'approve_tab_terminal', challenge: chal.challenge, pin_proof: decisionProof(secret, chal.challenge, 'a-key', 'approve_tab_terminal') });

  const chat = await api.chat(auth, 'p-termhub');
  expect(chat.actions.find((a) => a.id === 'a-key')!.status).toBe('approved');
  expect(chat.grants).toEqual([expect.objectContaining({ tab_id: 't-api', tool: 'terminal', source_action_id: 'a-key', tab_name: 'api' })]);
  expect(collected.events.filter((e) => e.type === 'grant')).toEqual([expect.objectContaining({ grant: expect.objectContaining({ tool: 'terminal' }) })]);
  const { grants } = await api.listGrants(auth, { state: 'active' });
  expect(grants).toEqual([expect.objectContaining({ kind: 'tab', tool: 'terminal', scope: null })]);

  collected.close();
});

it.each(['approve_tab_terminal', 'approve_project_all'] as const)('%s on a run_command card is 400 GRANT_NOT_ALLOWED before the challenge is spent', async (decision) => {
  const clock = { value: START };
  const { transport, api, auth, deviceId, secret } = await enrol(clock);
  await jest.advanceTimersByTimeAsync(0);
  seedCard(transport, 'a-cmd', { tool: 'run_command', args: { command: 'ls' }, tab_id: null });

  const chal = await api.challenge({ device_id: deviceId, purpose: 'decision', action_id: 'a-cmd' });
  await expect(api.decide(auth, 'a-cmd', { decision, challenge: chal.challenge, pin_proof: decisionProof(secret, chal.challenge, 'a-cmd', decision) })).rejects.toMatchObject({
    status: 400,
    code: 'GRANT_NOT_ALLOWED',
  });
  // the same challenge still approves it plainly
  await api.decide(auth, 'a-cmd', { decision: 'approve', challenge: chal.challenge, pin_proof: decisionProof(secret, chal.challenge, 'a-cmd', 'approve') });
  const chat = await api.chat(auth, 'p-termhub');
  expect(chat.grants).toEqual([]);
  expect(chat.project_grants).toEqual([]);
});

it('approve_tab_terminal on a send_input answering a permission dialog is 400 GRANT_NOT_ALLOWED', async () => {
  const clock = { value: START };
  const { transport, api, auth, deviceId, secret } = await enrol(clock);
  await jest.advanceTimersByTimeAsync(0);
  seedCard(transport, 'a-perm', { tool: 'send_input', args: { tab_id: 't-api', text: '1', answering_permission: true }, tab_id: 't-api' });
  const chal = await api.challenge({ device_id: deviceId, purpose: 'decision', action_id: 'a-perm' });
  await expect(
    api.decide(auth, 'a-perm', { decision: 'approve_tab_terminal', challenge: chal.challenge, pin_proof: decisionProof(secret, chal.challenge, 'a-perm', 'approve_tab_terminal') }),
  ).rejects.toMatchObject({ status: 400, code: 'GRANT_NOT_ALLOWED' });
});

it.each([
  ['a send_input to a tab', 'a-termhub-1'],
  ['a board card', 'a-termhub-2'],
])('approve_project_all on %s grants the project with scope "all" (TER-325)', async (_label, actionId) => {
  const clock = { value: START };
  const { transport, api, auth, deviceId, secret } = await enrol(clock);
  const collected = collectEvents(api, auth);
  await jest.advanceTimersByTimeAsync(0);
  const fetches = jest.spyOn(transport, 'fetch');

  const chal = await api.challenge({ device_id: deviceId, purpose: 'decision', action_id: actionId });
  await api.decide(auth, actionId, { decision: 'approve_project_all', challenge: chal.challenge, pin_proof: decisionProof(secret, chal.challenge, actionId, 'approve_project_all') });
  const decided = fetches.mock.calls.findLastIndex(([input]) => input.url.endsWith(`/chat/actions/${actionId}/decision`));
  const decisionBody = JSON.parse((await fetches.mock.results[decided]!.value).text);
  expect(decisionBody.project_grant).toMatchObject({ project_id: 'p-termhub', scope: 'all', source_action_id: actionId });

  const chat = await api.chat(auth, 'p-termhub');
  expect(chat.project_grants).toEqual([expect.objectContaining({ project_id: 'p-termhub', scope: 'all' })]);
  expect(collected.events.filter((e) => e.type === 'project_grant')).toEqual([expect.objectContaining({ grant: expect.objectContaining({ scope: 'all' }) })]);
  const { grants } = await api.listGrants(auth, { state: 'active' });
  expect(grants).toEqual([expect.objectContaining({ kind: 'project', scope: 'all', project_name: 'termhub' })]);

  collected.close();
});

it('a tab keeps one grant per tool: a narrow grant leaves the terminal one, widening revokes the narrow one with grant_revoked (TER-325)', async () => {
  const clock = { value: START };
  const { transport, api, auth, deviceId, secret } = await enrol(clock);
  const collected = collectEvents(api, auth);
  await jest.advanceTimersByTimeAsync(0);
  const decide = async (id: string, decision: 'approve_tab' | 'approve_tab_terminal') => {
    const chal = await api.challenge({ device_id: deviceId, purpose: 'decision', action_id: id });
    await api.decide(auth, id, { decision, challenge: chal.challenge, pin_proof: decisionProof(secret, chal.challenge, id, decision) });
  };

  seedCard(transport, 'a-key1', { tool: 'send_key', args: { tab_id: 't-api', key: '1' }, tab_id: 't-api' });
  await decide('a-key1', 'approve_tab_terminal');
  seedCard(transport, 'a-text1', { tool: 'send_input', args: { tab_id: 't-api', text: 'ls' }, tab_id: 't-api' });
  await decide('a-text1', 'approve_tab');
  let chat = await api.chat(auth, 'p-termhub');
  expect(chat.grants.map((g) => [g.tool, g.source_action_id])).toEqual([
    ['terminal', 'a-key1'],
    ['send_input', 'a-text1'],
  ]);

  // A same-tool re-grant replaces the older one.
  seedCard(transport, 'a-text2', { tool: 'send_input', args: { tab_id: 't-api', text: 'pwd' }, tab_id: 't-api' });
  await decide('a-text2', 'approve_tab');
  chat = await api.chat(auth, 'p-termhub');
  expect(chat.grants.map((g) => [g.tool, g.source_action_id])).toEqual([
    ['terminal', 'a-key1'],
    ['send_input', 'a-text2'],
  ]);
  const narrowId = chat.grants[1]!.id;

  // Widening revokes the narrow grant and screens hear it.
  seedCard(transport, 'a-key2', { tool: 'send_key', args: { tab_id: 't-api', key: 'Enter' }, tab_id: 't-api' });
  await decide('a-key2', 'approve_tab_terminal');
  chat = await api.chat(auth, 'p-termhub');
  expect(chat.grants.map((g) => [g.tool, g.source_action_id])).toEqual([['terminal', 'a-key2']]);
  expect(collected.events.filter((e) => e.type === 'grant_revoked')).toEqual([expect.objectContaining({ grant_id: narrowId })]);

  collected.close();
});

it('approve_project_all on a terminal card resolves the project through its tab, not the row (TER-325)', async () => {
  const clock = { value: START };
  const { transport, api, auth, deviceId, secret } = await enrol(clock);
  await jest.advanceTimersByTimeAsync(0);
  const decideAll = async (id: string) => {
    const chal = await api.challenge({ device_id: deviceId, purpose: 'decision', action_id: id });
    return api.decide(auth, id, { decision: 'approve_project_all', challenge: chal.challenge, pin_proof: decisionProof(secret, chal.challenge, id, 'approve_project_all') });
  };

  // A real send_key row carries no project: the tab's project is the one trusted.
  seedCard(transport, 'a-key', { tool: 'send_key', args: { tab_id: 't-api', key: '1' }, tab_id: 't-api', project_id: null });
  await decideAll('a-key');
  expect((await api.chat(auth, 'p-termhub')).project_grants).toEqual([expect.objectContaining({ project_id: 'p-termhub', scope: 'all', source_action_id: 'a-key' })]);

  // A tab the mock does not know resolves no project, even when the row names one.
  seedCard(transport, 'a-gone', { tool: 'send_input', args: { tab_id: 't-gone', text: 'ls' }, tab_id: 't-gone', project_id: 'p-termhub' });
  await expect(decideAll('a-gone')).rejects.toMatchObject({ status: 400, code: 'GRANT_NOT_ALLOWED' });
});

it('reset archives the conversation: chat() afterwards has no messages and a new conversation id', async () => {
  const clock = { value: START };
  const { api, auth } = await enrol(clock);

  const before = await api.chat(auth, 'p-termhub');
  expect(before.messages.length).toBeGreaterThan(0);

  await api.reset(auth, 'p-termhub');

  const after = await api.chat(auth, 'p-termhub');
  expect(after.conversation.id).not.toBe(before.conversation.id);
  expect(after.messages).toHaveLength(0);
});

it('setHost switches the account-wide chat between machines and accounts', async () => {
  const clock = { value: START };
  const { api, auth } = await enrol(clock);

  // Starts on the fixture default: m-jarvis, no account chosen.
  const initial = await api.chat(auth, null);
  expect(initial.host).toMatchObject({ kind: 'ready', machine: { id: 'm-jarvis', name: 'jarvis' }, account: { kind: 'default' } });

  await api.setHost(auth, { machine_id: 'm-hulk' });
  const offline = await api.chat(auth, null);
  expect(offline.host).toEqual({ kind: 'offline', machine: { id: 'm-hulk', name: 'hulk' } });

  await api.setHost(auth, { machine_id: 'm-jarvis', ai_account_id: 'acc-1' });
  const ready = await api.chat(auth, null);
  expect(ready.host).toEqual({
    kind: 'ready',
    machine: { id: 'm-jarvis', name: 'jarvis' },
    configDir: null,
    account: { kind: 'chosen', id: 'acc-1', label: 'Claude Pedro' },
    sessionAtStake: false,
  });

  // A project's conversation is never touched by setHost: it keeps its own fixed m-jarvis.
  const project = await api.chat(auth, 'p-termhub');
  expect(project.host).toMatchObject({ kind: 'ready', machine: { id: 'm-jarvis', name: 'jarvis' } });

  await expect(api.setHost(auth, { machine_id: 'm-does-not-exist' })).rejects.toMatchObject({ status: 404, code: 'MACHINE_NOT_FOUND' });
});

it('notifications list confirmations and finished runs newest first, with unread and markRead', async () => {
  const clock = { value: START };
  const { api, auth } = await enrol(clock);
  const collected = collectEvents(api, auth);
  await jest.advanceTimersByTimeAsync(0);

  const initial = await api.notifications(auth);
  const initialUnread = initial.unread;
  expect(initial.notifications.some((n) => n.kind === 'confirmation')).toBe(true);

  await api.sendMessage(auth, { text: 'roda o teste', project_id: 'p-termhub' });
  await jest.advanceTimersByTimeAsync(5000);
  await api.sendMessage(auth, { text: 'confirma de novo', project_id: 'p-termhub' });
  await jest.advanceTimersByTimeAsync(5000);

  const after = await api.notifications(auth);
  expect(after.notifications.length).toBeGreaterThanOrEqual(initial.notifications.length + 3); // 2 replies + 1 confirmation
  expect(after.unread).toBe(initialUnread + 3);
  // newest first
  const times = after.notifications.map((n) => Date.parse(n.created_at));
  expect([...times]).toEqual([...times].sort((a, b) => b - a));

  const firstUnread = after.notifications.find((n) => n.read_at === null)!;
  await api.markRead(auth, firstUnread.id);
  const afterRead = await api.notifications(auth);
  expect(afterRead.unread).toBe(after.unread - 1);

  collected.close();
});

it('controls.dropSocket closes with 1006 and is not final; controls.revokeNow closes with 4401 and is final', async () => {
  const clock = { value: START };
  const { transport, api, auth } = await enrol(clock);
  const collected = collectEvents(api, auth);
  await jest.advanceTimersByTimeAsync(0);
  expect(collected.reconnectCount()).toBe(1);

  transport.controls.dropSocket();
  expect(collected.closes).toContainEqual({ code: 1006, final: false });

  // Non-terminal: the socket client schedules a reconnect, which will itself open again on the
  // backoff timer — flush it so no timer is left running for the next assertion.
  await jest.advanceTimersByTimeAsync(2000);

  transport.controls.revokeNow();
  await jest.advanceTimersByTimeAsync(0);
  expect(collected.closes.some((c) => c.code === 4401 && c.final)).toBe(true);

  collected.close();
});

it('an upgrade with an expired token, or from a revoked device, is refused before opening: 1006, not final', async () => {
  // Mirrors the server, which answers a bad upgrade with HTTP 401 before switching protocols.
  const clock = { value: START };
  const { api, auth, transport } = await enrol(clock);

  clock.value += 15 * 60_000 + 1; // past the access token's lifetime
  const expired = collectEvents(api, auth);
  await jest.advanceTimersByTimeAsync(0);
  expect(expired.closes).toEqual([{ code: 1006, final: false }]);
  expect(expired.reconnectCount()).toBe(0);
  expired.close();

  clock.value = START; // the token is live again: only the device's status can refuse it now
  transport.controls.revokeNow();
  const revoked = collectEvents(api, auth);
  await jest.advanceTimersByTimeAsync(0);
  expect(revoked.closes).toEqual([{ code: 1006, final: false }]);
  expect(revoked.reconnectCount()).toBe(0);
  revoked.close();
});

it('a refused upgrade renews the token and the next attempt opens', async () => {
  const clock = { value: START };
  const { transport, key } = makeApi(clock);
  let renew: () => Promise<string | null> = async () => null;
  const api = createHttpMobileApi({ transport, baseUrl: 'https://termhub.dev', app: APP, key, onTokenExpired: () => renew(), now: () => clock.value });
  const jwk = await key.create();
  const req = await api.requestDevice({ email: 'chat@x.com', public_key: jwk, device: DEVICE, app_version: APP_VERSION });
  transport.controls.approve(req.request_id);
  const act = await api.activate({ request_id: req.request_id, request_secret: req.request_secret });
  const secret = fromB64url(act.pin_secret);
  renew = async () => {
    const { challenge } = await api.challenge({ device_id: act.device_id, purpose: 'refresh' });
    return (await api.token({ device_id: act.device_id, challenge, pin_proof: pinProof(secret, challenge) })).access_token;
  };

  clock.value += 15 * 60_000 + 1;
  const collected = collectEvents(api, { accessToken: act.access_token });
  await jest.advanceTimersByTimeAsync(0);
  expect(collected.closes).toEqual([{ code: 1006, final: false }]);

  // The backoff, then the renewal's two mock round trips and the new upgrade, each on a timer.
  for (let i = 0; i < 20 && collected.reconnectCount() === 0; i++) await jest.advanceTimersByTimeAsync(500);
  expect(collected.reconnectCount()).toBe(1);
  expect(collected.closes).toEqual([{ code: 1006, final: false }]);
  collected.close();
});

it('a message containing pergunta raises a tab question; answering it once works, twice is 409', async () => {
  const clock = { value: START };
  const { api, auth } = await enrol(clock);
  const collected = collectEvents(api, auth);
  await jest.advanceTimersByTimeAsync(0);

  await api.sendMessage(auth, { text: 'tem alguma pergunta pendente?', project_id: 'p-termhub' });
  await jest.advanceTimersByTimeAsync(5000);

  const opened = collected.events.find((e): e is Extract<TChatEvent, { type: 'tab_question' }> => e.type === 'tab_question');
  expect(opened?.question).toMatchObject({ kind: 'choice', status: 'open', tab_id: 't-api', tab_name: 'api' });
  const id = opened!.question.id;
  expect((await api.chat(auth, 'p-termhub')).tab_questions.map((q) => q.id)).toContain(id);
  expect((await api.tabQuestionScreen(auth, id)).text).toContain('Qual banco usamos nos testes?');

  await api.answerTabQuestion(auth, id, { answers: [{ selected: [0] }] });
  await jest.advanceTimersByTimeAsync(0);
  expect(collected.events.some((e) => e.type === 'tab_question_answered' && e.question.id === id && e.question.status === 'answered')).toBe(true);
  expect((await api.chat(auth, 'p-termhub')).tab_questions.find((q) => q.id === id)).toMatchObject({ status: 'answered', answer: { answers: [{ selected: [0] }] } });

  await expect(api.answerTabQuestion(auth, id, { answers: [{ selected: [0] }] })).rejects.toMatchObject({ status: 409, code: 'TAB_PROMPT_CHANGED' });
  await expect(api.tabQuestionScreen(auth, id)).rejects.toMatchObject({ status: 409 });
  await expect(api.answerTabQuestion(auth, 'nope', { allow: true })).rejects.toMatchObject({ status: 404 });

  collected.close();
});

it('cancelAutoAnswer is 404 for an unknown question and 409 NOT_SCHEDULED for a card with no countdown running (concierge memory spec 2026-09-26 §6)', async () => {
  const clock = { value: START };
  const { api, auth } = await enrol(clock);
  const collected = collectEvents(api, auth);
  await jest.advanceTimersByTimeAsync(0);

  await api.sendMessage(auth, { text: 'tem alguma pergunta pendente?', project_id: 'p-termhub' });
  await jest.advanceTimersByTimeAsync(5000);
  const opened = collected.events.find((e): e is Extract<TChatEvent, { type: 'tab_question' }> => e.type === 'tab_question');
  const id = opened!.question.id;

  await expect(api.cancelAutoAnswer(auth, 'nope')).rejects.toMatchObject({ status: 404 });
  // The canned card carries no `auto_answer` at all: nothing is counting down.
  await expect(api.cancelAutoAnswer(auth, id)).rejects.toMatchObject({ status: 409, code: 'NOT_SCHEDULED' });

  collected.close();
});

it('a message containing permissão raises a permission question for Bash', async () => {
  const clock = { value: START };
  const { api, auth } = await enrol(clock);
  const collected = collectEvents(api, auth);
  await jest.advanceTimersByTimeAsync(0);
  await api.sendMessage(auth, { text: 'preciso da sua permissão', project_id: 'p-termhub' });
  await jest.advanceTimersByTimeAsync(5000);
  const opened = collected.events.find((e): e is Extract<TChatEvent, { type: 'tab_question' }> => e.type === 'tab_question');
  expect(opened?.question).toMatchObject({ kind: 'permission', payload: { tool_name: 'Bash' } });
  await expect(api.answerTabQuestion(auth, opened!.question.id, { answers: [{ selected: [0] }] })).rejects.toMatchObject({ status: 400 });
  await api.answerTabQuestion(auth, opened!.question.id, { allow: false, text: 'use pnpm' });
  collected.close();
});

it('a message containing sugestão raises a tab suggestion; sending it once works, twice is 409; dismissing is idempotent', async () => {
  const clock = { value: START };
  const { api, auth } = await enrol(clock);
  const collected = collectEvents(api, auth);
  await jest.advanceTimersByTimeAsync(0);

  await api.sendMessage(auth, { text: 'alguma sugestão?', project_id: 'p-termhub' });
  await jest.advanceTimersByTimeAsync(5000);
  const opened = collected.events.find((e): e is Extract<TChatEvent, { type: 'tab_suggestion' }> => e.type === 'tab_suggestion');
  expect(opened?.suggestion).toMatchObject({ kind: 'suggestion', status: 'open', tab_name: 'api', payload: { text: 'commit it' } });
  const id = opened!.suggestion.id;
  expect((await api.chat(auth, 'p-termhub')).tab_suggestions.map((s) => s.id)).toContain(id);
  expect((await api.chat(auth, 'p-termhub')).tab_questions.map((q) => q.id)).not.toContain(id);

  await api.sendTabSuggestion(auth, id, { text: 'commit it and push' });
  await jest.advanceTimersByTimeAsync(0);
  expect(collected.events.some((e) => e.type === 'tab_suggestion_closed' && e.suggestion.id === id && e.suggestion.status === 'answered')).toBe(true);
  await expect(api.sendTabSuggestion(auth, id, { text: 'commit it' })).rejects.toMatchObject({ status: 409, code: 'TAB_PROMPT_CHANGED' });
  await api.dismissTabSuggestion(auth, id); // already sent: stays sent, no error
  expect((await api.chat(auth, 'p-termhub')).tab_suggestions.find((s) => s.id === id)).toMatchObject({ status: 'answered', answer: { text: 'commit it and push' } });
  await expect(api.dismissTabSuggestion(auth, 'nope')).rejects.toMatchObject({ status: 404 });
  collected.close();
});

it('listGrants lists active and ended grants, newest first, paging the history', async () => {
  const clock = { value: START };
  const { api, auth, deviceId, secret } = await enrol(clock);
  expect(await api.listGrants(auth, { state: 'active' })).toEqual({ grants: [], next_cursor: null });

  const chal = await api.challenge({ device_id: deviceId, purpose: 'decision', action_id: 'a-termhub-1' });
  await api.decide(auth, 'a-termhub-1', { decision: 'approve_tab', challenge: chal.challenge, pin_proof: decisionProof(secret, chal.challenge, 'a-termhub-1', 'approve_tab') });
  const [active] = (await api.listGrants(auth, { state: 'active' })).grants;
  expect(active).toMatchObject({ tab_name: 'api', state: 'active', ended_at: null, conversation_project_name: 'termhub', conversation_archived: false });

  await api.revokeGrant(auth, active!.id);
  expect((await api.listGrants(auth, { state: 'active' })).grants).toEqual([]);
  const ended = await api.listGrants(auth, { state: 'ended' });
  expect(ended.grants).toEqual([expect.objectContaining({ id: active!.id, state: 'revoked' })]);
  expect(ended.next_cursor).toBeNull();
});

it("listGrants asks for kinds=all_standing and gets both kinds merged; without it, the mock hides project rows (an old app's request)", async () => {
  const clock = { value: START };
  const { transport, api, auth, deviceId, secret } = await enrol(clock);

  const tabChal = await api.challenge({ device_id: deviceId, purpose: 'decision', action_id: 'a-termhub-1' });
  await api.decide(auth, 'a-termhub-1', { decision: 'approve_tab', challenge: tabChal.challenge, pin_proof: decisionProof(secret, tabChal.challenge, 'a-termhub-1', 'approve_tab') });
  const chal = await api.challenge({ device_id: deviceId, purpose: 'decision', action_id: 'a-termhub-2' });
  await api.decide(auth, 'a-termhub-2', { decision: 'approve_project', challenge: chal.challenge, pin_proof: decisionProof(secret, chal.challenge, 'a-termhub-2', 'approve_project') });

  const withAll = await api.listGrants(auth, { state: 'active' });
  expect(withAll.grants.map((g) => g.kind).sort()).toEqual(['project', 'tab']);

  // The client always asks `kinds=all`; capture the request it *would* make, without letting it
  // reach the mock (its DPoP proof's jti must stay unspent), then fire it once ourselves with
  // `kinds` stripped — the query is not part of the DPoP proof (`canonicalHtu` drops it), so the
  // same signed request still authenticates with a different query string. This is how an older
  // app's request (no `kinds` at all) reaches the server.
  let captured: Parameters<typeof transport.fetch>[0] | undefined;
  const fetchSpy = jest.spyOn(transport, 'fetch').mockImplementationOnce(async (req) => {
    captured = req;
    return { status: 200, headers: {}, text: JSON.stringify({ grants: [], next_cursor: null }) };
  });
  await api.listGrants(auth, { state: 'active' });
  fetchSpy.mockRestore();
  expect(captured!.url).toMatch(/[?&]kinds=all_standing(&|$)/);
  const withoutKinds = { ...captured!, url: captured!.url.replace(/[?&]kinds=all_standing/, '') };
  const res = await transport.fetch(withoutKinds);
  const body = JSON.parse(res.text) as { grants: Array<{ kind: string }> };
  expect(body.grants.map((g) => g.kind)).toEqual(['tab']);
});

it('uploads an attachment, reports its extraction over the socket, and echoes it on the sent message', async () => {
  const clock = { value: START };
  const { api, auth } = await enrol(clock);
  const collected = collectEvents(api, auth);
  await jest.advanceTimersByTimeAsync(0);

  const uploaded = await api.uploadAttachment(auth, { uri: 'file:///tmp/relatorio.pdf', name: 'relatorio.pdf', mime: 'application/pdf' }, 'p-termhub');
  expect(uploaded).toMatchObject({ name: 'relatorio.pdf', kind: 'pdf', status: 'pending' });

  await jest.advanceTimersByTimeAsync(2000);
  const status = collected.events.find((e): e is Extract<TChatEvent, { type: 'attachment_status' }> => e.type === 'attachment_status');
  expect(status).toMatchObject({ conversation_id: 'c-termhub', attachment: { id: uploaded.id, status: 'ready' } });

  await api.sendMessage(auth, { text: '', project_id: 'p-termhub', attachment_ids: [uploaded.id] });
  await jest.advanceTimersByTimeAsync(5000);
  const userMessage = collected.events.find((e): e is Extract<TChatEvent, { type: 'message' }> => e.type === 'message' && e.message.role === 'user')!;
  expect(userMessage.message.text).toBe('');
  expect(userMessage.message.attachments).toEqual([expect.objectContaining({ id: uploaded.id, status: 'ready' })]);

  // Sent: it can no longer be deleted (409, as the server answers), and cannot be sent twice.
  await expect(api.deleteAttachment(auth, uploaded.id)).rejects.toMatchObject({ status: 409 });
  await expect(api.sendMessage(auth, { text: 'de novo', project_id: 'p-termhub', attachment_ids: [uploaded.id] })).rejects.toMatchObject({ status: 409, code: 'ATTACHMENT_UNAVAILABLE' });

  collected.close();
});

it('refuses an unknown type, deletes an unsent attachment, and refuses an id of another conversation at send', async () => {
  const clock = { value: START };
  const { api, auth } = await enrol(clock);

  await expect(api.uploadAttachment(auth, { uri: 'file:///x', name: 'setup.exe', mime: 'application/octet-stream' }, null)).rejects.toMatchObject({ status: 415, code: 'ATTACHMENT_TYPE' });

  const general = await api.uploadAttachment(auth, { uri: 'file:///x', name: 'notas.txt', mime: 'text/plain' }, null);
  await expect(api.sendMessage(auth, { text: 'oi', project_id: 'p-termhub', attachment_ids: [general.id] })).rejects.toMatchObject({ status: 409, code: 'ATTACHMENT_UNAVAILABLE' });

  await api.deleteAttachment(auth, general.id);
  await expect(api.deleteAttachment(auth, general.id)).rejects.toMatchObject({ status: 404 });
});

// "Memória do chat" (chat decision memory spec 2026-09-26 §4.6/§5.2): the mock's own answers for
// the four routes, so the mock mode keeps working end to end (not only through the store's own
// unit tests, which stub `api` directly).
describe('chat decision memory', () => {
  it('GET decisions lists the seeded fixtures newest first, and q filters them', async () => {
    const clock = { value: START };
    const { api, auth } = await enrol(clock);
    const page = await api.chatDecisions(auth);
    expect(page.decisions.map((d) => d.id)).toEqual(['d-branch', 'd-worktree']); // newest first
    expect(page.next_cursor).toBeNull();

    const filtered = await api.chatDecisions(auth, 'worktree');
    expect(filtered.decisions.map((d) => d.id)).toEqual(['d-worktree']);
  });

  it('DELETE decisions/:id removes the row and is idempotent (a repeat, or an unknown id, is still 204)', async () => {
    const clock = { value: START };
    const { api, auth } = await enrol(clock);
    await api.forgetChatDecision(auth, 'd-worktree');
    expect((await api.chatDecisions(auth)).decisions.map((d) => d.id)).toEqual(['d-branch']);
    await api.forgetChatDecision(auth, 'd-worktree'); // already gone
    await api.forgetChatDecision(auth, 'nope'); // never existed
    expect((await api.chatMemory(auth)).count).toBe(1);
  });

  it('GET/PATCH memory reads and flips the switch, with the seeded count', async () => {
    const clock = { value: START };
    const { api, auth } = await enrol(clock);
    expect(await api.chatMemory(auth)).toMatchObject({ enabled: true, available: true, count: 2 });
    expect(await api.setChatMemory(auth, false)).toMatchObject({ enabled: false, available: true, count: 2 });
    expect(await api.chatMemory(auth)).toMatchObject({ enabled: false });
  });
});

it('approve_project_always grants a standing kind on the card\'s project, with a proof for that word; GET chat, the list and Revogar follow it (TER-386)', async () => {
  const clock = { value: START };
  const { transport, api, auth, deviceId, secret } = await enrol(clock);
  const collected = collectEvents(api, auth);
  await jest.advanceTimersByTimeAsync(0);
  const fetches = jest.spyOn(transport, 'fetch');
  seedCard(transport, 'a-close', { tool: 'close_tab', args: { tab_id: 't-api' }, tab_id: 't-api', project_id: null });

  // A proof signed for `approve_project_all` cannot be spent on `approve_project_always`.
  const first = await api.challenge({ device_id: deviceId, purpose: 'decision', action_id: 'a-close' });
  await expect(
    api.decide(auth, 'a-close', { decision: 'approve_project_always', challenge: first.challenge, pin_proof: decisionProof(secret, first.challenge, 'a-close', 'approve_project_all') }),
  ).rejects.toMatchObject({ status: 401, code: 'PIN_INVALID' });

  const chal = await api.challenge({ device_id: deviceId, purpose: 'decision', action_id: 'a-close' });
  await api.decide(auth, 'a-close', { decision: 'approve_project_always', challenge: chal.challenge, pin_proof: decisionProof(secret, chal.challenge, 'a-close', 'approve_project_always') });
  const decided = fetches.mock.calls.findLastIndex(([input]) => input.url.endsWith('/chat/actions/a-close/decision'));
  const decisionBody = JSON.parse((await fetches.mock.results[decided]!.value).text);
  // close_tab resolves its project through the tab, like the server.
  expect(decisionBody.standing_grant).toMatchObject({ project_id: 'p-termhub', project_name: 'termhub', kind: 'close_tab', source_action_id: 'a-close' });
  expect(decisionBody.project_grant).toBeUndefined();
  const grantId = decisionBody.standing_grant.id as string;

  // Not bound to a conversation: the project's chat and the account-wide chat show it, another project's does not.
  const chat = await api.chat(auth, 'p-termhub');
  expect(chat.actions.find((a) => a.id === 'a-close')!.status).toBe('approved');
  expect(chat.standing_grants).toEqual([expect.objectContaining({ id: grantId, kind: 'close_tab' })]);
  expect((await api.chat(auth, null)).standing_grants).toEqual([expect.objectContaining({ id: grantId })]);
  expect((await api.chat(auth, 'p-opapingou')).standing_grants).toEqual([]);
  // A reset of the project's chat keeps it.
  await api.reset(auth, 'p-termhub');
  expect((await api.chat(auth, 'p-termhub')).standing_grants).toEqual([expect.objectContaining({ id: grantId })]);

  const { grants } = await api.listGrants(auth, { state: 'active' });
  expect(grants).toEqual([expect.objectContaining({ id: grantId, kind: 'standing', standing_kind: 'close_tab', expires_at: null, project_name: 'termhub', state: 'active', ended_at: null })]);

  await api.revokeGrant(auth, grantId);
  expect((await api.chat(auth, 'p-termhub')).standing_grants).toEqual([]);
  expect((await api.listGrants(auth, { state: 'ended' })).grants).toEqual([expect.objectContaining({ id: grantId, kind: 'standing', state: 'revoked' })]);
  await expect(api.revokeGrant(auth, grantId)).rejects.toMatchObject({ status: 409 });

  const own = collected.events.filter((e) => e.type === 'standing_grant' || e.type === 'standing_grant_revoked');
  expect(own).toEqual([
    expect.objectContaining({ type: 'standing_grant', conversation_id: 'c-termhub', grant: expect.objectContaining({ id: grantId }) }),
    expect.objectContaining({ type: 'standing_grant_revoked', grant_id: grantId }),
  ]);
  collected.close();
});

it('approve_project_always replaces an active grant of the same project and kind (TER-386)', async () => {
  const clock = { value: START };
  const { transport, api, auth, deviceId, secret } = await enrol(clock);
  await jest.advanceTimersByTimeAsync(0);
  seedCard(transport, 'a-board', { tool: 'create_task', args: { project_id: 'p-termhub', title: 'x' }, tab_id: null });
  for (const id of ['a-termhub-2', 'a-board']) {
    const chal = await api.challenge({ device_id: deviceId, purpose: 'decision', action_id: id });
    await api.decide(auth, id, { decision: 'approve_project_always', challenge: chal.challenge, pin_proof: decisionProof(secret, chal.challenge, id, 'approve_project_always') });
  }
  expect((await api.chat(auth, 'p-termhub')).standing_grants).toEqual([expect.objectContaining({ kind: 'board', source_action_id: 'a-board' })]);
  expect((await api.listGrants(auth, { state: 'active' })).grants.filter((g) => g.kind === 'standing')).toHaveLength(1);
});

it('approve_project_always on a card with no standing kind is 400 GRANT_NOT_ALLOWED before the challenge is spent (TER-386)', async () => {
  const clock = { value: START };
  const { transport, api, auth, deviceId, secret } = await enrol(clock);
  await jest.advanceTimersByTimeAsync(0);
  seedCard(transport, 'a-cmd', { tool: 'run_command', args: { command: 'ls' }, tab_id: null });
  const chal = await api.challenge({ device_id: deviceId, purpose: 'decision', action_id: 'a-cmd' });
  await expect(
    api.decide(auth, 'a-cmd', { decision: 'approve_project_always', challenge: chal.challenge, pin_proof: decisionProof(secret, chal.challenge, 'a-cmd', 'approve_project_always') }),
  ).rejects.toMatchObject({ status: 400, code: 'GRANT_NOT_ALLOWED' });
  // the same challenge still approves it plainly
  await api.decide(auth, 'a-cmd', { decision: 'approve', challenge: chal.challenge, pin_proof: decisionProof(secret, chal.challenge, 'a-cmd', 'approve') });
  expect((await api.chat(auth, 'p-termhub')).standing_grants).toEqual([]);
});
