import { useRouter, type Href } from 'expo-router';
import { useEffect } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { useTranslation } from '@/i18n';
import { AppText, Sheet } from '@/ui';
import { hostAccountLine } from '../model/copy';
import type { ChatHostState } from '../model/types';
import { useChatStore } from '../viewmodel/useChatStore';

function Choice({ label, machine, onPress }: { label: string; machine: string; onPress(): void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`${label} (${machine})`} onPress={onPress} className="rounded-xl bg-app-surface2 px-4 py-3">
      <AppText>{label}</AppText>
    </Pressable>
  );
}

/** The account-wide chat's host picker: each machine, then its Claude accounts and the machine's
 * default login. With `project`, a project chat's sheet instead (spec 2026-09-30 project AI accounts §8):
 * which account runs it, and the way to the project's accounts and model — a project chat's host is not
 * picked here. */
export function HostSheet({ open, onClose, project }: { open: boolean; onClose(): void; project?: { id: string; host: ChatHostState | null } }) {
  if (project) return <ProjectHostSheet open={open} onClose={onClose} projectId={project.id} host={project.host} />;
  return <AccountWideHostSheet open={open} onClose={onClose} />;
}

function ProjectHostSheet({ open, onClose, projectId, host }: { open: boolean; onClose(): void; projectId: string; host: ChatHostState | null }) {
  const { t } = useTranslation();
  const router = useRouter();
  const openProjectAi = () => {
    onClose();
    router.push(`/project-ai/${encodeURIComponent(projectId)}` as Href);
  };
  return (
    <Sheet open={open} onClose={onClose} title={t('Onde o chat roda')}>
      <View className="gap-3">
        {host ? <AppText variant="muted">{hostAccountLine(host)}</AppText> : null}
        <Pressable accessibilityRole="button" accessibilityLabel={t('Contas e modelo do projeto')} onPress={openProjectAi} className="rounded-xl bg-app-surface2 px-4 py-3">
          <AppText>{t('Contas e modelo do projeto')}</AppText>
        </Pressable>
      </View>
    </Sheet>
  );
}

function AccountWideHostSheet({ open, onClose }: { open: boolean; onClose(): void }) {
  const { t } = useTranslation();
  const hostOptions = useChatStore((s) => s.hostOptions);
  const loadHostOptions = useChatStore((s) => s.loadHostOptions);
  const setHost = useChatStore((s) => s.setHost);

  useEffect(() => {
    if (open) void loadHostOptions();
  }, [open, loadHostOptions]);

  const choose = (machineId: string, accountId?: string) => {
    onClose();
    void setHost(machineId, accountId);
  };

  return (
    <Sheet open={open} onClose={onClose} title={t('Onde o chat roda')}>
      {hostOptions === null ? (
        <ActivityIndicator />
      ) : (
        <ScrollView className="max-h-96">
          <View className="gap-5">
            {hostOptions.machines.map((machine) => (
              <View key={machine.id} className="gap-2">
                <View className="flex-row items-center gap-2">
                  <AppText className="font-semibold">{machine.name}</AppText>
                  {machine.online ? null : <Text className="text-xs text-app-danger">{t('offline')}</Text>}
                  {machine.agent_version ? <AppText variant="muted">{t('agente {{version}}', { version: machine.agent_version })}</AppText> : null}
                </View>
                {machine.accounts.map((account) => (
                  <Choice key={account.id} label={account.label} machine={machine.name} onPress={() => choose(machine.id, account.id)} />
                ))}
                <Choice label={t('conta padrão da máquina')} machine={machine.name} onPress={() => choose(machine.id)} />
              </View>
            ))}
          </View>
        </ScrollView>
      )}
    </Sheet>
  );
}
