import { useState } from 'react';
import { View } from 'react-native';
import { useTranslation } from '@/i18n';
import { AppText, Button, Sheet } from '@/ui';

export type SessionMenuChoice = 'clear' | 'compact' | 'cycle_mode' | 'screen';

/** The session's menu (spec 2026-10-01 tab chat §6). "Limpar conversa" asks first: the session forgets. A Codex tab
 * (`agent`, TER-1102) has no "Alternar modo": it reads Claude Code's permission mode off its footer. */
export function SessionMenu({ open, onClose, onChoose, agent = null }: { open: boolean; onClose(): void; onChoose(choice: SessionMenuChoice): void; agent?: string | null }) {
  const codex = agent === 'codex';
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const choose = (choice: SessionMenuChoice) => {
    onClose();
    onChoose(choice);
  };
  return (
    <>
      <Sheet open={open} onClose={onClose} title={t('Sessão')}>
        <View className="gap-2">
          <Button
            label={t('Limpar conversa (/clear)')}
            variant="secondary"
            onPress={() => {
              onClose();
              setConfirming(true);
            }}
          />
          <Button label={t('Compactar (/compact)')} variant="secondary" onPress={() => choose('compact')} />
          {codex ? null : <Button label={t('Alternar modo')} variant="secondary" onPress={() => choose('cycle_mode')} />}
          <Button label={t('Ver tela')} variant="secondary" onPress={() => choose('screen')} />
          <Button label={t('Cancelar')} variant="ghost" onPress={onClose} />
        </View>
      </Sheet>
      <Sheet open={confirming} onClose={() => setConfirming(false)} title={t('Limpar conversa')}>
        <View className="gap-3">
          <AppText variant="muted">{codex ? t('Limpar a conversa desta sessão? O Codex esquece o que foi dito até aqui.') : t('Limpar a conversa desta sessão? O Claude esquece o que foi dito até aqui.')}</AppText>
          <Button
            label={t('Limpar conversa')}
            variant="danger"
            onPress={() => {
              setConfirming(false);
              onChoose('clear');
            }}
          />
          <Button label={t('Cancelar')} variant="ghost" onPress={() => setConfirming(false)} />
        </View>
      </Sheet>
    </>
  );
}
