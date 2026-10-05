import { afterEach, describe, expect, it, vi } from 'vitest';
import { chatBus, type ChatEvent } from '../chat/bus.js';
import { monitorBus } from '../monitor/bus.js';
import type { Tab } from '../db/repositories/types.js';
import type { Repositories } from '../db/repositories/index.js';
import type { Device } from '../db/repositories/devices.js';
import type { DeviceRequest } from '../db/repositories/device-requests.js';
import type { User } from '../db/repositories/types.js';
import { ExpoPushSender, ExpoReceiptFetcher, MobilePushService, sweepPushReceipts, type PushMessage, type PushReceipt, type PushSender } from './push.js';

const mkDevice = (id: string, token: string): Device => ({ id, user_id: 'u1', push_token: token, status: 'active' }) as unknown as Device;
const user = { id: 'u1', email: 'ana@example.com' } as unknown as User;

function setup(opts: { devices?: Device[]; live?: string[]; locale?: 'pt-BR' | 'en' | null; deletionScheduledAt?: string } = {}) {
  const devices = opts.devices ?? [mkDevice('d1', 'ExponentPushToken[a]'), mkDevice('d2', 'ExponentPushToken[b]')];
  const repos = {
    users: { findById: vi.fn(async (id: string) => ({ ...user, id, locale: opts.locale ?? null, deletion_scheduled_at: opts.deletionScheduledAt ?? null })), pushTabFinished: vi.fn(async () => true) },
    devices: { listActiveWithPush: vi.fn(async () => devices), setPushToken: vi.fn(async () => undefined), clearPushTokenIf: vi.fn(async () => true) },
    deviceEvents: { record: vi.fn(async () => undefined) },
    userNotifications: { create: vi.fn(async (input: object) => ({ id: 'n1', ...input })), countUnread: vi.fn(async () => 3), markReadByData: vi.fn(async () => 1) },
    pushTickets: { recordMany: vi.fn(async () => undefined) },
    projects: { findByIdsForOwner: vi.fn(async () => [{ id: 'p1', name: 'termhub' }]) },
    tabs: {
      findByIdsForOwner: vi.fn(async () => [{ id: 't1', name: 'api' }]),
      findById: vi.fn(async (id: string) => ({ id, project_id: 'p1', machine_id: 'm1', state: 'waiting_input' }) as { id: string; project_id: string; machine_id: string; state: string } | undefined),
    },
    tabQuestions: { findOpenForTab: vi.fn(async () => undefined as { kind: string } | undefined) },
    machines: { findByIdsForOwner: vi.fn(async () => [{ id: 'm1', name: 'jarvis' }]) },
    // cp / c9: conversations of project p1; cx: unknown to this user; anything else: the account-wide chat.
    chat: {
      findByIdForUser: vi.fn(async (id: string) => (id === 'cx' ? undefined : { id, user_id: 'u1', project_id: id === 'cp' || id === 'c9' ? 'p1' : null })),
      findLatestActiveForProject: vi.fn(async () => ({ id: 'cp', user_id: 'u1', project_id: 'p1' }) as { id: string } | undefined),
      findLatestActiveForUser: vi.fn(async () => ({ id: 'cp', user_id: 'u1', project_id: 'p1' }) as { id: string; user_id: string; project_id: string | null } | undefined),
    },
  };
  const sent: PushMessage[][] = [];
  const sender: PushSender & { send: ReturnType<typeof vi.fn> } = {
    send: vi.fn(async (messages: PushMessage[]) => {
      sent.push(messages);
      return messages.map((m) => ({ to: m.to }));
    }),
  };
  const sockets = { liveDevices: vi.fn(() => new Set(opts.live ?? [])) };
  const log = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
  const receipts = { fetch: vi.fn(async (_ids: string[]) => new Map<string, PushReceipt>()) };
  const service = new MobilePushService({ repos: repos as unknown as Repositories, sender, receipts, sockets: sockets as never, log: log as never });
  return { repos, sender, sent, sockets, log, service, receipts };
}

/** Lets the listener's async work (repo calls, send) settle. */
const flush = () => new Promise((r) => setTimeout(r, 10));

const confirmation: ChatEvent = {
  type: 'confirmation',
  user_id: 'u1',
  conversation_id: 'cp',
  action_id: 'a1',
  tool: 'send_input',
  args: { text: 'rm -rf segredo' },
  class: 'write' as never,
  machine_id: 'm1',
  // The gate fills this from the tool call's args (the action's target), not from the conversation.
  project_id: null,
  tab_id: 't1',
  summary: 'Digitar rm -rf segredo na aba api',
  created_at: '2026-09-24T00:00:00.000Z',
};

const finished = (conversation_id: string, ok = true): ChatEvent => ({ type: 'run_finished', user_id: 'u1', conversation_id, message_id: 'msg1', ok, error_code: ok ? null : 'X' });

let stop: (() => void) | null = null;
afterEach(() => {
  stop?.();
  stop = null;
});

