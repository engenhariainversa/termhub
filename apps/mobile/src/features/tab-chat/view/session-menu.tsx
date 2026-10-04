import { useState } from 'react';
import { View } from 'react-native';
import { AppText, Button, Sheet } from '@/ui';

export type SessionMenuChoice = 'clear' | 'compact' | 'cycle_mode' | 'screen';

/** The session's menu (spec 2026-10-01 tab chat §6). "Limpar conversa" asks first: the session forgets. */
export function SessionMenu({ open, onClose, onChoose }: { open: boolean; onClose(): void; onChoose(choice: SessionMenuChoice): void }) {
  const [confirming, setConfirming] = useState(false);
  const choose = (choice: SessionMenuChoice) => {
    onClose();
    onChoose(choice);
  };
  return (
    <>
      <Sheet open={open} onClose={onClose} title="Sessão">
        <View className="gap-2">
          <Button
            label="Limpar conversa (/clear)"
            variant="secondary"
            onPress={() => {
              onClose();
              setConfirming(true);
            }}
          />
          <Button label="Compactar (/compact)" variant="secondary" onPress={() => choose('compact')} />
          <Button label="Alternar modo" variant="secondary" onPress={() => choose('cycle_mode')} />
          <Button label="Ver tela" variant="secondary" onPress={() => choose('screen')} />
          <Button label="Cancelar" variant="ghost" onPress={onClose} />
        </View>
      </Sheet>
      <Sheet open={confirming} onClose={() => setConfirming(false)} title="Limpar conversa">
        <View className="gap-3">
          <AppText variant="muted">Limpar a conversa desta sessão? O Claude esquece o que foi dito até aqui.</AppText>
          <Button
            label="Limpar conversa"
            variant="danger"
            onPress={() => {
              setConfirming(false);
              onChoose('clear');
            }}
          />
          <Button label="Cancelar" variant="ghost" onPress={() => setConfirming(false)} />
        </View>
      </Sheet>
    </>
  );
}
