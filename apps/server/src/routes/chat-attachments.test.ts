import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import type { AttachmentRow, CreateAttachmentInput } from '../db/repositories/chat-attachments.js';
import { applyErrorHandler } from '../lib/errors.js';
import type { AttachmentStore } from '../chat/attachments/store.js';
import { chatAttachmentRoutes } from './chat-attachments.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
const OLE = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(16)]);

const row = (over: Partial<AttachmentRow> = {}): AttachmentRow => ({
  id: 'at1', user_id: 'u1', conversation_id: 'c1', message_id: null, name: 'notas.txt', mime: 'text/plain; charset=utf-8', kind: 'text', bytes: 5, sha256: 'h',
  status: 'ready', error_code: null, extracted_text: 'hello', meta: null, created_at: '2026-09-26T12:00:00.000Z', ...over,
});

function fakeStore() {
  const files = new Map<string, Buffer>();
  const store: AttachmentStore = {
    write: vi.fn(async (u: string, id: string, d: Buffer) => {
      files.set(`${u}/${id}`, d);
    }),
    read: vi.fn(async (u: string, id: string) => {
      const f = files.get(`${u}/${id}`);
      if (!f) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
      return f;
    }),
    remove: vi.fn(async (u: string, id: string) => {
      files.delete(`${u}/${id}`);
    }),
    listAll: async function* () {},
  };
  return { files, store };
}

function build(opts: { rows?: AttachmentRow[]; quotaBytes?: number; createFails?: boolean; files?: [string, Buffer][] } = {}) {
  const rows = new Map((opts.rows ?? []).map((r) => [r.id, { ...r }]));
  const chatAttachments = {
    create: vi.fn(async (input: CreateAttachmentInput) => {
      if (opts.createFails) throw Object.assign(new Error('pg down'), { code: 'P1001' });
      const created = row({ ...input, message_id: null, status: 'pending', error_code: null, extracted_text: null });
      rows.set(created.id, created);
      return created;
    }),
    findForUser: vi.fn(async (id: string, userId: string) => {
      const r = rows.get(id);
      return r && r.user_id === userId ? r : null;
    }),
    usageBytes: vi.fn(async (userId: string) => [...rows.values()].filter((r) => r.user_id === userId).reduce((s, r) => s + r.bytes, 0)),
    deleteUnsent: vi.fn(async (id: string, userId: string) => {
      const r = rows.get(id);
      if (!r || r.user_id !== userId || r.message_id !== null) return false;
      rows.delete(id);
      return true;
    }),
  };
  const { files, store } = fakeStore();
  for (const [k, v] of opts.files ?? []) files.set(k, v);
  const queue = { enqueue: vi.fn() };
  const service = { conversationFor: vi.fn(async (_u: unknown, projectId: string | null) => ({ id: projectId ? `c_${projectId}` : 'c1' })) };
  const app = Fastify();
  applyErrorHandler(app);
  app.decorateRequest('scope', null);
  app.addHook('preHandler', async (req) => {
    (req as unknown as { scope: unknown }).scope = { user: { id: 'u1' }, viewAs: { kind: 'self' }, ownerId: 'u1', createAs: 'u1' };
  });
  app.register((a) => chatAttachmentRoutes(a, { chatAttachments } as unknown as Repositories, { service: service as never, store, queue, quotaBytes: opts.quotaBytes ?? 2_147_483_648 }), { prefix: '/chat/attachments' });
  return { app, rows, files, store, queue, service, chatAttachments };
}

const upload = (app: ReturnType<typeof Fastify>, body: Buffer | string, name: string, type = 'application/octet-stream', extra = '') =>
  app.inject({ method: 'POST', url: `/chat/attachments?name=${encodeURIComponent(name)}${extra}`, headers: { 'content-type': type }, payload: body });

