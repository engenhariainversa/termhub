import { KeyboardState, useAnimatedKeyboard, type SharedValue } from 'react-native-reanimated';

export { KeyboardState };

/**
 * The keyboard's visible height (from the window's bottom) and state, on the UI thread, frame by frame
 * (TER-1103). On iOS Reanimated watches the keyboard's own view, so it also moves while the keyboard
 * follows a finger in an interactive dismiss, when no keyboard event comes at all. A seam of its own so
 * tests can drive it: Reanimated has no keyboard under Jest.
 */
export function useKeyboardFrames(): { height: SharedValue<number>; state: SharedValue<KeyboardState> } {
  return useAnimatedKeyboard();
}
