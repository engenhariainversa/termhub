import { useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { useTranslation } from '@/i18n';
import type { TTabAgentChoice, TTabAgentOptions } from '@/services/api/contract';
import { AppText, Button } from '@/ui';
import { cliOf, modelText } from '../model/started-agent';

/** One choice of the picker: a chip that reads as selected. */
function Choice({ label, selected, disabled, testID, onPress }: { label: string; selected: boolean; disabled: boolean; testID: string; onPress(): void }) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      className={`rounded-xl border px-4 py-2.5 ${selected ? 'border-app-accent bg-app-surface2' : 'border-app-border bg-app-surface'}`}
    >
      <Text className={`text-base ${selected ? 'font-semibold text-app-accent' : 'text-app-text'}`}>{label}</Text>
    </Pressable>
  );
}

/**
 * No rule picks the account (TER-1104): the CLI (when there are several), the account of that CLI (when
 * it has several) and the model it starts with, preselected on the project's CLI (the server's `provider`,
 * else the first choice's). Nothing starts until the person presses "Iniciar sessão".
 */
function ChooseAgent({ options, starting, onStart }: { options: TTabAgentOptions; starting: boolean; onStart(accountId: string): void }) {
  const { t } = useTranslation();
  const { choices } = options;
  const preselected = choices.find((c) => c.provider === options.provider) ?? choices[0]!;
  const [picked, setPicked] = useState(preselected.account_id);
  const choice = choices.find((c) => c.account_id === picked) ?? preselected;
  const clis = [...new Set(choices.map((c) => c.provider))];
  const ofCli = choices.filter((c) => c.provider === choice.provider);
  return (
    <View testID="session-choose-agent" className="gap-3">
      <AppText variant="muted" className="text-center">
        {t('Escolha com qual agente iniciar a sessão:')}
      </AppText>
      {clis.length > 1 ? (
        <View className="flex-row flex-wrap justify-center gap-2">
          {clis.map((cli) => (
            <Choice key={cli} testID={`session-cli-${cli}`} label={cliOf(cli)} selected={cli === choice.provider} disabled={starting} onPress={() => setPicked(choices.find((c) => c.provider === cli)!.account_id)} />
          ))}
        </View>
      ) : null}
      {ofCli.length > 1 ? (
        <View className="flex-row flex-wrap justify-center gap-2">
          {ofCli.map((c) => (
            <Choice key={c.account_id} testID={`session-account-${c.account_id}`} label={c.label} selected={c.account_id === choice.account_id} disabled={starting} onPress={() => setPicked(c.account_id)} />
          ))}
        </View>
      ) : (
        <AppText variant="muted" className="text-center text-xs">
          {t('Conta {{account}}', { account: choice.label })}
        </AppText>
      )}
      <AppText variant="muted" className="text-center text-xs">
        {t('Modelo: {{model}}', { model: modelText(choice.model) })}
      </AppText>
      <Button testID="session-start-chosen" label={t('Iniciar sessão')} onPress={() => onStart(choice.account_id)} loading={starting} />
    </View>
  );
}

/**
 * "Iniciar sessão" under the empty conversation of a plain shell (TER-1094). With an account the server
 * picks without asking (always of the project's CLI, TER-1104), one button names it, and "Escolher outra
 * conta" opens the rest; without one (say, a machine with both Claude and Codex), a picker asks first.
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
  if (!suggested)
    return (
      <View className="gap-2">
        <ChooseAgent options={options} starting={starting} onStart={onStart} />
        {errorLine}
      </View>
    );
  return (
    <View className="gap-2">
      <Button testID="session-start-agent" label={t('Iniciar sessão')} onPress={() => onStart()} loading={starting} />
      <AppText variant="muted" className="text-center text-xs">
        {t('Com {{account}} ({{cli}}) · modelo {{model}}', { account: suggested.label, cli: cliOf(suggested.provider), model: modelText(suggested.model) })}
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
