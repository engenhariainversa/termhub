import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Repositories } from '../db/repositories/index.js';
import { badRequest, HttpError, notFound } from '../lib/errors.js';
import { encryptionAvailable } from '../lib/crypto.js';
import { requireFeature } from '../features/flags.js';
import { checkPublicUrl } from '../integrations/public-url.js';
import { EvolutionError } from '../integrations/evolution.js';
import { audit } from '../auth/audit.js';
import { requestLocale, t, tk } from '../i18n/index.js';
import { failureCode, normalizeNumber, probe, savedTarget, sendToOwner, viewOf } from '../whatsapp/service.js';

/**
 * Configurações → WhatsApp (TER-1201): the signed-in person's own Evolution API setup. Always theirs —
 * never the "view as" scope's —, since the messages go to their phone. The API key is write-only: no
 * answer carries it, and a save without one keeps the stored key.
 */

const instanceName = z.string().trim().min(1).max(100);
const apiKey = z.string().trim().min(1).max(512);

const saveBody = z.object({
  server_url: z.string().trim().min(1).max(500),
  instance: instanceName,
  number: z.string().trim().min(1).max(40),
  api_key: apiKey.optional(),
  enabled: z.boolean().default(true),
  notify_needs_you: z.boolean().default(true),
  notify_done: z.boolean().default(true),
});

/** Test the form's values before saving; the key may be left out to use the stored one. */
const testBody = z.object({
  server_url: z.string().trim().min(1).max(500).optional(),
  instance: instanceName.optional(),
  api_key: apiKey.optional(),
});

/** The person behind the request (the setup is never another user's). */
const me = (request: FastifyRequest): string => request.scope.user.id;

async function assertServerUrl(raw: string): Promise<string> {
  const check = await checkPublicUrl(raw);
  if (!check.ok) throw badRequest(check.reason);
  return raw.replace(/\/+$/, '');
}

export async function whatsappRoutes(app: FastifyInstance, repos: Repositories) {
  app.addHook('preHandler', requireFeature('whatsapp', repos));

  app.get('/', async (request) => ({ whatsapp: viewOf(await repos.whatsapp.get(me(request))) }));

  app.put('/', async (request) => {
    if (!encryptionAvailable()) throw badRequest(tk('ENCRYPTION_KEY não configurada no servidor (openssl rand -base64 32)'));
    const body = saveBody.parse(request.body);
    const number = normalizeNumber(body.number);
    if (!number) throw badRequest(tk('Número inválido: use só dígitos com o código do país e o DDD (ex.: 5562999998888)'));
    const server_url = await assertServerUrl(body.server_url);
    const userId = me(request);
    const existed = (await repos.whatsapp.get(userId)) !== null;
    if (!existed && !body.api_key) throw badRequest(tk('Informe a API key do servidor Evolution'));
    const saved = await repos.whatsapp.save(userId, { ...body, server_url, number });
    if (!existed) await audit(repos, request, 'integration.create', { target: { type: 'whatsapp', id: userId, label: 'WhatsApp' }, meta: { provider: 'whatsapp' } });
    return { whatsapp: viewOf(saved) };
  });

  app.delete('/', async (request) => {
    const userId = me(request);
    if (!(await repos.whatsapp.delete(userId))) throw notFound();
    await audit(repos, request, 'integration.delete', { target: { type: 'whatsapp', id: userId, label: 'WhatsApp' }, meta: { provider: 'whatsapp' } });
    return { ok: true };
  });

  /** "Testar conexão": the instance's state on the server, with the form's values or the saved ones. */
  app.post('/test', { config: { action: 'read' } }, async (request) => {
    const body = testBody.parse(request.body ?? {});
    const userId = me(request);
    const saved = await savedTarget(repos, userId);
    const server_url = body.server_url ?? saved?.target.server_url;
    const instance = body.instance ?? saved?.target.instance;
    // A key typed in the form wins; the stored one only goes to the server it was saved for.
    const api_key = body.api_key ?? (saved && server_url === saved.target.server_url ? saved.target.api_key : undefined);
    if (!server_url || !instance || !api_key) throw badRequest(tk('Preencha o servidor, a instância e a API key'));
    await assertServerUrl(server_url);
    const result = await probe({ server_url, instance, api_key });
    return !result.ok && result.reason ? { ...result, reason: t(requestLocale(request), result.reason) } : result;
  });

  /** "Enviar mensagem de teste": a short text to the saved number, with the saved setup. */
  app.post('/test-message', { config: { action: 'update' } }, async (request) => {
    const userId = me(request);
    try {
      await sendToOwner(repos, userId, t(requestLocale(request), 'termhub: mensagem de teste do WhatsApp ✅'));
    } catch (err) {
      if (err instanceof Error && err.message === 'WHATSAPP_NOT_CONFIGURED') throw notFound(tk('Configure o WhatsApp antes de enviar o teste'));
      if (err instanceof EvolutionError) return { ok: false, code: failureCode(err), ...(err.reason ? { reason: t(requestLocale(request), err.reason) } : {}) };
      throw new HttpError(502, tk('Falha ao enviar pelo WhatsApp'), 'WHATSAPP_SEND_FAILED');
    }
    return { ok: true };
  });
}
