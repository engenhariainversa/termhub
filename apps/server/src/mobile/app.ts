import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { WebSocketServer } from 'ws';
import { config } from '../config.js';
import type { Repositories } from '../db/repositories/index.js';
import type { HostAgents } from '../chat/host.js';
import type { ChatService } from '../chat/service.js';
import type { TabChatHub } from '../tab-chat/hub.js';
import type { TranscriptionService } from '../terminal/transcription.js';
import type { Mailer } from '../email/mailer.js';
import type { createUpgradeRouter } from '../ws/router.js';
import { actionForMethod, type Resource } from '../auth/permissions.js';
import { mobileChatRoutes, mobileMeRoutes } from '../routes/m-chat.js';
import { mobileChatAttachmentRoutes } from '../routes/m-chat-attachments.js';
import type { ChatAttachmentDeps } from '../routes/chat-attachments.js';
import { mobileDeviceRoutes, mobilePushTokenRoutes } from '../routes/m-devices.js';
import { mobileNotificationRoutes } from '../routes/m-notifications.js';
import { progressRoutes } from '../routes/progress.js';
import { projectAiRoutes } from '../routes/project-ai.js';
import { mobileSessionRoutes } from '../routes/m-session.js';
import { filePreviewRoutes } from '../routes/file-preview.js';
import { fileRecentRoutes } from '../routes/file-recent.js';
import { mobileTabRoutes } from '../routes/m-tabs.js';
import { mobileTranscriptionRoutes } from '../routes/m-transcriptions.js';
import { buildMobileAuthHook, type MobileAuthMode } from './auth.js';
import { JtiCache } from './dpop.js';
import { EnrolmentService } from './enrolment.js';
import { ExpoPushSender, ExpoReceiptFetcher, MobilePushService, startPushReceiptSweeper } from './push.js';
import { MobileSocketRegistry, revokeDevice } from './revocation.js';
import { SessionService } from './session.js';
import type { AccountDeletionService } from '../account/deletion.js';
import { mobileAccountRoutes } from '../routes/m-account.js';
import { registerMobileTabWs } from './tab-ws.js';
import { registerMobileChatWs } from './ws.js';
import { sendError } from '../lib/errors.js';

export const MOBILE_PREFIX = '/api/m/v1';

/** Long-lived state of the mobile API, created once per server. */
export interface MobileServices {
  jtis: JtiCache;
  enrolment: EnrolmentService;
  sockets: MobileSocketRegistry;
  session: SessionService;
  /** Push notifications and their history; `registerMobileApi` starts it and stops it on close. */
  push: MobilePushService;
}

export interface MobileDeps {
  repos: Repositories;
  agents: HostAgents;
  chat: ChatService;
  transcriptions: TranscriptionService;
  mailer: Mailer;
  log: FastifyBaseLogger;
  upgrades: ReturnType<typeof createUpgradeRouter>;
  /** The chat's attachment store, queue and quota, shared with the web routes (spec 2026-09-26 §5.3). */
  attachments: ChatAttachmentDeps;
  /** Who watches which tab as a conversation (spec 2026-10-01 tab chat §5.3); the hooks route pokes it. */
  tabChat: TabChatHub;
  /** Account deletion (TER-720): Ajustes → "Excluir minha conta". Absent in tests that do not need it. */
  deletion?: AccountDeletionService;
}

/**
 * Registers a route plugin under a permission resource, like `guarded` in the root app.ts: every
 * route gets config.resource, an action derived from the HTTP method unless it sets its own, and
 * `mobileAuth` ('device' unless the route says otherwise).
 */
export type GuardedMobile = (resource: Resource, plugin: (a: FastifyInstance) => Promise<void>, prefix: string) => Promise<void>;

export function createMobileServices(deps: MobileDeps): MobileServices {
  const sockets = new MobileSocketRegistry();
  const { repos, mailer, log } = deps;
  const push = new MobilePushService({ repos, sender: new ExpoPushSender(config.mobile?.expoPushToken ?? null), sockets, log });
  return {
    jtis: new JtiCache(),
    // A real device request also pushes to the owner's phones (the decoy path never calls the hook).
    enrolment: new EnrolmentService({ repos, mailer, log, appUrl: config.publicUrl, hooks: { onRequestCreated: (u, r) => push.deviceRequest(u, r) } }),
    sockets,
    push,
    // Six wrong PIN proofs revoke the device through the same path as every other revoke.
    session: new SessionService({ repos, revoke: (id, input) => revokeDevice({ repos, sockets, mailer, log }, id, input) }),
  };
}

/**
 * The mobile app's API at /api/m/v1. It lives outside the /api plugin on purpose, so the cookie /
 * Cloudflare `buildAuthHook` never runs here: its only authentication is the device token plus a
 * DPoP proof (`buildMobileAuthHook`). Registered only when `config.mobile` is set. Returns the phone's
 * `WebSocketServer`s (the chat and the tab chat), for the shutdown drain.
 */
