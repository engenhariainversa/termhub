import { i18n } from '../i18n';
import { api, ApiError } from './api';
import type { Transcription } from './types';
import { voiceStore } from './voice-store';

/** Clips are cut here no matter what: the server budget assumes at most 5 minutes of audio. */
export const MAX_RECORDING_MS = 5 * 60 * 1000;
const POLL_MS = 1000;
/** Give up polling after this (a 5-minute clip on the CPU "medium" model takes ~100 s). */
const POLL_TIMEOUT_MS = 12 * 60 * 1000;

/** Container/codec the browser can record with: opus in webm (Chrome, Firefox) or mp4/aac (Safari). */
function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  for (const t of ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm', 'audio/mp4']) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return undefined;
}

export const canRecordVoice = () =>
  typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && window.isSecureContext;

/** User-facing message for a getUserMedia failure. */
export function micErrorMessage(err: unknown): string {
  const name = err instanceof Error ? err.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return i18n.t('Permissão do microfone negada');
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return i18n.t('Nenhum microfone encontrado');
  if (name === 'NotReadableError') return i18n.t('O microfone está em uso por outro app');
  return i18n.t('Não foi possível acessar o microfone');
}

export interface Clip {
  audio: Blob;
  /** recorded length in seconds */
  seconds: number;
}

/**
 * Microphone capture for one clip. `start()` asks for the mic (the browser prompts on first use),
 * `stop()` resolves with the encoded clip; `cancel()` drops it. The clip stops by itself at
 * MAX_RECORDING_MS (see onAutoStop). Every chunk is also written to IndexedDB (voiceStore) so a
 * refresh mid-recording can recover the audio.
 */
export class VoiceRecorder {
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private chunks: Blob[] = [];
  private seq = 0;
  private startedAt = 0;
  private limitTimer = 0;
  private stopped: ((clip: Clip) => void) | null = null;

  constructor(
    private readonly tabId: string,
    private readonly opts: { onAutoStop?: () => void } = {},
  ) {}

  get active(): boolean {
    return this.recorder?.state === 'recording';
  }

  /** seconds since the recorder started */
  get seconds(): number {
    return this.startedAt ? (Date.now() - this.startedAt) / 1000 : 0;
  }

  async start(): Promise<void> {
    if (this.recorder) return;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    const mimeType = pickMimeType();
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 48_000 } : undefined);
    this.stream = stream;
    this.recorder = recorder;
    this.chunks = [];
    this.seq = 0;
    this.startedAt = Date.now();
    const mime = recorder.mimeType || mimeType || 'audio/webm';
    void voiceStore.begin({ tabId: this.tabId, mime, startedAt: this.startedAt, seconds: 0, finished: false });
    recorder.ondataavailable = (ev) => {
      if (ev.data.size === 0) return;
      this.chunks.push(ev.data);
      void voiceStore.append(this.tabId, this.seq++, ev.data, this.seconds);
    };
    recorder.onstop = () => {
      const clip: Clip = { audio: new Blob(this.chunks, { type: mime }), seconds: this.seconds };
      void voiceStore.update(this.tabId, { finished: true, seconds: clip.seconds });
      this.release();
      this.stopped?.(clip);
      this.stopped = null;
    };
    recorder.start(1000); // 1 s chunks: at most a second is lost if the page dies mid-clip
    this.limitTimer = window.setTimeout(() => {
      if (this.active) this.opts.onAutoStop?.();
    }, MAX_RECORDING_MS);
  }

  /** Ends the clip and resolves with the encoded audio. */
  stop(): Promise<Clip> {
    return new Promise((resolve) => {
      const rec = this.recorder;
      if (!rec || rec.state === 'inactive') {
        this.release();
        return resolve({ audio: new Blob([], { type: 'audio/webm' }), seconds: 0 });
      }
      this.stopped = resolve;
      rec.stop();
    });
  }

  /** Drops the clip; with `keepStored` the audio already written to IndexedDB survives for recovery. */
  cancel(keepStored = false): void {
    const rec = this.recorder;
    this.stopped = null;
    if (rec && rec.state !== 'inactive') {
      rec.onstop = null;
      rec.stop();
    }
    this.release();
    if (keepStored) void voiceStore.update(this.tabId, { finished: true, seconds: this.seconds });
    else void voiceStore.clear(this.tabId);
  }

  private release(): void {
    window.clearTimeout(this.limitTimer);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.recorder = null;
    this.chunks = [];
  }
}

export type TranscribePhase = { phase: 'uploading'; fraction: number } | { phase: 'transcribing'; eta: number | null; progress: number };

/**
 * Uploads the clip (reporting progress) and polls the job until the text is ready. The job id is
 * saved next to the clip so a refresh resumes with `resumeTranscription` instead of re-uploading.
 * Throws with a user-facing message.
 */
export async function transcribeClip(tabId: string, clip: Clip, onPhase: (p: TranscribePhase) => void, signal?: AbortSignal): Promise<Transcription> {
  onPhase({ phase: 'uploading', fraction: 0 });
  const { transcription: job } = await api.transcriptions.create(clip.audio, clip.seconds, (fraction) => onPhase({ phase: 'uploading', fraction }));
  await voiceStore.update(tabId, { jobId: job.id });
  return pollTranscription(job, onPhase, signal);
}

/**
 * Picks up a job accepted before a refresh. Resolves null when the server no longer knows it
 * (restart/deploy), so the caller can fall back to re-uploading the stored audio.
 */
export async function resumeTranscription(jobId: string, onPhase: (p: TranscribePhase) => void, signal?: AbortSignal): Promise<Transcription | null> {
  let job: Transcription;
  try {
    job = (await api.transcriptions.get(jobId)).transcription;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
  return pollTranscription(job, onPhase, signal);
}

async function pollTranscription(job: Transcription, onPhase: (p: TranscribePhase) => void, signal?: AbortSignal): Promise<Transcription> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let current = job;
  while (current.status === 'pending') {
    onPhase({ phase: 'transcribing', eta: current.eta_seconds ?? null, progress: current.progress ?? 0 });
    if (signal?.aborted) throw new Error(i18n.t('Transcrição cancelada'));
    if (Date.now() > deadline) throw new Error(i18n.t('A transcrição demorou demais'));
    await new Promise((r) => setTimeout(r, POLL_MS));
    current = (await api.transcriptions.get(job.id)).transcription;
  }
  if (current.status === 'error') throw new Error(current.error || i18n.t('Falha ao transcrever o áudio'));
  return current;
}
