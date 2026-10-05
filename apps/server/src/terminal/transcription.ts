import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { HttpError, conflict, notFound } from '../lib/errors.js';
import { msg, tk } from '../i18n/index.js';

/** Recorded clips are capped at 5 minutes client-side; opus at 48 kbps is ~2 MB, mp4/aac a few more. */
export const TRANSCRIPTION_MAX_BYTES = 32 * 1024 * 1024;
/** Time budget for one clip (a 5-minute clip on the CPU "medium" model takes ~100 s). */
const WHISPER_TIMEOUT_MS = 10 * 60 * 1000;
/** Finished jobs stay pollable for this long; the client normally reads them within seconds. */
const JOB_TTL_MS = 10 * 60 * 1000;
/** Pending jobs per user: one clip at a time is the normal case; two absorbs a quick retry. */
const MAX_PENDING_PER_USER = 2;
/** Seconds of processing per second of audio before any job has been measured (CPU "medium"). */
const DEFAULT_SPEED_RATIO = 0.35;
/** Fixed cost per clip (decode, model warm-up), seconds. */
const OVERHEAD_S = 1.5;

export type TranscriptionStatus = 'pending' | 'done' | 'error';

export interface TranscriptionJob {
  id: string;
  user_id: string;
  status: TranscriptionStatus;
  /** transcribed text (done) — never logged */
  text?: string;
  /** audio length in seconds, as reported by whisper */
  duration?: number;
  /** audio length in seconds as told by the client at upload (drives the estimate while pending) */
  audio_seconds: number | null;
  /** user-facing failure message (error) */
  error?: string;
  /** machine-readable failure reason (error only), e.g. 'TOO_LONG' */
  code?: string;
  created_at: number;
  finished_at?: number;
}

export interface TranscriptionView {
  id: string;
  status: TranscriptionStatus;
  text?: string;
  duration?: number;
  error?: string;
  code?: string;
  /** pending only: estimated seconds until the text is ready (0 when overdue) */
  eta_seconds?: number;
  /** pending only: 0..1 share of the estimated time already elapsed (capped below 1) */
  progress?: number;
}

/** Extra rules a caller (the mobile route) can layer on top of the base upload contract. */
export interface StartOptions {
  /** whisper's measured duration past this many seconds ends the job as TOO_LONG, regardless of the client's own estimate */
  maxSeconds?: number;
}

export const isTranscriptionEnabled = () => config.transcription !== null;

/**
 * Transcription runs asynchronously: the audio is accepted and answered with a job id that the
 * client polls, because a 5-minute clip can take longer than what Cloudflare (100 s) and browsers
 * tolerate on a single request. Jobs are in memory only: they die with the container, and the
 * client shows an error if its job vanishes (blue/green retire — rare, and the user just re-records).
 */
export class TranscriptionService {
  private readonly jobs = new Map<string, TranscriptionJob>();
  private readonly log: (meta: Record<string, unknown>, msg: string) => void;
  /** processing seconds per audio second, learned from finished jobs (exponential moving average) */
  private speedRatio = DEFAULT_SPEED_RATIO;

  constructor(opts: { log: (meta: Record<string, unknown>, msg: string) => void }) {
    this.log = opts.log;
  }

  view(job: TranscriptionJob, now = Date.now()): TranscriptionView {
    const v: TranscriptionView = { id: job.id, status: job.status, text: job.text, duration: job.duration, error: job.error, code: job.code };
    if (job.status === 'pending' && job.audio_seconds !== null) {
      const expected = this.estimateSeconds(job.audio_seconds);
      const elapsed = (now - job.created_at) / 1000;
      v.eta_seconds = Math.max(0, Math.ceil(expected - elapsed));
      v.progress = Math.min(0.97, elapsed / expected);
    }
    return v;
  }

  /** Expected processing time for a clip of the given length. */
  estimateSeconds(audioSeconds: number): number {
    return OVERHEAD_S + audioSeconds * this.speedRatio;
  }

  /** Enqueues a clip; the whisper call runs in the background. */
  start(userId: string, audio: Buffer, mime: string, audioSeconds: number | null = null, opts: StartOptions = {}): TranscriptionJob {
    if (!config.transcription) throw new HttpError(503, 'Transcrição de voz não está configurada', 'TRANSCRIPTION_OFF');
    this.purge();
    let pending = 0;
    for (const j of this.jobs.values()) if (j.user_id === userId && j.status === 'pending') pending += 1;
    if (pending >= MAX_PENDING_PER_USER) throw conflict('Já existe uma transcrição em andamento');

    const job: TranscriptionJob = { id: randomUUID(), user_id: userId, status: 'pending', audio_seconds: audioSeconds, created_at: Date.now() };
    this.jobs.set(job.id, job);
    this.log({ jobId: job.id, bytes: audio.length, mime, audioSeconds, etaSeconds: audioSeconds === null ? null : Math.ceil(this.estimateSeconds(audioSeconds)) }, 'transcription started');
    void this.run(job, audio, mime, opts);
    return job;
  }

