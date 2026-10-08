import { useState, type ReactNode } from 'react';
import { Pressable, View } from 'react-native';
import { useTranslation } from '@/i18n';
import { AppText, Icon } from '@/ui';
import { actionTrailSummary } from '../model/action-trail';
import type { ChatAction } from '../model/types';

type Props = { actions: ChatAction[]; renderAction(action: ChatAction): ReactNode };

/** Whether a trail is open, by its first action's id, outside the component: the list recycles rows
 * and remounts one whose key moves, and a trail the person opened must not snap shut. */
const opened = new Set<string>();

/**
 * A turn's settled gate cards as one accordion above its answer (TER-1024), like the web's
 * `ChatActionTrail`: closed by default, one line says how many, how they ended and what they did, and a
 * tap opens the cards as they always read. Only settled cards land here (`groupSettledActions`): a
 * pending card, a tab's question or permission stays in the thread on its own.
 */
export function ActionTrailCard({ actions, renderAction }: Props) {
  const { t } = useTranslation();
  const id = actions[0]!.id;
  const [open, setOpen] = useState(() => opened.has(id));
  const toggle = () => {
    if (open) opened.delete(id);
    else opened.add(id);
    setOpen(!open);
  };
  const summary = actionTrailSummary(actions);
  return (
    <View className="gap-3">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={summary}
        accessibilityHint={open ? t('Recolher') : t('Ver ações')}
        accessibilityState={{ expanded: open }}
        onPress={toggle}
        className="flex-row items-center gap-2 self-start rounded-xl border border-app-border px-3 py-2"
      >
        <Icon name={open ? { ios: 'chevron.down', android: 'expand_more' } : { ios: 'chevron.right', android: 'chevron_right' }} size={12} tone="muted" />
        <AppText variant="muted" className="shrink" numberOfLines={2}>
          {summary}
        </AppText>
      </Pressable>
      {open ? actions.map((a) => <View key={a.id}>{renderAction(a)}</View>) : null}
    </View>
  );
}
