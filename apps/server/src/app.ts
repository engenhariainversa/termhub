import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
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
import { transcriptionRoutes } from './routes/transcriptions.js';
import { tabRoutes } from './routes/tabs.js';
import { projectTaskRoutes, taskRoutes } from './routes/tasks.js';
import { noteRoutes } from './routes/notes.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { integrationRoutes } from './routes/integrations.js';
import { setupRoutes } from './routes/setup.js';
import { projectTicketRoutes, taskTicketRoutes } from './routes/tickets.js';
import { aiAccountRoutes } from './routes/ai-accounts.js';
import { waitlistRoutes } from './routes/waitlist.js';
import { hooksRoutes } from './routes/hooks.js';
import { monitorRoutes } from './routes/monitor.js';
import { registerMonitorWs } from './monitor/ws.js';
import { roleRoutes } from './routes/roles.js';
import { userRoutes } from './routes/users.js';
import { uploadRoutes } from './routes/uploads.js';
import { apiTokenRoutes } from './routes/api-tokens.js';
import { mcpRoutes } from './mcp/route.js';
import { actionForMethod, type Resource } from './auth/permissions.js';
import { startTicketSyncScheduler } from './setup/tickets-sync.js';
import { registerTerminalWs } from './terminal/ws.js';
import { registerAgentWs } from './agent/ws.js';
import { TranscriptionService } from './terminal/transcription.js';
import { createUpgradeRouter } from './ws/router.js';
import { registerSimulatorWs } from './simulator/ws.js';
import { SimulatorSessionManager } from './simulator/session-manager.js';
import { realBackend } from './simulator/backend.js';
import { seed } from './seed.js';

const SERVER_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'apps', 'server', 'package.json'), 'utf8')).version as string;

export interface App {
  fastify: FastifyInstance;
  repos: Repositories;
  auth: AuthContext;
}

export async function buildApp(): Promise<App> {
  const fastify = Fastify({
    logger: {
      level: config.isProd ? 'info' : 'debug',
      transport: config.isProd ? undefined : { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } },
      // Nunca logar cookies/authorization.
      redact: ['req.headers.cookie', 'req.headers.authorization', 'req.headers["cf-access-jwt-assertion"]'],
    },
    trustProxy: true, // atrás do Cloudflare Tunnel / cloudflared em 127.0.0.1
    bodyLimit: 1024 * 1024,
  });

  const prisma = getPrisma();
  await prisma.$connect();
  const repos = createRepositories(prisma);
  await seed(repos, (m) => fastify.log.info(m));

  const mailer = createMailer((m) => fastify.log.info(m));
  const access = createAccessAllowlist(config.cloudflareAccess);
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

  const simulators = new SimulatorSessionManager(realBackend, { log: (msg, meta) => fastify.log.info(meta ?? {}, msg) });
  const transcriptions = new TranscriptionService({ log: (meta, msg) => fastify.log.info(meta, msg) });
  if (config.transcription) fastify.log.info({ url: config.transcription.url, language: config.transcription.language }, 'voice transcription enabled');

  // --- WebSockets (terminais e simulador) — criados antes do bloco /api para que as rotas HTTP
  // recebam `simulators` e `simWs.closeTab`. `fastify.server` já existe neste ponto.
  const upgrades = createUpgradeRouter(fastify.server, { auth });
  registerTerminalWs(upgrades, { repos, log: fastify.log });
  registerAgentWs(upgrades, { repos, log: fastify.log });
  const simWs = registerSimulatorWs(upgrades, { repos, manager: simulators, log: fastify.log });
  registerMonitorWs(upgrades, { log: fastify.log });

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

      await api.register((a) => authRoutes(a, auth), { prefix: '/auth' });
      await guarded('machines', (a) => machineRoutes(a, repos), '/machines');
      await guarded('projects', (a) => projectRoutes(a, repos, { simulators }), '/projects');
      await guarded('tasks', (a) => projectTaskRoutes(a, repos), '/projects');
      await guarded('notes', (a) => noteRoutes(a, repos), '/projects');
      await guarded('tasks', (a) => taskRoutes(a, repos), '/tasks');
      await guarded('projects', (a) => dashboardRoutes(a, repos), '/dashboard');
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
      await guarded('users', (a) => userRoutes(a, repos, { mailer, access }), '/users');
      await guarded('uploads', (a) => uploadRoutes(a, repos), '/uploads');
      await guarded('api_tokens', (a) => apiTokenRoutes(a, repos, { mcpUrl: config.mcpUrl }), '/api-tokens');
      api.get('/health', { config: { public: true } }, async () => ({ ok: true }));
      api.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'Rota não encontrada', code: 'NOT_FOUND' }));
    },
    { prefix: '/api' },
  );

  // --- MCP endpoint for the global terminal (public route: a personal API token authenticates each call) ---
  await fastify.register((a) => mcpRoutes(a, { repos, version: SERVER_VERSION }));

  // --- Frontend buildado (produção) ---
  const webDist = path.join(ROOT_DIR, 'apps', 'web', 'dist');
  if (fs.existsSync(path.join(webDist, 'index.html'))) {
    await fastify.register(fastifyStatic, { root: webDist, prefix: '/', index: ['index.html'] });
    // SPA fallback: qualquer rota não-API devolve o index.html
    fastify.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/') || request.url.startsWith('/ws/') || request.url.startsWith('/mcp')) {
        return reply.code(404).send({ error: 'Não encontrado' });
      }
      return reply.sendFile('index.html');
    });
  } else {
    fastify.log.warn('apps/web/dist não encontrado — rodando só a API (use "npm run build" para servir o frontend)');
  }

  // Limpeza periódica de sessões expiradas
  const purge = setInterval(() => void authService.purgeExpired().catch(() => {}), 60 * 60 * 1000);
  const stopSync = startTicketSyncScheduler(repos, fastify.log);
  fastify.addHook('onClose', async () => {
    clearInterval(purge);
    stopSync();
    await simulators.shutdownAll();
    await closePrisma();
  });

  return { fastify, repos, auth };
}
