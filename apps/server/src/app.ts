import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fs from 'node:fs';
import path from 'node:path';
import { config, ROOT_DIR } from './config.js';
import { getPrisma, closePrisma } from './db/prisma.js';
import { createRepositories, type Repositories } from './db/repositories/index.js';
import { createMailer } from './email/mailer.js';
import { createAccessAllowlist } from './cloudflare/access.js';
import { AuthService, authRoutes, buildAuthHook, type AuthContext } from './auth/index.js';
import { applyErrorHandler } from './lib/errors.js';
import { machineRoutes } from './routes/machines.js';
import { projectRoutes } from './routes/projects.js';
import { projectGroupRoutes } from './routes/project-groups.js';
import { transcriptionRoutes } from './routes/transcriptions.js';
import { tabRoutes } from './routes/tabs.js';
import { projectTaskRoutes, taskRoutes } from './routes/tasks.js';
import { columnRoutes, projectColumnRoutes } from './routes/columns.js';
import { noteRoutes } from './routes/notes.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { officeRoutes } from './routes/office.js';
import { integrationRoutes } from './routes/integrations.js';
import { setupRoutes } from './routes/setup.js';
import { projectTicketRoutes, taskTicketRoutes } from './routes/tickets.js';
import { aiAccountRoutes } from './routes/ai-accounts.js';
import { waitlistRoutes } from './routes/waitlist.js';
import { publicCityRoutes } from './routes/public-city.js';
import { cityLinkRoutes } from './routes/city-link.js';
import { ShortLinkService } from './public/short-link.js';
import { createTypeToAccessClient } from './public/typetoaccess.js';
import { registerPublicWs } from './public/ws.js';
import { defaultFrontendDirs, registerFrontend } from './frontend.js';
import { loadPublicIdKey, setPublicIdKey } from './public/public-id.js';
import { hooksRoutes } from './routes/hooks.js';
import { monitorRoutes } from './routes/monitor.js';
import { registerMonitorWs } from './monitor/ws.js';
import { chatRoutes } from './routes/chat.js';
import { ChatService, purgeExpiredActions } from './chat/service.js';
import { agentRunner } from './chat/runner.js';
import { startTabQuestionExpiry } from './chat/tab-questions.js';
import { stopTabSuggestions } from './chat/tab-suggestions.js';
import { registerChatWs } from './chat/ws.js';
import { roleRoutes } from './routes/roles.js';
import { userRoutes } from './routes/users.js';
import { uploadRoutes } from './routes/uploads.js';
import { apiTokenRoutes } from './routes/api-tokens.js';
import { deviceRoutes } from './routes/devices.js';
import { mcpRoutes } from './mcp/route.js';
import { createMobileServices, registerMobileApi } from './mobile/app.js';
import { revokeDevice } from './mobile/revocation.js';
import { purgeMobile } from './mobile/purge.js';
import { actionForMethod, type Resource } from './auth/permissions.js';
import { startTicketSyncScheduler } from './setup/tickets-sync.js';
import { startAgentUpdateScheduler } from './agent/latest-version.js';
import { registerTerminalWs } from './terminal/ws.js';
import { registerAgentWs } from './agent/ws.js';
import { agents } from './agent/registry.js';
import { TranscriptionService } from './terminal/transcription.js';
import { createUpgradeRouter } from './ws/router.js';
import { registerSimulatorWs } from './simulator/ws.js';
import { SimulatorSessionManager } from './simulator/session-manager.js';
import { createRealBackend } from './simulator/backend.js';
import { seed } from './seed.js';

const SERVER_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'apps', 'server', 'package.json'), 'utf8')).version as string;

export interface App {
  fastify: FastifyInstance;
  repos: Repositories;
  auth: AuthContext;
}

export interface BuildAppOptions {
  /** Where the built web bundles are read from (tests); defaults to apps/web/dist and dist-city. */
  frontend?: { webDist?: string; cityDist?: string };
}

