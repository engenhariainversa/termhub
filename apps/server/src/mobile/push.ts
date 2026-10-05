import type { FastifyBaseLogger } from 'fastify';
import { chatBus, type ChatEvent } from '../chat/bus.js';
import { failureLabel } from '../chat/service.js';
import type { Device } from '../db/repositories/devices.js';
import type { DeviceRequest } from '../db/repositories/device-requests.js';
import type { Repositories } from '../db/repositories/index.js';
import type { User } from '../db/repositories/types.js';
import type { PushTestKind, PushTestResponse } from '@termhub/mobile-api';
import { HttpError } from '../lib/errors.js';
import { confirmationText, deviceRequestText, replyText, tabQuestionText, type PushContext, type PushText } from './push-text.js';
import { SlidingWindow } from './rate-limit.js';
import type { MobileSocketRegistry } from './revocation.js';

export interface PushMessage {
  to: string;
  /** Absent on a badge-only update (TER-923): nothing is shown, the icon's number changes. */
  title?: string;
  body?: string;
  data: Record<string, unknown>;
  collapseId?: string;
  /** The icon badge (iOS): the person's unread history rows. */
  badge?: number;
}

/** One message's ticket: `id` names its receipt (TER-924); `error` is Expo's per-ticket error code. */
export interface PushTicketResult {
  to: string;
  id?: string;
  error?: 'DeviceNotRegistered' | string;
}

export interface PushSender {
  /** One result per message, in order. */
  send(messages: PushMessage[]): Promise<PushTicketResult[]>;
}

/** A receipt: what APNs/FCM made of the push, as Expo reports it later. */
export type PushReceipt = { status: 'ok' } | { status: 'error'; error: string };

export interface PushReceiptFetcher {
  /** The receipts Expo has for `ids`; an id missing from the map has none yet. */
  fetch(ids: string[]): Promise<Map<string, PushReceipt>>;
}

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const EXPO_RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts';
const EXPO_CHUNK = 100;
const EXPO_RECEIPT_CHUNK = 300;

interface ExpoTicket {
  id?: string;
  status?: string;
  message?: string;
  details?: { error?: string };
}

const expoHeaders = (accessToken: string | null): Record<string, string> => {
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  return headers;
};

/** How long one chunk may take before it is abandoned (a hung Expo must not pin a background task). */
const EXPO_TIMEOUT_MS = 10_000;

/**
 * Sends through the Expo Push Service over HTTPS, in chunks of 100 (Expo's per-request limit), each
 * with a 10 s timeout; a timeout rejects like any other failure and the caller logs it.
 */
