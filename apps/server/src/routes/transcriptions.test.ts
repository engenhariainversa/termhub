import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '../db/repositories/types.js';
import { applyErrorHandler } from '../lib/errors.js';
import { TranscriptionService } from '../terminal/transcription.js';
import { transcriptionRoutes } from './transcriptions.js';

vi.mock('../config.js', () => ({
  config: { transcription: { url: 'http://whisper:8000', language: 'pt', secret: 'whisper-secret' } },
}));

const alice = { id: 'u-alice', name: 'Alice' } as User;
const bob = { id: 'u-bob', name: 'Bob' } as User;

/** Routes with the real service, the auth hook replaced by a fixed user (header x-user picks who). */
function buildApp(service: TranscriptionService) {
  const app = Fastify();
  applyErrorHandler(app);
  app.addHook('preHandler', async (request) => {
    request.user = request.headers['x-user'] === 'bob' ? bob : alice;
  });
  app.register((a) => transcriptionRoutes(a, { transcriptions: service }), { prefix: '/api/transcriptions' });
  return app;
}

const fetchMock = vi.fn<typeof fetch>();
const whisperAnswers = (status: number, body: unknown) =>
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));

/** Lets the background whisper call settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('POST /api/transcriptions', () => {
  it('accepts an audio body, answers 202 with a pending job and forwards the clip to whisper', async () => {
    whisperAnswers(200, { text: '  ola mundo ', language: 'pt', duration: 1.5 });
    const service = new TranscriptionService({ log: () => {} });
    const app = buildApp(service);
    const res = await app.inject({ method: 'POST', url: '/api/transcriptions', headers: { 'content-type': 'audio/webm;codecs=opus' }, payload: Buffer.from('audio-bytes') });
    expect(res.statusCode).toBe(202);
    const job = res.json().transcription;
    expect(job.status).toBe('pending');
    expect(job.text).toBeUndefined();

    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('http://whisper:8000/transcribe?language=pt');
    expect((init?.headers as Record<string, string>)['content-type']).toBe('audio/webm');
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer whisper-secret');
    expect(Buffer.from(init?.body as Uint8Array).toString()).toBe('audio-bytes');

    const done = await app.inject({ method: 'GET', url: `/api/transcriptions/${job.id}` });
    expect(done.json().transcription).toMatchObject({ id: job.id, status: 'done', text: 'ola mundo', duration: 1.5 });
  });

  it('estimates progress from the clip length while pending and learns the real speed', async () => {
    let answer: (r: Response) => void = () => {};
    fetchMock.mockReturnValueOnce(new Promise<Response>((r) => (answer = r)));
    const service = new TranscriptionService({ log: () => {} });
    const app = buildApp(service);
    const res = await app.inject({ method: 'POST', url: '/api/transcriptions?seconds=60', headers: { 'content-type': 'audio/webm' }, payload: Buffer.from('x') });
    const job = res.json().transcription;
    expect(job.eta_seconds).toBeGreaterThan(10); // 1.5 + 60 × 0.35 ≈ 22 s
    expect(job.progress).toBeGreaterThanOrEqual(0);
    expect(job.progress).toBeLessThan(0.2);

    answer(new Response(JSON.stringify({ text: 'ok', language: 'pt', duration: 60 }), { status: 200 }));
    await settle();
    const done = (await app.inject({ method: 'GET', url: `/api/transcriptions/${job.id}` })).json().transcription;
    expect(done.status).toBe('done');
    expect(done.eta_seconds).toBeUndefined();
    // the finished job (instant here) taught the service the machine is fast: the next estimate shrinks
    expect(service.estimateSeconds(60)).toBeLessThan(5);
  });

  it('rejects a non-audio body', async () => {
    const app = buildApp(new TranscriptionService({ log: () => {} }));
    const res = await app.inject({ method: 'POST', url: '/api/transcriptions', headers: { 'content-type': 'application/json' }, payload: { audio: 'x' } });
    expect(res.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('turns a whisper failure into an error job with a user-facing message', async () => {
    whisperAnswers(422, { error: 'could not decode audio' });
    const service = new TranscriptionService({ log: () => {} });
    const app = buildApp(service);
    const res = await app.inject({ method: 'POST', url: '/api/transcriptions', headers: { 'content-type': 'audio/mp4' }, payload: Buffer.from('bad') });
    const { id } = res.json().transcription;
    await settle();
    const job = (await app.inject({ method: 'GET', url: `/api/transcriptions/${id}` })).json().transcription;
    expect(job.status).toBe('error');
    expect(job.error).toBe('Não foi possível decodificar o áudio');
  });

  it('reports an unreachable whisper without leaking the failure', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    const service = new TranscriptionService({ log: () => {} });
    const app = buildApp(service);
    const { id } = (await app.inject({ method: 'POST', url: '/api/transcriptions', headers: { 'content-type': 'audio/webm' }, payload: Buffer.from('x') })).json().transcription;
    await settle();
    const job = (await app.inject({ method: 'GET', url: `/api/transcriptions/${id}` })).json().transcription;
    expect(job).toMatchObject({ status: 'error', error: 'Serviço de transcrição indisponível' });
  });

  it('keeps jobs private to their owner', async () => {
    whisperAnswers(200, { text: 'segredo', language: 'pt', duration: 1 });
    const app = buildApp(new TranscriptionService({ log: () => {} }));
    const { id } = (await app.inject({ method: 'POST', url: '/api/transcriptions', headers: { 'content-type': 'audio/webm' }, payload: Buffer.from('x') })).json().transcription;
    await settle();
    const other = await app.inject({ method: 'GET', url: `/api/transcriptions/${id}`, headers: { 'x-user': 'bob' } });
    expect(other.statusCode).toBe(404);
    const unknown = await app.inject({ method: 'GET', url: '/api/transcriptions/00000000-0000-4000-8000-000000000000' });
    expect(unknown.statusCode).toBe(404);
  });

  it('limits pending clips per user', async () => {
    // whisper never answers: both jobs stay pending
    fetchMock.mockReturnValue(new Promise(() => {}));
    const app = buildApp(new TranscriptionService({ log: () => {} }));
    const post = () => app.inject({ method: 'POST', url: '/api/transcriptions', headers: { 'content-type': 'audio/webm' }, payload: Buffer.from('x') });
    expect((await post()).statusCode).toBe(202);
    expect((await post()).statusCode).toBe(202);
    const third = await post();
    expect(third.statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: '/api/transcriptions', headers: { 'content-type': 'audio/webm', 'x-user': 'bob' }, payload: Buffer.from('x') })).statusCode).toBe(202);
  });

  it('rejects a clip whisper measured past maxSeconds, even though the client-reported seconds were within range', async () => {
    whisperAnswers(200, { text: 'texto longo', language: 'pt', duration: 400 });
    const service = new TranscriptionService({ log: () => {} });
    const job = service.start('u-alice', Buffer.from('x'), 'audio/mp4', 300, { maxSeconds: 330 });
    await settle();
    const view = service.view(service.get('u-alice', job.id));
    expect(view.status).toBe('error');
    expect(view.code).toBe('TOO_LONG');
    expect(view.error).toBe('Áudio longo demais');
  });
});

describe('GET /api/transcriptions/config', () => {
  it('tells the client the feature is on', async () => {
    const app = buildApp(new TranscriptionService({ log: () => {} }));
    expect((await app.inject({ method: 'GET', url: '/api/transcriptions/config' })).json()).toEqual({ enabled: true });
  });
});
