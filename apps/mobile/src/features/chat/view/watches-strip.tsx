import { memo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { useTranslation } from '@/i18n';
import { AppText, Icon } from '@/ui';
import { watchEventsText, watchKindLabel, watchUntilLabel } from '../model/watch-text';
import type { ChatWatch } from '../model/types';

type Props = {
  watches: ChatWatch[];
  /** "Cancelar": the row goes at once (the store puts it back if the server refuses). */
  onCancel(watchId: string): void;
  /** Defaults to now: a prop only so a test can pin the "até …" labels. */
  now?: Date;
};

/** One watch: what it follows and when it speaks up, until when, the concierge's note, and "Cancelar". */
function WatchRow({ watch, onCancel, now }: { watch: ChatWatch; onCancel(id: string): void; now: Date }) {
  const { t } = useTranslation();
  const events = watchEventsText(watch);
  const until = watchUntilLabel(watch.expires_at, now);
  const details = [events, watch.recurring ? t('Recorrente') : '', until].filter(Boolean).join(' · ');
  return (
    <View testID={`watch-${watch.id}`} className="flex-row items-start gap-3 py-1.5">
      <View className="flex-1 gap-0.5">
        {/* The kind over the target's own name: a PR's name already starts with "PR #…". */}
        <AppText variant="label">{watchKindLabel(watch.kind)}</AppText>
        <AppText className="text-sm font-semibold" numberOfLines={1}>
          {watch.label}
        </AppText>
        {details ? <AppText variant="muted">{details}</AppText> : null}
        {watch.note ? (
          <AppText variant="muted" className="text-xs" numberOfLines={2}>
            {watch.note}
          </AppText>
        ) : null}
      </View>
      {/* A raw `Pressable`, like the subagents panel's: several rows each show "Cancelar", so the
          accessibility name says which one. */}
      <Pressable
        testID={`watch-cancel-${watch.id}`}
        accessibilityRole="button"
        accessibilityLabel={t('Cancelar acompanhamento de {{label}}', { label: watch.label })}
        hitSlop={6}
        onPress={() => onCancel(watch.id)}
        className="rounded-xl bg-app-surface2 px-3 py-1.5"
      >
        <AppText className="text-sm">{t('Cancelar')}</AppText>
      </Pressable>
    </View>
  );
}

/**
 * "Acompanhando" (TER-1099), right above the composer: what the concierge was asked to keep an eye on in
 * this chat ("me avise quando…"). Folded, it names the one watch or counts them; unfolded, each row says
 * what it follows, until when, and has its own "Cancelar". Hidden while there is none.
 */
export const WatchesStrip = memo(function WatchesStrip({ watches, onCancel, now }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  if (watches.length === 0) return null;
  const first = watches[0]!;
  const title = watches.length === 1 ? t('Acompanhando: {{label}}', { label: first.label }) : t('Acompanhando ({{n}})', { n: watches.length });
  const at = now ?? new Date();
  return (
    <View testID="watches-strip" className="gap-1 border-t border-app-border px-4 py-2">
      <Pressable accessibilityRole="button" accessibilityLabel={title} accessibilityState={{ expanded: open }} onPress={() => setOpen((o) => !o)} className="flex-row items-center gap-2 py-1">
        <Icon name={{ ios: 'eye', android: 'visibility' }} size={14} tone="muted" />
        <AppText className="flex-1 text-sm font-semibold text-app-muted" numberOfLines={1}>
          {title}
        </AppText>
        <Icon name={open ? { ios: 'chevron.down', android: 'expand_more' } : { ios: 'chevron.up', android: 'expand_less' }} size={16} tone="muted" />
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
