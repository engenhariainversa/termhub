import { Image, Pressable, Text, View } from 'react-native';
import { useTranslation } from '@/i18n';
import { Icon, type IconName } from '@/ui';
import { attachmentStatusText, formatBytes, type DraftAttachment } from '../viewmodel/attachments';

/** One symbol per kind, and the paperclip for a kind the list does not know. */
export const KIND_ICON: Record<string, IconName> = {
  image: { ios: 'photo', android: 'image' },
  pdf: { ios: 'doc.richtext', android: 'picture_as_pdf' },
  docx: { ios: 'doc.text', android: 'description' },
  xlsx: { ios: 'tablecells', android: 'table_chart' },
  audio: { ios: 'waveform', android: 'graphic_eq' },
  video: { ios: 'film', android: 'movie' },
  text: { ios: 'doc.plaintext', android: 'article' },
};
export const ATTACHMENT_ICON: IconName = { ios: 'paperclip', android: 'attach_file' };

/** One file in the box: thumbnail or symbol, name, size, and what is happening to it. ✕ in every state.
 * Each piece of the second line is its own `Text` (the `·` too), so a size, a status or an error reads
 * as exactly that text. */
export function AttachmentChip({ draft, onRemove, onRetry }: { draft: DraftAttachment; onRemove(): void; onRetry(): void }) {
  const { t } = useTranslation();
  const status = draft.phase === 'uploaded' && draft.attachment ? attachmentStatusText(draft.attachment) : null;
  const details: Array<{ key: string; text: string; tone: 'muted' | 'danger' }> = [];
  if (draft.file.bytes !== null) details.push({ key: 'size', text: formatBytes(draft.file.bytes), tone: 'muted' });
  if (draft.phase === 'uploading') details.push({ key: 'progress', text: t('enviando… {{percent}}%', { percent: Math.round(draft.progress * 100) }), tone: 'muted' });
  if (status) details.push({ key: 'status', text: status, tone: 'muted' });
  if (draft.phase === 'failed' && draft.error) details.push({ key: 'error', text: draft.error, tone: 'danger' });
  return (
    <View className={`max-w-full flex-row items-center gap-2 rounded-xl border px-2 py-1 ${draft.phase === 'failed' ? 'border-app-danger' : 'border-app-border bg-app-surface2'}`}>
      {draft.kind === 'image' ? (
        <Image source={{ uri: draft.file.uri }} accessibilityLabel={draft.file.name} className="h-9 w-9 rounded" />
      ) : (
        <Icon name={(draft.kind && KIND_ICON[draft.kind]) || ATTACHMENT_ICON} size={22} tone="muted" />
      )}
      <View className="shrink">
        <Text className="text-sm text-app-text" numberOfLines={1}>
          {draft.file.name}
        </Text>
        <View className="flex-row flex-wrap items-center gap-1">
          {details.map((d, i) => (
            <View key={d.key} className="flex-row items-center gap-1">
              {i > 0 ? <Text className="text-xs text-app-muted">·</Text> : null}
              <Text className={`text-xs ${d.tone === 'danger' ? 'text-app-danger' : 'text-app-muted'}`}>{d.text}</Text>
            </View>
          ))}
          {draft.phase === 'failed' && !draft.refused ? (
            <Pressable accessibilityRole="button" onPress={onRetry}>
              <Text className="text-xs text-app-accent">{t('tentar de novo')}</Text>
            </Pressable>
          ) : null}
        </View>
        {draft.phase === 'uploading' ? (
          <View className="mt-1 h-1 w-full overflow-hidden rounded bg-app-border">
            <View className="h-1 bg-app-accent" style={{ width: `${Math.round(draft.progress * 100)}%` }} />
          </View>
        ) : null}
      </View>
      <Pressable accessibilityRole="button" accessibilityLabel={t('Remover {{name}}', { name: draft.file.name })} onPress={onRemove} hitSlop={8} className="px-1">
        <Icon name={{ ios: 'xmark', android: 'close' }} size={14} tone="muted" />
      </Pressable>
    </View>
  );
}