export async function buildApp(opts: BuildAppOptions = {}): Promise<App> {
  const fastify = Fastify({
    logger: {
      level: config.isProd ? 'info' : 'debug',
      transport: config.isProd ? undefined : { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } },
      // Nunca logar cookies/authorization.
      redact: ['req.headers.cookie', 'req.headers.authorization', 'req.headers["cf-access-jwt-assertion"]', 'req.headers.dpop'],
    },
    trustProxy: true, // atrás do Cloudflare Tunnel / cloudflared em 127.0.0.1
    bodyLimit: 1024 * 1024,
  });

  const prisma = getPrisma();
  await prisma.$connect();
  const repos = createRepositories(prisma);
  // Before anything maps a machine or a project (the seed does): every public id is an HMAC with
  // this key, and publicId() refuses to answer without it.
  setPublicIdKey(await loadPublicIdKey(repos));
  await seed(repos, (m) => fastify.log.info(m));

  const mailer = createMailer((m) => fastify.log.info(m));
  const access = createAccessAllowlist(config.cloudflareAccess);
  const shortLinks = new ShortLinkService({
    users: repos.users,
    http: config.typeToAccess ? createTypeToAccessClient({ apiKey: config.typeToAccess.apiKey }) : null,
    cityBaseUrl: config.publicCityUrl,
    log: fastify.log.child({ mod: 'short-link' }),
  });
  if (config.cloudflareAccess) fastify.log.info({ domain: config.cloudflareAccess.appDomain, policy: config.cloudflareAccess.policyName }, 'cloudflare access allowlist sync enabled');
  const authService = new AuthService(repos, mailer);
  const auth: AuthContext = { service: authService, repos };

  await fastify.register(fastifyCookie);

  // JSON tolerante a body vazio (POST sem corpo vira {}).
  fastify.removeContentTypeParser('application/json');
  fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const text = typeof body === 'string' ? body : body.toString();
    if (!text.trim()) return done(null, {});
    try {
      done(null, JSON.parse(text));
    } catch (err) {
      done(Object.assign(err as Error, { statusCode: 400 }), undefined);
    }
  });

  // Cabeçalhos básicos de segurança
  fastify.addHook('onSend', async (_req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'same-origin');
  });

  applyErrorHandler(fastify);

  const simTunnelLog = fastify.log.child({ mod: 'sim-tunnel' });
  const simulators = new SimulatorSessionManager(
    createRealBackend((msg, meta) => simTunnelLog.info(meta ?? {}, msg)),
    { log: (msg, meta) => fastify.log.info(meta ?? {}, msg) },
  );
  const transcriptions = new TranscriptionService({ log: (meta, msg) => fastify.log.info(meta, msg) });
  if (config.transcription) fastify.log.info({ url: config.transcription.url, language: config.transcription.language }, 'voice transcription enabled');

  // --- WebSockets (terminais e simulador) — criados antes do bloco /api para que as rotas HTTP
  // recebam `simulators` e `simWs.closeTab`. `fastify.server` já existe neste ponto.
  const upgrades = createUpgradeRouter(fastify.server, { auth });
  registerTerminalWs(upgrades, { repos, log: fastify.log });
  registerAgentWs(upgrades, { repos, log: fastify.log });
  const simWs = registerSimulatorWs(upgrades, { repos, manager: simulators, log: fastify.log });
  registerMonitorWs(upgrades, { log: fastify.log });
  registerChatWs(upgrades, { log: fastify.log });
  registerPublicWs(upgrades, { repos, log: fastify.log });

  // The conversation runs on a machine of the user's own, on their own Claude account (spec §3):
  // `resolveHost` picks the pair per send, and `agentRunner` drives that machine's agent. No
  // config dir is configured here anymore — it is the chosen `ai_account`'s, or the machine's own
  // default — and the operator's container is no longer in this path at all. Shared by /api/chat
  // and the mobile API.
  const chat = new ChatService({ repos, agents, runnerFor: (machineId) => agentRunner(machineId) });
  const mobileDeps = { repos, agents, chat, transcriptions, mailer, log: fastify.log, upgrades };
  const mobile = config.mobile ? createMobileServices(mobileDeps) : null;

  // --- API (tudo autenticado, exceto rotas marcadas como public) ---
  await fastify.register(
    async (api) => {
      api.addHook('preHandler', buildAuthHook(auth));

      /**
       * Registers a route plugin under a permission resource: every route gets
       * config.resource = <resource> and, unless the route sets its own, an action
       * derived from the HTTP method (GET read, POST create, PATCH/PUT update, DELETE delete).
       * The auth hook then checks the user's role grants. Public routes are untouched.
       */
      const guarded = (resource: Resource, plugin: (a: FastifyInstance) => Promise<void>, prefix: string) =>
        api.register(async (a) => {
          a.addHook('onRoute', (route) => {
            const cfg = (route.config ?? {}) as { public?: boolean; resource?: string; action?: string };
            if (cfg.public) return;
            route.config = { ...cfg, resource: cfg.resource ?? resource, action: cfg.action ?? actionForMethod(String(route.method)) };
          });
          await plugin(a);
        }, { prefix });

      await api.register((a) => authRoutes(a, auth, { onNicknameClaimed: (u) => shortLinks.onNicknameClaimed(u) }), { prefix: '/auth' });
      await api.register((a) => cityLinkRoutes(a, { shortLinks }), { prefix: '/auth' });
      await guarded('machines', (a) => machineRoutes(a, repos), '/machines');
      await guarded('projects', (a) => projectRoutes(a, repos, { simulators }), '/projects');
      await guarded('projects', (a) => projectGroupRoutes(a, repos), '/project-groups');
      await guarded('tasks', (a) => projectTaskRoutes(a, repos), '/projects');
      await guarded('notes', (a) => noteRoutes(a, repos), '/projects');
      await guarded('tasks', (a) => taskRoutes(a, repos), '/tasks');
      await guarded('tasks', (a) => projectColumnRoutes(a, repos), '/projects');
      await guarded('tasks', (a) => columnRoutes(a, repos), '/columns');
      await guarded('projects', (a) => dashboardRoutes(a, repos), '/dashboard');
      await guarded('projects', (a) => officeRoutes(a, repos, { simulators, agents }), '/office');
      await guarded('integrations', (a) => integrationRoutes(a, repos), '/integrations');
      await guarded('projects', (a) => setupRoutes(a, repos), '/projects');
      await guarded('tickets', (a) => projectTicketRoutes(a, repos), '/projects');
      await guarded('tickets', (a) => taskTicketRoutes(a, repos), '/tasks');
      await guarded('terminals', (a) => tabRoutes(a, repos, { simulators, closeSimulatorTab: (id) => simWs.closeTab(id) }), '/tabs');
      await guarded('terminals', (a) => transcriptionRoutes(a, { transcriptions }), '/transcriptions');
      await guarded('terminals', (a) => monitorRoutes(a, repos), '/monitor');
      await guarded('terminals', (a) => hooksRoutes(a, repos), '/hooks');
      await guarded('ai_accounts', (a) => aiAccountRoutes(a, repos), '/ai-accounts');
      await guarded('waitlist', (a) => waitlistRoutes(a, repos), '/waitlist');
      await guarded('roles', (a) => roleRoutes(a, repos), '/roles');
      await guarded('users', (a) => userRoutes(a, repos, { mailer, access, revoke: mobile ? (id, input) => revokeDevice({ repos, sockets: mobile.sockets, mailer, log: fastify.log }, id, input) : null }), '/users');
      await guarded('uploads', (a) => uploadRoutes(a, repos), '/uploads');
      await guarded('api_tokens', (a) => apiTokenRoutes(a, repos, { mcpUrl: config.mcpUrl }), '/api-tokens');
      await guarded('chat', (a) => chatRoutes(a, repos, { service: chat }), '/chat');
      if (mobile) {
        await guarded(
          'devices',
          (a) => deviceRoutes(a, repos, { enrolment: mobile.enrolment, revoke: (id, input) => revokeDevice({ repos, sockets: mobile.sockets, mailer }, id, input) }),
          '/devices',
        );
      }
      await api.register((a) => publicCityRoutes(a, repos), { prefix: '/public' });
      api.get('/health', { config: { public: true } }, async () => ({ ok: true }));
      api.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'Rota não encontrada', code: 'NOT_FOUND' }));
    },
    { prefix: '/api' },
  );

  // --- MCP endpoint for the global terminal (public route: a personal API token authenticates each call) ---
  await fastify.register((a) => mcpRoutes(a, { repos, version: SERVER_VERSION }));

  // --- Mobile app API (/api/m/v1): outside /api, so only its device-token + DPoP hook runs on it ---
  if (config.mobile && mobile) await registerMobileApi(fastify, mobile, mobileDeps);

  // --- Frontend buildado (produção) ---
  const dirs = { ...defaultFrontendDirs(ROOT_DIR), ...opts.frontend };
  if (!(await registerFrontend(fastify, { repos, ...dirs, publicCityUrl: config.publicCityUrl }))) {
    fastify.log.warn('apps/web/dist e apps/web/dist-city não encontrados — rodando só a API (use "npm run build" e "npm run build:city -w @termhub/web" para servir os bundles)');
  }

  // Limpeza periódica de sessões expiradas e de perguntas do chat que ninguém respondeu
  const purge = setInterval(() => {
    void authService.purgeExpired().catch(() => {});
    void purgeExpiredActions(repos).catch(() => {});
    // Mobile: stale enrolment requests expire, then device sessions, requests, trail and push history age out
    if (mobile) void purgeMobile(repos, mobile.enrolment).catch(() => {});
  }, 60 * 60 * 1000);
  const stopSync = startTicketSyncScheduler(repos, fastify.log);
  const stopAgentUpdates = startAgentUpdateScheduler(repos, fastify.log);
  const stopTabQuestionExpiry = startTabQuestionExpiry(repos, fastify.log);
  fastify.addHook('onClose', async () => {
    clearInterval(purge);
    stopSync();
    stopAgentUpdates();
    stopTabQuestionExpiry();
    stopTabSuggestions();
    await simulators.shutdownAll();
    await closePrisma();
  });

  return { fastify, repos, auth };
}
