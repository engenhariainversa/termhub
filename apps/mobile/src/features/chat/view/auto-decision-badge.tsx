import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { autoDecisionSourceLine, type TAutoDecision } from '@/services/api/contract';
import { useTranslation } from '@/i18n';
import { formatNumber } from '@/i18n/format';
import { AppText } from '@/ui';
import { autoAnswerReason } from '../model/tab-question-text';

/** "Decisão automática" (TER-641) — the web's `AutoDecisionBadge`: marks what the concierge sent a tab on
 * its own, from memory. A tap toggles the detail: the reason and each cited ref with the recorded
 * question and answer, and — on an answer from memory (TER-642) — the similarity that decided it next
 * to the person's thresholds at that moment. Plain text only. */
export function AutoDecisionBadge({ decision }: { decision: TAutoDecision }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const reason = decision.by ? autoAnswerReason(decision) : decision.reason;
  const two = (value: number) => formatNumber(value, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (
    <View className="gap-1">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('Decisão automática')}
        accessibilityState={{ expanded: open }}
        accessibilityHint={t('Mostra a decisão da memória usada')}
        onPress={() => setOpen((v) => !v)}
        className="self-start rounded-full border border-app-accent bg-app-accent-soft px-2 py-0.5"
      >
        <AppText className="text-xs font-medium text-app-accent">{t('Decisão automática')}</AppText>
      </Pressable>
      {open ? (
        <View className="gap-0.5">
          {reason ? <AppText variant="muted">{t('Motivo: {{reason}}', { reason })}</AppText> : null}
          {decision.score !== undefined && decision.thresholds ? (
            <AppText variant="muted">{t('Semelhança {{score}} · limiares {{high}} / {{low}}', { score: two(decision.score), high: two(decision.thresholds.high), low: two(decision.thresholds.low) })}</AppText>
          ) : null}
          {decision.sources.length > 0 ? <AppText variant="muted">{t('Com base em:')}</AppText> : null}
          {decision.sources.map((s) => (
            <AppText key={s.ref} variant="muted">{`• ${autoDecisionSourceLine(s)} (${s.ref})`}</AppText>
          ))}
        </View>
      ) : null}
    </View>
  );
}
