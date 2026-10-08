import { useEffect, useRef, type ReactNode } from 'react';
import { Animated, Modal, PanResponder, Platform, Pressable, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from '@/i18n';
import { Icon, type IconName } from './icon';
import { readableColumn, SHEET_MAX_WIDTH } from './layout';

/** On a wide window the panel stays a centred sheet instead of a full-width slab, like `Sheet`. */
const PANEL = readableColumn(SHEET_MAX_WIDTH);
/** How far down (pt) or how fast (pt/ms) a drag has to go for the sheet to close. */
const DRAG_CLOSE_DISTANCE = 80;
const DRAG_CLOSE_VELOCITY = 0.8;

type Props = {
  open: boolean;
  /** A tap on the backdrop, "Cancelar", a drag down or the system back: the person chose nothing. */
  onCancel(): void;
  /** Once the sheet is gone from the screen: the moment focus can go back to a text box under it. */
  onHidden?(): void;
  children: ReactNode;
};

/**
 * A bottom sheet of actions (iOS's action sheet, WhatsApp's +): it rises from the bottom edge of the
 * screen over a dimmed backdrop, so where it stands never depends on the keyboard or on the button
 * that opened it. It closes on a tap outside, on "Cancelar", on a drag down and on the system back.
 * Plain React Native (`Modal`, `Animated`, `PanResponder`): no native module, so no store build.
 */
export function ActionSheet({ open, onCancel, onHidden, children }: Props) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const window = useWindowDimensions();
  const offset = useRef(new Animated.Value(window.height)).current;
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;

  // Slides up from below the screen each time it opens; the backdrop fades in with the modal.
  useEffect(() => {
    if (!open) return;
    offset.setValue(window.height);
    Animated.timing(offset, { toValue: 0, duration: 220, useNativeDriver: true }).start();
  }, [open, offset, window.height]);

  // `onDismiss` is the modal's own "gone" on iOS; elsewhere the sheet is gone once it is closed.
  const wasOpen = useRef(open);
  useEffect(() => {
    if (wasOpen.current && !open && Platform.OS !== 'ios') onHidden?.();
    wasOpen.current = open;
  }, [open, onHidden]);

  const drag = useRef(
    PanResponder.create({
      // Only a vertical drag down takes over: a tap still reaches the row under the finger.
      onMoveShouldSetPanResponder: (_e, g) => g.dy > 6 && Math.abs(g.dy) > Math.abs(g.dx),
      onPanResponderMove: (_e, g) => offset.setValue(Math.max(0, g.dy)),
      onPanResponderRelease: (_e, g) => {
        if (g.dy > DRAG_CLOSE_DISTANCE || g.vy > DRAG_CLOSE_VELOCITY) cancelRef.current();
        else Animated.spring(offset, { toValue: 0, useNativeDriver: true, bounciness: 0 }).start();
      },
      onPanResponderTerminate: () => Animated.spring(offset, { toValue: 0, useNativeDriver: true, bounciness: 0 }).start(),
    }),
  ).current;

  return (
    <Modal testID="action-sheet" transparent animationType="fade" visible={open} onRequestClose={onCancel} onDismiss={onHidden} statusBarTranslucent>
      <View className="flex-1 justify-end">
        {/* The panel is modal for VoiceOver, so the backdrop is a touch target only; its escape gesture cancels. */}
        <Pressable testID="action-sheet-backdrop" className="absolute inset-0 bg-black/40" onPress={onCancel} accessibilityRole="button" accessibilityLabel={t('Fechar')} />
        <Animated.View
          testID="action-sheet-panel"
          accessibilityViewIsModal
          onAccessibilityEscape={onCancel}
          {...drag.panHandlers}
          style={[PANEL, { paddingBottom: insets.bottom + 8, transform: [{ translateY: offset }] }]}
          className="rounded-t-3xl bg-app-surface px-3 pt-2"
        >
          <View className="mb-2 h-1 w-10 self-center rounded-full bg-app-border" />
          {children}
          <View className="my-2 h-px bg-app-border" />
          <Pressable accessibilityRole="button" accessibilityLabel={t('Cancelar')} onPress={onCancel} className="items-center rounded-2xl py-4 active:bg-app-surface2">
            <Text className="text-base font-semibold text-app-text">{t('Cancelar')}</Text>
          </Pressable>
        </Animated.View>
      </View>
    </Modal>
  );
}

/** One row of an `ActionSheet`: a large touch target with the symbol in a circle, then its label. */
export function ActionSheetItem({ icon, label, onPress }: { icon: IconName; label: string; onPress(): void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} className="min-h-14 flex-row items-center gap-4 rounded-2xl px-3 py-3 active:bg-app-surface2">
      <View className="h-10 w-10 items-center justify-center rounded-full bg-app-surface2">
        <Icon name={icon} size={20} tone="text" />
      </View>
      <Text className="text-lg text-app-text">{label}</Text>
    </Pressable>
  );
}
