import { useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { useTranslation } from '@/i18n';
import { MODEL_RE, type TTabAgentOptions } from '@/services/api/contract';
import { AppText, Button } from '@/ui';
import { SessionModelPicker } from './session-model-picker';

/** The CLI an account's agent runs: a provider this build does not know reads as itself. */
const cliOf = (provider: string): string => (provider === 'claude' ? 'Claude Code' : provider === 'chatgpt' ? 'Codex' : provider);

/**
 * "Iniciar sessão" under the empty conversation of a plain shell (TER-1094). With an account the server
 * suggests, the model can be chosen before starting; "Escolher outra conta" changes that selection.
 * Without a suggestion, choosing an account first reveals its model picker and start button.
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
  onStart(accountId?: string, model?: string): void;
}) {
  const { t } = useTranslation();
  const [choosing, setChoosing] = useState(false);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [model, setModel] = useState('');
  const errorLine = error ? <Text className="text-center text-xs text-app-danger">{error}</Text> : null;
  if (!options) return optionsError ? <Text className="text-center text-xs text-app-danger">{optionsError}</Text> : <ActivityIndicator />;
  if (options.choices.length === 0)
    return (
      <AppText variant="muted" className="text-center">
        {t('Nenhuma conta de IA nesta máquina pode iniciar um agente. Cadastre uma em Contas de IA.')}
      </AppText>
    );

  const selected = options.choices.find((c) => c.account_id === (accountId ?? options.suggested)) ?? null;
  const valid = model.trim() === '' || MODEL_RE.test(model.trim());
  return (
    <View className="gap-3">
      {selected ? (
        <>
          <AppText variant="muted" className="text-center text-xs">
            {t('Com {{account}} ({{cli}})', { account: selected.label, cli: cliOf(selected.provider) })}
          </AppText>
          <SessionModelPicker provider={selected.provider} defaultModel={selected.model} value={model} onChange={setModel} disabled={starting} />
          <Button testID="session-start-agent" label={t('Iniciar sessão')} onPress={() => onStart(model.trim() ? selected.account_id : accountId ?? undefined, model.trim() || undefined)} loading={starting} disabled={!valid || starting} />
        </>
      ) : null}
      {!selected || choosing ? options.choices.map((c) => (
        <Button key={c.account_id} testID={`session-start-agent-${c.account_id}`} variant="secondary"
          label={t('Com {{account}} ({{cli}})', { account: c.label, cli: cliOf(c.provider) })}
          onPress={() => { setAccountId(c.account_id); setModel(''); setChoosing(false); }} disabled={starting} />
      )) : options.choices.length > 1 ? (
        <Button testID="session-choose-account" variant="ghost" label={t('Escolher outra conta')} onPress={() => setChoosing(true)} disabled={starting} />
      ) : null}
      {errorLine}
    </View>
  );
}
