// Dictation for the composer (chat redesign spec §4.2 "Voice"), in two layers. `useRecorder` is the
// raw microphone over `expo-audio`: start, stop into a `file://` clip, cancel — what the attachment
// sheet records with too (phase B). `useVoice` is the web's `use-dictation.ts` state machine on top
// of it — checking, off, idle, starting, recording, uploading, transcribing — uploading the clip as a
// raw body to the mobile `/transcriptions` route and polling once a second until the text is ready.
// The API and the session come in through `deps`, so a test drives the whole flow against the mock.
import { AudioQuality, IOSOutputFormat, requestRecordingPermissionsAsync, setAudioModeAsync, useAudioRecorder, type RecordingOptions } from 'expo-audio';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSessionStore } from '@/features/session/viewmodel/useSessionStore';
import { api as appApi } from '@/services/api';
import type { Auth, MobileApi } from '@/services/api/types';

/** Mono AAC in an `.m4a` container at a bit rate that is plenty for speech: `audio/m4a` on the wire,
 * one of the server's `MOBILE_AUDIO_TYPES`. */
export const VOICE_RECORDING: RecordingOptions = {
  extension: '.m4a',
  sampleRate: 44100,
  numberOfChannels: 1,
  bitRate: 64000,
  android: { outputFormat: 'mpeg4', audioEncoder: 'aac' },
  ios: { outputFormat: IOSOutputFormat.MPEG4AAC, audioQuality: AudioQuality.MEDIUM },
  web: {},
};
export const VOICE_MIME = 'audio/m4a';
/** The server's `MOBILE_MAX_SECONDS`: clips are cut here no matter what. */
export const MAX_RECORDING_S = 300;
/** Below this there is nothing to transcribe: a tap, not speech. */
const MIN_CLIP_S = 0.5;
const POLL_MS = 1000;
/** Give up polling after this (a 5-minute clip on the CPU model takes ~100 s). */
const POLL_TIMEOUT_MS = 12 * 60 * 1000;
const MIC_DENIED = 'Permissão do microfone negada';
const MIC_UNAVAILABLE = 'Não foi possível acessar o microfone';

// --- the microphone -------------------------------------------------------------------------------

/** Hands the audio session back (other apps' playback resumes). Never before `recorder.stop()`
 * settled: releasing the session under a running recorder cuts the clip short. */
const releaseSession = () => setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);

export interface RecordedClip {
  /** a `file://` URI in the app's cache */
  uri: string;
  mime: string;
  /** recorded length in seconds */
  seconds: number;
}

export interface Recorder {
  state: 'idle' | 'recording';
  /** whole seconds recorded so far; 0 unless recording */
  seconds: number;
  /** pt-BR: why the last `start()` could not open the microphone; cleared by the next `start()` */
  error: string | null;
  /**
   * Asks for the microphone (the system sheet on first use) and starts recording. Resolves once the
   * clip is being recorded; rejects — with the same pt-BR message it puts in `error` — when the
   * microphone could not be opened (permission denied, no input). Await it in a try/catch. A
   * `cancel()` while the sheet is up closes the microphone when it opens and resolves quietly.
   */
  start(): Promise<void>;
  /** Ends the clip and hands it over — or `null` when nothing was being recorded. */
  stop(): Promise<RecordedClip | null>;
  /** Drops the clip: nothing is handed over. */
  cancel(): void;
}

