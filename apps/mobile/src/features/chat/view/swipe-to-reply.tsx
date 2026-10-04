import * as Haptics from 'expo-haptics';
import type { ReactNode } from 'react';
import { View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { interpolate, useAnimatedStyle, useReducedMotion, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { Icon, type IconName } from '@/ui';

/** Released past this, the drag answers the message. */
export const REPLY_THRESHOLD = 56;
/** How far the bubble can travel; past the threshold it follows at a third of the finger's speed. */
const MAX_TRAVEL = 80;
/** A touch that starts this close to the screen's left edge is the iOS back gesture's, never a reply. */
export const EDGE_GUARD = 24;
/** What the recognizer waits for: a clear move to the right. A vertical move is the list's scroll, and
 * any move to the left is nobody's business here. */
export const replyPanConfig = { activeOffsetX: 12, failOffsetY: [-10, 10] as [number, number], failOffsetX: -10 };

const REPLY_ICON: IconName = { ios: 'arrowshape.turn.up.left.fill', android: 'reply' };

/** The one light tap of crossing the threshold. A device without haptics just stays quiet. */
const tap = () => void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);

/** Where the bubble sits for a finger `t` points to the right: one to one, then a third past the threshold. */
function travel(t: number): number {
  'worklet';
  const x = Math.max(0, t);
  return x <= REPLY_THRESHOLD ? x : Math.min(MAX_TRAVEL, REPLY_THRESHOLD + (x - REPLY_THRESHOLD) / 3);
}

/**
 * WhatsApp's drag-to-answer around one row of the thread: a message (TER-447), or a confirmation or
 * a tab's question card (TER-849). The row follows the finger to the right on the UI thread; a reply
 * icon grows in behind it; crossing the threshold gives one light tap, and a release past it calls
 * `onReply`. The recognizer only starts on a clear move to the right and
 * gives up on a vertical one, so the thread's own scroll wins every vertical drag; a touch that begins
 * at the screen's left edge is left to the system's back gesture. A drag cannot be made with VoiceOver
 * or TalkBack, so the row also offers "Responder" as an accessibility action.
 */
export function SwipeToReply({ onReply, children }: { onReply(): void; children: ReactNode }) {
  const x = useSharedValue(0);
  const armed = useSharedValue(false);
  const still = useReducedMotion();

  const pan = Gesture.Pan()
    .withTestId('swipe-to-reply')
    .activeOffsetX(replyPanConfig.activeOffsetX)
    .failOffsetY(replyPanConfig.failOffsetY)
    .failOffsetX(replyPanConfig.failOffsetX)
    .onTouchesDown((e, manager) => {
      if ((e.allTouches[0]?.absoluteX ?? EDGE_GUARD) < EDGE_GUARD) manager.fail();
    })
    .onUpdate((e) => {
      x.set(travel(e.translationX));
      const past = e.translationX >= REPLY_THRESHOLD;
      if (past && !armed.get()) scheduleOnRN(tap);
      armed.set(past);
    })
    .onEnd(() => {
      if (armed.get()) scheduleOnRN(onReply);
    })
    .onFinalize(() => {
      armed.set(false);
      x.set(still ? withTiming(0, { duration: 0 }) : withSpring(0, { damping: 20, stiffness: 220 }));
    });

  const rowStyle = useAnimatedStyle(() => ({ transform: [{ translateX: x.get() }] }));
  const iconStyle = useAnimatedStyle(() => ({
    opacity: interpolate(x.get(), [0, REPLY_THRESHOLD], [0, 1], 'clamp'),
    transform: [{ scale: interpolate(x.get(), [0, REPLY_THRESHOLD], [0.5, 1], 'clamp') }],
  }));

  return (
    <GestureDetector gesture={pan}>
      <View
        testID="swipe-to-reply-row"
        accessibilityActions={[{ name: 'reply', label: 'Responder' }]}
        onAccessibilityAction={(e) => {
          if (e.nativeEvent.actionName === 'reply') onReply();
        }}
      >
        <Animated.View pointerEvents="none" style={[{ position: 'absolute', left: 0, top: 0, bottom: 0, justifyContent: 'center' }, iconStyle]}>
          <Icon name={REPLY_ICON} size={18} tone="muted" />
        </Animated.View>
        <Animated.View style={rowStyle}>{children}</Animated.View>
      </View>
    </GestureDetector>
  );
}
