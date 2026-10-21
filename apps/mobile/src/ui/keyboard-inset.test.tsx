import { act, render, screen, waitFor } from '@testing-library/react-native';
import { DeviceEventEmitter, Dimensions, Text } from 'react-native';
import { getAnimatedStyle } from 'react-native-reanimated';
import { KeyboardState } from './keyboard-frames';
import { KeyboardInsetView, keyboardOverlap, keyboardTop, trackedInset, useAfterKeyboardMoves } from './keyboard-inset';

const { __setKeyboardFrame: setFrame, __resetKeyboardFrame: resetFrame } = jest.requireMock('./keyboard-frames') as {
  __setKeyboardFrame(state: KeyboardState, height: number): void;
  __resetKeyboardFrame(): void;
};

// Host views' native methods are jest mocks shared by every view: the body is 700 pt tall, from 91 pt
// down the screen, so its bottom sits at 791.
const nativeMethods = require('@react-native/jest-preset/jest/MockNativeMethods').default as { measureInWindow: jest.Mock };
const SCREEN = Dimensions.get('screen').height;
const BODY_TOP = 91;
const BODY_BOTTOM = SCREEN - 40; // a bottom safe area of 40 under the body
const KEYBOARD = 336;
const QUICKTYPE = 44;

function emit(name: string, height: number, screenY = SCREEN - height) {
  DeviceEventEmitter.emit(name, {
    duration: 0,
    easing: 'keyboard',
    startCoordinates: { screenX: 0, screenY: SCREEN, width: 390, height: 0 },
    endCoordinates: { screenX: 0, screenY, width: 390, height },
    isEventFromThisApp: true,
  });
}

const padding = () => (getAnimatedStyle(screen.getByTestId('body')) as { paddingBottom: number }).paddingBottom;

describe('keyboardTop / keyboardOverlap', () => {
  it('reads the keyboard top from the end frame, and nothing for a keyboard going away', () => {
    expect(keyboardTop({ screenX: 0, screenY: SCREEN - KEYBOARD, width: 390, height: KEYBOARD }, false, SCREEN)).toBe(SCREEN - KEYBOARD);
    expect(keyboardTop({ screenX: 0, screenY: SCREEN - KEYBOARD, width: 390, height: KEYBOARD }, true, SCREEN)).toBeNull();
    // An interactive dismiss ends with a frame below the screen.
    expect(keyboardTop({ screenX: 0, screenY: SCREEN, width: 390, height: KEYBOARD }, false, SCREEN)).toBeNull();
    expect(keyboardTop({ screenX: 0, screenY: 0, width: 390, height: 0 }, false, SCREEN)).toBeNull();
    // "Prefer Cross-Fade Transitions": screenY 0, the keyboard still at the bottom.
    expect(keyboardTop({ screenX: 0, screenY: 0, width: 390, height: KEYBOARD }, false, SCREEN)).toBe(SCREEN - KEYBOARD);
    // An iPad's floating keyboard, off the bottom edge.
    expect(keyboardTop({ screenX: 0, screenY: 300, width: 320, height: 260 }, false, SCREEN)).toBeNull();
  });

  it('takes the frame-by-frame height only while the keyboard closes, never above the events\' inset', () => {
    // The body ends 40 above the window's bottom: a keyboard of 336 covers 296 of it.
    expect(trackedInset(KeyboardState.CLOSING, 236, 800, 840, 296)).toBe(196);
    expect(trackedInset(KeyboardState.CLOSING, 20, 800, 840, 296)).toBe(0);
    // A stale, taller height cannot lift the composer off the keyboard.
    expect(trackedInset(KeyboardState.CLOSING, 400, 800, 840, 296)).toBe(296);
    expect(trackedInset(KeyboardState.OPEN, 100, 800, 840, 296)).toBe(296);
    expect(trackedInset(KeyboardState.OPENING, 100, 800, 840, 296)).toBe(296);
  });

  it('covers only what overlaps', () => {
    expect(keyboardOverlap(800, 500)).toBe(300);
    expect(keyboardOverlap(400, 500)).toBe(0);
    expect(keyboardOverlap(800, null)).toBe(0);
  });
});

