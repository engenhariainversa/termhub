import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useTranslation } from '@/i18n';
import { AppText, Button, Field } from '@/ui';
import { parseContextLimit } from '../model/context';

const asText = (limit: number | null) => (limit === null ? '' : String(Math.round(limit / 1_000)));

/**
 * "Limite de contexto do chat" (TER-1038), as on the web's Memória do chat: the header's meter measures
 * against this many thousand tokens instead of the model's window. Empty = the window (the default).
 */
export function ContextLimitCard({ limit, onSave }: { limit: number | null; onSave: (limit: number | null) => Promise<boolean> }) {
  const { t } = useTranslation();
  const [text, setText] = useState(asText(limit));
  const [saving, setSaving] = useState(false);
  const [invalid, setInvalid] = useState(false);
  useEffect(() => setText(asText(limit)), [limit]);
  const parsed = parseContextLimit(text);

  const save = async () => {
    if (parsed === undefined) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setSaving(true);
    try {
      await onSave(parsed);
    } finally {
      setSaving(false);
    }
  };

  return (
    <View className="gap-2 rounded-xl border border-app-border bg-app-surface2 p-3">
      <Field
        label={t('Limite de contexto do chat (mil tokens)')}
        value={text}
        onChangeText={(v) => {
          setText(v);
          setInvalid(false);
        }}
        placeholder={t('janela')}
        keyboardType="number-pad"
        error={invalid ? t('Use um número inteiro entre 10 e 10000 (mil tokens), ou deixe vazio.') : undefined}
        testID="chat-context-limit"
      />
      <AppText variant="muted" className="text-xs">
        {t('O medidor do chat mostra o contexto da conversa contra este limite (ex.: 200 = 200 mil tokens) e avisa a partir de 80% dele; o concierge usa o mesmo número para sugerir compactar. Vazio = a janela do modelo.')}
      </AppText>
      <Button label={t('Salvar')} variant="ghost" loading={saving} disabled={parsed === limit} onPress={() => void save()} />
    </View>
  );
}