  /** Looks a job up for its owner; other users get a 404, never a hint that it exists. */
  get(userId: string, id: string): TranscriptionJob {
    this.purge();
    const job = this.jobs.get(id);
    if (!job || job.user_id !== userId) throw notFound('Transcrição não encontrada');
    return job;
  }

  private async run(job: TranscriptionJob, audio: Buffer, mime: string, opts: StartOptions): Promise<void> {
    const t0 = Date.now();
    try {
      const result = await transcribeWithWhisper(audio, mime);
      if (opts.maxSeconds !== undefined && result.duration > opts.maxSeconds) {
        job.status = 'error';
        job.error = 'Áudio longo demais';
        job.code = 'TOO_LONG';
        this.log({ jobId: job.id, audioSeconds: result.duration, maxSeconds: opts.maxSeconds }, 'transcription too long');
        return;
      }
      job.text = result.text;
      job.duration = result.duration;
      job.status = 'done';
      const ms = Date.now() - t0;
      if (result.duration >= 3) {
        // learn the machine's real speed; the first job replaces the guess outright
        const ratio = Math.max(0, ms / 1000 - OVERHEAD_S) / result.duration;
        this.speedRatio = this.speedRatio === DEFAULT_SPEED_RATIO ? ratio : this.speedRatio * 0.7 + ratio * 0.3;
      }
      this.log({ jobId: job.id, audioSeconds: result.duration, ms, chars: result.text.length, speedRatio: Number(this.speedRatio.toFixed(3)) }, 'transcription done');
    } catch (err) {
      job.status = 'error';
      job.error = err instanceof HttpError ? err.message : 'Falha ao transcrever o áudio';
      this.log({ jobId: job.id, ms: Date.now() - t0, err: err instanceof Error ? err.message : String(err) }, 'transcription failed');
    } finally {
      job.finished_at = Date.now();
    }
  }

  /** Drops finished jobs past their TTL (and pending ones stuck past the whisper timeout). */
  private purge(): void {
    const now = Date.now();
    for (const [id, j] of this.jobs) {
      const ref = j.finished_at ?? j.created_at + WHISPER_TIMEOUT_MS;
      if (now - ref > JOB_TTL_MS) this.jobs.delete(id);
    }
  }
}

interface WhisperResult {
  text: string;
  language: string;
  duration: number;
}

/** POSTs the clip to docker/whisper and returns its JSON. The audio never touches disk here. */
async function transcribeWithWhisper(audio: Buffer, mime: string): Promise<WhisperResult> {
  const t = config.transcription;
  if (!t) throw new HttpError(503, 'Transcrição de voz não está configurada', 'TRANSCRIPTION_OFF');
  let res: Response;
  try {
    res = await fetch(`${t.url}/transcribe?language=${encodeURIComponent(t.language)}`, {
      method: 'POST',
      headers: { 'content-type': mime },
      body: new Uint8Array(audio),
      signal: AbortSignal.timeout(WHISPER_TIMEOUT_MS),
    });
  } catch (err) {
    const timeout = err instanceof Error && err.name === 'TimeoutError';
    throw new HttpError(502, timeout ? tk('A transcrição demorou demais') : tk('Serviço de transcrição indisponível'), 'TRANSCRIPTION_UNAVAILABLE');
  }
  if (res.status === 422) throw new HttpError(422, 'Não foi possível decodificar o áudio', 'BAD_AUDIO');
  if (res.status === 503) throw new HttpError(503, 'O modelo de transcrição ainda está carregando, tente de novo em instantes', 'TRANSCRIPTION_LOADING');
  if (!res.ok) throw new HttpError(502, msg('Serviço de transcrição respondeu {{status}}', { status: res.status }), 'TRANSCRIPTION_UNAVAILABLE');
  const body = (await res.json()) as Partial<WhisperResult>;
  if (typeof body.text !== 'string') throw new HttpError(502, 'Resposta inválida do serviço de transcrição', 'TRANSCRIPTION_UNAVAILABLE');
  return { text: body.text.trim(), language: body.language ?? t.language, duration: typeof body.duration === 'number' ? body.duration : 0 };
}