describe('KeyboardInsetView (TER-1022)', () => {
  beforeEach(() => {
    nativeMethods.measureInWindow.mockImplementation((cb: (x: number, y: number, w: number, h: number) => void) => cb(0, BODY_TOP, 390, BODY_BOTTOM - BODY_TOP));
  });
  afterEach(() => {
    nativeMethods.measureInWindow.mockReset();
    resetFrame();
  });

  async function mount() {
    await render(
      <KeyboardInsetView testID="body">
        <Text>composer</Text>
      </KeyboardInsetView>,
    );
    expect(padding()).toBe(0);
  }

  it('sits on the keyboard on show, follows a frame change (the QuickType bar) and goes back to 0 on hide', async () => {
    await mount();
    await act(() => emit('keyboardWillShow', KEYBOARD));
    await waitFor(() => expect(padding()).toBe(KEYBOARD - 40));
    // The suggestions bar comes up after the keyboard: only a frame change says so.
    await act(() => emit('keyboardWillChangeFrame', KEYBOARD + QUICKTYPE));
    await waitFor(() => expect(padding()).toBe(KEYBOARD + QUICKTYPE - 40));
    await act(() => emit('keyboardWillHide', KEYBOARD + QUICKTYPE, SCREEN));
    await waitFor(() => expect(padding()).toBe(0));
  });

  it('lets go when an interactive dismiss ends with only a frame change, and lands on the whole keyboard when it opens again', async () => {
    await mount();
    for (let round = 0; round < 3; round++) {
      await act(() => emit('keyboardWillShow', KEYBOARD + QUICKTYPE));
      await waitFor(() => expect(padding()).toBe(KEYBOARD + QUICKTYPE - 40));
      // Dragging the thread down takes the keyboard off screen: no "will hide" at all.
      await act(() => emit('keyboardWillChangeFrame', KEYBOARD + QUICKTYPE, SCREEN));
      await waitFor(() => expect(padding()).toBe(0));
    }
  });

  it('uses the latest keyboard when a measurement resolves after the next event (a hide racing a show)', async () => {
    const pending: (() => void)[] = [];
    nativeMethods.measureInWindow.mockImplementation((cb: (x: number, y: number, w: number, h: number) => void) => pending.push(() => cb(0, BODY_TOP, 390, BODY_BOTTOM - BODY_TOP)));
    await mount();
    await act(() => emit('keyboardWillShow', KEYBOARD));
    await act(() => emit('keyboardWillHide', KEYBOARD, SCREEN));
    await act(() => pending.forEach((run) => run()));
    expect(padding()).toBe(0);
  });

  it('follows the keyboard down under the finger, where iOS sends no event, and lands on the safe area (TER-1103)', async () => {
    await mount();
    await act(() => setFrame(KeyboardState.OPENING, KEYBOARD));
    await act(() => emit('keyboardWillShow', KEYBOARD));
    await act(() => setFrame(KeyboardState.OPEN, KEYBOARD));
    await waitFor(() => expect(padding()).toBe(KEYBOARD - 40));
    // The thread is dragged: only Reanimated sees the keyboard move.
    await act(() => setFrame(KeyboardState.CLOSING, KEYBOARD - 100));
    expect(padding()).toBe(KEYBOARD - 100 - 40);
    await act(() => setFrame(KeyboardState.CLOSING, 30));
    expect(padding()).toBe(0);
    await act(() => emit('keyboardWillHide', KEYBOARD, SCREEN));
    await act(() => setFrame(KeyboardState.CLOSED, 0));
    await waitFor(() => expect(padding()).toBe(0));
  });

  it('goes back on the whole keyboard when a drag is let go before it closes', async () => {
    await mount();
    await act(() => emit('keyboardWillShow', KEYBOARD + QUICKTYPE));
    await act(() => setFrame(KeyboardState.OPEN, KEYBOARD + QUICKTYPE));
    await waitFor(() => expect(padding()).toBe(KEYBOARD + QUICKTYPE - 40));
    await act(() => setFrame(KeyboardState.CLOSING, 200));
    expect(padding()).toBe(200 - 40);
    // Let go: the keyboard slides back up and settles where the events had it.
    await act(() => setFrame(KeyboardState.OPENING, 260));
    await act(() => setFrame(KeyboardState.OPEN, KEYBOARD + QUICKTYPE));
    await waitFor(() => expect(padding()).toBe(KEYBOARD + QUICKTYPE - 40));
  });

  it('settles on the "did" events too, on Android-like paths', async () => {
    await mount();
    await act(() => emit('keyboardDidShow', KEYBOARD));
    await waitFor(() => expect(padding()).toBe(KEYBOARD - 40));
    await act(() => emit('keyboardDidHide', KEYBOARD, SCREEN));
    await waitFor(() => expect(padding()).toBe(0));
  });
});

describe('useAfterKeyboardMoves', () => {
  function Probe({ fn, enabled }: { fn(): void; enabled: boolean }) {
    useAfterKeyboardMoves(fn, enabled);
    return null;
  }

  it('runs once the keyboard has finished moving, only while enabled', async () => {
    const fn = jest.fn();
    const view = await render(<Probe fn={fn} enabled={false} />);
    await act(() => emit('keyboardDidHide', KEYBOARD, SCREEN));
    await act(() => new Promise((r) => requestAnimationFrame(() => r(null))));
    expect(fn).not.toHaveBeenCalled();
    await view.rerender(<Probe fn={fn} enabled />);
    await act(() => emit('keyboardDidShow', KEYBOARD));
    await waitFor(() => expect(fn).toHaveBeenCalledTimes(1));
  });
});