describe('MobilePushService', () => {
  it("writes the push and its history row in the recipient's language", async () => {
    const t = setup({ locale: 'en' });
    stop = t.service.start();
    chatBus.publish(confirmation);
    await flush();
    expect(t.repos.users.findById).toHaveBeenCalledWith('u1');
    expect(t.repos.userNotifications.create).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'termhub needs you', body: 'The chat of project termhub asked for confirmation to act in tab api (jarvis).' }),
    );
    expect(t.sent[0][0]).toMatchObject({ title: 'termhub needs you' });
  });

  it('turns a confirmation into one history row and a push to devices without a live socket, naming the conversation’s project', async () => {
    const t = setup({ live: ['d2'] });
    stop = t.service.start();
    chatBus.publish(confirmation);
    await flush();
    expect(t.repos.chat.findByIdForUser).toHaveBeenCalledWith('cp', 'u1');
    expect(t.repos.projects.findByIdsForOwner).toHaveBeenCalledWith(['p1'], 'u1');
    expect(t.repos.tabs.findByIdsForOwner).toHaveBeenCalledWith(['t1'], 'u1');
    expect(t.repos.machines.findByIdsForOwner).toHaveBeenCalledWith(['m1'], 'u1');
    expect(t.repos.userNotifications.create).toHaveBeenCalledTimes(1);
    expect(t.repos.userNotifications.create).toHaveBeenCalledWith({
      user_id: 'u1',
      kind: 'confirmation',
      title: 'termhub precisa de você',
      body: 'O chat do projeto termhub pediu confirmação para agir na aba api (jarvis).',
      data: { kind: 'confirmation', conversation_id: 'cp', project_id: 'p1', action_id: 'a1' },
    });
    expect(t.sent).toHaveLength(1);
    const messages = t.sent[0];
    expect(messages).toHaveLength(1);
    // The push also names its history row, so a tap marks it read; the row itself does not.
    expect(messages[0]).toEqual({
      to: 'ExponentPushToken[a]',
      title: 'termhub precisa de você',
      body: 'O chat do projeto termhub pediu confirmação para agir na aba api (jarvis).',
      data: { kind: 'confirmation', conversation_id: 'cp', project_id: 'p1', action_id: 'a1', notification_id: 'n1' },
      badge: 3,
    });
    for (const m of messages) {
      expect(m.data).not.toHaveProperty('summary');
      expect(m.data).not.toHaveProperty('args');
      expect(m.data).not.toHaveProperty('tool');
    }
    const json = JSON.stringify(messages);
    expect(json).not.toContain(confirmation.summary);
    expect(json).not.toContain('rm -rf');
    expect(json).not.toContain('send_input');
  });

  it('labels an account-wide conversation as the general chat even when the action targets a (foreign) project', async () => {
    const t = setup();
    stop = t.service.start();
    chatBus.publish({ ...confirmation, conversation_id: 'c1', project_id: 'p-foreign' } as ChatEvent);
    await flush();
    expect(t.repos.projects.findByIdsForOwner).not.toHaveBeenCalled();
    expect(t.sent[0][0]).toEqual({
      to: 'ExponentPushToken[a]',
      title: 'termhub precisa de você',
      body: 'O chat geral pediu confirmação para agir na aba api (jarvis).',
      data: { kind: 'confirmation', conversation_id: 'c1', project_id: null, action_id: 'a1', notification_id: 'n1' },
      badge: 3,
    });
    expect(JSON.stringify(t.repos.userNotifications.create.mock.calls)).not.toContain('p-foreign');
    expect(JSON.stringify(t.sent)).not.toContain('p-foreign');
  });

  it('falls back to the general chat wording when the conversation is not the user’s', async () => {
    const t = setup();
    stop = t.service.start();
    chatBus.publish({ ...confirmation, conversation_id: 'cx', project_id: 'p1' } as ChatEvent);
    await flush();
    expect(t.repos.userNotifications.create.mock.calls[0][0]).toMatchObject({
      body: 'O chat geral pediu confirmação para agir na aba api (jarvis).',
      data: { kind: 'confirmation', conversation_id: 'cx', project_id: null, action_id: 'a1' },
    });
  });

  it('pushes a finished reply once per conversation per minute, collapsed, and ignores failed runs', async () => {
    const t = setup();
    stop = t.service.start();
    chatBus.publish(finished('c1'));
    await flush();
    expect(t.repos.userNotifications.create).toHaveBeenCalledTimes(1);
    expect(t.repos.userNotifications.create.mock.calls[0][0]).toMatchObject({ kind: 'reply', data: { kind: 'reply', conversation_id: 'c1', project_id: null } });
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0].every((m) => m.collapseId === 'reply:c1')).toBe(true);
    expect(t.sent[0][0].title).toBe('Resposta pronta');

    chatBus.publish(finished('c1'));
    await flush();
    expect(t.repos.userNotifications.create).toHaveBeenCalledTimes(2);
    expect(t.sent).toHaveLength(1);

    chatBus.publish(finished('c2', false));
    await flush();
    expect(t.repos.userNotifications.create).toHaveBeenCalledTimes(2);
    expect(t.sent).toHaveLength(1);
  });

  it('names the project of a finished reply from its conversation, owner-scoped', async () => {
    const t = setup();
    stop = t.service.start();
    chatBus.publish(finished('c9'));
    await flush();
    expect(t.repos.chat.findByIdForUser).toHaveBeenCalledWith('c9', 'u1');
    expect(t.repos.projects.findByIdsForOwner).toHaveBeenCalledWith(['p1'], 'u1');
    expect(t.repos.userNotifications.create.mock.calls[0][0]).toMatchObject({ data: { kind: 'reply', conversation_id: 'c9', project_id: 'p1' } });
    expect(t.sent[0][0]).toMatchObject({ title: 'Resposta pronta em termhub', body: 'O chat do projeto termhub terminou de responder.' });
  });

  it('sends a device request to every device with a push token, live or not', async () => {
    const t = setup({ live: ['d1', 'd2'] });
    await t.service.deviceRequest(user, { id: 'r1', model: 'iPhone 15', city: 'São Paulo', country: 'BR' } as unknown as DeviceRequest);
    expect(t.repos.userNotifications.create).toHaveBeenCalledWith({
      user_id: 'u1',
      kind: 'device_request',
      title: 'Novo aparelho pede acesso',
      body: 'iPhone 15 (São Paulo) pediu acesso à sua conta. Confira o código e aprove ou recuse na web.',
      data: { kind: 'device_request' },
    });
    expect(t.sent[0].map((m) => m.to)).toEqual(['ExponentPushToken[a]', 'ExponentPushToken[b]']);
    expect(t.sent[0][0]).toEqual({
      to: 'ExponentPushToken[a]',
      title: 'Novo aparelho pede acesso',
      body: 'iPhone 15 (São Paulo) pediu acesso à sua conta. Confira o código e aprove ou recuse na web.',
      data: { kind: 'device_request', notification_id: 'n1' },
      badge: 3,
    });
  });

  it('clears the token of a device Expo reports as not registered', async () => {
    const t = setup();
    t.sender.send.mockImplementationOnce(async (messages: PushMessage[]) => messages.map((m) => (m.to === 'ExponentPushToken[b]' ? { to: m.to, error: 'DeviceNotRegistered' } : { to: m.to })));
    await t.service.deviceRequest(user, { id: 'r1', model: 'Pixel 8', city: null, country: null } as unknown as DeviceRequest);
    expect(t.repos.devices.setPushToken).toHaveBeenCalledTimes(1);
    expect(t.repos.devices.setPushToken).toHaveBeenCalledWith('d2', null);
  });

  it('logs a thrown sender error with ids only, keeps the history row and does not reject', async () => {
    const t = setup();
    t.sender.send.mockRejectedValueOnce(Object.assign(new Error('boom ana@example.com ExponentPushToken[a]'), { code: 'ECONNRESET' }));
    await expect(t.service.deviceRequest(user, { id: 'r1', model: 'Pixel 8', city: null, country: null } as unknown as DeviceRequest)).resolves.toBeUndefined();
    expect(t.repos.userNotifications.create).toHaveBeenCalledTimes(1);
    expect(t.log.warn).toHaveBeenCalled();
    const logged = JSON.stringify(t.log.warn.mock.calls);
    expect(logged).toContain('ECONNRESET');
    expect(logged).not.toContain('ana@example.com');
    expect(logged).not.toContain('ExponentPushToken');
  });

  it('a bus event whose sender throws does not escape the listener', async () => {
    const t = setup();
    t.sender.send.mockRejectedValueOnce(new Error('down'));
    stop = t.service.start();
    chatBus.publish(confirmation);
    await flush();
    expect(t.repos.userNotifications.create).toHaveBeenCalledTimes(1);
    expect(t.log.warn).toHaveBeenCalled();
  });

  it('still writes the history row for a user with no push-capable devices', async () => {
    const t = setup({ devices: [] });
    stop = t.service.start();
    chatBus.publish(confirmation);
    await flush();
    expect(t.repos.userNotifications.create).toHaveBeenCalledTimes(1);
    expect(t.sender.send).not.toHaveBeenCalled();
  });

  it('start() is idempotent: a second call does not subscribe again', async () => {
    const t = setup({ devices: [] });
    const first = t.service.start();
    const second = t.service.start();
    expect(second).toBe(first);
    stop = first;
    chatBus.publish(confirmation);
    await flush();
    expect(t.repos.userNotifications.create).toHaveBeenCalledTimes(1);
  });

  it('start() returns a working unsubscribe', async () => {
    const t = setup();
    const unsubscribe = t.service.start();
    unsubscribe();
    chatBus.publish(confirmation);
    await flush();
    expect(t.repos.userNotifications.create).not.toHaveBeenCalled();
  });

  it('a tab question is a confirmation-channel notification naming the tab, never the question', async () => {
    const { service, repos, sent } = setup();
    stop = service.start();
    chatBus.publish({
      type: 'tab_question',
      user_id: 'u1',
      conversation_id: 'cp',
      question: { id: 'q1', tab_id: 't1', tab_name: 'api', kind: 'choice', payload: { questions: [{ question: 'Apagar o banco?', header: 'DB', multi_select: false, options: [{ label: 'Sim', description: '', recommended: false }, { label: 'Não', description: '', recommended: true }] }] }, status: 'open', answer: null, error_code: null, created_at: '', answered_at: null, closed_at: null },
    });
    await flush();
    expect(repos.userNotifications.create).toHaveBeenCalledWith(expect.objectContaining({ kind: 'confirmation', data: { kind: 'tab_question', conversation_id: 'cp', project_id: 'p1', tab_question_id: 'q1' } }));
    expect(sent[0]![0]).toMatchObject({ title: 'termhub precisa de você', body: 'A aba api fez uma pergunta.' });
    expect(JSON.stringify(sent)).not.toContain('Apagar');
  });

  it('a confirmation re-published only to add its subagent origin (origin_update) is not notified again', async () => {
    const t = setup();
    stop = t.service.start();
    chatBus.publish(confirmation);
    await flush();
    // The live run bound the action to its subagent after the gate had already published the card.
    chatBus.publish({ ...confirmation, subagent: { id: 'sub1', description: 'Escrever testes' }, origin_update: true } as ChatEvent);
    await flush();
    expect(t.repos.userNotifications.create).toHaveBeenCalledTimes(1);
    expect(t.sent).toHaveLength(1);
  });

  it('a card brought back to the end of the chat (resurfaced) is not notified again (TER-477)', async () => {
    const { service, sent, repos } = setup();
    stop = service.start();
    chatBus.publish({ ...confirmation, surfaced_at: '2026-09-30T06:00:00.000Z', resurfaced: true } as ChatEvent);
    const question = { id: 'q1', tab_id: 't1', tab_name: 'api', kind: 'permission' as const, payload: { tool_name: 'Bash' }, status: 'open' as const, answer: null, error_code: null, created_at: '', answered_at: null, closed_at: null };
    chatBus.publish({ type: 'tab_question', user_id: 'u1', conversation_id: 'cp', question, resurfaced: true } as ChatEvent);
    await flush();
    expect(repos.userNotifications.create).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  it('the same open question republished because its card changed (update) is not notified again (TER-919)', async () => {
    const { service, sent, repos } = setup();
    stop = service.start();
    const question = { id: 'q1', tab_id: 't1', tab_name: 'api', kind: 'choice' as const, payload: { questions: [] }, status: 'open' as const, answer: null, error_code: null, created_at: '', answered_at: null, closed_at: null };
    chatBus.publish({ type: 'tab_question', user_id: 'u1', conversation_id: 'cp', question } as ChatEvent);
    await flush();
    // A countdown, a concierge suggestion, a cancel, the switch turned off, a lost sender: each redraws the card.
    for (let i = 0; i < 5; i++) chatBus.publish({ type: 'tab_question', user_id: 'u1', conversation_id: 'cp', question, update: true } as ChatEvent);
    await flush();
    expect(repos.userNotifications.create).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(1);
  });

  it('answered and closed tab questions write no row and show nothing: their rows go read, the badge follows (TER-923)', async () => {
    const { service, sent, repos } = setup();
    stop = service.start();
    const question = { id: 'q1', tab_id: 't1', tab_name: 'api', kind: 'permission' as const, payload: { tool_name: 'Bash' }, status: 'answered' as const, answer: { allow: true }, error_code: null, created_at: '', answered_at: '', closed_at: null };
    chatBus.publish({ type: 'tab_question_answered', user_id: 'u1', conversation_id: 'cp', question });
    chatBus.publish({ type: 'tab_question_closed', user_id: 'u1', conversation_id: 'cp', question });
    await flush();
    expect(repos.userNotifications.create).not.toHaveBeenCalled();
    expect(repos.userNotifications.markReadByData).toHaveBeenCalledWith('u1', 'tab_question_id', 'q1', expect.any(Date));
    expect(sent.flat().every((m) => m.title === undefined && m.badge === 3 && m.data.kind === 'badge')).toBe(true);
  });
});

