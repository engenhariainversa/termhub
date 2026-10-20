import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { untilLabel } from '@/features/chat/model/grant-time';
import { AUTO_THRESHOLD_MAX, AUTO_THRESHOLD_MIN, type TAutoThresholds, type TChatGrantListItem } from '@/services/api/contract';
import { useTranslation } from '@/i18n';
import { AppText, Banner, Button, Field, Screen } from '@/ui';
import { endedAtLabel, GRANT_STATE_LABEL, grantOriginLabel, grantTitleLabel } from '../model/labels';
import { parseThresholds, thresholdText } from '../model/thresholds';
import { useChatGrantsStore } from '../viewmodel/useChatGrantsStore';

// A tab row also names its project (a tab grant is always inside one); a project row's title
// already names the project, so nothing is appended there — mirrors the web's own `title`.
const title = (g: TChatGrantListItem) => `${grantTitleLabel(g)}${g.kind === 'tab' && g.project_name ? ` · ${g.project_name}` : ''}`;

/** "Permissões do chat" (design spec 2026-09-26 §7, spec 2026-09-26 §5): the phone's copy of the
 * web list — tab, project and standing grants ("sem prazo", TER-386) together. Revogar needs no PIN. */
export function ChatGrantsScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const { active, history, next, loadingMore, revokingId, error, memory, savingThresholds, thresholdsError, load, loadMore, revoke, loadMemory, setThresholds } = useChatGrantsStore();

  useEffect(() => {
    void load();
    void loadMemory();
  }, [load, loadMemory]);

  return (
    <Screen scroll>
      <View className="gap-6 pb-10">
        <View className="flex-row items-center gap-2">
          <Button label={t('Voltar')} variant="ghost" onPress={() => router.back()} />
          <AppText variant="title" className="flex-1">
            {t('Permissões do chat')}
          </AppText>
        </View>
        <AppText variant="muted">
          {t('O que o chat pode fazer sem pedir confirmação. Permissões de conversa valem por até 24 horas; as sem prazo valem até você revogar.')}
        </AppText>
        {error ? <Banner tone="danger" text={error} /> : null}
        {active === null || history === null ? (
          error ? <Button label={t('Tentar de novo')} variant="secondary" onPress={() => void load()} /> : <ActivityIndicator />
        ) : (
          <>
            <View className="gap-2">
              <AppText variant="label">{t('Ativas')}</AppText>
              {active.length === 0 ? (
                <AppText variant="muted">{t('Nenhuma permissão ativa agora.')}</AppText>
              ) : (
                active.map((g) => (
                  <View key={g.id} className="flex-row items-center justify-between gap-2 rounded-xl border border-app-border bg-app-surface2 px-3 py-2">
                    <View className="flex-1">
                      <AppText>{title(g)}</AppText>
                      <AppText variant="muted">{`${grantOriginLabel(g)} · ${typeof g.expires_at === 'string' ? untilLabel(g.expires_at) : t('sem prazo')}`}</AppText>
                    </View>
                    <Button label={t('Revogar')} variant="ghost" onPress={() => void revoke(g.id)} disabled={revokingId === g.id} />
                  </View>
                ))
              )}
            </View>
            <View className="gap-2">
              <AppText variant="label">{t('Histórico')}</AppText>
              {history.length === 0 ? (
                <AppText variant="muted">{t('Nada no histórico ainda.')}</AppText>
              ) : (
                history.map((g) => (
                  <View key={g.id} className="rounded-xl border border-app-border px-3 py-2">
                    <AppText>{title(g)}</AppText>
                    <AppText variant="muted">{`${grantOriginLabel(g)} · ${g.ended_at ? t('{{state}} em {{date}}', { state: t(GRANT_STATE_LABEL[g.state]), date: endedAtLabel(g.ended_at) }) : t(GRANT_STATE_LABEL[g.state])}`}</AppText>
                  </View>
                ))
              )}
              {next ? <Button label={t('Carregar mais')} variant="secondary" onPress={() => void loadMore()} disabled={loadingMore} /> : null}
            </View>
          </>
        )}
        {/* Absent from an older server, and pointless where the memory cannot match anything. */}
        {memory?.available && memory.auto_thresholds ? (
          <AutoAnswerBlock thresholds={memory.auto_thresholds} delaySeconds={memory.auto_delay_seconds ?? DEFAULT_DELAY_SECONDS} saving={savingThresholds} error={thresholdsError} onSave={setThresholds} />
        ) : null}
      </View>
    </Screen>
  );
}

