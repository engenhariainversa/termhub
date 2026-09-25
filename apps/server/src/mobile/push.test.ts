import { afterEach, describe, expect, it, vi } from 'vitest';
import { chatBus, type ChatEvent } from '../chat/bus.js';
import type { Repositories } from '../db/repositories/index.js';
import type { Device } from '../db/repositories/devices.js';
import type { DeviceRequest } from '../db/repositories/device-requests.js';
import type { User } from '../db/repositories/types.js';
import { ExpoPushSender, MobilePushService, type PushMessage, type PushSender } from './push.js';

const mkDevice = (id: string, token: string): Device => ({ id, user_id: 'u1', push_token: token, status: 'active' }) as unknown as Device;
const user = { id: 'u1', email: 'ana@example.com' } as unknown as User;

function setup(opts: { devices?: Device[]; live?: string[] } = {}) {
  const devices = opts.devices ?? [mkDevice('d1', 'ExponentPushToken[a]'), mkDevice('d2', 'ExponentPushToken[b]')];
  const repos = {
    devices: { listActiveWithPush: vi.fn(async () => devices), setPushToken: vi.fn(async () => undefined) },
    userNotifications: { create: vi.fn(async (input: object) => ({ id: 'n1', ...input })) },
    projects: { findByIdsForOwner: vi.fn(async () => [{ id: 'p1', name: 'termhub' }]) },
    tabs: { findByIdsForOwner: vi.fn(async () => [{ id: 't1', name: 'api' }]) },
    machines: { findByIdsForOwner: vi.fn(async () => [{ id: 'm1', name: 'jarvis' }]) },
    // cp / c9: conversations of project p1; cx: unknown to this user; anything else: the account-wide chat.
    chat: { findByIdForUser: vi.fn(async (id: string) => (id === 'cx' ? undefined : { id, user_id: 'u1', project_id: id === 'cp' || id === 'c9' ? 'p1' : null })) },
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
  const service = new MobilePushService({ repos: repos as unknown as Repositories, sender, sockets: sockets as never, log: log as never });
  return { repos, sender, sent, sockets, log, service };
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
    expect(messages[0]).toEqual({
      to: 'ExponentPushToken[a]',
      title: 'termhub precisa de você',
      body: 'O chat do projeto termhub pediu confirmação para agir na aba api (jarvis).',
      data: { kind: 'confirmation', conversation_id: 'cp', project_id: 'p1', action_id: 'a1' },
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
      data: { kind: 'confirmation', conversation_id: 'c1', project_id: null, action_id: 'a1' },
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
      data: { kind: 'device_request' },
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

  it('answered and closed tab questions push nothing', async () => {
    const { service, sent, repos } = setup();
    stop = service.start();
    const question = { id: 'q1', tab_id: 't1', tab_name: 'api', kind: 'permission' as const, payload: { tool_name: 'Bash' }, status: 'answered' as const, answer: { allow: true }, error_code: null, created_at: '', answered_at: '', closed_at: null };
    chatBus.publish({ type: 'tab_question_answered', user_id: 'u1', conversation_id: 'cp', question });
    chatBus.publish({ type: 'tab_question_closed', user_id: 'u1', conversation_id: 'cp', question });
    await flush();
    expect(sent).toEqual([]);
    expect(repos.userNotifications.create).not.toHaveBeenCalled();
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
    expect(results[0]).toEqual({ to: 'ExponentPushToken[0]', error: undefined });
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
