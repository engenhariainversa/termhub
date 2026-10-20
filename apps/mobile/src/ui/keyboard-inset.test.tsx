import { act, render, screen, waitFor } from '@testing-library/react-native';
import { DeviceEventEmitter, Dimensions, StyleSheet, Text } from 'react-native';
import { KeyboardInsetView, keyboardOverlap, keyboardTop, useAfterKeyboardMoves } from './keyboard-inset';

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

const padding = () => StyleSheet.flatten(screen.getByTestId('body').props.style).paddingBottom;

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
  afterEach(() => nativeMethods.measureInWindow.mockReset());

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
