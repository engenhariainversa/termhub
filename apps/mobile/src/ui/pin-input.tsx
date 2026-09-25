import { useEffect, useRef } from 'react';
import { Pressable, TextInput } from 'react-native';
import { PinDots } from './pin-dots';

type Props = {
  value: string;
  onChange(value: string): void;
  length?: number;
  disabled?: boolean;
  error?: boolean;
  accessibilityLabel: string;
};

/** A PIN typed on the system number pad: the dots are what shows, over a hidden field that holds
 * the digits. Tapping the dots brings the keyboard back; the field takes focus again whenever it is
 * re-enabled (a lock ends, a wrong PIN was cleared). */
export function PinInput({ value, onChange, length = 6, disabled = false, error = false, accessibilityLabel }: Props) {
  const input = useRef<TextInput>(null);

  useEffect(() => {
    if (!disabled) input.current?.focus();
  }, [disabled]);

  return (
    <Pressable accessible={false} className="py-4" onPress={() => input.current?.focus()}>
      <PinDots length={length} filled={value.length} error={error} />
      <TextInput
        ref={input}
        value={value}
        onChangeText={(text) => onChange(text.replace(/\D/g, '').slice(0, length))}
        editable={!disabled}
        autoFocus={!disabled}
        keyboardType="number-pad"
        maxLength={length}
        autoComplete="off"
        autoCorrect={false}
        textContentType="none"
        caretHidden
        contextMenuHidden
        accessibilityLabel={accessibilityLabel}
        className="absolute h-px w-px opacity-0"
      />
    </Pressable>
  );
}
