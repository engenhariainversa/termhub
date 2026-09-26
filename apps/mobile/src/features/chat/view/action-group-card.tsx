import { memo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { AppText, Button } from '@/ui';
import type { ChatAction } from '../model/types';

type Decision = { id: string; decision: 'approve' | 'deny' };
type Props = { actions: ChatAction[]; busy: boolean; onDecide(d: Decision[]): void; onShowSeparately(): void };

/** Several pending confirmations as one (spec 2026-09-26 §7.1), like the web's `ChatActionGroup`:
 * writes start checked, irreversible ones unchecked, and what is left unchecked is denied. Approving
 * asks for the PIN once (the store's `decideMany`). */
export const ActionGroupCard = memo(function ActionGroupCard({ actions, busy, onDecide, onShowSeparately }: Props) {
  const [checked, setChecked] = useState<Record<string, boolean>>(() => Object.fromEntries(actions.map((a) => [a.id, a.class !== 'irreversible'])));
  const isChecked = (a: ChatAction) => checked[a.id] ?? a.class !== 'irreversible';
  const count = actions.filter(isChecked).length;
  return (
    <View className="gap-3 rounded-2xl border border-app-accent bg-app-surface2 p-4">
      <AppText variant="label">{`${actions.length} ações aguardando sua confirmação`}</AppText>
      {actions.map((a) => (
        <Pressable
          key={a.id}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: isChecked(a), disabled: busy }}
          accessibilityLabel={a.summary}
          disabled={busy}
          onPress={() => setChecked((prev) => ({ ...prev, [a.id]: !isChecked(a) }))}
          className="flex-row items-start gap-2"
        >
          <AppText>{isChecked(a) ? '☑' : '☐'}</AppText>
          <AppText className="flex-1">{a.summary}</AppText>
          {a.class === 'irreversible' ? <AppText variant="muted">irreversível</AppText> : null}
        </Pressable>
      ))}
      {count < actions.length ? <AppText variant="muted">As desmarcadas serão recusadas.</AppText> : null}
      <Button label={`Aprovar selecionadas (${count})`} onPress={() => onDecide(actions.map((a) => ({ id: a.id, decision: isChecked(a) ? 'approve' : 'deny' })))} disabled={busy || count === 0} />
      <Button label="Recusar todas" variant="secondary" onPress={() => onDecide(actions.map((a) => ({ id: a.id, decision: 'deny' })))} disabled={busy} />
      <Button label="Ver separadas" variant="ghost" onPress={onShowSeparately} disabled={busy} />
    </View>
  );
});
