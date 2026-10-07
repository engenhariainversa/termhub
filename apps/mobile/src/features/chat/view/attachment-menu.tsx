import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { useState } from 'react';
import { Modal, Pressable, Text, View, useWindowDimensions } from 'react-native';
import { useTranslation } from '@/i18n';
import { Icon, type IconName } from '@/ui';
import { CHAT_MSG } from '../model/messages';
import type { PickedFile } from '../viewmodel/attachments';
import { useRecorder } from '../viewmodel/use-voice';

/** Whole seconds as `m:ss`. */
const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

/** Where the + button sits on screen (window coordinates of its top-left corner): the menu opens above it. */
export type MenuAnchor = { x: number; y: number };

/** The gap between the menu and the + button, and where the menu goes when the button could not be measured. */
const ANCHOR_GAP = 8;
const FALLBACK = { left: 16, bottom: 120 };

/** One line of the menu: the symbol in a circle, then its label (ChatGPT's attachment menu). */
function MenuItem({ icon, label, onPress, tone = 'text' }: { icon: IconName; label: string; onPress(): void; tone?: 'text' | 'danger' }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} className="flex-row items-center gap-3 rounded-2xl px-2 py-2 active:bg-app-surface2">
      <View className="h-9 w-9 items-center justify-center rounded-full bg-app-surface2">
        <Icon name={icon} size={18} tone={tone} />
      </View>
      <Text className={`text-base ${tone === 'danger' ? 'text-app-danger' : 'text-app-text'}`}>{label}</Text>
    </Pressable>
  );
}

/**
 * The + button's menu, floating just above it with rounded corners — the three ways in of spec
 * 2026-09-26 §5.6: the gallery (photos and videos, `quality: 0.8` so a phone
 * photo is not 8 MB), the file picker, and a recording that goes up as an audio attachment — the same
 * recorder as dictation, but the clip is kept, not transcribed into the box. `room` is how many more
 * files the message can take. A tap outside closes it (and drops a recording under way).
 */
export function AttachmentMenu({
  open,
  anchor,
  room,
  onClose,
  onPicked,
}: {
  open: boolean;
  anchor: MenuAnchor | null;
  room: number;
  onClose(): void;
  onPicked(files: PickedFile[]): void;
}) {
  const { t } = useTranslation();
  const recorder = useRecorder();
  const window = useWindowDimensions();
  const [error, setError] = useState<string | null>(null);

  // `cancel()` is a no-op when idle, and while the microphone is still being asked for it stops the
  // recording from ever starting: a Cancelar or backdrop tap during that wait must not leave one running.
  const close = () => {
    recorder.cancel();
    setError(null);
    onClose();
  };

  const pickMedia = async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      setError(CHAT_MSG.attachmentGalleryDenied);
      return;
    }
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images', 'videos'], quality: 0.8, allowsMultipleSelection: true, selectionLimit: room, exif: false });
    if (res.canceled) return;
    onPicked(
      res.assets.map((a) => ({
        uri: a.uri,
        name: a.fileName ?? `${a.type === 'video' ? 'video' : 'foto'}-${Date.now()}.${a.type === 'video' ? 'mp4' : 'jpg'}`,
        mime: a.mimeType ?? (a.type === 'video' ? 'video/mp4' : 'image/jpeg'),
        bytes: a.fileSize ?? null,
      })),
    );
    close();
  };

  const pickFile = async () => {
    const res = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
    if (res.canceled) return;
    onPicked(res.assets.slice(0, room).map((a) => ({ uri: a.uri, name: a.name, mime: a.mimeType ?? 'application/octet-stream', bytes: a.size ?? null })));
    close();
  };

  const stopRecording = async () => {
    const clip = await recorder.stop();
    if (!clip) return;
    onPicked([{ uri: clip.uri, name: `audio-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.m4a`, mime: clip.mime, bytes: null }]);
    close();
  };

  // `start()` rejects with the same message it puts in `recorder.error`, shown below.
  const startRecording = () => recorder.start().catch(() => undefined);

  const place = anchor ? { left: Math.max(8, anchor.x - 4), bottom: window.height - anchor.y + ANCHOR_GAP } : FALLBACK;

  return (
    <Modal transparent animationType="fade" visible={open} onRequestClose={close}>
      <Pressable className="absolute inset-0" onPress={close} accessibilityRole="button" accessibilityLabel={t('Fechar')} />
      <View testID="attachment-menu" style={{ position: 'absolute', ...place }} className="min-w-56 rounded-3xl border border-app-border bg-app-surface p-2 shadow-lg">
        {recorder.state === 'recording' ? (
          <>
            <View className="flex-row items-center gap-2 px-3 py-2">
              <View className="h-2 w-2 rounded-full bg-app-danger" />
              <Text className="text-sm text-app-muted">{t('Gravando… {{time}}', { time: clock(recorder.seconds) })}</Text>
            </View>
            <MenuItem icon={{ ios: 'stop.fill', android: 'stop' }} label={t('Parar e anexar')} onPress={() => void stopRecording()} />
            <MenuItem icon={{ ios: 'xmark', android: 'close' }} label={t('Cancelar gravação')} onPress={close} tone="danger" />
          </>
        ) : (
          <>
            <MenuItem icon={{ ios: 'photo.on.rectangle', android: 'photo_library' }} label={t('Foto ou vídeo')} onPress={() => void pickMedia()} />
            <MenuItem icon={{ ios: 'doc', android: 'description' }} label={t('Arquivo')} onPress={() => void pickFile()} />
            <MenuItem icon={{ ios: 'waveform', android: 'graphic_eq' }} label={t('Gravar áudio')} onPress={() => void startRecording()} />
          </>
        )}
        {(error ?? recorder.error) ? <Text className="max-w-64 px-3 py-2 text-sm text-app-danger">{error ?? recorder.error}</Text> : null}
      </View>
    </Modal>
  );
}