export async function registerMobileApi(
  fastify: FastifyInstance,
  services: MobileServices,
  deps: MobileDeps,
  routes?: (guardedMobile: GuardedMobile, m: FastifyInstance) => Promise<void>,
): Promise<WebSocketServer[]> {
  const mobile = config.mobile;
  if (!mobile) throw new Error('registerMobileApi requires config.mobile (MOBILE_PUBLIC_URL)');
  const publicUrl = mobile.publicUrl;
  // The phone's chat stream, /ws/m/chat: authenticated like this prefix (device token + proof).
  const chatWs = registerMobileChatWs(deps.upgrades, { repos: deps.repos, jtis: services.jtis, publicUrl, sockets: services.sockets, log: deps.log });
  // One open session screen, /ws/m/tabs/:id: the same checks, then the tab chat hub (spec 2026-10-01 tab chat §5.5).
  const tabWs = registerMobileTabWs(deps.upgrades, { repos: deps.repos, jtis: services.jtis, publicUrl, sockets: services.sockets, hub: deps.tabChat, log: deps.log });
  // Pending actions and finished answers become push notifications while the server runs.
  const stopPush = services.push.start();
  // Their receipts, ~15 min later: dead tokens and APNs/FCM credential errors (TER-924).
  const stopReceipts = startPushReceiptSweeper({ repos: deps.repos, receipts: new ExpoReceiptFetcher(mobile.expoPushToken ?? null), log: deps.log });
  fastify.addHook('onClose', async () => {
    stopPush();
    stopReceipts();
    chatWs.close();
    tabWs.close();
  });
  await fastify.register(
    async (m) => {
      m.addHook('preHandler', buildMobileAuthHook({ repos: deps.repos, publicUrl: mobile.publicUrl, minAppVersion: mobile.minAppVersion, jtis: services.jtis }));

      const guardedMobile: GuardedMobile = async (resource, plugin, prefix) => {
        await m.register(
          async (a) => {
            a.addHook('onRoute', (route) => {
              const cfg = (route.config ?? {}) as { resource?: string; action?: string; mobileAuth?: MobileAuthMode };
              route.config = {
                ...cfg,
                resource: cfg.resource ?? resource,
                action: cfg.action ?? actionForMethod(String(route.method)),
                mobileAuth: cfg.mobileAuth ?? 'device',
              };
            });
            await plugin(a);
          },
          { prefix },
        );
      };

      // The mobile API's own routes: enrolment, self-management, push-token and session under `devices`, then the chat.
      async function mobileRoutes(guarded: GuardedMobile): Promise<void> {
        await guarded(
          'devices',
          (a) =>
            mobileDeviceRoutes(a, deps.repos, {
              enrolment: services.enrolment,
              revoke: (id, input) => revokeDevice({ repos: deps.repos, sockets: services.sockets, mailer: deps.mailer, log: deps.log }, id, input),
            }),
          '/devices',
        );
        await guarded('devices', (a) => mobilePushTokenRoutes(a, deps.repos), '');
        // Challenge and token renewal: both mobileAuth 'none', /token verifies the device proof itself.
        await guarded('devices', (a) => mobileSessionRoutes(a, deps.repos, { session: services.session, jtis: services.jtis, publicUrl }), '/session');
        // The chat, over the same ChatService as the web; `GET /me` reads under `chat` too (spec §6).
        await guarded('chat', (a) => mobileChatRoutes(a, deps.repos, { chat: deps.chat, agents: deps.agents, session: services.session }), '/chat');
        await guarded('chat', (a) => mobileMeRoutes(a, deps.repos), '');
        // Attachments for the phone's chat: same store, queue and quota as the web (spec 2026-09-26 §5.3).
        await guarded('chat', (a) => mobileChatAttachmentRoutes(a, deps.repos, deps.attachments), '/chat/attachments');
        // The Notificações tab: the caller's own push history.
        await guarded('chat', (a) => mobileNotificationRoutes(a, deps.repos), '/notifications');
        // The Progresso tab: the same read model as the web panel (spec 2026-09-26 progress-panel D10).
        await guarded('tasks', (a) => progressRoutes(a, deps.repos), '/progress');
        // The project's AI accounts and default models, the same endpoint as the web's (TER-589).
        await guarded('projects', (a) => projectAiRoutes(a, deps.repos), '/projects');
        // Voice dictation, over the same TranscriptionService as the web (`routes/transcriptions.ts`).
        await guarded('terminals', (a) => mobileTranscriptionRoutes(a, { transcriptions: deps.transcriptions }), '/transcriptions');
        // The person's own account: no role grant needed to delete it (device auth only).
        const deletion = deps.deletion;
        if (deletion) await m.register((a) => mobileAccountRoutes(a, { deletion, session: services.session }), { prefix: '/account' });
        // A terminal tab read as a conversation (spec 2026-10-01 tab chat).
        await guarded('terminals', (a) => mobileTabRoutes(a, deps.repos, { hub: deps.tabChat }), '/tabs');
        // A file an agent wrote, previewed from its path (spec 2026-10-04 file preview): the web's route.
        await guarded('terminals', (a) => filePreviewRoutes(a, deps.repos), '/file-preview');
        await guarded('terminals', (a) => fileRecentRoutes(a, deps.repos), '/file-recent');
      }

      await mobileRoutes(guardedMobile);
      // `routes` stays for tests that want to register extra routes alongside the real ones.
      if (routes) await routes(guardedMobile, m);
      m.get('/health', { config: { mobileAuth: 'none' } }, async () => ({ ok: true }));
      m.setNotFoundHandler((request, reply) => sendError(request, reply, 404, 'Rota não encontrada', 'NOT_FOUND'));
    },
    { prefix: MOBILE_PREFIX },
  );
  // The shutdown drain closes their clients with the other WebSocket servers' (spec 2026-09-27 §5.2).
  return [chatWs, tabWs];
}
