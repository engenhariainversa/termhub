// WhatsApp's voice note for the composer (TER-1036): hold the microphone to record, let go to send,
// slide left to drop the clip, slide up to lock the recording and go on without holding. This hook is
// the state machine behind the gesture; the composer's microphone feeds it the finger (`press`,
// `move`, `release`, `interrupt`) and renders what it says. The clip goes up as an audio attachment,
// which the server transcribes like any other: nothing here talks to the transcription API.
import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '@/i18n';
import { MAX_RECORDING_S, MIN_CLIP_S, useRecorder, type RecordedClip } from './use-voice';

/** How long a press has to last to be a hold: a shorter tap only says how to record. */
export const HOLD_MS = 200;
/** How far left the finger goes to drop the clip, and how far up to lock the recording. */
export const CANCEL_DX = 100;
export const LOCK_DY = 70;
/** How long the "hold to record" hint of a short tap stays. */
const HINT_MS = 2500;

/**
 * - `idle`: nothing under way.
 * - `arming`: the finger is down, not for long enough yet to be a hold.
 * - `starting`: a hold, and the microphone is being opened (the permission sheet, the first time).
 * - `holding`: recording while the finger stays down.
 * - `locked`: recording on its own; ✕ drops it and ↑ sends it.
 */
export type VoiceNoteState = 'idle' | 'arming' | 'starting' | 'holding' | 'locked';

export interface VoiceNote {
  state: VoiceNoteState;
  /** whole seconds recorded; 0 unless recording */
  seconds: number;
  /** the microphone's level, 0–1, or `null` (see `Recorder.level`) */
  level: number | null;
  /** how far the finger has slid left while holding (≤ 0), for the "slide to cancel" line to follow */
  slide: number;
  /** "Segure para gravar" after a short tap, "Gravação muito curta" after a clip with nothing in it */
  hint: string | null;
  /** why the microphone could not be opened (translated) */
  error: string | null;
  press(): void;
  /** the finger moved by `dx`, `dy` from where it went down */
  move(dx: number, dy: number): void;
  release(): void;
  /** the system took the touch away (a call, a sheet): a hold becomes a locked recording, nothing is lost */
  interrupt(): void;
  /** straight to a locked recording, for a screen reader (a hold cannot be made with VoiceOver/TalkBack) */
  startLocked(): void;
  /** ↑ of a locked recording */
  send(): void;
  /** ✕ of a locked recording */
  discard(): void;
}

/** A device without haptics just stays quiet. */
const buzz = (style: Haptics.ImpactFeedbackStyle) => void Haptics.impactAsync(style).catch(() => undefined);

