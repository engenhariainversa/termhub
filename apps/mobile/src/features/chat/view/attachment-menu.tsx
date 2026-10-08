import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { useState } from 'react';
import { Text } from 'react-native';
import { useTranslation } from '@/i18n';
import { ActionSheet, ActionSheetItem } from '@/ui';
import { CHAT_MSG } from '../model/messages';
import type { PickedFile } from '../viewmodel/attachments';

const asPicked = (a: ImagePicker.ImagePickerAsset): PickedFile => ({
  uri: a.uri,
  name: a.fileName ?? `${a.type === 'video' ? 'video' : 'foto'}-${Date.now()}.${a.type === 'video' ? 'mp4' : 'jpg'}`,
  mime: a.mimeType ?? (a.type === 'video' ? 'video/mp4' : 'image/jpeg'),
  bytes: a.fileSize ?? null,
});

/**
 * The + button's menu, a bottom sheet (TER-1041): it rises from the bottom edge of the screen, not
 * from the button, so it never floats where the keyboard used to be. The ways in of spec 2026-09-26
 * §5.6: the gallery (photos and videos, `quality: 0.8` so a phone photo is not 8 MB), the camera and
 * the file picker. A voice note is the microphone's (hold it, TER-1036), so the menu does not record;
 * it offers dictation instead (`onDictate`, when the server transcribes): what is said lands in the
 * box as text, to be read before it is sent. `room` is how many more files the message can take.
 * `onClose(chose)` says whether an option was taken; `onHidden` runs once the sheet left the screen.
 */
export function AttachmentMenu({
  open,
  room,
  onClose,
  onHidden,
  onPicked,
  onDictate,
}: {
  open: boolean;
  room: number;
  onClose(chose: boolean): void;
  onHidden?(): void;
  onPicked(files: PickedFile[]): void;
  /** Starts dictation into the box; without it the menu has no "Ditar". */
  onDictate?(): void;
}) {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);

  const close = (chose: boolean) => {
    setError(null);
    onClose(chose);
  };

  const pickMedia = async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      setError(CHAT_MSG.attachmentGalleryDenied);
      return;
    }
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images', 'videos'], quality: 0.8, allowsMultipleSelection: true, selectionLimit: room, exif: false });
    if (res.canceled) return;
    onPicked(res.assets.map(asPicked));
    close(true);
  };

  const takePhoto = async () => {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      setError(CHAT_MSG.attachmentCameraDenied);
      return;
    }
    try {
      const res = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.8, exif: false });
      if (res.canceled) return;
      onPicked(res.assets.slice(0, room).map(asPicked));
      close(true);
    } catch {
      // A device with no camera (the simulator) throws instead of opening it.
      setError(CHAT_MSG.attachmentCameraFailed);
    }
  };

  const pickFile = async () => {
    const res = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
    if (res.canceled) return;
    onPicked(res.assets.slice(0, room).map((a) => ({ uri: a.uri, name: a.name, mime: a.mimeType ?? 'application/octet-stream', bytes: a.size ?? null })));
    close(true);
  };

  const dictate = () => {
    close(true);
    onDictate?.();
  };

  return (
    <ActionSheet open={open} onCancel={() => close(false)} onHidden={onHidden}>
      <ActionSheetItem icon={{ ios: 'photo.on.rectangle', android: 'photo_library' }} label={t('Foto ou vídeo')} onPress={() => void pickMedia()} />
      <ActionSheetItem icon={{ ios: 'camera', android: 'photo_camera' }} label={t('Câmera')} onPress={() => void takePhoto()} />
      <ActionSheetItem icon={{ ios: 'doc', android: 'description' }} label={t('Arquivo')} onPress={() => void pickFile()} />
      {onDictate ? <ActionSheetItem icon={{ ios: 'text.bubble', android: 'record_voice_over' }} label={t('Ditar')} onPress={dictate} /> : null}
      {error ? <Text className="px-3 py-2 text-sm text-app-danger">{error}</Text> : null}
    </ActionSheet>
  );
}