/** The countdown of a suggested answer when the server does not say (`auto_delay_seconds`). */
const DEFAULT_DELAY_SECONDS = 60;

type AutoAnswerProps = {
  thresholds: TAutoThresholds;
  delaySeconds: number;
  saving: boolean;
  error: string | null;
  onSave(thresholds: { high: number; low: number } | null): Promise<boolean>;
};

/** "Resposta automática" (TER-642): the similarity thresholds that rule an answer sent from memory —
 * what each one does, where they come from (pinned by hand, the person's own history, or the defaults)
 * and the two fields that pin them. Pinning turns the automatic adjustment off until it is handed back. */
function AutoAnswerBlock({ thresholds, delaySeconds, saving, error, onSave }: AutoAnswerProps) {
  const { t } = useTranslation();
  const [high, setHigh] = useState(() => thresholdText(thresholds.high));
  const [low, setLow] = useState(() => thresholdText(thresholds.low));
  // The fields follow what is in force: after a save, or once the automatic adjustment takes over again.
  useEffect(() => {
    setHigh(thresholdText(thresholds.high));
    setLow(thresholdText(thresholds.low));
  }, [thresholds.high, thresholds.low]);
  const parsed = parseThresholds(high, low);
  const manual = thresholds.source === 'manual';
  const unchanged = manual && parsed?.high === thresholds.high && parsed?.low === thresholds.low;
  const values = { high: thresholdText(thresholds.high), low: thresholdText(thresholds.low) };
  const origin =
    thresholds.source === 'manual'
      ? t('Limiares fixados por você: o ajuste automático está desligado.')
      : thresholds.source === 'calibrated'
        ? t('Limiares ajustados pelo seu histórico ({{samples}} respostas).', { samples: thresholds.samples })
        : thresholds.source === 'default'
          ? t('Limiares padrão — o ajuste automático começa com {{min}} respostas suas ({{samples}} até agora).', { min: thresholds.min_samples, samples: thresholds.samples })
          : null;
  return (
    <View className="gap-2">
      <AppText variant="label">{t('Resposta automática')}</AppText>
      <AppText variant="muted">{t('Quando uma aba pergunta algo parecido com o que a memória já guarda, a semelhança (de 0 a 1) decide o que o chat faz. Só age com «Responder sozinho» ligado, na Memória do chat.')}</AppText>
      <View className="gap-1 rounded-xl border border-app-border bg-app-surface2 px-3 py-2">
        <AppText>{t('A partir de {{high}}: envia a resposta sozinho.', values)}</AppText>
        <AppText>{t('De {{low}} até {{high}}: sugere a resposta e envia em {{seconds}} s, contando só com o termhub em foco.', { ...values, seconds: delaySeconds })}</AppText>
        <AppText>{t('Abaixo de {{low}}: não sugere nada.', values)}</AppText>
        {origin ? <AppText variant="muted">{origin}</AppText> : null}
      </View>
      <Field label={t('Limiar de envio')} value={high} onChangeText={setHigh} keyboardType="decimal-pad" testID="auto-threshold-high" />
      <Field label={t('Limiar de sugestão')} value={low} onChangeText={setLow} keyboardType="decimal-pad" testID="auto-threshold-low" />
      {parsed ? null : <AppText className="text-app-danger">{t('Use números de {{min}} a {{max}}, com o limiar de sugestão igual ou abaixo do de envio.', { min: thresholdText(AUTO_THRESHOLD_MIN), max: thresholdText(AUTO_THRESHOLD_MAX) })}</AppText>}
      {error ? <AppText className="text-app-danger">{error}</AppText> : null}
      <Button label={t('Fixar limiares')} variant="secondary" loading={saving} disabled={!parsed || unchanged} onPress={() => parsed && void onSave(parsed)} />
      {manual ? <Button label={t('Voltar ao ajuste automático')} variant="ghost" disabled={saving} onPress={() => void onSave(null)} /> : null}
    </View>
  );
}
