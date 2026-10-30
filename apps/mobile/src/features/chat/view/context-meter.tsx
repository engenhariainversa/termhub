import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useTranslation } from '@/i18n';
import { AppText, Button, Sheet } from '@/ui';
import { contextDetails, contextLabel, type ContextLevel, type ContextMeter as Meter } from '../model/context';

/** No amber token in the palette: the accent marks "compact soon", danger "about to hit the window". */
const TONE: Record<ContextLevel, string> = { ok: 'text-app-muted', warn: 'text-app-accent font-semibold', full: 'text-app-danger font-semibold' };

/** "Compactar" as the meter's sheet and the conversation's settings offer it (TER-1152). */
export interface CompactControl {
  compacting: boolean;
  /** Whether a tap may start one now: a conversation with a session and a ready host. */
  canCompact: boolean;
  onCompact(): void;
}

/**
 * The exact numbers, the last compaction and "Compactar" (TER-1152), behind a confirmation: compacting
 * rewrites the session's transcript into a summary, which cannot be undone.
 */
export function ContextDetails({ meter, compact, onCompacted }: { meter: Meter; compact: CompactControl; onCompacted?: () => void }) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  return (
    <View className="gap-2">
      {contextDetails(meter).map((line) => (
        <AppText key={line} variant="muted">
          {line}
        </AppText>
      ))}
      {confirming ? (
        <>
          <AppText>{t('Compactar a conversa? O concierge resume o que foi dito até aqui para liberar contexto.')}</AppText>
          <Button
            testID="context-compact-confirm"
            label={t('Compactar agora')}
            onPress={() => {
              setConfirming(false);
              compact.onCompact();
              onCompacted?.();
            }}
          />
          <Button label={t('Cancelar')} variant="ghost" onPress={() => setConfirming(false)} />
        </>
      ) : (
        <Button
          testID="context-compact"
          label={compact.compacting ? t('Compactando…') : t('Compactar')}
          variant={meter.level === 'ok' ? 'secondary' : 'primary'}
          loading={compact.compacting}
          disabled={!compact.canCompact}
          onPress={() => setConfirming(true)}
        />
      )}
    </View>
  );
}

/**
 * The chat header's "ctx 150k/200k" (TER-1038), measured against the person's own limit when they set
 * one, "compactando…" while a compaction runs. Tapping it opens the exact numbers, the last compaction
 * and "Compactar" (TER-1152). Nothing before the first answer.
 */
export function ContextMeter({ meter, compact }: { meter: Meter | null; compact: CompactControl }) {
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
        accessibilityState={{ busy: compact.compacting }}
        hitSlop={8}
        onPress={() => setOpen(true)}
        className="px-1"
      >
        <Text className={`font-mono text-xs ${compact.compacting ? 'text-app-muted' : TONE[meter.level]}`}>{compact.compacting ? t('compactando…') : contextLabel(meter)}</Text>
      </Pressable>
      <Sheet open={open} onClose={() => setOpen(false)} title={t('Contexto da conversa')}>
        <View className="gap-2">
          <ContextDetails meter={meter} compact={compact} onCompacted={() => setOpen(false)} />
          <Button label={t('Fechar')} variant="ghost" onPress={() => setOpen(false)} />
        </View>
      </Sheet>
    </>
  );
}
