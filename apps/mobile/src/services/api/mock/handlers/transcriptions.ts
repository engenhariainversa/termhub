// Voice notes (P§6 `/transcriptions`), mirrored from `apps/server/src/routes/m-transcriptions.ts`:
// the same MIME allowlist and `seconds` bound, a `202` with a pending job, and the job done on its
// second poll with a canned pt-BR sentence — the mock never decodes audio.
import { randomId } from '../../../crypto/random';
import { isUploadBody, type MockRouter } from '../router';
import { type MockState, verifyAuth, WireError } from '../state';

/** The server's `MOBILE_AUDIO_TYPES`. */
export const MOBILE_AUDIO_TYPES = new Set(['audio/mp4', 'audio/m4a', 'audio/x-m4a', 'audio/aac', 'audio/3gpp', 'audio/webm', 'audio/ogg', 'audio/wav']);
const MOBILE_MAX_SECONDS = 300;
export const MOCK_TRANSCRIPT = 'roda os testes da aba api';

export function registerTranscriptionRoutes(router: MockRouter, state: MockState): void {
  router.route('GET', '/api/m/v1/transcriptions/config', (ctx) => {
    verifyAuth(state, { headers: ctx.headers, htm: 'GET', htu: ctx.htu, now: ctx.now() });
    return { status: 200, body: { enabled: true } };
  });

  router.route('POST', '/api/m/v1/transcriptions', (ctx) => {
    verifyAuth(state, { headers: ctx.headers, htm: 'POST', htu: ctx.htu, now: ctx.now() });
    // Decided on the header, as the real route does; the body only says which file it was.
    const mime = (ctx.headers['content-type'] ?? '').split(';')[0]!.trim();
    if (!MOBILE_AUDIO_TYPES.has(mime)) throw new WireError(400, 'BAD_REQUEST', 'Formato de áudio não aceito');
    if (!isUploadBody(ctx.body)) throw new WireError(400, 'BAD_REQUEST', 'Áudio vazio');
    const seconds = Number(ctx.query.seconds);
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > MOBILE_MAX_SECONDS) throw new WireError(400, 'VALIDATION', 'Dados inválidos.');
    const job = { id: randomId(10), seconds, polls: 0 };
    state.transcriptions.set(job.id, job);
    return { status: 202, body: { transcription: { id: job.id, status: 'pending', eta_seconds: 1, progress: 0 } } };
  });

  router.route('GET', '/api/m/v1/transcriptions/:id', (ctx) => {
    verifyAuth(state, { headers: ctx.headers, htm: 'GET', htu: ctx.htu, now: ctx.now() });
    const job = state.transcriptions.get(ctx.params.id!);
    if (!job) throw new WireError(404, 'NOT_FOUND', 'Transcrição não encontrada.');
    job.polls += 1;
    if (job.polls < 2) return { status: 200, body: { transcription: { id: job.id, status: 'pending', eta_seconds: 1, progress: 0.5 } } };
    return { status: 200, body: { transcription: { id: job.id, status: 'done', text: MOCK_TRANSCRIPT, duration: job.seconds } } };
  });
}
