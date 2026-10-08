import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Dimensions, Keyboard, LayoutAnimation, Platform, View, type KeyboardEvent, type KeyboardEventName, type KeyboardMetrics, type ViewProps } from 'react-native';

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
export function useKeyboardInset() {
  const ref = useRef<View>(null);
  const [inset, setInset] = useState(0);
  const insetRef = useRef(0);
  /** The latest keyboard top: a measurement that resolves late uses this, never the one it started with. */
  const topRef = useRef<number | null>(null);
  const motionRef = useRef<{ duration: number; easing: string } | null>(null);

  const update = useCallback(() => {
    const view = ref.current;
    const apply = (next: number) => {
      if (next === insetRef.current) return;
      insetRef.current = next;
      const motion = motionRef.current;
      motionRef.current = null;
      if (motion && motion.duration > 0) {
        const duration = Math.max(10, motion.duration);
        const type = (LayoutAnimation.Types as Record<string, string>)[motion.easing] ?? LayoutAnimation.Types.keyboard;
        LayoutAnimation.configureNext({ duration, update: { duration, type: type as never } });
      }
      setInset(next);
    };
    if (topRef.current === null || !view) {
      apply(0);
      return;
    }
    view.measureInWindow((_x, y, _w, h) => apply(keyboardOverlap(y + h, topRef.current)));
  }, []);

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

  return { ref, inset, onLayout };
}

/** A flex-1 view padded by the keyboard's overlap with it (see `useKeyboardInset`). */
export function KeyboardInsetView({ children, style, onLayout, ...rest }: ViewProps & { children: ReactNode }) {
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
