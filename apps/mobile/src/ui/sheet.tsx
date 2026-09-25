import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, View } from 'react-native';
import { AppText } from './text';

type Props = { open: boolean; onClose(): void; title: string; children: ReactNode };

export function Sheet({ open, onClose, title, children }: Props) {
  return (
    <Modal transparent animationType="slide" visible={open} onRequestClose={onClose}>
      {/* The sheet rises with the keyboard (the PIN prompt opens the number pad); the avoiding view is
          the modal's root, so its frame is the screen's and its offset needs no correction. */}
      <KeyboardAvoidingView className="flex-1 justify-end" behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Pressable
          className="absolute inset-0 bg-black/50"
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Fechar"
        />
        <View className="rounded-t-3xl bg-app-surface p-6">
          <AppText variant="title">{title}</AppText>
          <View className="mt-4">{children}</View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
