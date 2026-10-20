import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';
import { activeGrantsLabel } from '@/features/chat-grants/model/labels';
import { useTranslation } from '@/i18n';
import { AppText, Button, Screen, Sheet } from '@/ui';
import { isGrantActive } from '../model/grant-time';
import { isActive } from '../model/subagents';
import { useChatStore } from '../viewmodel/useChatStore';
import { HostLine } from './host-line';
import { SubagentsSheet } from './subagents-sheet';

/** How often the subagents sheet's elapsed labels refresh while it is open (spec 2026-09-26 panel §4). */
const SUBAGENTS_TICK_MS = 30_000;

/** "Configurações da conversa" (TER-1039), route `/chat-settings`, opened by the cog in the
 * conversation's header: what used to crowd that header — where the chat runs, the subagents panel,
 * the trusted tabs, the memory and "Nova conversa" — for the conversation the store has open. */
export function ConversationSettingsScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const activeProject = useChatStore((s) => s.activeProject);
  const slot = useChatStore((s) => (s.activeProject === undefined ? undefined : s.conversations[s.activeProject ?? '']));
  const reset = useChatStore((s) => s.reset);
  const cancelSubagent = useChatStore((s) => s.cancelSubagent);
  const [confirmingReset, setConfirmingReset] = useState(false);

  // The subagents panel (spec 2026-09-26 panel §4): the button is always here, so the sheet it opens
  // always has a way back, and `Sheet`'s backdrop closes it too.
  const [subagentsOpen, setSubagentsOpen] = useState(false);
  const subagents = useMemo(() => slot?.subagents ?? [], [slot?.subagents]);
  const cancelFailed = useMemo(() => slot?.cancelFailed ?? [], [slot?.cancelFailed]);
  const activeSubagents = useMemo(() => subagents.filter(isActive), [subagents]);
  const [subagentsNow, setSubagentsNow] = useState(() => Date.now());
  useEffect(() => {
    if (!subagentsOpen) return;
    // Fresh on open too: otherwise the sheet shows the time of its last open (or of the mount).
    setSubagentsNow(Date.now());
    const timer = setInterval(() => setSubagentsNow(Date.now()), SUBAGENTS_TICK_MS);
    return () => clearInterval(timer);
  }, [subagentsOpen]);
  const onCancelSubagent = useCallback((id: string) => void cancelSubagent(id), [cancelSubagent]);

  // Standing grants ("Liberar sem prazo") never expire: all of them count. Read once per render: the
  // conversation's cards re-check expiry on their own tick, this count only leads to the list.
  const activeGrantCount =
    (slot?.grants ?? []).filter((g) => isGrantActive(g)).length + (slot?.projectGrants ?? []).filter((g) => isGrantActive(g)).length + (slot?.standingGrants ?? []).length;

  // Opened from a deep link, there may be no conversation behind it: the chats list stands in.
  const goBack = () => (router.canGoBack() ? router.back() : router.replace('/(tabs)/chats'));

  const confirmReset = () => {
    setConfirmingReset(false);
    setSubagentsOpen(false);
    void reset();
    goBack();
  };

  return (
    <Screen scroll>
      <View className="gap-6 pb-10">
        <View className="flex-row items-center gap-2">
          <Button label={t('Voltar')} variant="ghost" onPress={goBack} />
          <AppText variant="title" className="flex-1">
            {t('Configurações da conversa')}
          </AppText>
        </View>
        {/* Where it runs, ready or not; a project chat's line also leads to the project's accounts and
            model and its recent files (spec 2026-09-30 project AI accounts §8). */}
        {slot?.host ? (
          <View className="gap-2">
            <AppText variant="label">{t('Onde o chat roda')}</AppText>
            <HostLine host={slot.host} canChange={activeProject === null} projectId={activeProject ?? null} />
          </View>
        ) : null}
        {/* Contexto: the context window indicator of TER-1038 goes here once the phone has one. */}
        <View className="gap-2">
          <AppText variant="label">{t('Subagentes')}</AppText>
          <Button label={t('Subagentes ({{n}})', { n: activeSubagents.length })} variant="secondary" onPress={() => setSubagentsOpen(true)} />
        </View>
        {activeGrantCount > 0 ? (
          <View className="gap-2">
            <AppText variant="label">{t('Abas liberadas')}</AppText>
            <Button label={activeGrantsLabel(activeGrantCount)} variant="secondary" onPress={() => router.push('/chat-grants')} />
          </View>
        ) : null}
        <View className="gap-2">
          <AppText variant="label">{t('Memória')}</AppText>
          <Button label={t('Memória do chat')} variant="secondary" onPress={() => router.push('/chat-memory')} />
        </View>
        <Button label={t('Nova conversa')} variant="secondary" onPress={() => setConfirmingReset(true)} />
      </View>
      <Sheet open={confirmingReset} onClose={() => setConfirmingReset(false)} title={t('Começar uma nova conversa?')}>
        <View className="gap-3">
          <AppText variant="muted">{t('A conversa atual fica arquivada e o chat começa do zero.')}</AppText>
          <Button label={t('Começar nova conversa')} variant="danger" onPress={confirmReset} />
          <Button label={t('Cancelar')} variant="ghost" onPress={() => setConfirmingReset(false)} />
        </View>
      </Sheet>
      <SubagentsSheet open={subagentsOpen} onClose={() => setSubagentsOpen(false)} subagents={subagents} cancelFailed={cancelFailed} onCancel={onCancelSubagent} now={subagentsNow} />
    </Screen>
  );
}
