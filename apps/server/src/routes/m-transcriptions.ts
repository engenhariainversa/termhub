import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError, badRequest, unauthorized } from '../lib/errors.js';
import { SlidingWindow } from '../mobile/rate-limit.js';
import { TRANSCRIPTION_MAX_BYTES, isTranscriptionEnabled, type TranscriptionService } from '../terminal/transcription.js';
import { languageHints } from '../lib/whisper.js';

const idParam = z.object({ id: z.string().uuid() });

/** Codecs the apps actually record: tighter than the web's "any audio/*" because a phone isn't a trusted browser tab. */
export const MOBILE_AUDIO_TYPES = new Set(['audio/mp4', 'audio/m4a', 'audio/x-m4a', 'audio/aac', 'audio/3gpp', 'audio/webm', 'audio/ogg', 'audio/wav']);
/** The apps cap recording client-side at 5 minutes; the upload must say so. */
export const MOBILE_MAX_SECONDS = 300;
/** Past this whisper-measured duration a clip is rejected after the fact, even if the client under-reported `seconds`. */
export const MOBILE_TOO_LONG_SECONDS = 330;
export const MOBILE_UPLOADS_PER_10MIN = 10;

/** clip length in seconds, as measured by the recorder; required (unlike the web) so the limiter and estimate always have a value. */
const createQuery = z.object({ seconds: z.coerce.number().min(0).max(MOBILE_MAX_SECONDS) });

const tooManyUploads = () => new HttpError(429, 'Muitos envios de áudio; tente de novo em alguns minutos', 'RATE_LIMITED');

/**
 * Mirrors the web's `routes/transcriptions.ts` under the mobile prefix (guarded `terminals`), with
 * rules suited to an app rather than a trusted browser tab: a MIME allowlist instead of any
 * `audio/*`, a mandatory `seconds` capped at 5 minutes, and a per-device sliding-window limit on top
 * of the service's own per-user pending-job cap.
 */
export async function mobileTranscriptionRoutes(app: FastifyInstance, deps: { transcriptions: TranscriptionService }) {
  const uploadLimiter = new SlidingWindow(10 * 60_000, MOBILE_UPLOADS_PER_10MIN);

  app.addContentTypeParser(/^audio\/.+/, { parseAs: 'buffer', bodyLimit: TRANSCRIPTION_MAX_BYTES }, (_req, body, done) => done(null, body));

  app.get('/config', async () => ({ enabled: isTranscriptionEnabled() }));

  app.post('/', { bodyLimit: TRANSCRIPTION_MAX_BYTES }, async (request, reply) => {
    if (!request.user || !request.mobile || !('device' in request.mobile)) throw unauthorized();
    const mime = String(request.headers['content-type'] ?? '').split(';')[0].trim();
    if (!MOBILE_AUDIO_TYPES.has(mime)) throw badRequest('Formato de áudio não aceito');
    // Checked before the limiter, so an empty upload never spends one of the device's slots.
    if (!Buffer.isBuffer(request.body) || request.body.length === 0) throw badRequest('Áudio vazio');
    const { seconds } = createQuery.parse(request.query);
    if (!uploadLimiter.take(request.mobile.device.id)) throw tooManyUploads();
    const job = deps.transcriptions.start(request.user.id, request.body, mime, seconds, { maxSeconds: MOBILE_TOO_LONG_SECONDS, hints: languageHints(request.headers['accept-language'], request.user.locale) });
    return reply.code(202).send({ transcription: deps.transcriptions.view(job) });
  });

  app.get('/:id', async (request) => {
    if (!request.user) throw unauthorized();
    const { id } = idParam.parse(request.params);
    return { transcription: deps.transcriptions.view(deps.transcriptions.get(request.user.id, id)) };
  });
}
