import { Image, Pressable, Text, View } from 'react-native';
import { attachmentStatusText, formatBytes, type DraftAttachment } from '../viewmodel/attachments';

/** One glyph per kind; the web has icons, the phone a character. */
export const KIND_GLYPH: Record<string, string> = { image: '🖼', pdf: '📄', docx: '📝', xlsx: '📊', audio: '🎙', video: '🎬', text: '📃' };

/** One file in the box: thumbnail or glyph, name, size, and what is happening to it. ✕ in every state.
 * Each piece of the second line is its own `Text` (the `·` too), so a size, a status or an error reads
 * as exactly that text. */
export function AttachmentChip({ draft, onRemove, onRetry }: { draft: DraftAttachment; onRemove(): void; onRetry(): void }) {
  const status = draft.phase === 'uploaded' && draft.attachment ? attachmentStatusText(draft.attachment) : null;
  const details: Array<{ key: string; text: string; tone: 'muted' | 'danger' }> = [];
  if (draft.file.bytes !== null) details.push({ key: 'size', text: formatBytes(draft.file.bytes), tone: 'muted' });
  if (draft.phase === 'uploading') details.push({ key: 'progress', text: `enviando… ${Math.round(draft.progress * 100)}%`, tone: 'muted' });
  if (status) details.push({ key: 'status', text: status, tone: 'muted' });
  if (draft.phase === 'failed' && draft.error) details.push({ key: 'error', text: draft.error, tone: 'danger' });
  return (
    <View className={`max-w-full flex-row items-center gap-2 rounded-xl border px-2 py-1 ${draft.phase === 'failed' ? 'border-app-danger' : 'border-app-border bg-app-surface2'}`}>
      {draft.kind === 'image' ? (
        <Image source={{ uri: draft.file.uri }} accessibilityLabel={draft.file.name} className="h-9 w-9 rounded" />
      ) : (
        <Text className="text-lg">{(draft.kind && KIND_GLYPH[draft.kind]) ?? '📎'}</Text>
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
              <Text className="text-xs text-app-accent">tentar de novo</Text>
            </Pressable>
          ) : null}
        </View>
        {draft.phase === 'uploading' ? (
          <View className="mt-1 h-1 w-full overflow-hidden rounded bg-app-border">
            <View className="h-1 bg-app-accent" style={{ width: `${Math.round(draft.progress * 100)}%` }} />
          </View>
        ) : null}
      </View>
      <Pressable accessibilityRole="button" accessibilityLabel={`Remover ${draft.file.name}`} onPress={onRemove} hitSlop={8} className="px-1">
        <Text className="text-base text-app-muted">✕</Text>
      </Pressable>
    </View>
  );
}