export class ExpoPushSender implements PushSender {
  constructor(
    private readonly accessToken: string | null,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(messages: PushMessage[]): Promise<PushTicketResult[]> {
    const results: PushTicketResult[] = [];
    for (let i = 0; i < messages.length; i += EXPO_CHUNK) {
      const chunk = messages.slice(i, i + EXPO_CHUNK);
      const res = await this.fetchImpl(EXPO_PUSH_URL, {
        method: 'POST',
        headers: expoHeaders(this.accessToken),
        signal: AbortSignal.timeout(EXPO_TIMEOUT_MS),
        body: JSON.stringify(
          chunk.map((m) =>
            m.title === undefined
              ? { to: m.to, data: m.data, ...(m.badge !== undefined ? { badge: m.badge } : {}) }
              : {
                  to: m.to,
                  title: m.title,
                  body: m.body,
                  data: m.data,
                  sound: 'default',
                  priority: 'high',
                  ...(m.collapseId ? { collapseId: m.collapseId } : {}),
                  ...(m.badge !== undefined ? { badge: m.badge } : {}),
                },
          ),
        ),
      });
      if (!res.ok) throw Object.assign(new Error(`Expo push answered ${res.status}`), { code: `EXPO_HTTP_${res.status}` });
      const tickets = ((await res.json()) as { data?: ExpoTicket[] }).data ?? [];
      chunk.forEach((m, j) => {
        const t = tickets[j];
        const error = t?.details?.error ?? (t?.status === 'error' ? t.message : undefined);
        results.push({ to: m.to, ...(t?.status === 'ok' && t.id ? { id: t.id } : {}), ...(error ? { error } : {}) });
      });
    }
    return results;
  }
}

/** Reads receipts from the Expo Push Service, in chunks of 300 ids, each with a 10 s timeout. */
export class ExpoReceiptFetcher implements PushReceiptFetcher {
  constructor(
    private readonly accessToken: string | null,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async fetch(ids: string[]): Promise<Map<string, PushReceipt>> {
    const out = new Map<string, PushReceipt>();
    for (let i = 0; i < ids.length; i += EXPO_RECEIPT_CHUNK) {
      const chunk = ids.slice(i, i + EXPO_RECEIPT_CHUNK);
      const res = await this.fetchImpl(EXPO_RECEIPTS_URL, {
        method: 'POST',
        headers: expoHeaders(this.accessToken),
        signal: AbortSignal.timeout(EXPO_TIMEOUT_MS),
        body: JSON.stringify({ ids: chunk }),
      });
      if (!res.ok) throw Object.assign(new Error(`Expo receipts answered ${res.status}`), { code: `EXPO_HTTP_${res.status}` });
      const data = ((await res.json()) as { data?: Record<string, ExpoTicket> }).data ?? {};
      for (const id of chunk) {
        const r = data[id];
        if (!r) continue;
        out.set(id, r.status === 'ok' ? { status: 'ok' } : { status: 'error', error: r.details?.error ?? 'Unknown' });
      }
    }
    return out;
  }
}

/** A test push's receipt is read this long after the send, then once more if it was not ready. */
export const TEST_RECEIPT_AFTER_MS = 15_000;
export const TEST_RECEIPT_RETRY_MS = 60_000;

/** A receipt is read once the ticket is this old: Expo says they are ready within 15 minutes. */
export const RECEIPT_AFTER_MS = 15 * 60_000;
/** A claim whose receipt was not ready yet (or whose sweeper died) is taken again after this. */
const RECEIPT_RECLAIM_MS = 30 * 60_000;
/** Expo keeps a receipt for 24 hours. */
const RECEIPT_KEPT_MS = 24 * 60 * 60_000;
const RECEIPT_SWEEP_MS = 5 * 60_000;
const RECEIPT_BATCH = 1000;

export interface PushReceiptSweepDeps {
  repos: Pick<Repositories, 'pushTickets' | 'devices' | 'deviceEvents'>;
  receipts: PushReceiptFetcher;
  log: Pick<FastifyBaseLogger, 'info' | 'warn'>;
}

/**
 * One pass over the tickets whose receipt should be ready (TER-924): `DeviceNotRegistered` clears that
 * device's token (only if it is still the one the push went to), and every error — a dead token, an
 * APNs/FCM credential problem (`InvalidCredentials`), `MessageTooBig` — is logged with its code and
 * recorded once per device as a `push_failed` event, which Aparelhos shows. Tickets with a receipt are
 * deleted; the others wait for a later pass, until Expo's 24 h are over. Logs ids and codes, never a token.
 */
export async function sweepPushReceipts(deps: PushReceiptSweepDeps, now = new Date()): Promise<{ read: number; failed: number }> {
  const { repos, log } = deps;
  await repos.pushTickets.deleteSentBefore(new Date(now.getTime() - RECEIPT_KEPT_MS));
  const tickets = await repos.pushTickets.claimDue(new Date(now.getTime() - RECEIPT_AFTER_MS), new Date(now.getTime() - RECEIPT_RECLAIM_MS), now, RECEIPT_BATCH);
  if (tickets.length === 0) return { read: 0, failed: 0 };
  const receipts = await deps.receipts.fetch(tickets.map((t) => t.ticket_id));
  const done: string[] = [];
  const failures = new Map<string, { code: string; push_token: string }>();
  for (const t of tickets) {
    const r = receipts.get(t.ticket_id);
    if (!r) continue;
    done.push(t.id);
    if (r.status === 'error') {
      log.warn({ deviceId: t.device_id, ticketId: t.ticket_id, kind: t.kind, code: r.error }, 'mobile push receipt error');
      failures.set(t.device_id, { code: r.error, push_token: t.push_token });
    }
  }
  for (const [deviceId, f] of failures) {
    if (f.code === 'DeviceNotRegistered') await repos.devices.clearPushTokenIf(deviceId, f.push_token);
    const device = await repos.devices.findById(deviceId);
    await repos.deviceEvents.record({ user_id: device?.user_id ?? null, device_id: deviceId, kind: 'push_failed', actor: 'system', meta: { code: f.code } });
  }
  await repos.pushTickets.deleteMany(done);
  if (done.length) log.info({ read: done.length, failed: failures.size }, 'mobile push receipts read');
  return { read: done.length, failed: failures.size };
}

/** Every 5 minutes, one pass at a time per process; safe on both colors (`claimDue`). */
export function startPushReceiptSweeper(deps: PushReceiptSweepDeps): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void sweepPushReceipts(deps)
      .catch((err) => deps.log.warn({ code: failureLabel(err) }, 'mobile push receipt sweep failed'))
      .finally(() => (running = false));
  }, RECEIPT_SWEEP_MS);
  timer.unref();
  return () => clearInterval(timer);
}

