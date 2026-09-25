/**
 * The videos (spec 2026-09-23 §2.4), recorded in real time in the visitor's browser: the 10-second
 * story (1080×1920, composed) and the screen recording (1920×1080, the camera's view, as long as the
 * visitor keeps recording, up to SCREEN_VIDEO_MAX_MS). A canvas redrawn on every scene frame gives
 * the video track (captureStream), the soundscape gives the audio track, and a MediaRecorder writes
 * both. No server work.
 */
import type { CityModel } from '../../office/model';
import { FORMAT_SIZE, paintCapture, type CaptureFormat, type ShareInfo } from './compose';
import type { FrameSource } from './images';
import { createSoundscape, loadMix, soundEvents } from './sound';

export const STORY_VIDEO_MS = 10_000;
/** A screen recording stops by itself here, so a forgotten one does not fill the memory. */
export const SCREEN_VIDEO_MAX_MS = 60_000;

/**
 * First supported wins: H.264 + AAC in an MP4 is what Instagram takes, spelled several ways because
 * browsers disagree on the exact codec string (Safari may refuse the precise one and would otherwise
 * fall to WebM); WebM is the fallback some browsers only have. Never a bare 'video/mp4': Chromium
 * accepts it and writes VP9 + Opus inside an MP4, which Instagram refuses. So every MP4 asked for here
 * is H.264, and `instagramReady` can trust an MP4 recording.
 */
export const VIDEO_TYPES: readonly string[] = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4;codecs="avc1.42E01E, mp4a.40.2"',
  'video/mp4;codecs=avc1,mp4a',
  'video/mp4;codecs=avc1',
  'video/webm;codecs=vp9,opus',
  'video/webm',
];

export function pickMimeType(isTypeSupported: (type: string) => boolean): string | null {
  for (const type of VIDEO_TYPES) {
    try {
      if (isTypeSupported(type)) return type;
    } catch {
      /* a browser that throws on the question cannot record the answer */
    }
  }
  return null;
}

/** The type without its parameters: share sheets (Chrome's allowlist) compare 'video/mp4', not its codecs. */
export const baseType = (mimeType: string): string => mimeType.split(';')[0].trim().toLowerCase();
export const isWebm = (mimeType: string): boolean => baseType(mimeType) === 'video/webm';
export const extensionFor = (mimeType: string): 'mp4' | 'webm' => (isWebm(mimeType) ? 'webm' : 'mp4');

/**
 * Whether Instagram takes the recording, judged by what the recorder says it wrote. MP4 is only ever
 * asked for with H.264 (VIDEO_TYPES), so any MP4 is one — Safari reports it as a bare 'video/mp4'.
 * Anything else (WebM) gets the warning.
 */
export function instagramReady(mimeType: string): boolean {
  return baseType(mimeType) === 'video/mp4';
}

/** MediaRecorder, canvas capture and at least one type this browser can write. */
export function canRecordVideo(): boolean {
  if (typeof MediaRecorder === 'undefined' || typeof HTMLCanvasElement === 'undefined') return false;
  if (typeof HTMLCanvasElement.prototype.captureStream !== 'function') return false;
  return pickMimeType((t) => MediaRecorder.isTypeSupported(t)) !== null;
}

export class RecordingCancelled extends Error {
  constructor() {
    super('recording cancelled');
    this.name = 'RecordingCancelled';
  }
}

export interface RecordingResult { blob: Blob; mimeType: string }
export interface Recording {
  done: Promise<RecordingResult>;
  /** stops and throws the recording away (`done` rejects with RecordingCancelled) */
  cancel(): void;
  /** stops early and keeps what was recorded so far (`done` resolves) */
  finish(): void;
}

const PROGRESS_MS = 250;

