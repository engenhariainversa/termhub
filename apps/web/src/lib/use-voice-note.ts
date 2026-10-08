import { i18n } from '../i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import { VoiceRecorder, micErrorMessage, type Clip } from './voice-recorder';
import { voiceStore } from './voice-store';

/**
 * A voice note held on the chat's microphone (TER-1036, WhatsApp's flow): the clip is sent as an
 * audio attachment, not transcribed into the box (that is dictation, `use-dictation.ts`).
 *
 * - `pressing`: the button is down, but not for long enough to be a hold yet (`HOLD_MS`). Letting go
 *   here is a click, which only says how the button works (`hint`).
 * - `starting`: the browser is opening the microphone (its permission sheet, on the first recording
 *   only). Letting go here drops the recording quietly: the next hold records.
 * - `recording`: held. Letting go sends; a drag to the left cancels; a drag up locks.
 * - `locked`: recording with the button released, until Enviar or Descartar.
 */
export type VoiceNotePhase = 'idle' | 'pressing' | 'starting' | 'recording' | 'locked';

export interface VoiceNote {
  phase: VoiceNotePhase;
  /** whole seconds recorded so far; 0 unless recording or locked */
  seconds: number;
  /** "Segure para gravar", for a couple of seconds after a click on the microphone */
  hint: string | null;
  /** Already user-facing (translated): the microphone could not be opened. Cleared by the next press. */
  error: string | null;
  /** Feedback that is not a failure ("Gravação muito curta"). Cleared by the next press. */
  notice: string | null;
  /** The button went down: a hold starts recording after `HOLD_MS`. */
  press: () => void;
  /** Starts recording at once, without the hold delay (the keyboard's Space or Enter). */
  begin: () => void;
  /** The button came up: a click hints, a hold sends, a locked recording keeps going. */
  release: () => void;
  /** Drops whatever is under way; nothing is sent. */
  cancel: () => void;
  /** Keeps recording without holding (the drag up). Only while recording. */
  lock: () => void;
  /** Ends the clip and hands it over (`onClip`), held or locked. */
  send: () => void;
}

/** How long the button has to stay down before it records: shorter is a click. */
export const HOLD_MS = 200;
/** How long the click's hint stays on screen. */
const HINT_MS = 2000;
/** Below this size (~0.3 s of opus) the clip is a slip of the finger, not a message. */
export const MIN_VOICE_NOTE_BYTES = 2048;
/**
 * The IndexedDB key `VoiceRecorder` writes the chunks under. Distinct from dictation's `'chat'` so the
 * two never overwrite each other; cleared when the clip ends, either way — nothing reads it back.
 */
const STORE_KEY = 'chat-voice-note';

export function useVoiceNote(onClip: (clip: Clip) => void): VoiceNote {
  const [phase, setPhaseValue] = useState<VoiceNotePhase>('idle');
  /** mirrors `phase` for the callbacks below (timers and recorder promises fire outside render) */
  const phaseRef = useRef<VoiceNotePhase>('idle');
  const [seconds, setSeconds] = useState(0);
  const [hint, setHint] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const recorderRef = useRef<VoiceRecorder | null>(null);
  const holdTimer = useRef(0);
  const hintTimer = useRef(0);
  const clockTimer = useRef(0);
  const onClipRef = useRef(onClip);
  onClipRef.current = onClip;

  const setPhase = useCallback((p: VoiceNotePhase) => {
    phaseRef.current = p;
    setPhaseValue(p);
  }, []);

  const stopTimers = () => {
    window.clearTimeout(holdTimer.current);
    window.clearInterval(clockTimer.current);
    holdTimer.current = 0;
    clockTimer.current = 0;
  };

  const cancel = useCallback(() => {
    stopTimers();
    recorderRef.current?.cancel();
    recorderRef.current = null;
    setSeconds(0);
    setPhase('idle');
  }, [setPhase]);

  const send = useCallback(() => {
    const rec = recorderRef.current;
    if (!rec || (phaseRef.current !== 'recording' && phaseRef.current !== 'locked')) return;
    stopTimers();
    recorderRef.current = null;
    setSeconds(0);
    setPhase('idle');
    void rec.stop().then((clip) => {
      void voiceStore.clear(STORE_KEY);
      if (clip.audio.size < MIN_VOICE_NOTE_BYTES) {
        setNotice(i18n.t('Gravação muito curta'));
        return;
      }
      onClipRef.current(clip);
    });
  }, [setPhase]);
  const sendRef = useRef(send);
  sendRef.current = send;

  const begin = useCallback(() => {
    if (phaseRef.current !== 'idle' && phaseRef.current !== 'pressing') return;
    window.clearTimeout(holdTimer.current);
    // The 5-minute cut sends what was recorded, exactly like letting go.
    const rec = new VoiceRecorder(STORE_KEY, { onAutoStop: () => sendRef.current() });
    recorderRef.current = rec;
    setPhase('starting');
    rec
      .start()
      .then(() => {
        // Let go (or cancelled) while the microphone was opening — on the first recording, that is the
        // permission sheet taking the click. Close what just opened; the next hold records.
        if (recorderRef.current !== rec) {
          rec.cancel();
          return;
        }
        setPhase('recording');
        setSeconds(0);
        const startedAt = Date.now();
        clockTimer.current = window.setInterval(() => setSeconds(Math.floor((Date.now() - startedAt) / 1000)), 500);
      })
      .catch((err: unknown) => {
        if (recorderRef.current !== rec) return;
        recorderRef.current = null;
        setPhase('idle');
        setError(micErrorMessage(err));
      });
  }, [setPhase]);

  const press = useCallback(() => {
    if (phaseRef.current !== 'idle') return;
    setError(null);
    setNotice(null);
    setHint(null);
    setPhase('pressing');
    holdTimer.current = window.setTimeout(begin, HOLD_MS);
  }, [begin, setPhase]);

  const release = useCallback(() => {
    switch (phaseRef.current) {
      case 'pressing':
        // A click: say how the button works instead of recording a fraction of a second.
        stopTimers();
        setPhase('idle');
        setHint(i18n.t('Segure para gravar'));
        window.clearTimeout(hintTimer.current);
        hintTimer.current = window.setTimeout(() => setHint(null), HINT_MS);
        return;
      case 'starting':
        cancel();
        return;
      case 'recording':
        send();
        return;
      default:
        // `locked` keeps recording; `idle` has nothing to release.
        return;
    }
  }, [cancel, send, setPhase]);

  const lock = useCallback(() => {
    if (phaseRef.current === 'recording') setPhase('locked');
  }, [setPhase]);

  const beginNow = useCallback(() => {
    if (phaseRef.current !== 'idle') return;
    setError(null);
    setNotice(null);
    setHint(null);
    begin();
  }, [begin]);

  // Unmounted mid-recording (the chat closed): free the microphone, send nothing.
  useEffect(
    () => () => {
      window.clearTimeout(holdTimer.current);
      window.clearInterval(clockTimer.current);
      window.clearTimeout(hintTimer.current);
      recorderRef.current?.cancel();
      recorderRef.current = null;
    },
    [],
  );

  return { phase, seconds, hint, error, notice, press, begin: beginNow, release, cancel, lock, send };
}