describe('MobilePushService — account pending deletion (TER-920)', () => {
  const question = { id: 'q1', tab_id: 't1', tab_name: 'api', kind: 'permission' as const, payload: { tool_name: 'Bash' }, status: 'open' as const, answer: null, error_code: null, created_at: '', answered_at: null, closed_at: null };

  it('sends nothing and writes no history row for any event while the deletion is pending', async () => {
    const t = setup({ deletionScheduledAt: '2026-11-03T00:00:00.000Z' });
    stop = t.service.start();
    chatBus.publish(confirmation);
    chatBus.publish({ type: 'tab_question', user_id: 'u1', conversation_id: 'cp', question } as ChatEvent);
    chatBus.publish(finished('cp'));
    await t.service.deviceRequest(user, { id: 'r1', model: 'Pixel 8', city: null, country: null } as unknown as DeviceRequest);
    await flush();
    expect(t.repos.users.findById).toHaveBeenCalledWith('u1');
    expect(t.repos.userNotifications.create).not.toHaveBeenCalled();
    expect(t.sent).toEqual([]);
  });

  it('sends nothing for a user that no longer exists', async () => {
    const t = setup();
    t.repos.users.findById.mockResolvedValueOnce(undefined as never);
    stop = t.service.start();
    chatBus.publish(confirmation);
    await flush();
    expect(t.repos.userNotifications.create).not.toHaveBeenCalled();
    expect(t.sent).toEqual([]);
  });

  it('pushes again once the deletion is cancelled', async () => {
    const t = setup();
    stop = t.service.start();
    chatBus.publish(confirmation);
    await flush();
    expect(t.sent).toHaveLength(1);
  });
});

