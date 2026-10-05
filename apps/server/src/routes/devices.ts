import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { formatVerificationCode, pushTestBody } from '@termhub/mobile-api';
import type { Repositories } from '../db/repositories/index.js';
import type { DeviceRequest } from '../db/repositories/device-requests.js';
import type { Device } from '../db/repositories/devices.js';
import type { DeviceEvent } from '../db/repositories/device-events.js';
import { notFound } from '../lib/errors.js';
import { clientLocation } from '../mobile/auth.js';
import type { EnrolmentService } from '../mobile/enrolment.js';
import type { MobilePushService } from '../mobile/push.js';
import type { RevokeInput } from '../mobile/revocation.js';

const idParam = z.object({ id: z.string().min(1).max(64) });
const renameBody = z.object({ name: z.string().trim().min(1).max(60) });

export interface DeviceRouteDeps {
  enrolment: EnrolmentService;
  revoke: (deviceId: string, input: RevokeInput) => Promise<Device | undefined>;
  /** "Enviar notificação de teste" (TER-913). */
  push: Pick<MobilePushService, 'testPush'>;
}

const toRequestView = (r: DeviceRequest) => ({
  id: r.id,
  device_name: r.device_name,
  model: r.model,
  platform: r.platform,
  os_version: r.os_version,
  country: r.country,
  city: r.city,
  ip: r.ip,
  verification_code: formatVerificationCode(r.verification_code),
  created_at: r.created_at,
  expires_at: r.expires_at,
});

/**
 * The pt-BR text shown next to a device trail row (spec §8). A pure function so it can be tested
 * without a database; unknown kinds — and `device_revoked` reasons outside the ones below — fall
 * back to the kind itself rather than guessing at a sentence.
 */
export function describeDeviceEvent(e: DeviceEvent): string {
  const meta = e.meta ?? {};
  const model = typeof meta.model === 'string' && meta.model.length > 0 ? meta.model : null;
  switch (e.kind) {
    case 'request_created':
      return model ? `Pedido de acesso de ${model}` : 'Pedido de acesso';
    case 'request_approved':
      return model ? `Pedido aprovado de ${model}` : 'Pedido aprovado';
    case 'request_denied':
      return 'Pedido recusado';
    case 'request_expired':
      return 'Pedido expirou sem resposta';
    case 'device_activated':
      return 'Aparelho ativado';
    case 'pin_failed':
      return typeof meta.failures === 'number' ? `PIN errado (${meta.failures}ª tentativa)` : 'PIN errado';
    case 'pin_locked':
      return 'PIN errado 3 vezes, aparelho bloqueado por 15 min';
    case 'device_revoked':
      if (meta.reason === 'pin_bruteforce') return 'Aparelho revogado por tentativas de PIN';
      if (meta.reason === 'user') return 'Aparelho revogado por você';
      if (meta.reason === 'admin') return 'Aparelho revogado por um administrador';
      if (meta.reason === 'review') return 'Aparelho revogado ao desligar o modo revisão';
      return 'Aparelho revogado';
    case 'push_token_set':
      return 'Notificações ativadas neste aparelho';
    case 'push_failed':
      if (meta.code === 'DeviceNotRegistered') return 'Notificação recusada: o aparelho não aceita mais avisos (app removido ou notificações desligadas)';
      if (meta.code === 'InvalidCredentials') return 'Notificação não entregue: credencial da Apple ou do Google inválida no servidor';
      return typeof meta.code === 'string' ? `Notificação não entregue (${meta.code})` : 'Notificação não entregue';
    case 'push_test':
      if (meta.outcome === 'delivered_to_provider') return 'Notificação de teste: entregue à Apple/Google';
      if (meta.outcome === 'receipt_pending') return 'Notificação de teste enviada; a Apple/Google ainda não confirmou';
      if (meta.outcome === 'send_failed') return 'Notificação de teste falhou: o servidor não conseguiu enviar';
      return typeof meta.outcome === 'string' ? `Notificação de teste falhou: ${meta.outcome}` : 'Notificação de teste';
    case 'review_auto_approved':
      return 'Aprovado automaticamente (conta de revisão)';
    case 'review_changed':
      return typeof meta.until === 'string' ? `Modo revisão ligado até ${formatBrDateTime(meta.until)}` : 'Modo revisão desligado';
    case 'token_refreshed':
      return 'Sessão renovada';
    default:
      return e.kind;
  }
}

/** `dd/mm/yyyy HH:MM` in the Brazil timezone, for the store-review trail (Task 17 review, finding 1). */
function formatBrDateTime(iso: string): string {
  const parts = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('day')}/${get('month')}/${get('year')} ${get('hour')}:${get('minute')}`;
}

/**
 * Web device routes (Settings → Aparelhos), mounted at `/api/devices`. Always the signed-in user's
 * own devices via `request.user`, never `request.scope` — an admin "viewing as" someone does not
 * get to see or manage that person's phones, same rule as `api-tokens.ts`.
 */
export async function deviceRoutes(app: FastifyInstance, repos: Repositories, deps: DeviceRouteDeps) {
  app.get('/requests', async (request) => {
    const requests = await repos.deviceRequests.listPendingForUser(request.user!.id, new Date());
    return { requests: requests.map(toRequestView) };
  });

  // Both decide an existing request, not create one — `config.action` overrides `guarded()`'s
  // default (POST → `create`), same as chat.ts's `/host` and `/reset`.
  app.post('/requests/:id/approve', { config: { action: 'update' } }, async (request) => {
    const { id } = idParam.parse(request.params);
    const decided = await deps.enrolment.approve(id, request.user!, clientLocation(request));
    return { request: toRequestView(decided) };
  });

  app.post('/requests/:id/deny', { config: { action: 'update' } }, async (request) => {
    const { id } = idParam.parse(request.params);
    const decided = await deps.enrolment.deny(id, request.user!, clientLocation(request));
    return { request: toRequestView(decided) };
  });

  app.get('/', async (request) => ({ devices: await repos.devices.listByUser(request.user!.id) }));

  app.patch('/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    const { name } = renameBody.parse(request.body ?? {});
    const device = await repos.devices.rename(id, request.user!.id, name);
    if (!device) throw notFound('Aparelho não encontrado');
    return { device };
  });

  app.delete('/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    const existing = await repos.devices.findById(id);
    if (!existing || existing.user_id !== request.user!.id) throw notFound('Aparelho não encontrado');
    const device = await deps.revoke(id, { reason: 'user', actor: 'user', ip: clientLocation(request).ip });
    if (!device) throw notFound('Aparelho não encontrado');
    return { device };
  });

  // A test push to one of the signed-in user's own active devices (TER-913). `update`, like the other
  // device actions: it changes nothing but must not be open to a read-only grant.
  app.post('/:id/test-push', { config: { action: 'update' } }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const body = pushTestBody.parse(request.body ?? {});
    const device = await repos.devices.findActiveById(id);
    if (!device || device.user_id !== request.user!.id) throw notFound('Aparelho não encontrado');
    return reply.code(202).send(await deps.push.testPush(request.user!, device, body.kind, body.delay_seconds));
  });

  app.get('/events', async (request) => {
    const events = await repos.deviceEvents.listForUser(request.user!.id, 50);
    return { events: events.map((e) => ({ ...e, text: describeDeviceEvent(e) })) };
  });

  app.get('/summary', async (request) => {
    const userId = request.user!.id;
    const [pending_requests, active_devices] = await Promise.all([
      repos.deviceRequests.countPendingForUser(userId, new Date()),
      repos.devices.countActive(userId),
    ]);
    return { pending_requests, active_devices };
  });
}