describe('POST /chat/attachments', () => {
  it('stores a PNG: sniffed kind and mime, pending row, file on disk, one queued job', async () => {
    const { app, files, queue, service, chatAttachments } = build();
    const res = await upload(app, PNG, 'foto.png', 'image/png', '&project_id=p1');
    expect(res.statusCode).toBe(201);
    const a = res.json().attachment;
    expect(a).toMatchObject({ name: 'foto.png', kind: 'image', mime: 'image/png', bytes: PNG.length, status: 'pending', error_code: null });
    expect(a).not.toHaveProperty('user_id');
    expect(a).not.toHaveProperty('sha256');
    expect(files.get(`u1/${a.id}`)?.equals(PNG)).toBe(true);
    expect(queue.enqueue).toHaveBeenCalledWith(a.id);
    expect(service.conversationFor).toHaveBeenCalledWith(expect.objectContaining({ id: 'u1' }), 'p1');
    expect(chatAttachments.create.mock.calls[0][0]).toMatchObject({ id: a.id, user_id: 'u1', conversation_id: 'c_p1', kind: 'image', sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });

  it('a file whose extension lies is refused by its bytes, and nothing is stored (Review Focus 1)', async () => {
    const { app, files, chatAttachments, queue } = build();
    const svg = await upload(app, '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', 'foto.png', 'image/png');
    expect(svg.statusCode).toBe(415);
    expect(svg.json()).toEqual({ error: 'Tipo de arquivo não suportado', code: 'ATTACHMENT_TYPE' });
    const html = await upload(app, '<!doctype html><script>alert(1)</script>', 'foto.png', 'image/png');
    expect(html.statusCode).toBe(415);
    const zipAsPdf = await upload(app, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]), 'relatorio.pdf', 'application/pdf');
    expect(zipAsPdf.statusCode).toBe(415);
    expect(files.size).toBe(0);
    expect(chatAttachments.create).not.toHaveBeenCalled();
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it('the legacy office container gets its own message', async () => {
    const { app } = build();
    const res = await upload(app, OLE, 'antigo.doc');
    expect(res.statusCode).toBe(415);
    expect(res.json()).toEqual({ error: 'Envie como .docx/.xlsx', code: 'ATTACHMENT_TYPE' });
  });

  it('a file over its kind limit answers 413 ATTACHMENT_TOO_LARGE', async () => {
    const { app, files } = build();
    const res = await upload(app, Buffer.alloc(1_048_577, 0x61), 'grande.txt', 'text/plain');
    expect(res.statusCode).toBe(413);
    expect(res.json()).toMatchObject({ code: 'ATTACHMENT_TOO_LARGE' });
    expect(files.size).toBe(0);
  });

  it('a file past the user quota answers 413 ATTACHMENT_QUOTA', async () => {
    const { app, files } = build({ quotaBytes: 100, rows: [row({ id: 'old', bytes: 90 })] });
    const res = await upload(app, Buffer.alloc(20, 0x61), 'notas.txt');
    expect(res.statusCode).toBe(413);
    expect(res.json()).toMatchObject({ code: 'ATTACHMENT_QUOTA' });
    expect(files.size).toBe(0);
  });

  it('when the row cannot be inserted, the file just written is removed again', async () => {
    const { app, files, store } = build({ createFails: true });
    const res = await upload(app, PNG, 'foto.png');
    expect(res.statusCode).toBe(500);
    expect(store.remove).toHaveBeenCalledTimes(1);
    expect(files.size).toBe(0);
  });

  it('refuses an empty body, a JSON body, and a name it cannot use', async () => {
    const { app } = build();
    expect((await upload(app, Buffer.alloc(0), 'a.txt')).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/chat/attachments?name=a.txt', payload: { text: 'x' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/chat/attachments', headers: { 'content-type': 'application/octet-stream' }, payload: PNG })).statusCode).toBe(400);
    expect((await upload(app, PNG, 'x'.repeat(201))).statusCode).toBe(400);
  });

  it('keeps the name for display with control characters and separators replaced', async () => {
    const { app } = build();
    const res = await upload(app, PNG, '../..\\evil\u0000name\n.png');
    expect(res.json().attachment.name).toBe('.._.._evil_name_.png');
  });
});

