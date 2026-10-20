import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { badRequest, unauthorized } from '../lib/errors.js';
import { languageHints } from '../lib/whisper.js';
import { TRANSCRIPTION_MAX_BYTES, isTranscriptionEnabled, type TranscriptionService } from '../terminal/transcription.js';

const idParam = z.object({ id: z.string().uuid() });
/** clip length in seconds, as measured by the recorder (drives the progress estimate) */
const createQuery = z.object({ seconds: z.coerce.number().min(0).max(600).optional() });

/**
 * Voice input for the terminals: the browser records a clip, POSTs it here and polls the job
 * until the text is ready; the frontend then pastes the text into the terminal. Nothing runs on
 * the tab's machine, so the routes hang off the "terminals" resource rather than a tab.
 */
export async function transcriptionRoutes(app: FastifyInstance, deps: { transcriptions: TranscriptionService }) {
  app.addContentTypeParser(/^audio\/.+/, { parseAs: 'buffer', bodyLimit: TRANSCRIPTION_MAX_BYTES }, (_req, body, done) => done(null, body));

  app.get('/config', async () => ({ enabled: isTranscriptionEnabled() }));

  app.post('/', { bodyLimit: TRANSCRIPTION_MAX_BYTES }, async (request, reply) => {
    if (!request.user) throw unauthorized();
    const mime = String(request.headers['content-type'] ?? '').split(';')[0].trim();
    if (!Buffer.isBuffer(request.body) || !mime.startsWith('audio/')) throw badRequest('Envie o áudio como corpo binário (content-type audio/*)');
    if (request.body.length === 0) throw badRequest('Áudio vazio');
    const { seconds } = createQuery.parse(request.query);
    const job = deps.transcriptions.start(request.user.id, request.body, mime, seconds ?? null, { hints: languageHints(request.headers['accept-language'], request.user.locale) });
    return reply.code(202).send({ transcription: deps.transcriptions.view(job) });
  });

  app.get('/:id', async (request) => {
    if (!request.user) throw unauthorized();
    const { id } = idParam.parse(request.params);
    return { transcription: deps.transcriptions.view(deps.transcriptions.get(request.user.id, id)) };
  });
}
