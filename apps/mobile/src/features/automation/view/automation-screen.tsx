import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect } from 'react';
import { ActivityIndicator, Pressable, Switch, Text, View } from 'react-native';
import { AppText, Banner, Button, Screen, Sheet } from '@/ui';
import { AUTOMATION_MSG, AUTONOMY_LABEL, AUTONOMY_LEVELS, toggleType, TYPE_OPTIONS } from '../model/automation';
import { automationDeps } from '../viewmodel/deps';
import { useAutomation } from '../viewmodel/use-automation';

/** One choice of a level or a type: selected or not. */
function Choice({ label, selected, role, onPress }: { label: string; selected: boolean; role: 'radio' | 'checkbox'; onPress(): void }) {
  return (
    <Pressable
      accessibilityRole={role}
      accessibilityLabel={label}
      accessibilityState={{ selected, checked: selected }}
      onPress={onPress}
      className={`rounded-xl border px-3 py-2 ${selected ? 'border-app-accent bg-app-surface2' : 'border-app-border'}`}
    >
      <Text className={`text-sm ${selected ? 'font-semibold text-app-accent' : 'text-app-text'}`}>{label}</Text>
    </Pressable>
  );
}

/** "Trabalho automático" of the project Setup (spec 2026-10-04), reached from a project chat's host sheet:
 * the switch, the card types and how far the agents go alone. The rest of the block (paths, limits,
 * prompts) is edited on the web and kept as it is. */
export function AutomationView({ projectId }: { projectId: string }) {
  const router = useRouter();
  const { saved, draft, loadError, saving, saveError, notice, confirming, canSave, load, edit, save, confirm, cancelConfirm } = useAutomation(projectId, automationDeps);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Screen scroll>
      <View className="gap-6 pb-10">
        <View className="flex-row items-center gap-2">
          <Button label="Voltar" variant="ghost" onPress={() => router.back()} />
          <AppText variant="title" className="flex-1">
            {AUTOMATION_MSG.title}
          </AppText>
        </View>
        {loadError ? <Banner tone="danger" text={loadError} /> : null}
        {saved === null || draft === null ? (
          loadError ? <Button label="Tentar de novo" variant="secondary" onPress={() => void load()} /> : <ActivityIndicator />
        ) : (
          <>
            <AppText variant="muted">{AUTOMATION_MSG.intro}</AppText>
            <View className="flex-row items-center justify-between gap-3 rounded-xl border border-app-border px-3 py-3">
              <AppText className="flex-1">{AUTOMATION_MSG.enable}</AppText>
              <Switch accessibilityLabel={AUTOMATION_MSG.enable} value={draft.enabled} onValueChange={(enabled) => edit((d) => ({ ...d, enabled }))} />
            </View>
            <View className="gap-2">
              <AppText variant="label">{AUTOMATION_MSG.types}</AppText>
              <View className="flex-row flex-wrap gap-2">
                {TYPE_OPTIONS.map((o) => (
                  <Choice key={o.type} role="checkbox" label={o.label} selected={draft.types.includes(o.type)} onPress={() => edit((d) => toggleType(d, o.type))} />
                ))}
              </View>
            </View>
            <View className="gap-2">
              <AppText variant="label">{AUTOMATION_MSG.level}</AppText>
              <View accessibilityRole="radiogroup" className="flex-row flex-wrap gap-2">
                {AUTONOMY_LEVELS.map((level) => (
                  <Choice key={level} role="radio" label={AUTONOMY_LABEL[level]} selected={draft.autonomy === level} onPress={() => edit((d) => ({ ...d, autonomy: level }))} />
                ))}
              </View>
              <AppText variant="muted">{AUTOMATION_MSG.storesNever}</AppText>
            </View>
            {saveError ? <Banner tone="danger" text={saveError} /> : null}
            {notice ? <AppText variant="muted">{notice}</AppText> : null}
            <Button label="Salvar" onPress={() => void save()} disabled={!canSave} loading={saving} />
            <Sheet open={confirming !== null} onClose={cancelConfirm} title={AUTOMATION_MSG.confirmTitle}>
              <View className="gap-4">
                <AppText>{confirming ?? ''}</AppText>
                <Button label="Confirmar" onPress={() => void confirm()} />
                <Button label="Cancelar" variant="ghost" onPress={cancelConfirm} />
              </View>
            </Sheet>
          </>
        )}
      </View>
    </Screen>
  );
}

/** The `/project-automation/[projectId]` route. */
export function AutomationScreen() {
  const { projectId } = useLocalSearchParams<{ projectId: string }>();
  return <AutomationView projectId={projectId} />;
}