export function useRecorder(): Recorder {
  const recorder = useAudioRecorder(VOICE_RECORDING);
  const [state, setStateValue] = useState<Recorder['state']>('idle');
  /** mirrors `state` for the closures below (they run outside React's render cycle) */
  const stateRef = useRef<Recorder['state']>('idle');
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const clock = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAt = useRef(0);
  /** A `start()` still asking for the mic; `cancel()` clears it, and `start()` then closes what it opened. */
  const opening = useRef(false);

  const setState = useCallback((s: Recorder['state']) => {
    stateRef.current = s;
    setStateValue(s);
  }, []);

  const stopClock = () => {
    if (clock.current !== null) {
      clearInterval(clock.current);
      clock.current = null;
    }
  };

  /** Back to idle on screen: clock off, `seconds` at 0 (as documented). The audio session is handed
   * back separately (`releaseSession`), only once the recorder has stopped. */
  const resetToIdle = useCallback(() => {
    stopClock();
    setSeconds(0);
    setState('idle');
  }, [setState]);

  const start = useCallback(async () => {
    if (stateRef.current === 'recording' || opening.current) return;
    setError(null);
    opening.current = true;
    let sessionOpened = false;
    try {
      const permission = await requestRecordingPermissionsAsync();
      if (!permission.granted) throw new Error(MIC_DENIED);
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      sessionOpened = true;
      await recorder.prepareToRecordAsync();
      recorder.record();
    } catch (err) {
      opening.current = false;
      if (sessionOpened) void releaseSession();
      const message = err instanceof Error && err.message === MIC_DENIED ? MIC_DENIED : MIC_UNAVAILABLE;
      setError(message);
      throw new Error(message);
    }
    if (!opening.current) {
      // Cancelled while the sheet was up: the mic only opened now, close it and hand the session back.
      void recorder
        .stop()
        .catch(() => undefined)
        .then(() => releaseSession());
      return;
    }
    opening.current = false;
    startedAt.current = Date.now();
    setSeconds(0);
    setState('recording');
    stopClock();
    clock.current = setInterval(() => setSeconds(Math.floor((Date.now() - startedAt.current) / 1000)), 500);
  }, [recorder, setState]);

  const stop = useCallback(async (): Promise<RecordedClip | null> => {
    if (stateRef.current !== 'recording') return null;
    const clipSeconds = (Date.now() - startedAt.current) / 1000;
    resetToIdle();
    let stopped = true;
    try {
      await recorder.stop();
    } catch {
      stopped = false;
    }
    void releaseSession();
    if (!stopped) return null;
    const uri = recorder.uri;
    return uri ? { uri, mime: VOICE_MIME, seconds: clipSeconds } : null;
  }, [recorder, resetToIdle]);

  const cancel = useCallback(() => {
    if (opening.current) {
      opening.current = false;
      return;
    }
    if (stateRef.current !== 'recording') return;
    resetToIdle();
    void recorder
      .stop()
      .catch(() => undefined)
      .then(() => releaseSession());
  }, [recorder, resetToIdle]);

  // Unmount mid-recording (the screen closed): stop the clock; `useAudioRecorder` releases the recorder.
  useEffect(() => () => stopClock(), []);

  return { state, seconds, error, start, stop, cancel };
}

// --- dictation ------------------------------------------------------------------------------------

export type VoiceState = 'checking' | 'off' | 'idle' | 'starting' | 'recording' | 'uploading' | 'transcribing';

export interface Voice {
  state: VoiceState;
  /** whole seconds recorded so far, for the timer; 0 unless recording */
  seconds: number;
  /** pt-BR, already user-facing; cleared by the next start() */
  error: string | null;
  /** pt-BR feedback that is not a failure: a clip too short to hold speech, a transcription with
   * no words in it. Cleared by the next start(). */
  notice: string | null;
  start(): void;
  /** stop and transcribe; the text is delivered through `onText` */
  stop(): void;
  /** drop the clip, no upload */
  cancel(): void;
}

export interface VoiceDeps {
  api: Pick<MobileApi, 'transcriptionConfig' | 'transcribe' | 'transcription'>;
  auth(): Auth;
}

