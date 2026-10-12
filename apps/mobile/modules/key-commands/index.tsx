import { requireNativeView } from 'expo';
import type { ReactNode } from 'react';
import { Platform, View, type NativeSyntheticEvent, type ViewProps } from 'react-native';

/** Which Return the hardware keyboard sent: plain, or with ⌘. */
export type SubmitKeyEvent = { modifiers: 'none' | 'command' };

type Props = ViewProps & {
  /** Off, Return is left to the text view (a new line), as if the wrapper were not there. */
  enabled?: boolean;
  onSubmitKey?(event: NativeSyntheticEvent<SubmitKeyEvent>): void;
  children: ReactNode;
};

// iOS only (the module's `platforms`); elsewhere the wrapper is a plain view and Return is untouched.
const NativeKeyCommands = Platform.OS === 'ios' ? requireNativeView<Props>('KeyCommands') : null;

/**
 * Wraps a `TextInput` (TER-368): while it has the focus, a hardware keyboard's Return and ⌘Return fire
 * `onSubmitKey` instead of inserting a new line, whatever the box holds. Shift+Return, the on-screen
 * keyboard's Return and Return during an IME composition keep their usual meaning.
 */
export function KeyCommands({ enabled = true, onSubmitKey, ...rest }: Props) {
  if (!NativeKeyCommands) return <View {...rest} />;
  return <NativeKeyCommands enabled={enabled} onSubmitKey={onSubmitKey} {...rest} />;
}