describe('ExpoPushSender', () => {
  const msg = (i: number): PushMessage => ({ to: `ExponentPushToken[${i}]`, title: 't', body: 'b', data: { kind: 'reply' }, ...(i === 0 ? { collapseId: 'reply:c1' } : {}) });

  it('posts chunks of 100 with the bearer token and maps per-ticket errors', async () => {
    const fetchImpl = vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { to: string }[];
      return new Response(JSON.stringify({ data: body.map((m, i) => (i === 1 ? { status: 'error', message: 'nope', details: { error: 'DeviceNotRegistered' } } : i === 2 ? { status: 'error', message: 'Other' } : { status: 'ok', id: 'x' })) }), { status: 200 });
    });
    const sender = new ExpoPushSender('tok', fetchImpl as never);
    const messages = Array.from({ length: 150 }, (_, i) => msg(i));
    const results = await sender.send(messages);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, { method: string; headers: Record<string, string>; body: string }];
    expect(url).toBe('https://exp.host/--/api/v2/push/send');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'content-type': 'application/json', accept: 'application/json', authorization: 'Bearer tok' });
    const first = JSON.parse(init.body);
    expect(first).toHaveLength(100);
    expect(first[0]).toEqual({ to: 'ExponentPushToken[0]', title: 't', body: 'b', data: { kind: 'reply' }, sound: 'default', priority: 'high', collapseId: 'reply:c1' });
    expect(first[3]).not.toHaveProperty('collapseId');
    expect(JSON.parse((fetchImpl.mock.calls[1] as unknown as [string, { body: string }])[1].body)).toHaveLength(50);
    expect(results).toHaveLength(150);
    expect(results[1]).toEqual({ to: 'ExponentPushToken[1]', error: 'DeviceNotRegistered' });
    expect(results[2]).toEqual({ to: 'ExponentPushToken[2]', error: 'Other' });
    expect(results[0]).toEqual({ to: 'ExponentPushToken[0]', id: 'x' });
  });

  it('sends no Authorization header without a token', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: [{ status: 'ok' }] }), { status: 200 }));
    await new ExpoPushSender(null, fetchImpl as never).send([msg(1)]);
    const init = (fetchImpl.mock.calls[0] as unknown as [string, { headers: Record<string, string> }])[1];
    expect(Object.keys(init.headers).map((k) => k.toLowerCase())).not.toContain('authorization');
  });

  it('gives each request a 10 s timeout signal', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: [{ status: 'ok' }] }), { status: 200 }));
    await new ExpoPushSender(null, fetchImpl as never).send([msg(1)]);
    expect(timeout).toHaveBeenCalledWith(10_000);
    const init = (fetchImpl.mock.calls[0] as unknown as [string, { signal: AbortSignal }])[1];
    expect(init.signal).toBeInstanceOf(AbortSignal);
    timeout.mockRestore();
  });

  it('a timed-out fetch (AbortError) is a send failure: logged by the service, never thrown', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new DOMException('The operation was aborted due to timeout', 'AbortError');
    });
    const t = setup();
    const log = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
    const service = new MobilePushService({ repos: t.repos as unknown as Repositories, sender: new ExpoPushSender(null, fetchImpl as never), sockets: t.sockets as never, log: log as never });
    await expect(service.deviceRequest(user, { id: 'r1', model: 'Pixel 8', city: null, country: null } as unknown as DeviceRequest)).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(t.repos.userNotifications.create).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ err: 'AbortError' }), 'mobile push send failed');
  });

  it('throws on a non-2xx answer', async () => {
    const fetchImpl = vi.fn(async () => new Response('bad', { status: 500 }));
    await expect(new ExpoPushSender(null, fetchImpl as never).send([msg(1)])).rejects.toThrow();
  });
});

