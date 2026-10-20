import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useTranslation } from '@/i18n';
import { AppText, Button, Sheet } from '@/ui';
import { contextDetails, contextLabel, type ContextLevel, type ContextMeter as Meter } from '../model/context';

/** No amber token in the palette: the accent marks "compact soon", danger "about to hit the window". */
const TONE: Record<ContextLevel, string> = { ok: 'text-app-muted', warn: 'text-app-accent font-semibold', full: 'text-app-danger font-semibold' };

/**
 * The chat header's "ctx 150k/200k" (TER-1038), measured against the person's own limit when they set
 * one. Tapping it opens the exact numbers and the last compaction. Nothing before the first answer.
 */
export function ContextMeter({ meter }: { meter: Meter | null }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  if (!meter) return null;
  const pct = meter.share === null ? null : `${Math.round(meter.share * 100)}%`;
  return (
    <>
      <Pressable
        testID="context-meter"
        accessibilityRole="button"
        accessibilityLabel={pct === null ? t('Contexto da conversa') : t('{{share}} do contexto', { share: pct })}
        hitSlop={8}
        onPress={() => setOpen(true)}
        className="px-1"
      >
        <Text className={`font-mono text-xs ${TONE[meter.level]}`}>{contextLabel(meter)}</Text>
      </Pressable>
      <Sheet open={open} onClose={() => setOpen(false)} title={t('Contexto da conversa')}>
        <View className="gap-2">
          {contextDetails(meter).map((line) => (
            <AppText key={line} variant="muted">
              {line}
            </AppText>
          ))}
          <Button label={t('Fechar')} variant="ghost" onPress={() => setOpen(false)} />
        </View>
      </Sheet>
    </>
  );
}
