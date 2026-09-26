import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { useState } from 'react';
import { View } from 'react-native';
import { AppText, Button, Sheet } from '@/ui';
import { CHAT_MSG } from '../model/messages';
import type { PickedFile } from '../viewmodel/attachments';
import { useRecorder } from '../viewmodel/use-voice';

/** Whole seconds as `m:ss`. */
const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

/**
 * 📎's three ways in (spec 2026-09-26 §5.6): the gallery (photos and videos, `quality: 0.8` so a phone
 * photo is not 8 MB), the file picker, and a recording that goes up as an audio attachment — the same
 * recorder as dictation, but the clip is kept, not transcribed into the box. `room` is how many more
 * files the message can take.
 */
export function AttachmentSheet({ open, room, onClose, onPicked }: { open: boolean; room: number; onClose(): void; onPicked(files: PickedFile[]): void }) {
  const recorder = useRecorder();
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    if (recorder.state === 'recording') recorder.cancel();
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

  return (
    <Sheet open={open} onClose={close} title="Anexar">
      <View className="gap-3">
        {recorder.state === 'recording' ? (
          <>
            <AppText variant="muted">Gravando… {clock(recorder.seconds)}</AppText>
            <Button label="Parar e anexar" onPress={() => void stopRecording()} />
            <Button label="Cancelar gravação" variant="ghost" onPress={close} />
          </>
        ) : (
          <>
            <Button label="Foto ou vídeo" variant="secondary" onPress={() => void pickMedia()} />
            <Button label="Arquivo" variant="secondary" onPress={() => void pickFile()} />
            <Button label="Gravar áudio" variant="secondary" onPress={() => void startRecording()} />
            <Button label="Cancelar" variant="ghost" onPress={close} />
          </>
        )}
        {(error ?? recorder.error) ? <AppText className="text-app-danger">{error ?? recorder.error}</AppText> : null}
      </View>
    </Sheet>
  );
}