describe('push receipts (TER-924)', () => {
  it('records the ticket of every accepted push, with its device and token, and none for a refused one', async () => {
    const t = setup();
    t.sender.send.mockImplementationOnce(async (messages: PushMessage[]) => [
      { to: messages[0]!.to, id: 'tk-a' },
      { to: messages[1]!.to, error: 'DeviceNotRegistered' },
    ]);
    await t.service.deviceRequest(user, { id: 'r1', model: 'Pixel 8', city: null, country: null } as unknown as DeviceRequest);
    expect(t.repos.pushTickets.recordMany).toHaveBeenCalledWith([{ ticket_id: 'tk-a', device_id: 'd1', push_token: 'ExponentPushToken[a]', kind: 'device_request' }]);
  });

  it('a failure to record tickets is logged and does not stop the dead-token cleanup', async () => {
    const t = setup();
    t.repos.pushTickets.recordMany.mockRejectedValueOnce(new Error('db down'));
    t.sender.send.mockImplementationOnce(async (messages: PushMessage[]) => [{ to: messages[0]!.to, id: 'tk-a' }, { to: messages[1]!.to, error: 'DeviceNotRegistered' }]);
    await t.service.deviceRequest(user, { id: 'r1', model: 'Pixel 8', city: null, country: null } as unknown as DeviceRequest);
    expect(t.log.warn).toHaveBeenCalledWith(expect.objectContaining({ kind: 'device_request' }), 'recording push tickets failed');
    expect(t.repos.devices.setPushToken).toHaveBeenCalledWith('d2', null);
  });

  function sweepSetup(tickets: { id: string; ticket_id: string; device_id: string; push_token: string; kind: string }[], receipts: Map<string, PushReceipt>) {
    const repos = {
      pushTickets: { deleteSentBefore: vi.fn(async () => 0), claimDue: vi.fn(async () => tickets.map((t) => ({ ...t, created_at: '' }))), deleteMany: vi.fn(async () => undefined) },
      devices: { clearPushTokenIf: vi.fn(async () => true), findById: vi.fn(async (id: string) => ({ id, user_id: 'u1' })) },
      deviceEvents: { record: vi.fn(async () => undefined) },
    };
    const fetcher = { fetch: vi.fn(async () => receipts) };
    const log = { warn: vi.fn(), info: vi.fn() };
    return { repos, fetcher, log, run: (now: Date) => sweepPushReceipts({ repos: repos as never, receipts: fetcher, log }, now) };
  }

  it('reads due receipts: clears a dead token, records push_failed per device, logs codes only, deletes what it read', async () => {
    const now = new Date('2026-10-05T12:00:00.000Z');
    const s = sweepSetup(
      [
        { id: 'p1', ticket_id: 'tk1', device_id: 'd1', push_token: 'ExponentPushToken[a]', kind: 'reply' },
        { id: 'p2', ticket_id: 'tk2', device_id: 'd2', push_token: 'ExponentPushToken[b]', kind: 'confirmation' },
        { id: 'p3', ticket_id: 'tk3', device_id: 'd3', push_token: 'ExponentPushToken[c]', kind: 'reply' },
        { id: 'p4', ticket_id: 'tk4', device_id: 'd2', push_token: 'ExponentPushToken[b]', kind: 'reply' },
      ],
      new Map<string, PushReceipt>([
        ['tk1', { status: 'error', error: 'DeviceNotRegistered' }],
        ['tk2', { status: 'error', error: 'InvalidCredentials' }],
        ['tk4', { status: 'ok' }],
        // tk3: not ready yet
      ]),
    );
    expect(await s.run(now)).toEqual({ read: 3, failed: 2 });
    // Sent over 15 min ago, unclaimed for 30 min; anything past Expo's 24 h is dropped first.
    expect(s.repos.pushTickets.claimDue).toHaveBeenCalledWith(new Date('2026-10-05T11:45:00.000Z'), new Date('2026-10-05T11:30:00.000Z'), now, 1000);
    expect(s.repos.pushTickets.deleteSentBefore).toHaveBeenCalledWith(new Date('2026-10-04T12:00:00.000Z'));
    expect(s.fetcher.fetch).toHaveBeenCalledWith(['tk1', 'tk2', 'tk3', 'tk4']);
    expect(s.repos.devices.clearPushTokenIf).toHaveBeenCalledTimes(1);
    expect(s.repos.devices.clearPushTokenIf).toHaveBeenCalledWith('d1', 'ExponentPushToken[a]');
    expect(s.repos.deviceEvents.record).toHaveBeenCalledWith({ user_id: 'u1', device_id: 'd1', kind: 'push_failed', actor: 'system', meta: { code: 'DeviceNotRegistered' } });
    expect(s.repos.deviceEvents.record).toHaveBeenCalledWith({ user_id: 'u1', device_id: 'd2', kind: 'push_failed', actor: 'system', meta: { code: 'InvalidCredentials' } });
    expect(s.repos.deviceEvents.record).toHaveBeenCalledTimes(2);
    expect(s.repos.pushTickets.deleteMany).toHaveBeenCalledWith(['p1', 'p2', 'p4']);
    expect(s.log.warn).toHaveBeenCalledWith({ deviceId: 'd2', ticketId: 'tk2', kind: 'confirmation', code: 'InvalidCredentials' }, 'mobile push receipt error');
    expect(JSON.stringify(s.log.warn.mock.calls)).not.toContain('ExponentPushToken');
  });

  it('nothing due: no call to Expo', async () => {
    const s = sweepSetup([], new Map());
    expect(await s.run(new Date())).toEqual({ read: 0, failed: 0 });
    expect(s.fetcher.fetch).not.toHaveBeenCalled();
  });

  it('ExpoReceiptFetcher posts ids in chunks of 300 and maps ok, errors and missing receipts', async () => {
    const fetchImpl = vi.fn(async (_url: string, init: { body: string }) => {
      const { ids } = JSON.parse(init.body) as { ids: string[] };
      const data: Record<string, unknown> = {};
      for (const id of ids) if (id !== 'r5') data[id] = id === 'r1' ? { status: 'error', message: 'x', details: { error: 'MessageTooBig' } } : { status: 'ok' };
      return new Response(JSON.stringify({ data }), { status: 200 });
    });
    const ids = Array.from({ length: 450 }, (_, i) => `r${i}`);
    const out = await new ExpoReceiptFetcher('tok', fetchImpl as never).fetch(ids);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, { headers: Record<string, string>; body: string }];
    expect(url).toBe('https://exp.host/--/api/v2/push/getReceipts');
    expect(init.headers).toMatchObject({ authorization: 'Bearer tok' });
    expect(JSON.parse(init.body).ids).toHaveLength(300);
    expect(out.get('r1')).toEqual({ status: 'error', error: 'MessageTooBig' });
    expect(out.get('r0')).toEqual({ status: 'ok' });
    expect(out.has('r5')).toBe(false);
    expect(out.size).toBe(449);
  });

  it('ExpoReceiptFetcher throws on a non-2xx answer', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 503 }));
    await expect(new ExpoReceiptFetcher(null, fetchImpl as never).fetch(['a'])).rejects.toMatchObject({ code: 'EXPO_HTTP_503' });
  });
});

