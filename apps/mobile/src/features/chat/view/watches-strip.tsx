import { memo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { useTranslation } from '@/i18n';
import { AppText, Icon } from '@/ui';
import { watchDetails, watchHeadline, watchStatus } from '../model/watch-text';
import type { ChatWatch } from '../model/types';

type Props = {
  watches: ChatWatch[];
  /** "Cancelar": the row goes at once (the store puts it back if the server refuses). */
  onCancel(watchId: string): void;
  /** Defaults to now: a prop only so a test can pin the times. */
  now?: Date;
};

/** One watch: the person's line, what already happened and until when, and ✕. A press unfolds the details. */
function WatchRow({ watch, onCancel, now }: { watch: ChatWatch; onCancel(id: string): void; now: Date }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const headline = watchHeadline(watch, now);
  const status = watchStatus(watch, now);
  return (
    <View testID={`watch-${watch.id}`} className="flex-row items-center gap-2 py-1">
      <Pressable accessibilityRole="button" accessibilityLabel={headline} accessibilityState={{ expanded: open }} onPress={() => setOpen((o) => !o)} className="flex-1 flex-row items-start gap-2">
        <View className="pt-0.5">
          <Icon name={watch.kind === 'reminder' ? { ios: 'alarm', android: 'alarm' } : { ios: 'eye', android: 'visibility' }} size={14} tone="muted" />
        </View>
        <View className="flex-1">
          <AppText className="text-sm" numberOfLines={open ? undefined : 1}>
            {headline}
          </AppText>
          {status ? (
            <AppText variant="muted" className="text-xs" numberOfLines={1}>
              {status}
            </AppText>
          ) : null}
          {open ? (
            <AppText variant="muted" className="text-xs">
              {watchDetails(watch)}
            </AppText>
          ) : null}
        </View>
      </Pressable>
      {/* A raw `Pressable`, like the subagents panel's: several rows each have a ✕, so the accessibility
          name says which one. */}
      <Pressable
        testID={`watch-cancel-${watch.id}`}
        accessibilityRole="button"
        accessibilityLabel={t('Cancelar acompanhamento de {{label}}', { label: headline })}
        hitSlop={10}
        onPress={() => onCancel(watch.id)}
        className="p-1"
      >
        <Icon name={{ ios: 'xmark', android: 'close' }} size={14} tone="muted" />
      </Pressable>
    </View>
  );
}

/**
 * "Acompanhando" (TER-1099, compact since TER-1115), right above the composer: what the concierge keeps an
 * eye on in this chat. One watch is one row; several fold into "Acompanhando 3 coisas", unfolded on a
 * press. Each row is the concierge's sentence for the person (never its note), what already happened and
 * until when, with its own ✕. Hidden while there is none.
 */
export const WatchesStrip = memo(function WatchesStrip({ watches, onCancel, now }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  if (watches.length === 0) return null;
  const at = now ?? new Date();
  if (watches.length === 1)
    return (
      <View testID="watches-strip" className="border-t border-app-border px-4 py-1">
        <WatchRow watch={watches[0]!} onCancel={onCancel} now={at} />
      </View>
    );
  const title = t('Acompanhando {{count}} coisas', { count: watches.length });
  return (
    <View testID="watches-strip" className="border-t border-app-border px-4 py-1">
      <Pressable accessibilityRole="button" accessibilityLabel={title} accessibilityState={{ expanded: open }} onPress={() => setOpen((o) => !o)} className="flex-row items-center gap-2 py-1">
        <Icon name={{ ios: 'eye', android: 'visibility' }} size={14} tone="muted" />
        <AppText className="flex-1 text-sm text-app-muted" numberOfLines={1}>
          {title}
        </AppText>
        <Icon name={open ? { ios: 'chevron.down', android: 'expand_more' } : { ios: 'chevron.right', android: 'chevron_right' }} size={14} tone="muted" />
      </Pressable>
      {open ? (
        <View>
          {watches.map((w) => (
            <WatchRow key={w.id} watch={w} onCancel={onCancel} now={at} />
          ))}
        </View>
      ) : null}
    </View>
  );
});
