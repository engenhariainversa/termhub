import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { AppState, View } from 'react-native';
import Animated, { cancelAnimation, Easing, useAnimatedStyle, useReducedMotion, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';
import type { TTabSummary } from '@/services/api/contract';

/** One beat of the working pulse: grow and fade over half of ~1.5 s, back over the other half. */
const PULSE_HALF_MS = 750;
/** One turn of the automatic run's ring. */
const RING_TURN_MS = 1200;

type DotTab = Pick<TTabSummary, 'availability' | 'needs_you' | 'state' | 'finished' | 'auto_ref'> & Partial<Pick<TTabSummary, 'blocked'>>;

/** The dot's colour: the accent while it works, the danger tone when it needs the person or failed, the
 * ok tone once it finished with a report (TER-972), the muted tone for a blocked automatic run (TER-1046). */
export function dotClass(tab: DotTab): string {
  if (tab.availability !== 'ready') return 'bg-app-muted';
  if (tab.needs_you || tab.state === 'error') return 'bg-app-danger';
  if (tab.state === 'working') return 'bg-app-accent';
  if (tab.state === 'idle' && tab.finished) return 'bg-app-ok';
  if (tab.state === 'idle' && tab.blocked) return 'bg-app-muted';
  return 'bg-app-border';
}

/** Whether the tab is at work as the dot shows it: the pulse, and the turning ring of an automatic run. */
export const dotWorking = (tab: DotTab): boolean => tab.availability === 'ready' && !tab.needs_you && tab.state === 'working';

/**
 * Whether the list is on the person's screen: its screen is focused and the app is in the foreground.
 * The dots stop moving otherwise (TER-1044), so an animation never runs where nobody sees it.
 */
export function useListOnScreen(): boolean {
  const [focused, setFocused] = useState(true);
  const [active, setActive] = useState(AppState.currentState !== 'background' && AppState.currentState !== 'inactive');
  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, []),
  );
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => setActive(next === 'active'));
    return () => sub.remove();
  }, []);
  return focused && active;
}

/**
 * A tab's status dot (TER-1044): a soft pulse (scale and opacity, ~1.5 s) while the tab works, and a ring
 * around it for a tab an automatic run works in, turning while it works. Still — only the colour — with
 * the system's Reduce Motion on, and while `onScreen` is false. Decorative: the row's label says the state.
 */
export function StatusDot({ tab, onScreen = true }: { tab: DotTab; onScreen?: boolean }) {
  const still = useReducedMotion();
  const working = dotWorking(tab);
  const pulse = useSharedValue(0);
  const turn = useSharedValue(0);
  const moving = working && onScreen && !still;
  const auto = !!tab.auto_ref;

  useEffect(() => {
    if (!moving) {
      cancelAnimation(pulse);
      cancelAnimation(turn);
      pulse.set(0);
      turn.set(0);
      return;
    }
    pulse.set(withRepeat(withTiming(1, { duration: PULSE_HALF_MS, easing: Easing.inOut(Easing.ease) }), -1, true));
    if (auto) turn.set(withRepeat(withTiming(360, { duration: RING_TURN_MS, easing: Easing.linear }), -1, false));
  }, [moving, auto, pulse, turn]);

  const dotStyle = useAnimatedStyle(() => ({ opacity: 1 - 0.45 * pulse.get(), transform: [{ scale: 1 + 0.4 * pulse.get() }] }));
  const ringStyle = useAnimatedStyle(() => ({ transform: [{ rotate: `${turn.get()}deg` }] }));

  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" className="h-4 w-4 items-center justify-center">
      {/* the classes on plain Views, the motion on the Animated wrappers (as composer.tsx does) */}
      {auto ? (
        <Animated.View testID="status-dot-ring" style={[{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }, ringStyle]}>
          <View className="h-4 w-4 rounded-full border-2 border-app-accent border-r-transparent" />
        </Animated.View>
      ) : null}
      <Animated.View testID="status-dot" style={dotStyle}>
        <View className={`h-2.5 w-2.5 rounded-full ${dotClass(tab)}`} />
      </Animated.View>
    </View>
  );
}