describe('MobilePushService.testPush (TER-913)', () => {
  const dev = mkDevice('d1', 'ExponentPushToken[a]');
  const ok = (id = 'tk1') => async (messages: PushMessage[]) => messages.map((m) => ({ to: m.to, id }));

  afterEach(() => vi.useRealTimers());

  it('sends one message to that device even with a live socket, no history row, "[Teste]" title, data.test, the latest conversation', async () => {
    const t = setup({ live: ['d1'] });
    const res = await t.service.testPush(user, dev, 'confirmation', 0);
    expect(res.ticket).toEqual({ status: 'ok' });
    expect(t.repos.userNotifications.create).not.toHaveBeenCalled();
    expect(t.sent).toEqual([
      [
        {
          to: 'ExponentPushToken[a]',
          title: '[Teste] termhub precisa de você',
          body: 'O chat do projeto termhub pediu sua confirmação.',
          data: { kind: 'confirmation', conversation_id: 'cp', project_id: 'p1', test: true },
        },
      ],
    ]);
    expect(t.sent[0]![0]!.data).not.toHaveProperty('notification_id');
  });

  it.each([
    ['tab_question', '[Teste] termhub precisa de você', 'A aba teste pede permissão para continuar.'],
    ['reply', '[Teste] Resposta pronta em termhub', 'O chat do projeto termhub terminou de responder.'],
  ] as const)('%s uses the real text', async (kind, title, body) => {
    const t = setup();
    await t.service.testPush(user, dev, kind, 0);
    expect(t.sent[0]![0]).toMatchObject({ title, body, data: { kind, conversation_id: 'cp', test: true } });
  });

  it('device_request names no conversation; with no conversation at all, the tap just opens the app', async () => {
    const t = setup();
    await t.service.testPush(user, dev, 'device_request', 0);
    expect(t.sent[0]![0]).toMatchObject({ title: '[Teste] Novo aparelho pede acesso', data: { kind: 'device_request', test: true } });
    expect(t.repos.chat.findLatestActiveForUser).not.toHaveBeenCalled();
    t.repos.chat.findLatestActiveForUser.mockResolvedValueOnce(undefined);
    await t.service.testPush(user, dev, 'reply', 0);
    expect(t.sent[1]![0]).toEqual({ to: 'ExponentPushToken[a]', title: '[Teste] Resposta pronta em Projeto de teste', body: 'O chat do projeto Projeto de teste terminou de responder.', data: { kind: 'reply', test: true } });
  });

  it('409 NO_PUSH_TOKEN for a device without a token', async () => {
    const t = setup();
    await expect(t.service.testPush(user, { ...dev, push_token: null } as Device, 'confirmation', 0)).rejects.toMatchObject({ statusCode: 409, code: 'NO_PUSH_TOKEN' });
    expect(t.sent).toEqual([]);
  });

  it('429 PUSH_TEST_RATE_LIMITED on the seventh call in a minute, per device', async () => {
    const t = setup();
    for (let i = 0; i < 6; i++) await t.service.testPush(user, dev, 'confirmation', 0);
    await expect(t.service.testPush(user, dev, 'confirmation', 0)).rejects.toMatchObject({ statusCode: 429, code: 'PUSH_TEST_RATE_LIMITED' });
    await expect(t.service.testPush(user, mkDevice('d2', 'ExponentPushToken[b]'), 'confirmation', 0)).resolves.toBeTruthy();
  });

  it('a delay answers at once with no ticket and sends later', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-05T00:00:00.000Z') });
    const t = setup();
    const res = await t.service.testPush(user, dev, 'confirmation', 10);
    expect(res).toEqual({ scheduled_for: '2026-10-05T00:00:10.000Z', ticket: null });
    expect(t.sender.send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.sender.send).toHaveBeenCalledTimes(1);
  });

  it('records the receipt as a push_test event ~15 s later: delivered, an error, or pending after a retry', async () => {
    vi.useFakeTimers();
    const t = setup();
    t.sender.send.mockImplementation(ok('tk1'));
    t.receipts.fetch.mockResolvedValueOnce(new Map([['tk1', { status: 'ok' }]]));
    await t.service.testPush(user, dev, 'reply', 0);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(t.repos.deviceEvents.record).toHaveBeenLastCalledWith({ user_id: 'u1', device_id: 'd1', kind: 'push_test', actor: 'user', meta: { kind: 'reply', outcome: 'delivered_to_provider' } });

    t.receipts.fetch.mockResolvedValueOnce(new Map([['tk1', { status: 'error', error: 'InvalidCredentials' }]]));
    await t.service.testPush(user, dev, 'reply', 0);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(t.repos.deviceEvents.record).toHaveBeenLastCalledWith(expect.objectContaining({ meta: { kind: 'reply', outcome: 'InvalidCredentials' } }));
    expect(t.repos.devices.clearPushTokenIf).not.toHaveBeenCalled();

    t.receipts.fetch.mockResolvedValue(new Map());
    await t.service.testPush(user, dev, 'reply', 0);
    await vi.advanceTimersByTimeAsync(15_000 + 60_000);
    expect(t.repos.deviceEvents.record).toHaveBeenLastCalledWith(expect.objectContaining({ meta: { kind: 'reply', outcome: 'receipt_pending' } }));
    expect(JSON.stringify(t.log.warn.mock.calls) + JSON.stringify(t.log.info.mock.calls)).not.toContain('ExponentPushToken');
  });

  it('a ticket error answers it, records it and clears a dead token', async () => {
    const t = setup();
    t.sender.send.mockImplementationOnce(async (m: PushMessage[]) => [{ to: m[0]!.to, error: 'DeviceNotRegistered' }]);
    expect((await t.service.testPush(user, dev, 'confirmation', 0)).ticket).toEqual({ status: 'error', error: 'DeviceNotRegistered' });
    expect(t.repos.devices.clearPushTokenIf).toHaveBeenCalledWith('d1', 'ExponentPushToken[a]');
    expect(t.repos.deviceEvents.record).toHaveBeenCalledWith(expect.objectContaining({ kind: 'push_test', meta: { kind: 'confirmation', outcome: 'DeviceNotRegistered' } }));
  });

  it('a thrown send answers send_failed and never rejects', async () => {
    const t = setup();
    t.sender.send.mockRejectedValueOnce(new Error('down'));
    expect((await t.service.testPush(user, dev, 'confirmation', 0)).ticket).toEqual({ status: 'error', error: 'send_failed' });
    expect(t.repos.deviceEvents.record).toHaveBeenCalledWith(expect.objectContaining({ meta: { kind: 'confirmation', outcome: 'send_failed' } }));
  });
});

