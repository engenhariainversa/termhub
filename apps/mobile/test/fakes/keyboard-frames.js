// Reanimated has no keyboard under jest (`useAnimatedKeyboard` only warns): every view shares these
// shared values, which a test moves the way iOS would during an interactive dismiss (TER-1103).
const { makeMutable } = require('react-native-reanimated');

const KeyboardState = { UNKNOWN: 0, OPENING: 1, OPEN: 2, CLOSING: 3, CLOSED: 4 };
const frames = { height: makeMutable(0), state: makeMutable(KeyboardState.UNKNOWN) };

module.exports = {
  KeyboardState,
  useKeyboardFrames: () => frames,
  /** Test helper: where the keyboard is now, as Reanimated would report it. */
  __setKeyboardFrame(state, height) {
    frames.state.value = state;
    frames.height.value = height;
  },
  __resetKeyboardFrame() {
    frames.state.value = KeyboardState.UNKNOWN;
    frames.height.value = 0;
  },
};
