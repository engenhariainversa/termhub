import { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { Button } from '@/ui';

/** The message field and its send button; the text clears as soon as it is sent and comes back if
 * the send fails. Dictation is not wired yet: its button is there, disabled, saying so. */
export function Composer({ sending, onSend }: { sending: boolean; onSend(text: string): Promise<boolean> }) {
  const [text, setText] = useState('');

  // The box empties at once (the row is already on screen) and gets its text back if the send
  // fails — unless something new was typed meanwhile, which is the person's to keep.
  const submit = async () => {
    const sent = text;
    setText('');
    if (!(await onSend(sent))) setText((current) => current || sent);
  };

  return (
    <View className="flex-row items-end gap-2 border-t border-app-border bg-app-bg px-4 py-3">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Ditar mensagem, em breve"
        accessibilityState={{ disabled: true }}
        disabled
        className="items-center justify-center rounded-xl border border-app-border px-3 py-3.5 opacity-60"
      >
        <Text className="text-xs text-app-muted">em breve</Text>
      </Pressable>
      <TextInput
        value={text}
        onChangeText={setText}
        placeholder="Mensagem"
        accessibilityLabel="Mensagem"
        multiline
        className="max-h-32 flex-1 rounded-xl border border-app-border bg-app-surface px-4 py-3 text-base text-app-text placeholder:text-app-muted"
      />
      <Button label="Enviar" onPress={() => void submit()} disabled={!text.trim()} loading={sending} />
    </View>
  );
}
