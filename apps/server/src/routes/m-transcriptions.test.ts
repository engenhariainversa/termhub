import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { Device } from '../db/repositories/devices.js';
import type { User } from '../db/repositories/types.js';
import { applyErrorHandler } from '../lib/errors.js';
import type { TranscriptionJob, TranscriptionService, TranscriptionView } from '../terminal/transcription.js';
import { MOBILE_TOO_LONG_SECONDS, MOBILE_UPLOADS_PER_10MIN, mobileTranscriptionRoutes } from './m-transcriptions.js';

vi.mock('../config.js', () => ({
  config: { transcription: { url: 'http://whisper:8000', language: 'pt', secret: 'whisper-secret' } },
}));

const alice = { id: 'u-alice', name: 'Alice' } as User;
const baseDevice: Device = {
  id: 'd1',
  user_id: 'u-alice',
  name: 'iPhone de Alice',
  platform: 'ios',
  model: 'iPhone 15',
  os_version: '18.0',
  app_version: '1.0.0+1',
  public_key: '{}',
  key_thumbprint: 'thumb',
  pin_failures: 0,
  pin_locked_until: null,
  status: 'active',
  revoked_at: null,
  revoked_reason: null,
  push_token: null,
  last_seen_at: null,
  last_ip: null,
  request_id: null,
  created_at: '2026-09-19T00:00:00.000Z',
};

/** A stand-in for TranscriptionService: the route's job is parsing/guarding, not the whisper flow. */
function fakeService(): TranscriptionService {
  const job: TranscriptionJob = { id: 'job1', user_id: 'u-alice', status: 'pending', audio_seconds: null, created_at: Date.now() };
  return {
    start: vi.fn(() => job),
    view: vi.fn((j: TranscriptionJob): TranscriptionView => ({ id: j.id, status: j.status })),
    get: vi.fn(() => job),
  } as unknown as TranscriptionService;
}

/** Mobile routes with the auth hook replaced by a fixed device/user (header x-device picks the device). */
function buildApp(service: TranscriptionService) {
  const app = Fastify();
  applyErrorHandler(app);
  app.addHook('preHandler', async (request) => {
    const deviceId = (request.headers['x-device'] as string | undefined) ?? 'd1';
    request.user = alice;
    request.mobile = { device: { ...baseDevice, id: deviceId }, user: alice } as never;
  });
  app.register((a) => mobileTranscriptionRoutes(a, { transcriptions: service }), { prefix: '/api/m/v1/transcriptions' });
  return app;
}

describe('POST /api/m/v1/transcriptions', () => {
  it('accepts an allowed MIME with seconds, forwards it with maxSeconds and answers 202', async () => {
    const service = fakeService();
    const app = buildApp(service);
    const res = await app.inject({
      method: 'POST',
      url: '/api/m/v1/transcriptions?seconds=12',
      headers: { 'content-type': 'audio/mp4' },
      payload: Buffer.from('clip-bytes'),
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().transcription.id).toBe('job1');
    expect(service.start).toHaveBeenCalledTimes(1);
    const [userId, body, mime, seconds, opts] = (service.start as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(userId).toBe('u-alice');
    expect(Buffer.from(body).toString()).toBe('clip-bytes');
    expect(mime).toBe('audio/mp4');
    expect(seconds).toBe(12);
    expect(opts).toEqual({ maxSeconds: MOBILE_TOO_LONG_SECONDS });
  });

  it('strips MIME parameters before checking the allowlist', async () => {
    const service = fakeService();
    const app = buildApp(service);
    const res = await app.inject({
      method: 'POST',
      url: '/api/m/v1/transcriptions?seconds=1',
      headers: { 'content-type': 'audio/mp4;codecs=mp4a' },
      payload: Buffer.from('x'),
    });
    expect(res.statusCode).toBe(202);
    expect((service.start as ReturnType<typeof vi.fn>).mock.calls[0][2]).toBe('audio/mp4');
  });

  it('rejects a MIME type outside the allowlist', async () => {
    const service = fakeService();
    const app = buildApp(service);
    const res = await app.inject({
      method: 'POST',
      url: '/api/m/v1/transcriptions?seconds=1',
      headers: { 'content-type': 'audio/flac' },
      payload: Buffer.from('x'),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('Formato de áudio não aceito');
    expect(service.start).not.toHaveBeenCalled();
  });

  it('rejects an empty body with "Áudio vazio", like the web', async () => {
    const service = fakeService();
    const app = buildApp(service);
    const res = await app.inject({
      method: 'POST',
      url: '/api/m/v1/transcriptions?seconds=1',
      headers: { 'content-type': 'audio/mp4' },
      payload: Buffer.alloc(0),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('Áudio vazio');
    expect(service.start).not.toHaveBeenCalled();
  });

  it('requires seconds', async () => {
    const service = fakeService();
    const app = buildApp(service);
    const res = await app.inject({
      method: 'POST',
      url: '/api/m/v1/transcriptions',
      headers: { 'content-type': 'audio/mp4' },
      payload: Buffer.from('x'),
    });
    expect(res.statusCode).toBe(400);
    expect(service.start).not.toHaveBeenCalled();
  });

  it('rejects seconds above the 300s cap', async () => {
    const service = fakeService();
    const app = buildApp(service);
    const res = await app.inject({
      method: 'POST',
      url: '/api/m/v1/transcriptions?seconds=301',
      headers: { 'content-type': 'audio/mp4' },
      payload: Buffer.from('x'),
    });
    expect(res.statusCode).toBe(400);
    expect(service.start).not.toHaveBeenCalled();
  });

  it('rate-limits a device to 10 uploads per 10 minutes, and keys the budget by device rather than user', async () => {
    const service = fakeService();
    const app = buildApp(service);
    const post = (deviceId: string) =>
      app.inject({
        method: 'POST',
        url: '/api/m/v1/transcriptions?seconds=1',
        headers: { 'content-type': 'audio/mp4', 'x-device': deviceId },
        payload: Buffer.from('x'),
      });
    for (let i = 0; i < MOBILE_UPLOADS_PER_10MIN; i++) {
      expect((await post('d1')).statusCode).toBe(202);
    }
    const eleventh = await post('d1');
    expect(eleventh.statusCode).toBe(429);
    expect(eleventh.json()).toMatchObject({ code: 'RATE_LIMITED', error: 'Muitos envios de áudio; tente de novo em alguns minutos' });

    // same user, different device: its own budget, untouched by d1's uploads
    expect((await post('d2')).statusCode).toBe(202);
  });
});

describe('GET /api/m/v1/transcriptions/config', () => {
  it('mirrors the web: tells the client whether transcription is enabled', async () => {
    const app = buildApp(fakeService());
    const res = await app.inject({ method: 'GET', url: '/api/m/v1/transcriptions/config' });
    expect(res.json()).toEqual({ enabled: true });
  });
});

describe('GET /api/m/v1/transcriptions/:id', () => {
  it('mirrors the web: returns the job view for the current user', async () => {
    const service = fakeService();
    const app = buildApp(service);
    const id = '00000000-0000-4000-8000-000000000000';
    const res = await app.inject({ method: 'GET', url: `/api/m/v1/transcriptions/${id}` });
    expect(res.statusCode).toBe(200);
    expect(service.get).toHaveBeenCalledWith('u-alice', id);
  });
});
