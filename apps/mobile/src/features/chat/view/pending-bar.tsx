import { memo, useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { t, useTranslation } from '@/i18n';
import { AppText, Button, Icon } from '@/ui';
import { permissionTitle, tabLabel } from '../model/tab-question-text';
import type { ChatEntry } from '../model/timeline';

/** What `POST chat/actions/decisions` takes in one call (the server refuses more). */
const BATCH_MAX = 20;

type PendingItem = {
  id: string;
  line: string;
  /** A reversible confirmation: what "Aprovar as reversíveis" approves. */
  write: boolean;
};

/** What waits on the person, in thread order (spec 2026-09-30 §2.1): pending confirmations and open tab
 * questions and permission prompts — the web's `pendingItems`. Suggestions never need an answer, so
 * they are not counted. */
function pendingItems(entries: ChatEntry[]): PendingItem[] {
  return entries.flatMap((e): PendingItem[] => {
    if (e.kind === 'action') return e.action.status === 'pending' ? [{ id: e.action.id, line: e.action.summary, write: e.action.class === 'write' }] : [];
    if (e.kind !== 'tab_question' || e.question.status !== 'open') return [];
    const q = e.question;
    const line = q.kind === 'permission' ? permissionTitle(q) : t('{{tab}} pergunta: {{question}}', { tab: tabLabel(q), question: q.payload.questions[0]?.question ?? '' });
    return [{ id: q.id, line, write: false }];
  });
}

type Props = {
  /** The thread before grouping (`chatTimeline`): its order is the list's. */
  entries: ChatEntry[];
  /** A decision is in flight (the store's `decidingId`). */
  deciding: boolean;
  /** Scrolls the thread to the card of this action or question id. */
  onJump(id: string): void;
  /** "Aprovar as reversíveis": approves these ids through the batch call, leaving the rest pending. */
  onApprove(ids: string[]): void;
};

/**
 * "N pendentes", right above the composer (TER-477): what waits on the person, however far up the
 * thread it sits. Expanded, a line scrolls the thread to its card and folds the bar again; the card
 * stays where it is, the one place it is answered. With two or more pending writes it offers to
 * approve them all at once (`write` needs no PIN, TER-92); irreversible ones stay pending. Hidden
 * while nothing waits.
 */
export const PendingBar = memo(function PendingBar({ entries, deciding, onJump, onApprove }: Props) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  // The lines are composed in the current language: rebuilt when it changes.
  const items = useMemo(() => pendingItems(entries), [entries, i18n.language]);
  if (items.length === 0) return null;
  const writes = items.filter((i) => i.write).slice(0, BATCH_MAX);
  const count = t('{{count}} pendentes', { count: items.length });
  return (
    <View testID="pending-bar" className="gap-1 border-t border-app-border px-4 py-2">
      <Pressable accessibilityRole="button" accessibilityLabel={count} accessibilityState={{ expanded: open }} onPress={() => setOpen((o) => !o)} className="flex-row items-center gap-2 py-1">
        <AppText className="flex-1 text-sm font-semibold text-app-accent">{count}</AppText>
        <Icon name={open ? { ios: 'chevron.down', android: 'expand_more' } : { ios: 'chevron.up', android: 'expand_less' }} size={16} tone="muted" />
      </Pressable>
      {open ? (
        <View className="gap-1">
          {items.map((item) => (
            <Pressable
              key={item.id}
              accessibilityRole="button"
              onPress={() => {
                setOpen(false);
                onJump(item.id);
              }}
              className="py-1.5"
            >
              <AppText variant="muted" numberOfLines={1}>
                {item.line}
              </AppText>
            </Pressable>
          ))}
          {writes.length >= 2 ? <Button label={t('Aprovar as reversíveis ({{n}})', { n: writes.length })} variant="secondary" onPress={() => onApprove(writes.map((w) => w.id))} disabled={deciding} /> : null}
        </View>
      ) : null}
    </View>
  );
});
