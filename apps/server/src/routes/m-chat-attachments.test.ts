import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { Device } from '../db/repositories/devices.js';
import type { Repositories } from '../db/repositories/index.js';
import type { AttachmentRow, CreateAttachmentInput } from '../db/repositories/chat-attachments.js';
import type { User } from '../db/repositories/types.js';
import { applyErrorHandler } from '../lib/errors.js';
import type { AttachmentStore } from '../chat/attachments/store.js';
import { MOBILE_ATTACHMENT_UPLOADS_PER_10MIN, mobileChatAttachmentRoutes } from './m-chat-attachments.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
const user = { id: 'u1', email: 'ana@example.com', name: 'Ana' } as User;
const device: Device = {
  id: 'd1', user_id: 'u1', name: 'iPhone de Ana', platform: 'ios', model: 'iPhone 15', os_version: '18.0', app_version: '1.0.0+1', public_key: '{}', key_thumbprint: 'thumb',
  pin_failures: 0, pin_locked_until: null, status: 'active', revoked_at: null, revoked_reason: null, push_token: null, last_seen_at: null, last_ip: null, request_id: null, created_at: '2026-09-19T00:00:00.000Z',
};
const row = (over: Partial<AttachmentRow> = {}): AttachmentRow => ({
  id: 'at1', user_id: 'u1', conversation_id: 'c1', message_id: null, name: 'notas.txt', mime: 'text/plain; charset=utf-8', kind: 'text', bytes: 5, sha256: 'h',
  status: 'ready', error_code: null, extracted_text: null, meta: null, created_at: '2026-09-26T12:00:00.000Z', ...over,
});

function build(rows: AttachmentRow[] = []) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const chatAttachments = {
    create: vi.fn(async (input: CreateAttachmentInput) => row({ ...input, status: 'pending' })),
    findForUser: vi.fn(async (id: string, userId: string) => (byId.get(id)?.user_id === userId ? byId.get(id)! : null)),
    usageBytes: vi.fn(async () => 0),
    deleteUnsent: vi.fn(async () => false),
  };
  const files = new Map<string, Buffer>();
  const store: AttachmentStore = {
    write: vi.fn(async (u: string, id: string, d: Buffer) => void files.set(`${u}/${id}`, d)),
    read: vi.fn(async (u: string, id: string) => files.get(`${u}/${id}`) ?? Promise.reject(Object.assign(new Error('gone'), { code: 'ENOENT' }))),
    remove: vi.fn(async () => undefined),
    listAll: async function* () {},
  };
  const queue = { enqueue: vi.fn() };
  const service = { conversationFor: vi.fn(async () => ({ id: 'c1' })) };
  const app = Fastify();
  applyErrorHandler(app);
  app.decorateRequest('scope', null);
  app.addHook('preHandler', async (req) => {
    const deviceId = (req.headers['x-device'] as string | undefined) ?? 'd1';
    (req as unknown as { scope: unknown }).scope = { user, viewAs: { kind: 'self' }, ownerId: 'u1', createAs: 'u1' };
    req.user = user;
    req.mobile = { device: { ...device, id: deviceId }, user } as never;
  });
  app.register((a) => mobileChatAttachmentRoutes(a, { chatAttachments } as unknown as Repositories, { service: service as never, store, queue, quotaBytes: 1_000_000 }), { prefix: '/api/m/v1/chat/attachments' });
  const post = (deviceId = 'd1', body: Buffer = PNG) =>
    app.inject({ method: 'POST', url: '/api/m/v1/chat/attachments?name=foto.png', headers: { 'content-type': 'image/png', 'x-device': deviceId }, payload: body });
  return { app, post, queue, chatAttachments, files };
}

describe('POST /api/m/v1/chat/attachments', () => {
  it('mirrors the web upload: 201 with the public row, file stored, job queued', async () => {
    const { post, queue, files } = build();
    const res = await post();
    expect(res.statusCode).toBe(201);
    expect(res.json().attachment).toMatchObject({ kind: 'image', mime: 'image/png', status: 'pending' });
    expect(queue.enqueue).toHaveBeenCalledTimes(1);
    expect(files.size).toBe(1);
  });

  it('rate-limits a device to 30 uploads per 10 minutes, keyed by device, and an empty body never spends a slot', async () => {
    const { post, chatAttachments } = build();
    for (let i = 0; i < MOBILE_ATTACHMENT_UPLOADS_PER_10MIN; i++) expect((await post('d1')).statusCode).toBe(201);
    const over = await post('d1');
    expect(over.statusCode).toBe(429);
    expect(over.json()).toEqual({ error: 'Muitos envios de arquivo; tente de novo em alguns minutos', code: 'RATE_LIMITED' });
    expect((await post('d2')).statusCode).toBe(201);
    expect(chatAttachments.create).toHaveBeenCalledTimes(MOBILE_ATTACHMENT_UPLOADS_PER_10MIN + 1);
    expect((await post('d1', Buffer.alloc(0))).statusCode).toBe(400);
  });

  it('serves status and download for the owner and 404 for anyone else', async () => {
    const { app, files } = build([row({ id: 'mine' }), row({ id: 'theirs', user_id: 'u2' })]);
    files.set('u1/mine', Buffer.from('hello'));
    expect((await app.inject({ method: 'GET', url: '/api/m/v1/chat/attachments/mine/status' })).json().attachment.id).toBe('mine');
    const dl = await app.inject({ method: 'GET', url: '/api/m/v1/chat/attachments/mine' });
    expect(dl.statusCode).toBe(200);
    expect(dl.headers['content-disposition']).toMatch(/^attachment;/);
    expect((await app.inject({ method: 'GET', url: '/api/m/v1/chat/attachments/theirs/status' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/m/v1/chat/attachments/theirs' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: '/api/m/v1/chat/attachments/theirs' })).statusCode).toBe(404);
  });
});
