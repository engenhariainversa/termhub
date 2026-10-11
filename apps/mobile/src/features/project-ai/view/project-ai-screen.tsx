import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect } from 'react';
import { ActivityIndicator, Pressable, Switch, Text, TextInput, View } from 'react-native';
import { useTranslation } from '@/i18n';
import type { TProjectAiOption } from '@/services/api/contract';
import { AppText, Banner, Button, Screen } from '@/ui';
import {
  accountLabel,
  addAccount,
  CLAUDE_ALIASES,
  modelError,
  modelWarning,
  moveAccount,
  PROJECT_AI_MSG,
  PROVIDER_LABEL,
  providersOf,
  removeAccount,
  setModel,
  type ModelDraft,
  type Provider,
} from '../model/project-ai';
import { projectAiDeps } from '../viewmodel/deps';
import { useProjectAi } from '../viewmodel/use-project-ai';

const INPUT = 'rounded-xl border border-app-border bg-app-surface px-4 py-3 text-base text-app-text placeholder:text-app-muted';

/** A small button on an account row: a plain Pressable, named after its account for screen readers. */
function RowAction({ label, name, disabled = false, onPress }: { label: string; name: string; disabled?: boolean; onPress(): void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`${label} ${name}`} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} className={`rounded-lg border border-app-border px-3 py-2 ${disabled ? 'opacity-40' : ''}`}>
      <Text className="text-sm text-app-text">{label}</Text>
    </Pressable>
  );
}

/** One choice of a model: selected or not. */
function Choice({ label, selected, onPress }: { label: string; selected: boolean; onPress(): void }) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityState={{ selected, checked: selected }}
      onPress={onPress}
      className={`rounded-xl border px-3 py-2 ${selected ? 'border-app-accent bg-app-surface2' : 'border-app-border'}`}
    >
      <Text className={`text-sm ${selected ? 'font-semibold text-app-accent' : 'text-app-text'}`}>{label}</Text>
    </Pressable>
  );
}

function ModelChoice({ provider, model, onChange }: { provider: Provider; model: ModelDraft; onChange(patch: Partial<ModelDraft>): void }) {
  const { t } = useTranslation();
  const name = PROVIDER_LABEL[provider];
  const error = modelError(model);
  const warning = modelWarning(provider, model);
  return (
    <View className="gap-2">
      <AppText variant="label">{t('Modelo do {{name}}', { name })}</AppText>
      <View accessibilityRole="radiogroup" className="flex-row flex-wrap gap-2">
        <Choice label={t('Padrão do CLI')} selected={model.choice === 'default'} onPress={() => onChange({ choice: 'default' })} />
        {provider === 'claude' ? CLAUDE_ALIASES.map((alias) => <Choice key={alias} label={alias} selected={model.choice === alias} onPress={() => onChange({ choice: alias })} />) : null}
        <Choice label={t('Outro id…')} selected={model.choice === 'other'} onPress={() => onChange({ choice: 'other' })} />
      </View>
      {model.choice === 'other' ? (
        <TextInput
          accessibilityLabel={t('Id do modelo do {{name}}', { name })}
          value={model.other}
          onChangeText={(other) => onChange({ other })}
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={100}
          placeholder={t('id do modelo')}
          className={INPUT}
        />
      ) : null}
      {error ? <AppText className="text-app-danger">{error}</AppText> : null}
      {warning ? <AppText variant="muted">{warning}</AppText> : null}
    </View>
  );
}

/** "Contas e modelo do projeto" (spec 2026-09-30 project AI accounts §8), reached from a project chat's
 * host sheet: the project's accounts in priority order (Subir / Descer / Remover, no drag and drop), the
 * other accounts its machines offer, and the model per provider. */
export function ProjectAiView({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const router = useRouter();
  const { saved, draft, loadError, saving, saveError, notice, canSave, load, edit, save } = useProjectAi(projectId, projectAiDeps);

  useEffect(() => {
    void load();
  }, [load]);

  const available = saved?.available ?? [];
  const byId = new Map(available.map((o) => [o.id, o] as const));
  const included = (draft?.accounts ?? []).flatMap((id) => {
    const o = byId.get(id);
    return o ? [o] : [];
  });
  const others = available.filter((o) => !draft?.accounts.includes(o.id));

  return (
    <Screen scroll>
      <View className="gap-6 pb-10">
        <View className="flex-row items-center gap-2">
          <Button label={t('Voltar')} variant="ghost" onPress={() => router.back()} />
          <AppText variant="title" className="flex-1">
            {PROJECT_AI_MSG.title}
          </AppText>
        </View>
        {loadError ? <Banner tone="danger" text={loadError} /> : null}
        {saved === null || draft === null ? (
          loadError ? <Button label={t('Tentar de novo')} variant="secondary" onPress={() => void load()} /> : <ActivityIndicator />
        ) : (
          <>
            <View className="gap-2">
              <AppText variant="label">{t('Contas do projeto')}</AppText>
              {included.length === 0 ? (
                <AppText variant="muted">{PROJECT_AI_MSG.empty}</AppText>
              ) : (
                included.map((o, i) => (
                  <View key={o.id} className="gap-2 rounded-xl border border-app-border bg-app-surface2 px-3 py-2">
                    <AppText>{`${i + 1}. ${accountLabel(o)}`}</AppText>
                    <View className="flex-row flex-wrap gap-2">
                      <RowAction label={t('Subir')} name={o.label} disabled={i === 0} onPress={() => edit((d) => moveAccount(d, o.id, -1))} />
                      <RowAction label={t('Descer')} name={o.label} disabled={i === included.length - 1} onPress={() => edit((d) => moveAccount(d, o.id, 1))} />
                      <RowAction label={t('Remover')} name={o.label} onPress={() => edit((d) => removeAccount(d, o.id))} />
                    </View>
                  </View>
                ))
              )}
            </View>
            {others.length > 0 ? (
              <View className="gap-2">
                <AppText variant="label">{t('Outras contas das máquinas do projeto')}</AppText>
                {others.map((o: TProjectAiOption) => (
                  <View key={o.id} className="flex-row items-center justify-between gap-2 rounded-xl border border-app-border px-3 py-2">
                    <AppText className="flex-1">{accountLabel(o)}</AppText>
                    <Switch accessibilityLabel={t('Incluir {{name}}', { name: o.label })} value={false} onValueChange={(on) => (on ? edit((d) => addAccount(d, o.id)) : undefined)} />
                  </View>
                ))}
              </View>
            ) : null}
            {providersOf(available).map((provider) => (
              <ModelChoice key={provider} provider={provider} model={draft.models[provider]} onChange={(patch) => edit((d) => setModel(d, provider, patch))} />
            ))}
            {saveError ? <Banner tone="danger" text={saveError} /> : null}
            {notice ? <AppText variant="muted">{notice}</AppText> : null}
            <Button label={t('Salvar')} onPress={() => void save()} disabled={!canSave} loading={saving} />
          </>
        )}
      </View>
    </Screen>
  );
}

/** The `/project-ai/[projectId]` route. */
export function ProjectAiScreen() {
  const { projectId } = useLocalSearchParams<{ projectId: string }>();
  return <ProjectAiView projectId={projectId} />;
}