export interface MobilePushDeps {
  repos: Repositories;
  sender: PushSender;
  /** Reads a test push's receipt a few seconds after it is sent (TER-913). */
  receipts?: PushReceiptFetcher;
  sockets: MobileSocketRegistry;
  log: FastifyBaseLogger;
  now?: () => Date;
}

type Kind = 'confirmation' | 'reply' | 'device_request';

/**
 * Turns three moments into a row of the person's notification history and a push to their phones
 * (spec §9): a pending action, a finished answer and a new device request. The payload names the
 * project, tab and machine — resolved owner-scoped from ids — and never carries an action's
 * summary, arguments or tool, nor a reply's text. Never throws out of a bus listener; logs ids only.
 */
export class MobilePushService {
  /** "Resposta pronta" at most once per conversation per minute. */
  private readonly replies = new SlidingWindow(60_000, 1);

  /** Test pushes: six per minute per device (TER-913). */
  private readonly tests = new SlidingWindow(60_000, 6);

  /** The live subscription's unsubscribe, so a second `start()` never subscribes twice. */
  private stop: (() => void) | null = null;

  constructor(private readonly deps: MobilePushDeps) {}

  /** Subscribes to the chat bus once; returns the unsubscribe (the same one on every call while subscribed). */
  start(): () => void {
    if (this.stop) return this.stop;
    const unsubscribe = chatBus.subscribe((event) => {
      void this.handle(event).catch((err) =>
        this.deps.log.warn({ err: failureLabel(err), userId: event.user_id, conversationId: event.conversation_id, event: event.type }, 'mobile push failed'),
      );
    });
    const stop = () => {
      unsubscribe();
      if (this.stop === stop) this.stop = null;
    };
    this.stop = stop;
    return stop;
  }

  /** Called by the enrolment service for a real request: goes to every device, live or not. */
  async deviceRequest(user: User, request: DeviceRequest): Promise<void> {
    try {
      const text = deviceRequestText(request);
      const devices = await this.deps.repos.devices.listActiveWithPush(user.id);
      await this.deliver(user.id, 'device_request', text, { kind: 'device_request' }, devices);
    } catch (err) {
      this.deps.log.warn({ err: failureLabel(err), userId: user.id, requestId: request.id }, 'mobile push failed');
    }
  }