describe('badge and handled cards (TER-923)', () => {
  it('a decided or ended action marks its rows read and sends a badge-only update to every phone with a token', async () => {
    const t = setup({ live: ['d1'] });
    t.repos.userNotifications.countUnread.mockResolvedValue(1);
    stop = t.service.start();
    chatBus.publish({ type: 'decision', user_id: 'u1', conversation_id: 'cp', action_id: 'a1', status: 'approved' });
    await flush();
    expect(t.repos.userNotifications.markReadByData).toHaveBeenCalledWith('u1', 'action_id', 'a1', expect.any(Date));
    expect(t.sent).toEqual([
      [
        { to: 'ExponentPushToken[a]', data: { kind: 'badge' }, badge: 1 },
        { to: 'ExponentPushToken[b]', data: { kind: 'badge' }, badge: 1 },
      ],
    ]);
    chatBus.publish({ type: 'action_status', user_id: 'u1', conversation_id: 'cp', action_id: 'a2', status: 'expired', error_code: null });
    await flush();
    expect(t.repos.userNotifications.markReadByData).toHaveBeenLastCalledWith('u1', 'action_id', 'a2', expect.any(Date));
  });

  it('nothing to mark read: no push', async () => {
    const t = setup();
    t.repos.userNotifications.markReadByData.mockResolvedValue(0);
    stop = t.service.start();
    chatBus.publish({ type: 'decision', user_id: 'u1', conversation_id: 'cp', action_id: 'a1', status: 'denied' });
    await flush();
    expect(t.sent).toEqual([]);
  });

  it('ExpoPushSender sends a badge-only message without title, sound or priority', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: [{ status: 'ok', id: 'x' }] }), { status: 200 }));
    await new ExpoPushSender(null, fetchImpl as never).send([{ to: 'ExponentPushToken[a]', data: { kind: 'badge' }, badge: 0 }]);
    const body = JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, { body: string }])[1].body);
    expect(body).toEqual([{ to: 'ExponentPushToken[a]', data: { kind: 'badge' }, badge: 0 }]);
  });
});

