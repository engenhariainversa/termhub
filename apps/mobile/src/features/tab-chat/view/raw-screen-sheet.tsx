import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, View } from 'react-native';
import { useTranslation } from '@/i18n';
import { Button, Sheet } from '@/ui';
import { TAB_CHAT_MSG } from '../model/messages';
import { MONOSPACE } from './tools-row';

/** "Ver tela" (spec 2026-10-01 tab chat §6): the tab's pane as plain text, in monospace, scrolled
 * sideways rather than wrapped, with "Atualizar". Read when opened, never kept. */
export function RawScreenSheet({ open, onClose, load }: { open: boolean; onClose(): void; load(): Promise<string | null> }) {
  const { t } = useTranslation();
  const [text, setText] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    const next = await load();
    setLoading(false);
    setFailed(next === null);
    setText(next);
  }, [load]);

  useEffect(() => {
    if (!open) {
      setText(null);
      setFailed(false);
      return;
    }
    void refresh();
  }, [open, refresh]);

  return (
    <Sheet open={open} onClose={onClose} title={t('Tela')}>
      <View className="gap-3">
        {failed ? <Text className="text-sm text-app-danger">{TAB_CHAT_MSG.screenFailed}</Text> : null}
        {text !== null ? (
          <ScrollView style={{ maxHeight: 360 }} className="rounded-lg bg-app-bg">
            <ScrollView horizontal contentContainerClassName="p-3">
              <Text style={{ fontFamily: MONOSPACE, fontSize: 11, lineHeight: 15 }} className="text-app-text">
                {text}
              </Text>
            </ScrollView>
          </ScrollView>
        ) : loading ? (
          <ActivityIndicator />
        ) : null}
        <Button label={t('Atualizar')} variant="secondary" onPress={() => void refresh()} loading={loading && text !== null} />
        <Button label={t('Fechar')} variant="ghost" onPress={onClose} />
      </View>
    </Sheet>
  );
}
