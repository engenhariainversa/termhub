import { memo } from 'react';
import { View } from 'react-native';
import { useTranslation } from '@/i18n';
import { AppText, Button } from '@/ui';
import { TAB_LIMIT_TITLE, tabLimitStatusLabel, tabLimitText } from '../model/tab-limit-text';
import type { TabLimit } from '../model/types';

type Props = {
  limit: TabLimit;
  /** This card's answer is in flight. */
  busy: boolean;
  /** Why this card's last answer did not go through (pt-BR). */
  error?: string | null;
  /** `accountId` null is "Esperar". */
  onAnswer(limitId: string, accountId: string | null): void;
};

/** A project tab stuck on its account's usage limit, on a machine that does not swap by itself (spec
 * 2026-09-30 project AI accounts §7.2), the web card's twin: one "Trocar para …" per project account
 * with room, in order, and "Esperar" — no PIN. Memoised: `onAnswer` is stable. */
export const TabLimitCard = memo(function TabLimitCard({ limit, busy, error, onAnswer }: Props) {
  const { t } = useTranslation();
  const open = limit.status === 'open';
  return (
    <View testID={`tab-limit-${limit.id}`} className="gap-3 rounded-2xl border border-app-border bg-app-surface2 p-4">
      <AppText variant="label">{t(TAB_LIMIT_TITLE)}</AppText>
      <AppText>{tabLimitText(limit)}</AppText>
      {open ? (
        <View className="gap-2">
          {limit.payload.candidates.map((c) => (
            <Button key={c.id} label={t('Trocar para {{account}}', { account: c.label })} onPress={() => onAnswer(limit.id, c.id)} disabled={busy} />
          ))}
          <Button label={t('Esperar')} variant="secondary" onPress={() => onAnswer(limit.id, null)} disabled={busy} />
        </View>
      ) : (
        <AppText variant="muted">{tabLimitStatusLabel(limit)}</AppText>
      )}
      {error ? <AppText className="text-app-danger">{error}</AppText> : null}
    </View>
  );
});