describe('MobilePushService — aba terminou (TER-925)', () => {
  const state = (id: string, s: Tab['state'], owner: string | null = 'u1') =>
    monitorBus.publish({ tab: { id, state: s } as Tab, project_id: 'p1', machine_id: 'm1', owner_id: owner });

  afterEach(() => vi.useRealTimers());

  async function finish(t: ReturnType<typeof setup>, id = 't1', end: Tab['state'] = 'waiting_input') {
    state(id, 'working');
    state(id, end);
    await vi.advanceTimersByTimeAsync(5_000);
  }

  it('a tab that worked and stopped pushes once, naming tab and machine, with tab_id to open it', async () => {
    vi.useFakeTimers();
    const t = setup({ live: ['d2'] });
    stop = t.service.start();
    await finish(t);
    expect(t.repos.users.pushTabFinished).toHaveBeenCalledWith('u1');
    expect(t.repos.userNotifications.create).toHaveBeenCalledWith({
      user_id: 'u1',
      kind: 'reply',
      title: 'termhub: aba terminou',
      body: 'A aba api (jarvis) terminou e espera você.',
      data: { kind: 'tab_finished', tab_id: 't1', project_id: 'p1', conversation_id: 'cp' },
    });
    expect(t.sent).toEqual([[expect.objectContaining({ to: 'ExponentPushToken[a]', collapseId: 'tab:t1', data: expect.objectContaining({ tab_id: 't1', notification_id: 'n1' }) })]]);
  });

  it('is opt-in: nothing for an owner who did not turn it on', async () => {
    vi.useFakeTimers();
    const t = setup();
    t.repos.users.pushTabFinished.mockResolvedValue(false);
    stop = t.service.start();
    await finish(t);
    expect(t.repos.userNotifications.create).not.toHaveBeenCalled();
    expect(t.sent).toEqual([]);
  });

  it('at most once per tab every five minutes; another tab is separate; an agent exit (idle) counts', async () => {
    vi.useFakeTimers();
    const t = setup();
    stop = t.service.start();
    await finish(t, 't1');
    await finish(t, 't1');
    await finish(t, 't2', 'idle');
    expect(t.sent).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await finish(t, 't1');
    expect(t.sent).toHaveLength(3);
  });

  it('never for a tab not seen working, one working again within the pause, or one ending in an error', async () => {
    vi.useFakeTimers();
    const t = setup();
    stop = t.service.start();
    state('t1', 'waiting_input');
    await vi.advanceTimersByTimeAsync(5_000);
    state('t1', 'working');
    state('t1', 'waiting_input');
    state('t1', 'working');
    await vi.advanceTimersByTimeAsync(5_000);
    state('t3', 'working');
    state('t3', 'error');
    state('t3', 'waiting_input');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(t.sent).toEqual([]);
  });

  it('a turn that ends with a plain report (finished, TER-972) is pushed too', async () => {
    vi.useFakeTimers();
    const t = setup();
    t.repos.tabs.findById.mockResolvedValue({ id: 't1', project_id: 'p1', machine_id: 'm1', state: 'finished' });
    stop = t.service.start();
    await finish(t, 't1', 'finished');
    expect(t.sent).toHaveLength(1);
  });

  it('a permission prompt or background work in the middle is still the same turn', async () => {
    vi.useFakeTimers();
    const t = setup();
    stop = t.service.start();
    state('t1', 'working');
    state('t1', 'waiting_permission');
    state('t1', 'waiting_background');
    state('t1', 'waiting_input');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(t.sent).toHaveLength(1);
  });

  it('skips a tab with an open question or permission card (already "precisa de você"), not one with a suggestion', async () => {
    vi.useFakeTimers();
    const t = setup();
    stop = t.service.start();
    t.repos.tabQuestions.findOpenForTab.mockResolvedValueOnce({ kind: 'choice' });
    await finish(t, 't1');
    expect(t.sent).toEqual([]);
    t.repos.tabQuestions.findOpenForTab.mockResolvedValueOnce({ kind: 'suggestion' });
    await finish(t, 't2');
    expect(t.sent).toHaveLength(1);
  });

  it('re-reads the tab: one working again by now, or gone, is not pushed; no owner, nothing', async () => {
    vi.useFakeTimers();
    const t = setup();
    stop = t.service.start();
    t.repos.tabs.findById.mockResolvedValueOnce({ id: 't1', project_id: 'p1', machine_id: 'm1', state: 'working' });
    await finish(t, 't1');
    t.repos.tabs.findById.mockResolvedValueOnce(undefined);
    await finish(t, 't2');
    state('t4', 'working', null);
    state('t4', 'waiting_input', null);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(t.sent).toEqual([]);
  });

  it('stop() cancels a pending one', async () => {
    vi.useFakeTimers();
    const t = setup();
    const stopIt = t.service.start();
    state('t1', 'working');
    state('t1', 'waiting_input');
    stopIt();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(t.sent).toEqual([]);
  });
});
