import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, View } from 'react-native';
import { useTranslation } from '@/i18n';
import { readableColumn, SHEET_MAX_WIDTH } from './layout';
import { AppText } from './text';

type Props = { open: boolean; onClose(): void; title: string; children: ReactNode };

/** On a wide window the panel stays a centred sheet instead of a full-width slab (spec 2026-09-28 iPad §2.4). */
const PANEL = readableColumn(SHEET_MAX_WIDTH);

export function Sheet({ open, onClose, title, children }: Props) {
  const { t } = useTranslation();
  return (
    <Modal transparent animationType="slide" visible={open} onRequestClose={onClose}>
      {/* The sheet rises with the keyboard (the PIN prompt opens the number pad); the avoiding view is
          the modal's root, so its frame is the screen's and its offset needs no correction. */}
      <KeyboardAvoidingView className="flex-1 justify-end" behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Pressable
          className="absolute inset-0 bg-black/50"
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel={t('Fechar')}
        />
        <View testID="sheet-panel" style={PANEL} className="rounded-t-3xl bg-app-surface p-6">
          <AppText variant="title">{title}</AppText>
          <View className="mt-4">{children}</View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