export function useVoiceNote(onClip: (clip: RecordedClip) => void): VoiceNote {
  const recorder = useRecorder();
  const [state, setStateValue] = useState<VoiceNoteState>('idle');
  /** mirrors `state` for the callbacks below (the recorder answers outside React's render cycle) */
  const stateRef = useRef<VoiceNoteState>('idle');
  const [slide, setSlide] = useState(0);
  const [hint, setHintValue] = useState<string | null>(null);
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Where the next opened microphone goes: a screen reader's start is locked from the first second. */
  const lockOnOpen = useRef(false);
  const recorderRef = useRef(recorder);
  recorderRef.current = recorder;
  const onClipRef = useRef(onClip);
  onClipRef.current = onClip;

  const setState = useCallback((s: VoiceNoteState) => {
    stateRef.current = s;
    setStateValue(s);
  }, []);

  const setHint = useCallback((text: string | null, timed = false) => {
    if (hintTimer.current !== null) clearTimeout(hintTimer.current);
    hintTimer.current = timed ? setTimeout(() => setHintValue(null), HINT_MS) : null;
    setHintValue(text);
  }, []);

  const clearArm = () => {
    if (armTimer.current !== null) {
      clearTimeout(armTimer.current);
      armTimer.current = null;
    }
  };

  const open = useCallback(() => {
    setState('starting');
    recorderRef.current.start().then(
      () => {
        // Let go (or cancelled) while the microphone was opening: the recorder closed it by itself.
        if (stateRef.current !== 'starting') return;
        buzz(Haptics.ImpactFeedbackStyle.Medium);
        setState(lockOnOpen.current ? 'locked' : 'holding');
      },
      () => {
        // The reason is the recorder's `error`, shown by the composer.
        if (stateRef.current === 'starting') setState('idle');
      },
    );
  }, [setState]);

  const finish = useCallback(() => {
    setState('idle');
    setSlide(0);
    void recorderRef.current.stop().then((clip) => {
      if (!clip) return;
      if (clip.seconds < MIN_CLIP_S) {
        setHint(t('Gravação muito curta'), true);
        return;
      }
      onClipRef.current({ ...clip, seconds: Math.min(clip.seconds, MAX_RECORDING_S) });
    });
  }, [setHint, setState]);

  const drop = useCallback(() => {
    const was = stateRef.current;
    clearArm();
    setState('idle');
    setSlide(0);
    recorderRef.current.cancel();
    if (was === 'holding' || was === 'locked') buzz(Haptics.ImpactFeedbackStyle.Heavy);
  }, [setState]);

  const press = useCallback(() => {
    if (stateRef.current !== 'idle') return;
    setHint(null);
    lockOnOpen.current = false;
    setState('arming');
    clearArm();
    armTimer.current = setTimeout(() => {
      armTimer.current = null;
      if (stateRef.current === 'arming') open();
    }, HOLD_MS);
  }, [open, setHint, setState]);

  const move = useCallback(
    (dx: number, dy: number) => {
      if (stateRef.current !== 'holding') return;
      if (dx <= -CANCEL_DX) {
        drop();
        return;
      }
      if (dy <= -LOCK_DY) {
        buzz(Haptics.ImpactFeedbackStyle.Light);
        setSlide(0);
        setState('locked');
        return;
      }
      setSlide(Math.min(0, dx));
    },
    [drop, setState],
  );

  const release = useCallback(() => {
    switch (stateRef.current) {
      case 'arming':
        clearArm();
        setState('idle');
        setHint(t('Segure para gravar'), true);
        return;
      case 'starting':
        drop();
        return;
      case 'holding':
        finish();
        return;
      default:
        // `locked` goes on without the finger; `idle` has nothing to do.
        return;
    }
  }, [drop, finish, setHint, setState]);

  const interrupt = useCallback(() => {
    if (stateRef.current === 'holding') {
      setSlide(0);
      setState('locked');
    } else if (stateRef.current === 'arming' || stateRef.current === 'starting') {
      drop();
    }
  }, [drop, setState]);

  const startLocked = useCallback(() => {
    if (stateRef.current !== 'idle') return;
    setHint(null);
    lockOnOpen.current = true;
    open();
  }, [open, setHint]);

  const send = useCallback(() => {
    if (stateRef.current === 'locked' || stateRef.current === 'holding') finish();
  }, [finish]);

  // The server takes at most 5 minutes: the clip is sent there, as if the finger had let go.
  const recording = state === 'holding' || state === 'locked';
  useEffect(() => {
    if (recording && recorder.seconds >= MAX_RECORDING_S) finish();
  }, [recording, recorder.seconds, finish]);

  // Unmounted mid-gesture (the screen closed): no timer fires into a hook that is gone.
  useEffect(
    () => () => {
      clearArm();
      if (hintTimer.current !== null) clearTimeout(hintTimer.current);
    },
    [],
  );

  return {
    state,
    seconds: recording ? recorder.seconds : 0,
    level: recording ? recorder.level : null,
    slide,
    hint,
    error: recorder.error,
    press,
    move,
    release,
    interrupt,
    startLocked,
    send,
    discard: drop,
  };
}