  /**
   * A test push to one of the person's own active devices (TER-913): the text and `data` of a real
   * push of `kind`, with "[Teste] " before the title and `data.test: true`, its tap landing in the
   * person's most recently active conversation. It skips the live-socket filter and writes no history
   * row. Sent after `delaySeconds` (an in-process timer: a deploy in between drops it, fine for a test);
   * an immediate send answers Expo's ticket. A few seconds later the receipt becomes the device's
   * `push_test` event. Logs ids, kind and outcome only — never the token.
   */
  async testPush(user: User, device: Device, kind: PushTestKind, delaySeconds: number): Promise<PushTestResponse> {
    if (!device.push_token) throw new HttpError(409, 'Este aparelho ainda não ativou as notificações.', 'NO_PUSH_TOKEN');
    if (!this.tests.take(device.id)) throw new HttpError(429, 'Muitas notificações de teste. Espere um minuto e tente de novo.', 'PUSH_TEST_RATE_LIMITED');
    const message = await this.testMessage(user, device.push_token, kind);
    const scheduledFor = new Date(this.now().getTime() + delaySeconds * 1000).toISOString();
    if (delaySeconds === 0) return { scheduled_for: scheduledFor, ticket: await this.sendTest(user, device, kind, message) };
    setTimeout(() => void this.sendTest(user, device, kind, message), delaySeconds * 1000).unref();
    return { scheduled_for: scheduledFor, ticket: null };
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private async testMessage(user: User, to: string, kind: PushTestKind): Promise<PushMessage> {
    const test = (t: PushText): PushText => ({ title: `[Teste] ${t.title}`, body: t.body });
    if (kind === 'device_request') {
      const text = test(deviceRequestText({ model: 'Aparelho de teste', city: null, country: null }));
      return { to, ...text, data: { kind: 'device_request', test: true } };
    }
    const conversation = await this.deps.repos.chat.findLatestActiveForUser(user.id);
    const projectId = conversation?.project_id ?? null;
    const ctx = conversation ? await this.names(user.id, projectId, null, null) : { projectName: 'Projeto de teste', tabName: null, machineName: null };
    const where = conversation ? { conversation_id: conversation.id, project_id: projectId } : {};
    if (kind === 'tab_question') return { to, ...test(tabQuestionText({ ...ctx, tabName: 'teste' }, 'permission')), data: { kind: 'tab_question', ...where, test: true } };
    if (kind === 'reply') return { to, ...test(replyText(ctx)), data: { kind: 'reply', ...where, test: true } };
    return { to, ...test(confirmationText(ctx)), data: { kind: 'confirmation', ...where, test: true } };
  }

  /** Sends one test push; never throws. Its outcome becomes the device's `push_test` event. */
  private async sendTest(user: User, device: Device, kind: PushTestKind, message: PushMessage): Promise<PushTestResponse['ticket']> {
    const record = (outcome: string) =>
      this.deps.repos.deviceEvents
        .record({ user_id: user.id, device_id: device.id, kind: 'push_test', actor: 'user', meta: { kind, outcome } })
        .catch((err) => this.deps.log.warn({ err: failureLabel(err), deviceId: device.id }, 'recording a push test failed'));
    let result: PushTicketResult | undefined;
    try {
      [result] = await this.deps.sender.send([message]);
    } catch (err) {
      this.deps.log.warn({ err: failureLabel(err), deviceId: device.id, kind }, 'mobile push test send failed');
      await record('send_failed');
      return { status: 'error', error: 'send_failed' };
    }
    const error = result?.error;
    this.deps.log.info({ deviceId: device.id, kind, outcome: error ?? 'ticket_ok' }, 'mobile push test sent');
    if (error) {
      if (error === 'DeviceNotRegistered') await this.deps.repos.devices.clearPushTokenIf(device.id, message.to).catch(() => false);
      await record(error);
      return { status: 'error', error };
    }
    if (result?.id) this.checkTestReceipt(user, device, message.to, result.id, record);
    return { status: 'ok' };
  }

  /** The receipt a few seconds later (again after a minute if it is not ready), then the event. */
  private checkTestReceipt(user: User, device: Device, token: string, ticketId: string, record: (outcome: string) => Promise<unknown>): void {
    const receipts = this.deps.receipts;
    if (!receipts) return;
    const attempt = (delays: number[]) => {
      const [delay, ...rest] = delays;
      setTimeout(async () => {
        try {
          const receipt = (await receipts.fetch([ticketId])).get(ticketId);
          if (!receipt) return rest.length ? attempt(rest) : void (await record('receipt_pending'));
          if (receipt.status === 'ok') return void (await record('delivered_to_provider'));
          if (receipt.error === 'DeviceNotRegistered') await this.deps.repos.devices.clearPushTokenIf(device.id, token);
          this.deps.log.warn({ deviceId: device.id, userId: user.id, ticketId, code: receipt.error }, 'mobile push receipt error');
          await record(receipt.error);
        } catch (err) {
          this.deps.log.warn({ err: failureLabel(err), deviceId: device.id }, 'mobile push test receipt failed');
        }
      }, delay).unref();
    };
    attempt([TEST_RECEIPT_AFTER_MS, TEST_RECEIPT_RETRY_MS]);
  }

  /**
   * The card a history row was about got handled (TER-923): answered, decided or ended, here or on any
   * other screen. Its rows become read, and the phones get a badge-only push with the new count, so the
   * icon stops counting it; the app clears the delivered notification when it next looks.
   */
  private async handled(userId: string, key: 'action_id' | 'tab_question_id', value: string): Promise<void> {
    const { repos } = this.deps;
    if ((await repos.userNotifications.markReadByData(userId, key, value, this.now())) === 0) return;
    const devices = (await repos.devices.listActiveWithPush(userId)).filter((d): d is Device & { push_token: string } => !!d.push_token);
    if (devices.length === 0) return;
    const badge = await repos.userNotifications.countUnread(userId);
    try {
      await this.deps.sender.send(devices.map((d) => ({ to: d.push_token, data: { kind: 'badge' }, badge })));
    } catch (err) {
      this.deps.log.warn({ err: failureLabel(err), userId, devices: devices.length }, 'mobile badge push failed');
    }
  }

  private async handle(event: ChatEvent): Promise<void> {
    if (event.type === 'decision' || event.type === 'action_status') return this.handled(event.user_id, 'action_id', event.action_id);
    if (event.type === 'tab_question_answered' || event.type === 'tab_question_closed') return this.handled(event.user_id, 'tab_question_id', event.question.id);
    if (event.type === 'confirmation') {
      // A card re-published only to name its subagent: the person was already told about it.
      if (event.origin_update) return;
      // Brought back to the end of the chat (TER-477): the same question, already notified.
      if (event.resurfaced) return;
      // The event's project_id is the action's target (from the tool call's args), not the chat the
      // question belongs to: the wording and data.project_id come from the conversation itself.
      const projectId = await this.conversationProject(event.conversation_id, event.user_id);
      const ctx = await this.names(event.user_id, projectId, event.tab_id, event.machine_id);
      const data = { kind: 'confirmation', conversation_id: event.conversation_id, project_id: projectId, action_id: event.action_id };
      await this.deliver(event.user_id, 'confirmation', confirmationText(ctx), data, await this.offline(event.user_id));
    } else if (event.type === 'tab_question' && event.question.kind !== 'suggestion' && !event.resurfaced) {
      // (A suggestion never rides `tab_question` — it has its own events and is never pushed — the
      // kind check only narrows the view's type.)
      // Same channel as a confirmation — the history row keeps that kind, which every app version
      // parses — with its own `data.kind` so a newer app can tell them apart.
      const projectId = await this.conversationProject(event.conversation_id, event.user_id);
      const ctx = await this.names(event.user_id, projectId, event.question.tab_id, null);
      const data = { kind: 'tab_question', conversation_id: event.conversation_id, project_id: projectId, tab_question_id: event.question.id };
      await this.deliver(event.user_id, 'confirmation', tabQuestionText(ctx, event.question.kind), data, await this.offline(event.user_id));
    } else if (event.type === 'run_finished' && event.ok) {
      const projectId = await this.conversationProject(event.conversation_id, event.user_id);
      const ctx = await this.names(event.user_id, projectId, null, null);
      const data = { kind: 'reply', conversation_id: event.conversation_id, project_id: projectId };
      const send = this.replies.take(event.conversation_id);
      await this.deliver(event.user_id, 'reply', replyText(ctx), data, send ? await this.offline(event.user_id) : [], `reply:${event.conversation_id}`);
    }
  }

  /** The project of the user's own conversation; null for the account-wide chat or one not found. */
  private async conversationProject(conversationId: string, userId: string): Promise<string | null> {
    return (await this.deps.repos.chat.findByIdForUser(conversationId, userId))?.project_id ?? null;
  }

  /** Devices with a push token and no live /ws/m/chat socket: whoever has the app open already saw it. */
  private async offline(userId: string): Promise<Device[]> {
    const live = this.deps.sockets.liveDevices(userId);
    return (await this.deps.repos.devices.listActiveWithPush(userId)).filter((d) => !live.has(d.id));
  }

  /** Names only what the owner can see: `findByIdsForOwner` drops anything that is not theirs. */
  private async names(ownerId: string, projectId: string | null, tabId: string | null, machineId: string | null): Promise<PushContext> {
    const { repos } = this.deps;
    const [projects, tabs, machines] = await Promise.all([
      projectId ? repos.projects.findByIdsForOwner([projectId], ownerId) : [],
      tabId ? repos.tabs.findByIdsForOwner([tabId], ownerId) : [],
      machineId ? repos.machines.findByIdsForOwner([machineId], ownerId) : [],
    ]);
    return {
      projectName: projects.find((p) => p.id === projectId)?.name ?? null,
      tabName: tabs.find((t) => t.id === tabId)?.name ?? null,
      machineName: machines.find((m) => m.id === machineId)?.name ?? null,
    };
  }

  /** The history row first — it exists even when sending fails — then the push, which carries the
   * row's id as `notification_id` so a tap on it can mark that row read. */
  private async deliver(userId: string, kind: Kind, text: PushText, data: Record<string, unknown>, devices: Device[], collapseId?: string): Promise<void> {
    const row = await this.deps.repos.userNotifications.create({ user_id: userId, kind, title: text.title, body: text.body, data });
    const targets = devices.filter((d): d is Device & { push_token: string } => !!d.push_token);
    if (targets.length === 0) return;
    const pushData = { ...data, notification_id: row.id };
    // The icon shows the unread rows, this one included (TER-923).
    const badge = await this.deps.repos.userNotifications.countUnread(userId);
    const messages: PushMessage[] = targets.map((d) => ({ to: d.push_token, title: text.title, body: text.body, data: pushData, badge, ...(collapseId ? { collapseId } : {}) }));
    let results: PushTicketResult[];
    try {
      results = await this.deps.sender.send(messages);
    } catch (err) {
      this.deps.log.warn({ err: failureLabel(err), userId, kind, devices: targets.length }, 'mobile push send failed');
      return;
    }
    // Each accepted ticket waits for its receipt (TER-924): APNs/FCM refusals only show up there.
    const tickets = results.flatMap((r) => {
      const device = r.id ? targets.find((d) => d.push_token === r.to) : undefined;
      return device && r.id ? [{ ticket_id: r.id, device_id: device.id, push_token: r.to, kind }] : [];
    });
    await this.deps.repos.pushTickets
      .recordMany(tickets)
      .catch((err) => this.deps.log.warn({ err: failureLabel(err), userId, kind }, 'recording push tickets failed'));
    for (const r of results) {
      if (r.error !== 'DeviceNotRegistered') continue;
      const device = targets.find((d) => d.push_token === r.to);
      if (!device) continue;
      await this.deps.repos.devices
        .setPushToken(device.id, null)
        .catch((err) => this.deps.log.warn({ err: failureLabel(err), deviceId: device.id }, 'clearing a dead push token failed'));
    }
  }
}
