import { useEffect, useRef } from 'react';
import { AccessibilityInfo, Animated, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { create } from 'zustand';

/** How long a toast stays on screen. */
export const TOAST_MS = 1_800;

type ToastState = { text: string | null; seq: number };

const useToastStore = create<ToastState>(() => ({ text: null, seq: 0 }));

/** Shows a short line near the bottom of the screen ("Copiado"), replacing the one on it. Already translated. */
export function showToast(text: string): void {
  useToastStore.setState((s) => ({ text, seq: s.seq + 1 }));
  AccessibilityInfo.announceForAccessibility(text);
}

/**
 * The one toast of the app, mounted once at the root: a pill above the bottom edge that fades in, stays
 * `TOAST_MS` and fades out. Never takes a touch, so nothing under it is blocked. Plain React Native.
 */
export function ToastHost() {
  const text = useToastStore((s) => s.text);
  const seq = useToastStore((s) => s.seq);
  const insets = useSafeAreaInsets();
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (text === null) return;
    opacity.setValue(0);
    Animated.timing(opacity, { toValue: 1, duration: 150, useNativeDriver: true }).start();
    const timer = setTimeout(() => {
      Animated.timing(opacity, { toValue: 0, duration: 200, useNativeDriver: true }).start(({ finished }) => {
        if (finished) useToastStore.setState((s) => (s.seq === seq ? { text: null } : s));
      });
    }, TOAST_MS);
    return () => clearTimeout(timer);
  }, [text, seq, opacity]);

  if (text === null) return null;
  return (
    <View pointerEvents="none" className="absolute inset-x-0 items-center" style={{ bottom: insets.bottom + 72 }}>
      <Animated.View testID="toast" style={{ opacity }} className="rounded-full bg-app-text px-4 py-2">
        <Text className="text-sm font-medium text-app-bg">{text}</Text>
      </Animated.View>
    </View>
  );
}
