import { Switch, View } from 'react-native';
import { useTranslation } from '@/i18n';
import type { ConciergePushSettings } from '@/services/api/contract';
import { AppText, Button } from '@/ui';
import { useSettingsStore } from '../viewmodel/useSettingsStore';

/** Quiet hours offered here (on the phone's clock); a window set on the web shows as it is. */
export const QUIET_PRESETS: { start: string; end: string }[] = [
  { start: '22:00', end: '07:00' },
  { start: '23:00', end: '08:00' },
  { start: '00:00', end: '08:00' },
];
export const GROUP_PRESETS = [0, 5, 15, 30];

/**
 * Ajustes → Notificações → "Avisos do concierge" (TER-1101): which of the concierge's notices reach the
 * phone (needs you / done; "just so you know" never does), quiet hours and the grouping of notices that come
 * close together. The same rules hold for the web. Hidden until loaded (or on a server without them).
 */
export function ConciergeNoticeSettings() {
  const { t } = useTranslation();
  const rules = useSettingsStore((s) => s.concierge);
  const save = useSettingsStore((s) => s.setConcierge);
  if (!rules) return null;
  const set = (patch: Partial<ConciergePushSettings>) => void save({ ...rules, ...patch });
  const custom = rules.quiet_start !== null && !QUIET_PRESETS.some((p) => p.start === rules.quiet_start && p.end === rules.quiet_end);
  return (
    <View className="gap-3">
      <AppText variant="label">{t('Avisos do concierge')}</AppText>
      <AppText variant="muted">{t('Quando o concierge escreve sozinho, ele avisa conforme o nível. "Só para saber" fica só no chat.')}</AppText>
      <View className="flex-row items-center justify-between">
        <AppText>{t('Precisa de você')}</AppText>
        <Switch accessibilityLabel={t('Precisa de você')} value={rules.needs_you} onValueChange={(v) => set({ needs_you: v })} />
      </View>
      <View className="flex-row items-center justify-between">
        <AppText>{t('Concluído')}</AppText>
        <Switch accessibilityLabel={t('Concluído')} value={rules.done} onValueChange={(v) => set({ done: v })} />
      </View>
      <AppText>{t('Horário de silêncio')}</AppText>
      <View className="flex-row flex-wrap gap-2">
        <Button label={t('Desligado')} variant={rules.quiet_start === null ? 'primary' : 'secondary'} onPress={() => set({ quiet_start: null, quiet_end: null })} />
        {QUIET_PRESETS.map((p) => (
          <Button
            key={p.start}
            label={`${p.start}–${p.end}`}
            variant={rules.quiet_start === p.start && rules.quiet_end === p.end ? 'primary' : 'secondary'}
            onPress={() => set({ quiet_start: p.start, quiet_end: p.end })}
          />
        ))}
      </View>
      {custom ? <AppText variant="muted">{t('Definido na web: {{start}}–{{end}}.', { start: rules.quiet_start, end: rules.quiet_end })}</AppText> : null}
      <AppText>{t('Juntar avisos em')}</AppText>
      <View className="flex-row flex-wrap gap-2">
        {GROUP_PRESETS.map((m) => (
          <Button key={m} label={m === 0 ? t('Não juntar') : t('{{count}} min', { count: m })} variant={rules.group_minutes === m ? 'primary' : 'secondary'} onPress={() => set({ group_minutes: m })} />
        ))}
      </View>
      <AppText variant="muted">{t('No seu fuso. O que chegar no silêncio, ou logo depois de um aviso, sai junto num só. "Precisa de você" não espera o agrupamento.')}</AppText>
    </View>
  );
}
