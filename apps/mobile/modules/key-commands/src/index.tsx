// SPIKE (TER-368) — throwaway.
import { requireNativeView } from 'expo';
import type { ReactNode } from 'react';
import { Platform, View, type ViewProps } from 'react-native';

type Props = ViewProps & {
  enabled?: boolean;
  onSubmitKey?: (e: { nativeEvent: { modifiers: 'none' | 'command' } }) => void;
  children: ReactNode;
};

const Native = Platform.OS === 'ios' ? requireNativeView<Props>('KeyCommands') : null;

/** Wraps a TextInput: Return (and Cmd+Return) on a hardware keyboard fire `onSubmitKey` instead of a new line. */
export function KeyCommands({ children, enabled = true, onSubmitKey, ...rest }: Props) {
  if (!Native) return <View {...rest}>{children}</View>;
  return (
    <Native enabled={enabled} onSubmitKey={onSubmitKey} {...rest}>
      {children}
    </Native>
  );
}
