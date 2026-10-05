import { memo, useEffect, useReducer, useState } from 'react';
import { Image, Modal, Pressable, Text, View } from 'react-native';
import type { TChatAttachment } from '@/services/api/contract';
import { useTranslation } from '@/i18n';
import { Icon } from '@/ui';
import { attachmentStatusText, formatBytes, thumbSize } from '../viewmodel/attachments';
import { useChatStore } from '../viewmodel/useChatStore';
import { ATTACHMENT_ICON, KIND_ICON } from './attachment-chip';

type Source = { uri: string; headers: Record<string, string> };

/** The signed `<Image source>` for a sent image: the store signs one DPoP proof per `attempt`, with the
 * token it holds then. `null` while a proof is being signed. A source is tied to the attempt it was
 * signed for and read during render, so a new attempt never mounts the previous, already used proof. */
export function useAttachmentSource(id: string, attempt: number): Source | null {
  const attachmentSource = useChatStore((s) => s.attachmentSource);
  const [signed, setSigned] = useState<{ id: string; attempt: number; source: Source } | null>(null);
  useEffect(() => {
    let live = true;
    attachmentSource(id)
      .then((source) => live && setSigned({ id, attempt, source }))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [attachmentSource, id, attempt]);
  return signed && signed.id === id && signed.attempt === attempt ? signed.source : null;
}

/** How many loads failed, and which signed source is on screen. */
type LoadState = { attempt: number; errors: number };
type LoadAction = 'error' | 'reload';

/** A proof is single-use and lives ±60 s: the first failure (an expired token, a stale proof, a blip) is
 * retried once with a fresh one on its own; a second failure waits for a tap, so a dead link never loops. */
function loadReducer(s: LoadState, action: LoadAction): LoadState {
  if (action === 'reload') return { attempt: s.attempt + 1, errors: s.errors };
  const errors = s.errors + 1;
  return { attempt: errors === 1 ? s.attempt + 1 : s.attempt, errors };
}

/** The thumbnail's box (`h-40 w-40`), and its smallest side once the size is known (a tappable reload). */
const THUMB_BOX = 160;
const THUMB_MIN = 64;

type Size = { width: number; height: number };

function AuthImage({ attachment, className, resizeMode, size }: { attachment: TChatAttachment; className: string; resizeMode: 'cover' | 'contain'; size?: Size | null }) {
  const { t } = useTranslation();
  const [load, dispatch] = useReducer(loadReducer, { attempt: 0, errors: 0 });
  const source = useAttachmentSource(attachment.id, load.attempt);
  const stuck = load.errors >= 2 && load.attempt < load.errors;
  // Every state takes the same box, so the row never changes size when the image arrives (TER-197).
  const style = size ?? undefined;
  if (stuck) {
    return (
      <Pressable accessibilityRole="button" accessibilityLabel={t('Toque para recarregar')} onPress={() => dispatch('reload')} className={`${className} items-center justify-center bg-app-surface2`} style={style}>
        <Text className="text-xs text-app-muted">{t('Toque para recarregar')}</Text>
      </Pressable>
    );
  }
  if (!source) return <View testID="attachment-placeholder" className={`${className} bg-app-surface2`} style={style} />;
  return <Image source={source} accessibilityLabel={attachment.name} resizeMode={resizeMode} className={className} style={style} onError={() => dispatch('error')} />;
}

/**
 * What the person sent with a message (spec 2026-09-26 §5.6): an image as a thumbnail that opens full
 * screen; every other kind as its name, size and status — opening a file on the phone is out of scope.
 * The size, the `·` and the status are separate `Text`s, so each reads as exactly its own text.
 */
export const MessageAttachments = memo(function MessageAttachments({ attachments }: { attachments: TChatAttachment[] }) {
  const { t } = useTranslation();
  const [viewing, setViewing] = useState<TChatAttachment | null>(null);
  return (
    <View className="mt-2 gap-2">
      {attachments.map((a) => {
        if (a.kind === 'image') {
          return (
            <Pressable key={a.id} accessibilityRole="button" accessibilityLabel={t('Abrir imagem {{name}}', { name: a.name })} onPress={() => setViewing(a)}>
              <AuthImage attachment={a} className="h-40 w-40 rounded-lg" resizeMode="cover" size={thumbSize(a.meta, THUMB_BOX, THUMB_MIN)} />
            </Pressable>
          );
        }
        const status = attachmentStatusText(a);
        const tone = a.status === 'failed' ? 'text-app-danger' : 'text-white/70';
        return (
          <View key={a.id} className="flex-row items-center gap-2 rounded-lg bg-black/10 px-2 py-1">
            <Icon name={KIND_ICON[a.kind] ?? ATTACHMENT_ICON} size={18} color="rgba(255,255,255,0.85)" />
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
        <Pressable className="flex-1 items-center justify-center bg-black/95" accessibilityRole="button" accessibilityLabel={t('Fechar imagem')} onPress={() => setViewing(null)}>
          {viewing ? <AuthImage attachment={viewing} className="h-full w-full" resizeMode="contain" /> : null}
        </Pressable>
      </Modal>
    </View>
  );
});
