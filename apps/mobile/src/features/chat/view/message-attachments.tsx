import { memo, useEffect, useState } from 'react';
import { Image, Modal, Pressable, Text, View } from 'react-native';
import type { TChatAttachment } from '@/services/api/contract';
import { attachmentStatusText, formatBytes } from '../viewmodel/attachments';
import { useChatStore } from '../viewmodel/useChatStore';
import { KIND_GLYPH } from './attachment-chip';

type Source = { uri: string; headers: Record<string, string> };

/** The signed `<Image source>` for a sent image: the store signs one DPoP proof per load. */
function useAttachmentSource(id: string): Source | null {
  const attachmentSource = useChatStore((s) => s.attachmentSource);
  const [source, setSource] = useState<Source | null>(null);
  useEffect(() => {
    let live = true;
    attachmentSource(id)
      .then((s) => live && setSource(s))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [attachmentSource, id]);
  return source;
}

function AuthImage({ attachment, className, resizeMode }: { attachment: TChatAttachment; className: string; resizeMode: 'cover' | 'contain' }) {
  const source = useAttachmentSource(attachment.id);
  if (!source) return <View className={`${className} bg-app-surface2`} />;
  return <Image source={source} accessibilityLabel={attachment.name} resizeMode={resizeMode} className={className} />;
}

/**
 * What the person sent with a message (spec 2026-09-26 §5.6): an image as a thumbnail that opens full
 * screen; every other kind as its name, size and status — opening a file on the phone is out of scope.
 * The size, the `·` and the status are separate `Text`s, so each reads as exactly its own text.
 */
export const MessageAttachments = memo(function MessageAttachments({ attachments }: { attachments: TChatAttachment[] }) {
  const [viewing, setViewing] = useState<TChatAttachment | null>(null);
  return (
    <View className="mt-2 gap-2">
      {attachments.map((a) => {
        if (a.kind === 'image') {
          return (
            <Pressable key={a.id} accessibilityRole="button" accessibilityLabel={`Abrir imagem ${a.name}`} onPress={() => setViewing(a)}>
              <AuthImage attachment={a} className="h-40 w-40 rounded-lg" resizeMode="cover" />
            </Pressable>
          );
        }
        const status = attachmentStatusText(a);
        const tone = a.status === 'failed' ? 'text-app-danger' : 'text-white/70';
        return (
          <View key={a.id} className="flex-row items-center gap-2 rounded-lg bg-black/10 px-2 py-1">
            <Text className="text-base">{KIND_GLYPH[a.kind] ?? '📎'}</Text>
            <View className="shrink">
              <Text className="text-sm text-white" numberOfLines={1}>
                {a.name}
              </Text>
              <View className="flex-row items-center gap-1">
                <Text className={`text-xs ${tone}`}>{formatBytes(a.bytes)}</Text>
                {status ? (
                  <>
                    <Text className={`text-xs ${tone}`}>·</Text>
                    <Text className={`text-xs ${tone}`}>{status}</Text>
                  </>
                ) : null}
              </View>
            </View>
          </View>
        );
      })}
      <Modal visible={viewing !== null} transparent animationType="fade" onRequestClose={() => setViewing(null)}>
        <Pressable className="flex-1 items-center justify-center bg-black/95" accessibilityRole="button" accessibilityLabel="Fechar imagem" onPress={() => setViewing(null)}>
          {viewing ? <AuthImage attachment={viewing} className="h-full w-full" resizeMode="contain" /> : null}
        </Pressable>
      </Modal>
    </View>
  );
});
