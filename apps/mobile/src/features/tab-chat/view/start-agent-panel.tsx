import { useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { useTranslation } from '@/i18n';
import type { TTabAgentChoice, TTabAgentOptions } from '@/services/api/contract';
import { AppText, Button } from '@/ui';

/** The CLI an account's agent runs: a provider this build does not know reads as itself. */
const cliOf = (provider: string): string => (provider === 'claude' ? 'Claude Code' : provider === 'chatgpt' ? 'Codex' : provider);

/**
 * "Iniciar sessão" under the empty conversation of a plain shell (TER-1094). With an account the server
 * picks without asking, one button names it, and "Escolher outra conta" opens the rest; without one (say,
 * a machine with both Claude and Codex), each account is its own button.
 */
export function StartAgentPanel({
  options,
  optionsError,
  starting,
  error,
  onStart,
}: {
  options: TTabAgentOptions | null;
  optionsError: string | null;
  starting: boolean;
  error: string | null;
  onStart(accountId?: string): void;
}) {
  const { t } = useTranslation();
  const [choosing, setChoosing] = useState(false);
  const errorLine = error ? <Text className="text-center text-xs text-app-danger">{error}</Text> : null;
  if (!options) return optionsError ? <Text className="text-center text-xs text-app-danger">{optionsError}</Text> : <ActivityIndicator />;
  if (options.choices.length === 0)
    return (
      <AppText variant="muted" className="text-center">
        {t('Nenhuma conta de IA nesta máquina pode iniciar um agente. Cadastre uma em Contas de IA.')}
      </AppText>
    );

  const suggested = options.choices.find((c) => c.account_id === options.suggested) ?? null;
  const choiceButton = (c: TTabAgentChoice) => (
    <Button
      key={c.account_id}
      testID={`session-start-agent-${c.account_id}`}
      variant="secondary"
      label={t('Iniciar com {{account}} ({{cli}})', { account: c.label, cli: cliOf(c.provider) })}
      onPress={() => onStart(c.account_id)}
      disabled={starting}
    />
  );
  if (!suggested) return <View className="gap-2">{options.choices.map(choiceButton)}{errorLine}</View>;
  return (
    <View className="gap-2">
      <Button testID="session-start-agent" label={t('Iniciar sessão')} onPress={() => onStart()} loading={starting} />
      <AppText variant="muted" className="text-center text-xs">
        {t('Com {{account}} ({{cli}})', { account: suggested.label, cli: cliOf(suggested.provider) })}
      </AppText>
      {options.choices.length > 1 ? (
        choosing ? (
          options.choices.filter((c) => c !== suggested).map(choiceButton)
        ) : (
          <Button testID="session-choose-account" variant="ghost" label={t('Escolher outra conta')} onPress={() => setChoosing(true)} />
        )
      ) : null}
      {errorLine}
    </View>
  );
}