const appDeps: VoiceDeps = { api: appApi, auth: () => useSessionStore.getState().auth() };

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function useVoice(onText: (text: string) => void, deps: VoiceDeps = appDeps): Voice {
  const recorder = useRecorder();
  const [state, setStateValue] = useState<VoiceState>('checking');
  /** mirrors `state` for the closures below */
  const stateRef = useRef<VoiceState>('checking');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const onTextRef = useRef(onText);
  onTextRef.current = onText;
  const depsRef = useRef(deps);
  depsRef.current = deps;
  const recorderRef = useRef(recorder);
  recorderRef.current = recorder;
  /** False once unmounted (the screen closed mid-transcription): the poll loop stops, nobody listens. */
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const setState = useCallback((s: VoiceState) => {
    stateRef.current = s;
    setStateValue(s);
  }, []);

  useEffect(() => {
    let alive = true;
    // Only while still `checking`: this is the one write that comes from outside the state machine.
    // `auth()` throws when locked; through the promise chain that reads as "off" like a server without whisper.
    Promise.resolve()
      .then(() => depsRef.current.api.transcriptionConfig(depsRef.current.auth()))
      .then((c) => c.enabled)
      .catch(() => false)
      .then((ok) => {
        if (alive && stateRef.current === 'checking') setState(ok ? 'idle' : 'off');
      });
    return () => {
      alive = false;
    };
  }, [setState]);

  const transcribeClip = useCallback(
    async (clip: RecordedClip) => {
      try {
        const { api, auth } = depsRef.current;
        let job = await api.transcribe(auth(), clip.uri, clip.mime, clip.seconds);
        setState('transcribing');
        const deadline = Date.now() + POLL_TIMEOUT_MS;
        while (job.status === 'pending') {
          if (Date.now() > deadline) throw new Error('A transcrição demorou demais');
          await wait(POLL_MS);
          // Unmounted meanwhile: the server finishes the job on its own; there is no box to put the text in.
          if (!alive.current) return;
          job = await api.transcription(auth(), job.id);
        }
        if (!alive.current) return;
        if (job.status === 'error') throw new Error(job.error || 'Falha ao transcrever o áudio');
        // Whisper answers an empty string for a clip it heard nothing in: said, not delivered.
        const text = (job.text ?? '').trim();
        setError(null);
        if (text) {
          setNotice(null);
          onTextRef.current(text);
        } else {
          setNotice('Nenhuma fala reconhecida');
        }
      } catch (err) {
        setError(err instanceof Error && err.message !== 'LOCKED' ? err.message : 'Falha ao transcrever o áudio');
      } finally {
        setState('idle');
      }
    },
    [setState],
  );

  const stop = useCallback(() => {
    if (stateRef.current !== 'recording') return;
    setState('uploading');
    void recorderRef.current.stop().then((clip) => {
      if (!clip || clip.seconds < MIN_CLIP_S) {
        // Too short to be speech. Not an error — the person let go too early — but not silence either.
        setNotice('Gravação muito curta');
        setState('idle');
        return;
      }
      return transcribeClip({ ...clip, seconds: Math.min(clip.seconds, MAX_RECORDING_S) });
    });
  }, [setState, transcribeClip]);
  const stopRef = useRef(stop);
  stopRef.current = stop;

  // The server takes at most 5 minutes: the clip is cut there exactly like a tap on Parar — same
  // upload, same errors.
  useEffect(() => {
    if (state === 'recording' && recorder.seconds >= MAX_RECORDING_S) stopRef.current();
  }, [recorder.seconds, state]);

  const start = useCallback(() => {
    if (stateRef.current !== 'idle') return;
    setError(null);
    setNotice(null);
    // `starting` while the permission sheet is up: nothing listens yet, and the button says so.
    setState('starting');
    recorderRef.current.start().then(
      () => {
        // Cancelled meanwhile: the recorder closed the mic itself and this hook is already idle.
        if (stateRef.current === 'starting') setState('recording');
      },
      (err: unknown) => {
        if (stateRef.current !== 'starting') return;
        setState('idle');
        setError(err instanceof Error ? err.message : MIC_UNAVAILABLE);
      },
    );
  }, [setState]);

  const cancel = useCallback(() => {
    if (stateRef.current !== 'recording' && stateRef.current !== 'starting') return;
    recorderRef.current.cancel();
    setState('idle');
  }, [setState]);

  return { state, seconds: state === 'recording' ? recorder.seconds : 0, error, notice, start, stop, cancel };
}
