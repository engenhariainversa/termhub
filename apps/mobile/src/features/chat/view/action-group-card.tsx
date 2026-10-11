import { memo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { useTranslation } from '@/i18n';
import { AppText, Button, Icon } from '@/ui';
import type { ChatAction } from '../model/types';

type Decision = { id: string; decision: 'approve' | 'deny' };
type Props = { actions: ChatAction[]; busy: boolean; onDecide(d: Decision[]): void; onShowSeparately(): void };

/** The person's own ticks, by action id, outside the component (TER-530). What is left unticked is
 * denied, so a selection that fell back to the defaults would turn every irreversible card the person
 * had ticked into a refusal on the next tap. The group remounts whenever its list key moves (a new
 * pending card, a card brought back to the end of the thread) or the list recycles it; the ticks must not. */
const chosen = new Map<string, boolean>();

/** Several pending confirmations as one (spec 2026-09-26 §7.1), like the web's `ChatActionGroup`:
 * writes start checked, irreversible ones unchecked, and what is left unchecked is denied. Approving
 * asks for the PIN once (the store's `decideMany`). */
export const ActionGroupCard = memo(function ActionGroupCard({ actions, busy, onDecide, onShowSeparately }: Props) {
  const { t } = useTranslation();
  const [checked, setChecked] = useState<Record<string, boolean>>(() => Object.fromEntries(actions.map((a) => [a.id, chosen.get(a.id) ?? a.class !== 'irreversible'])));
  const isChecked = (a: ChatAction) => checked[a.id] ?? chosen.get(a.id) ?? a.class !== 'irreversible';
  const toggle = (id: string, value: boolean) => {
    chosen.set(id, value);
    setChecked((prev) => ({ ...prev, [id]: value }));
  };
  const count = actions.filter(isChecked).length;
  return (
    <View className="gap-3 rounded-2xl border border-app-accent bg-app-surface2 p-4">
      <AppText variant="label">{t('{{count}} ações aguardando sua confirmação', { count: actions.length })}</AppText>
      {actions.map((a) => (
        <Pressable
          key={a.id}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: isChecked(a), disabled: busy }}
          accessibilityLabel={a.summary}
          disabled={busy}
          onPress={() => toggle(a.id, !isChecked(a))}
          className="flex-row items-start gap-2"
        >
          <Icon name={isChecked(a) ? { ios: 'checkmark.square.fill', android: 'check_box' } : { ios: 'square', android: 'check_box_outline_blank' }} tone={isChecked(a) ? 'accent' : 'muted'} />
          <View className="flex-1">
            <AppText>{a.summary}</AppText>
            {/* The subagent whose turn proposed this action (spec 2026-09-26 §4), when there is one. */}
            {a.subagent ? <AppText variant="muted">{t('Pedido pelo subagente «{{description}}»', { description: a.subagent.description })}</AppText> : null}
          </View>
          {a.class === 'irreversible' ? <AppText variant="muted">{t('irreversível')}</AppText> : null}
        </Pressable>
      ))}
      {count < actions.length ? <AppText variant="muted">{t('As desmarcadas serão recusadas.')}</AppText> : null}
      <Button label={t('Aprovar selecionadas ({{n}})', { n: count })} onPress={() => onDecide(actions.map((a) => ({ id: a.id, decision: isChecked(a) ? 'approve' : 'deny' })))} disabled={busy || count === 0} />
      <Button label={t('Recusar todas')} variant="secondary" onPress={() => onDecide(actions.map((a) => ({ id: a.id, decision: 'deny' })))} disabled={busy} />
      <Button label={t('Ver separadas')} variant="ghost" onPress={onShowSeparately} disabled={busy} />
    </View>
  );
});
