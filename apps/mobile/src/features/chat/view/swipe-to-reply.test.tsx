import { act, fireEvent, render, screen } from '@testing-library/react-native';
import * as Haptics from 'expo-haptics';
import { Text } from 'react-native';
import { State } from 'react-native-gesture-handler';
import { fireGestureHandler, getByGestureTestId } from 'react-native-gesture-handler/jest-utils';
import { REPLY_THRESHOLD, replyPanConfig, SwipeToReply } from './swipe-to-reply';

type Point = { translationX: number; translationY?: number };

/** One drag, from a touch down to the release, through the gesture handler's own jest driver. */
async function drag(points: Point[]) {
  await act(async () => {
    fireGestureHandler(getByGestureTestId('swipe-to-reply'), [
    { state: State.BEGAN, translationX: 0, translationY: 0 },
    ...points.map((p) => ({ state: State.ACTIVE, translationY: 0, ...p })),
      { state: State.END, translationY: 0, ...points.at(-1)! },
    ]);
  });
}

beforeEach(() => jest.mocked(Haptics.impactAsync).mockClear());

describe('SwipeToReply (TER-447)', () => {
  it('a drag past the threshold answers, with one haptic tap', async () => {
    const onReply = jest.fn();
    await render(<SwipeToReply onReply={onReply}><Text>oi</Text></SwipeToReply>);
    await drag([{ translationX: 30 }, { translationX: REPLY_THRESHOLD + 4 }, { translationX: 75 }]);
    expect(onReply).toHaveBeenCalledTimes(1);
    expect(Haptics.impactAsync).toHaveBeenCalledTimes(1);
  });

  it('a drag released short of the threshold does nothing', async () => {
    const onReply = jest.fn();
    await render(<SwipeToReply onReply={onReply}><Text>oi</Text></SwipeToReply>);
    await drag([{ translationX: 30 }, { translationX: 40 }]);
    expect(onReply).not.toHaveBeenCalled();
    expect(Haptics.impactAsync).not.toHaveBeenCalled();
  });

  it('a drag brought back under the threshold before release does not answer', async () => {
    const onReply = jest.fn();
    await render(<SwipeToReply onReply={onReply}><Text>oi</Text></SwipeToReply>);
    await drag([{ translationX: 70 }, { translationX: 20 }]);
    expect(onReply).not.toHaveBeenCalled();
  });

  it('the row offers "Responder" as an accessibility action', async () => {
    const onReply = jest.fn();
    await render(<SwipeToReply onReply={onReply}><Text>oi</Text></SwipeToReply>);
    await fireEvent(screen.getByTestId('swipe-to-reply-row'), 'accessibilityAction', { nativeEvent: { actionName: 'reply' } });
    expect(onReply).toHaveBeenCalledTimes(1);
  });

  it('disabled, it answers nothing and offers no action, and turning it on does not remount the row (TER-1001)', async () => {
    const onReply = jest.fn();
    const { rerender } = await render(<SwipeToReply onReply={onReply} enabled={false}><Text>oi</Text></SwipeToReply>);
    expect(getByGestureTestId('swipe-to-reply').config.enabled).toBe(false);
    expect(screen.queryByTestId('swipe-to-reply-row')).toBeNull();
    const row = screen.getByText('oi');

    await rerender(<SwipeToReply onReply={onReply}><Text>oi</Text></SwipeToReply>);
    expect(screen.getByText('oi')).toBe(row);
    await fireEvent(screen.getByTestId('swipe-to-reply-row'), 'accessibilityAction', { nativeEvent: { actionName: 'reply' } });
    expect(onReply).toHaveBeenCalledTimes(1);
  });

  it('the recognizer waits for a clear move right and leaves vertical drags to the list', () => {
    // The native recognizer applies these; jest does not run it, so the numbers are pinned here and
    // the feel is checked on devices.
    expect(replyPanConfig).toEqual({ activeOffsetX: 12, failOffsetY: [-10, 10], failOffsetX: -10 });
  });
});
