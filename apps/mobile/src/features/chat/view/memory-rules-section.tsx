import { useEffect, useState } from 'react';
import { Alert, View } from 'react-native';
import { AUTONOMY_LABEL } from '@/features/automation/model/automation';
import type { TMemoryRule } from '@/services/api/contract';
import { AppText, Banner, Button } from '@/ui';
import { useMemoryRulesStore } from '../viewmodel/useMemoryRulesStore';
import { useTranslation } from '@/i18n';

/** What a policy changes, one line each: the autonomy level and/or the parallel cap — the same
 * lines as the web's `MemoryRulesSection`. */
function usePolicyLines() {
  const { t } = useTranslation();
  return (r: TMemoryRule): string[] => {
    if (!r.policy) return [];
    const lines: string[] = [];
    if (r.policy.autonomy) lines.push(t('Mudar o nível para «{{level}}»', { level: t(AUTONOMY_LABEL[r.policy.autonomy]) }));
    if (r.policy.max_parallel !== null) lines.push(t('Máximo em paralelo: {{n}}', { n: r.policy.max_parallel }));
    return lines;
  };
}

/** The sources' count as a toggle, and, open, each source's statement and project. */
function Sources({ rule }: { rule: TMemoryRule }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <View className="gap-1">
      <Button label={t('{{count}} origens', { count: rule.sources.length })} variant="ghost" onPress={() => setOpen((o) => !o)} testID={`rule-sources-${rule.id}`} />
      {open ? (
        <View className="gap-1 border-l border-app-border pl-3">
          {rule.sources.map((s) => (
            <AppText key={s.ref} variant="muted" className="text-xs">
              {`${s.statement} · ${s.project_name ?? t('sem projeto')}`}
            </AppText>
          ))}
        </View>
      ) : null}
    </View>
  );
}

/**
 * "Regras vigentes" (TER-1010, spec 2026-10-07 current rules) on the "Memória do chat" screen: the
 * proposals consolidated from the person's decisions and concierge notes, and the rules they
 * approved — the mobile twin of the web's `MemoryRulesSection`. Nothing changes until they approve,
 * and a policy proposal still asks its confirmation in each project's chat. Loads on its own when
 * mounted; "Remover" confirms with a native `Alert.alert` (the web asks `window.confirm`).
 */
export function MemoryRulesSection() {
  const { t } = useTranslation();
  const rules = useMemoryRulesStore((s) => s.rules);
  const proposals = useMemoryRulesStore((s) => s.proposals);
  const busyId = useMemoryRulesStore((s) => s.busyId);
  const error = useMemoryRulesStore((s) => s.error);
  const notice = useMemoryRulesStore((s) => s.notice);
  const load = useMemoryRulesStore((s) => s.load);
  const approve = useMemoryRulesStore((s) => s.approve);
  const reject = useMemoryRulesStore((s) => s.reject);
  const remove = useMemoryRulesStore((s) => s.remove);
  const policyLines = usePolicyLines();

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const scope = (r: TMemoryRule) => r.project?.name ?? t('Todos os projetos');

  const confirmRemove = (r: TMemoryRule) => {
    Alert.alert(t('Remover a regra «{{text}}»? As decisões e anotações de origem voltam a valer.', { text: r.text }), undefined, [
      { text: t('Cancelar'), style: 'cancel' },
      { text: t('Remover'), style: 'destructive', onPress: () => void remove(r.id) },
    ]);
  };

  return (
    <View className="gap-3 pt-6">
      <AppText variant="title" className="text-base">
        {t('Regras vigentes')}
      </AppText>
      <AppText variant="muted">{t('Decisões e anotações que dizem a mesma coisa viram uma regra só. Nada muda até você aprovar.')}</AppText>
      {error ? <Banner tone="danger" text={error} /> : null}
      {notice ? <AppText variant="muted">{notice}</AppText> : null}
      {rules === null || proposals === null ? (
        <AppText variant="muted">{t('Carregando…')}</AppText>
      ) : rules.length === 0 && proposals.length === 0 ? (
        <AppText variant="muted">{t('Nenhuma regra vigente nem proposta por enquanto.')}</AppText>
      ) : (
        <View className="gap-3">
          {proposals.length > 0 ? (
            <AppText className="font-semibold">{t('Propostas')}</AppText>
          ) : null}
          {proposals.map((r) => (
            <View key={r.id} className="gap-1 rounded-xl border border-app-accent bg-app-surface2 p-4" testID={`rule-proposal-${r.id}`}>
              <AppText>{r.text}</AppText>
              {r.kind === 'policy' ? (
                <>
                  {policyLines(r).map((line) => (
                    <AppText key={line} variant="muted">
                      {line}
                    </AppText>
                  ))}
                  <AppText variant="muted" className="text-xs">
                    {t('Projetos: {{names}}', { names: r.policy?.projects.map((p) => p.name).join(', ') ?? '' })}
                  </AppText>
                </>
              ) : null}
              <AppText variant="muted" className="text-xs">
                {r.kind === 'policy' ? t('Política do trabalho automático') : scope(r)}
              </AppText>
              <Sources rule={r} />
              {r.status === 'awaiting_confirmation' ? (
                <AppText variant="muted" className="text-xs">
                  {t('Aguardando a confirmação no chat')}
                </AppText>
              ) : (
                <>
                  {r.kind === 'policy' ? (
                    <AppText variant="muted" className="text-xs">
                      {t('Cada projeto pede a sua confirmação no chat.')}
                    </AppText>
                  ) : null}
                  <View className="flex-row flex-wrap items-center gap-3">
                    <Button label={t('Aprovar')} disabled={busyId === r.id} onPress={() => void approve(r.id)} />
                    <Button label={t('Recusar')} variant="ghost" disabled={busyId === r.id} onPress={() => void reject(r.id)} />
                  </View>
                </>
              )}
            </View>
          ))}
          {rules.map((r) => (
            <View key={r.id} className="gap-1 rounded-xl border border-app-border bg-app-surface2 p-4" testID={`rule-${r.id}`}>
              <AppText>{r.text}</AppText>
              {r.kind === 'policy'
                ? policyLines(r).map((line) => (
                    <AppText key={line} variant="muted">
                      {line}
                    </AppText>
                  ))
                : null}
              <AppText variant="muted" className="text-xs">
                {r.kind === 'policy'
                  ? t('Projetos: {{names}}', { names: r.policy?.projects.filter((p) => p.applied).map((p) => p.name).join(', ') ?? '' })
                  : scope(r)}
              </AppText>
              <Sources rule={r} />
              {r.kind === 'rule' ? <Button label={t('Remover')} variant="ghost" disabled={busyId === r.id} onPress={() => confirmRemove(r)} /> : null}
            </View>
          ))}
        </View>
      )}
    </View>
  );
}