describe('GET /chat/attachments/:id (download) and /status', () => {
  it('a non-image downloads as an attachment, sandboxed, never sniffed', async () => {
    const { app } = build({ rows: [row()], files: [['u1/at1', Buffer.from('hello')]] });
    const res = await app.inject({ method: 'GET', url: '/chat/attachments/at1' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('hello');
    expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(res.headers['content-disposition']).toBe("attachment; filename=\"notas.txt\"; filename*=UTF-8''notas.txt");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBe('sandbox');
    expect(res.headers['cache-control']).toBe('private, max-age=3600');
  });

  it('an HTML body accepted as a text attachment is still served as inert plain text (B3 carry-over)', async () => {
    const html = Buffer.from('<!doctype html><html><body><script>alert(1)</script></body></html>');
    const { app } = build({ rows: [row({ id: 'page', name: 'pagina.txt', bytes: html.length })], files: [['u1/page', html]] });
    const res = await app.inject({ method: 'GET', url: '/chat/attachments/page' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(html.toString());
    expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-disposition']).toMatch(/^attachment;/);
    expect(res.headers['content-security-policy']).toBe('sandbox');
  });

  it('an image is served inline, with a non-ASCII name escaped in both forms', async () => {
    const { app } = build({ rows: [row({ id: 'img', kind: 'image', mime: 'image/png', name: 'fotografia ação.png' })], files: [['u1/img', PNG]] });
    const res = await app.inject({ method: 'GET', url: '/chat/attachments/img' });
    expect(res.headers['content-disposition']).toBe("inline; filename=\"fotografia a__o.png\"; filename*=UTF-8''fotografia%20a%C3%A7%C3%A3o.png");
    expect(res.headers['content-type']).toBe('image/png');
  });

  it('another user\'s id is a 404 on download, status and delete (Review Focus 3)', async () => {
    const { app, files } = build({ rows: [row({ id: 'theirs', user_id: 'u2' })], files: [['u2/theirs', Buffer.from('x')]] });
    for (const [method, url] of [['GET', '/chat/attachments/theirs'], ['GET', '/chat/attachments/theirs/status'], ['DELETE', '/chat/attachments/theirs']] as const) {
      const res = await app.inject({ method, url });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Anexo não encontrado', code: 'NOT_FOUND' });
    }
    expect(files.has('u2/theirs')).toBe(true);
  });

  it('a row whose file is gone answers 404 with its own message', async () => {
    const { app } = build({ rows: [row()] });
    const res = await app.inject({ method: 'GET', url: '/chat/attachments/at1' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('O arquivo deste anexo não está mais disponível');
  });

  it('status answers the public row', async () => {
    const { app } = build({ rows: [row({ status: 'failed', error_code: 'TRANSCRIPTION_UNAVAILABLE', extracted_text: 'SEGREDO' })] });
    const res = await app.inject({ method: 'GET', url: '/chat/attachments/at1/status' });
    expect(res.json()).toEqual({ attachment: { id: 'at1', name: 'notas.txt', mime: 'text/plain; charset=utf-8', kind: 'text', bytes: 5, status: 'failed', error_code: 'TRANSCRIPTION_UNAVAILABLE', meta: null, created_at: '2026-09-26T12:00:00.000Z' } });
    expect(res.body).not.toContain('SEGREDO');
  });

  it('an id that is not id-shaped is a 400, never a path', async () => {
    const { app, store } = build();
    expect((await app.inject({ method: 'GET', url: '/chat/attachments/AB..1' })).statusCode).toBe(400);
    expect(store.read).not.toHaveBeenCalled();
  });
});

describe('DELETE /chat/attachments/:id', () => {
  it('removes an unsent attachment and its file', async () => {
    const { app, rows, files } = build({ rows: [row()], files: [['u1/at1', Buffer.from('hello')]] });
    const res = await app.inject({ method: 'DELETE', url: '/chat/attachments/at1' });
    expect(res.statusCode).toBe(200);
    expect(rows.has('at1')).toBe(false);
    expect(files.has('u1/at1')).toBe(false);
  });

  it('refuses one already sent with 409 and keeps the file', async () => {
    const { app, files } = build({ rows: [row({ message_id: 'm1' })], files: [['u1/at1', Buffer.from('hello')]] });
    const res = await app.inject({ method: 'DELETE', url: '/chat/attachments/at1' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'Este anexo já foi enviado', code: 'CONFLICT' });
    expect(files.has('u1/at1')).toBe(true);
  });
});
