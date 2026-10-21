import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Dimensions, Keyboard, LayoutAnimation, Platform, View, type KeyboardEvent, type KeyboardEventName, type KeyboardMetrics, type ViewProps } from 'react-native';
import Animated, { useAnimatedReaction, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { KeyboardState, useKeyboardFrames } from './keyboard-frames';

/**
 * The keyboard events a view follows (TER-1022). iOS announces every move before it happens:
 * `keyboardWillChangeFrame` is the one that also comes for an interactive drag-to-dismiss and for the
 * QuickType bar showing or hiding, which the stock `KeyboardAvoidingView` (show/hide only) missed.
 * Android only reports after the fact.
 */
const EVENTS: readonly KeyboardEventName[] =
  Platform.OS === 'ios' ? ['keyboardWillShow', 'keyboardWillChangeFrame', 'keyboardWillHide', 'keyboardDidShow', 'keyboardDidHide'] : ['keyboardDidShow', 'keyboardDidHide'];

/** Where the keyboard's top is on screen, or `null` while it is down. */
export function keyboardTop(event: KeyboardEvent['endCoordinates'] | KeyboardMetrics | null | undefined, hidden: boolean, screenHeight = Dimensions.get('screen').height): number | null {
  if (hidden || !event || event.height <= 0) return null;
  // With "Prefer Cross-Fade Transitions" iOS reports `screenY` 0: the keyboard still sits at the bottom.
  const top = event.screenY > 0 ? event.screenY : screenHeight - event.height;
  // Below the screen is a keyboard on its way out; one whose bottom is off the screen's (an iPad's
  // floating or undocked keyboard) covers no bottom bar. Android's numbers leave out the system bars.
  if (top >= screenHeight || (Platform.OS === 'ios' && top + event.height < screenHeight - 1)) return null;
  return top;
}

/** How much of a view whose bottom is at `frameBottom` (window coordinates) the keyboard covers. */
export function keyboardOverlap(frameBottom: number, top: number | null): number {
  return top === null ? 0 : Math.max(0, Math.round(frameBottom - top));
}

/**
 * The room a view must leave at its bottom so nothing in it sits under the keyboard: one source for
 * the height, recomputed from the event's own end frame and the view's place measured right then, so
 * no value outlives the event that set it (a hide racing a show, a reopen after an interactive
 * dismiss). Attach `ref` and `onLayout` to the view whose bottom the keyboard may cover; its frame
 * does not change with the padding it is given, so the measurement stays honest.
 */
export function useKeyboardInset({ layoutAnimation = true, onMeasure }: { layoutAnimation?: boolean; onMeasure?(frameBottom: number): void } = {}) {
  const ref = useRef<View>(null);
  const [inset, setInset] = useState(0);
  const insetRef = useRef(0);
  /** The latest keyboard top: a measurement that resolves late uses this, never the one it started with. */
  const topRef = useRef<number | null>(null);
  const motionRef = useRef<{ duration: number; easing: string } | null>(null);
  /** How long the keyboard took for the move that set the current inset (0: no animation). */
  const durationRef = useRef(0);
  const onMeasureRef = useRef(onMeasure);
  onMeasureRef.current = onMeasure;

  const update = useCallback(() => {
    const view = ref.current;
    const apply = (next: number) => {
      if (next === insetRef.current) return;
      insetRef.current = next;
      const motion = motionRef.current;
      motionRef.current = null;
      durationRef.current = motion && motion.duration > 0 ? Math.max(10, motion.duration) : 0;
      if (layoutAnimation && motion && motion.duration > 0) {
        const duration = Math.max(10, motion.duration);
        const type = (LayoutAnimation.Types as Record<string, string>)[motion.easing] ?? LayoutAnimation.Types.keyboard;
        LayoutAnimation.configureNext({ duration, update: { duration, type: type as never } });
      }
      setInset(next);
    };
    if (!view) {
      apply(0);
      return;
    }
    if (topRef.current === null && !onMeasureRef.current) {
      apply(0);
      return;
    }
    view.measureInWindow((_x, y, _w, h) => {
      onMeasureRef.current?.(y + h);
      apply(keyboardOverlap(y + h, topRef.current));
    });
  }, [layoutAnimation]);

  useEffect(() => {
    const subs = EVENTS.map((name) =>
      Keyboard.addListener(name, (e: KeyboardEvent) => {
        topRef.current = keyboardTop(e?.endCoordinates, name === 'keyboardWillHide' || name === 'keyboardDidHide');
        motionRef.current = e && 'duration' in e ? { duration: e.duration, easing: e.easing } : null;
        update();
      }),
    );
    return () => subs.forEach((s) => s.remove());
  }, [update]);

  const onLayout = useCallback(() => {
    motionRef.current = null;
    update();
  }, [update]);

  return { ref, inset, onLayout, durationRef };
}

/**
 * The bottom padding while the keyboard moves under a finger (TER-1103). iOS sends no event during an
 * interactive dismiss, so the inset from the events stays put while the keyboard slides down and the
 * composer floats above it. While it closes, the frame-by-frame height wins, never above where the
 * events had set it (`steady`: a stale height can only push the composer under the keyboard). While
 * it opens, the events' inset is eased in on the keyboard's own duration; at rest it is the events'
 * inset, which also follows the QuickType bar.
 */
export function trackedInset(state: KeyboardState, keyboardHeight: number, frameBottom: number, windowHeight: number, steady: number): number {
  'worklet';
  const overlap = Math.max(0, Math.round(keyboardHeight - (windowHeight - frameBottom)));
  return state === KeyboardState.CLOSING ? Math.min(steady, overlap) : steady;
}

/** How long the composer takes back up after a cancelled drag when no keyboard move set a duration yet. */
const SNAP_BACK_MS = 250;

/** iOS: the events' inset, plus the keyboard followed frame by frame while it closes (see `trackedInset`). */
function TrackedKeyboardInsetView({ children, style, onLayout, ...rest }: ViewProps & { children: ReactNode }) {
  const frames = useKeyboardFrames();
  const frameBottom = useSharedValue(Dimensions.get('window').height);
  const windowHeight = useSharedValue(Dimensions.get('window').height);
  const inset = useSharedValue(0);
  const duration = useSharedValue(0);
  /** The events' inset as of the last moment the keyboard was not closing. */
  const steady = useSharedValue(0);
  const padding = useSharedValue(0);
  const last = useSharedValue<{ state: KeyboardState; target: number }>({ state: KeyboardState.UNKNOWN, target: 0 });
  const keyboard = useKeyboardInset({
    layoutAnimation: false,
    onMeasure: (bottom) => {
      frameBottom.set(bottom);
      windowHeight.set(Dimensions.get('window').height);
    },
  });

  useEffect(() => {
    duration.set(keyboard.durationRef.current);
    inset.set(keyboard.inset);
  }, [keyboard.inset, keyboard.durationRef, duration, inset]);

  useAnimatedReaction(
    () => ({ state: frames.state.get(), height: frames.height.get(), bottom: frameBottom.get(), window: windowHeight.get(), inset: inset.get() }),
    (now) => {
      if (now.state !== KeyboardState.CLOSING) steady.set(now.inset);
      const target = trackedInset(now.state, now.height, now.bottom, now.window, steady.get());
      const was = last.get();
      last.set({ state: now.state, target });
      // Under the finger (and on the way down) the padding is the keyboard's, frame by frame.
      if (now.state === KeyboardState.CLOSING) padding.set(target);
      // Otherwise a new place is eased in once, on the keyboard's duration: the way back up after a
      // cancelled drag included, whose target did not change while it was closing.
      else if (target !== was.target || was.state === KeyboardState.CLOSING) {
        const ms = duration.get() > 0 ? duration.get() : was.state === KeyboardState.CLOSING ? SNAP_BACK_MS : 0;
        padding.set(ms > 0 ? withTiming(target, { duration: ms }) : target);
      }
    },
  );

  const padded = useAnimatedStyle(() => ({ paddingBottom: padding.get() }));

  return (
    <Animated.View
      {...rest}
      ref={keyboard.ref}
      onLayout={(e) => {
        keyboard.onLayout();
        onLayout?.(e);
      }}
      style={[{ flex: 1 }, style, padded]}
    >
      {children}
    </Animated.View>
  );
}

/** A flex-1 view padded by the keyboard's overlap with it (see `useKeyboardInset`); on iOS it also
 * follows the keyboard during an interactive dismiss (TER-1103). */
export function KeyboardInsetView(props: ViewProps & { children: ReactNode }) {
  return Platform.OS === 'ios' ? <TrackedKeyboardInsetView {...props} /> : <PlainKeyboardInsetView {...props} />;
}

function PlainKeyboardInsetView({ children, style, onLayout, ...rest }: ViewProps & { children: ReactNode }) {
  const keyboard = useKeyboardInset();
  return (
    <View
      {...rest}
      ref={keyboard.ref}
      onLayout={(e) => {
        keyboard.onLayout();
        onLayout?.(e);
      }}
      style={[{ flex: 1, paddingBottom: keyboard.inset }, style]}
    >
      {children}
    </View>
  );
}

/**
 * Runs `fn` whenever the keyboard has finished moving (did show / did hide), on the next frame so the
 * layout that followed it has landed: the place for something measured on screen to be measured again.
 */
export function useAfterKeyboardMoves(fn: () => void, enabled = true) {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    if (!enabled) return;
    let frame: number | null = null;
    const run = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = null;
        fnRef.current();
      });
    };
    const subs = (['keyboardDidShow', 'keyboardDidHide', 'keyboardDidChangeFrame'] as const).map((name) => Keyboard.addListener(name, run));
    return () => {
      subs.forEach((s) => s.remove());
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [enabled]);
}