export function runRecorder(opts: { stream: MediaStream; mimeType: string; durationMs: number; onProgress?: (elapsedMs: number) => void; cleanup: () => void }): Recording {
  const recorder = new MediaRecorder(opts.stream, { mimeType: opts.mimeType });
  const chunks: Blob[] = [];
  let outcome: 'recorded' | 'cancelled' | 'failed' = 'recorded';
  let tick: ReturnType<typeof setInterval> | null = null;
  const started = Date.now();

  /** an error that stops an inactive recorder calls onstop by hand, and the browser may still fire its own stop */
  let finished = false;

  const done = new Promise<RecordingResult>((resolve, reject) => {
    recorder.ondataavailable = (e: BlobEvent) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    recorder.onstop = () => {
      if (finished) return;
      finished = true;
      if (tick) clearInterval(tick);
      opts.cleanup();
      // what the browser really wrote, which may not be what was asked for
      const mimeType = recorder.mimeType || opts.mimeType;
      if (outcome === 'cancelled') reject(new RecordingCancelled());
      else if (outcome === 'failed') reject(new Error('the recorder failed'));
      else resolve({ blob: new Blob(chunks, { type: baseType(mimeType) }), mimeType });
    };
    recorder.onerror = () => {
      outcome = 'failed';
      if (recorder.state !== 'inactive') recorder.stop();
      else recorder.onstop?.(new Event('stop'));
    };
  });

  recorder.start(PROGRESS_MS);
  tick = setInterval(() => {
    const elapsed = Math.min(Date.now() - started, opts.durationMs);
    opts.onProgress?.(elapsed);
    if (elapsed >= opts.durationMs && recorder.state === 'recording') recorder.stop();
  }, PROGRESS_MS);

  return {
    done,
    cancel() {
      if (recorder.state === 'inactive') return;
      outcome = 'cancelled';
      recorder.stop();
    },
    finish() {
      if (recorder.state !== 'inactive') recorder.stop();
    },
  };
}

type VideoOptions = { source: FrameSource; info: () => ShareInfo; model: () => CityModel; durationMs?: number; onProgress?: (elapsedMs: number) => void };

export function recordStory(opts: VideoOptions): Recording {
  return recordVideo({ ...opts, format: 'story', durationMs: opts.durationMs ?? STORY_VIDEO_MS });
}

export function recordVideo(opts: VideoOptions & { format: CaptureFormat; durationMs: number }): Recording {
  const mimeType = pickMimeType((t) => MediaRecorder.isTypeSupported(t));
  const canvas = document.createElement('canvas');
  canvas.width = FORMAT_SIZE[opts.format].width;
  canvas.height = FORMAT_SIZE[opts.format].height;
  const ctx = canvas.getContext('2d');
  const refused = (err: Error): Recording => ({ done: Promise.reject(err), cancel: () => {}, finish: () => {} });
  if (!mimeType || !ctx) return refused(new Error('this browser cannot record the video'));

  // every piece is let go exactly once, whichever of them got built before something threw
  let audio: AudioContext | null = null;
  let sound: ReturnType<typeof createSoundscape> | null = null;
  let off: (() => void) | null = null;
  let stream: MediaStream | null = null;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    off?.();
    sound?.stop();
    stream?.getTracks().forEach((t) => t.stop());
    void audio?.close();
  };

  try {
    audio = new AudioContext();
    const soundscape = createSoundscape(audio, loadMix());
    sound = soundscape;
    let heard: CityModel | null = null;
    // redraw on every scene frame; the counts and the sounds follow the model the page draws
    off = opts.source.onFrame((scene) => {
      paintCapture(ctx, opts.format, opts.info(), scene);
      const model = opts.model();
      if (model !== heard) {
        soundscape.play(soundEvents(heard, model));
        heard = model;
      }
    });
    const video = canvas.captureStream(30);
    stream = new MediaStream([...video.getVideoTracks(), ...soundscape.stream.getAudioTracks()]);
    return runRecorder({ stream, mimeType, durationMs: opts.durationMs, onProgress: opts.onProgress, cleanup });
  } catch (err) {
    // no AudioContext, no capture, a recorder that refuses the stream or will not start
    cleanup();
    return refused(err instanceof Error ? err : new Error('the recording could not start'));
  }
}
