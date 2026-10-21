import { Pressable, Text, TextInput, View } from 'react-native';
import { useTranslation } from '@/i18n';
import { CLAUDE_MODEL_ALIASES, MODEL_ID_EXAMPLE, MODEL_RE } from '@/services/api/contract';
import { AppText } from '@/ui';

/** Empty means inherit the project. A choice only affects the session being started. */
export function SessionModelPicker({ provider, defaultModel, value, onChange, disabled = false }: {
  provider: string;
  defaultModel: string | null;
  value: string;
  onChange(value: string): void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const valid = value.trim() === '' || MODEL_RE.test(value.trim());
  return (
    <View className="gap-2">
      <AppText variant="label">{t('Modelo desta sessão')}</AppText>
      <View accessibilityRole="radiogroup" className="flex-row flex-wrap gap-2">
        {['', ...(provider === 'claude' ? CLAUDE_MODEL_ALIASES : [])].map((model) => (
          <Pressable key={model} accessibilityRole="radio" accessibilityState={{ checked: value === model, disabled }} disabled={disabled} onPress={() => onChange(model)} className={`rounded-xl border px-3 py-2 ${value === model ? 'border-app-accent bg-app-surface2' : 'border-app-border'}`}>
            <Text className="text-sm text-app-text">{model || t('Padrão do projeto')}</Text>
          </Pressable>
        ))}
      </View>
      <TextInput accessibilityLabel={t('Id do modelo')} value={value} onChangeText={onChange} editable={!disabled} autoCapitalize="none" autoCorrect={false} placeholder={defaultModel ?? MODEL_ID_EXAMPLE[provider === 'claude' ? 'claude' : 'chatgpt']} className="rounded-xl border border-app-border bg-app-surface px-4 py-3 text-base text-app-text placeholder:text-app-muted" />
      <AppText variant="muted" className="text-xs">{defaultModel ? t('Padrão do projeto: {{model}}', { model: defaultModel }) : t('Sem escolha, usa o padrão do CLI.')}</AppText>
      {!valid ? <Text className="text-sm text-app-danger">{t('Informe um id de modelo válido.')}</Text> : null}
    </View>
  );
}
