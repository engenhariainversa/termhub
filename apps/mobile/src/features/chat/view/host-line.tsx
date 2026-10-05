import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { fileRecentRoute } from '@/features/file-recent/model/format';
import { useTranslation } from '@/i18n';
import { Button } from '@/ui';
import { accountFromProject, hostLine, type HostLine as HostLineCopy } from '../model/copy';
import type { ChatHostState } from '../model/types';
import { HostSheet } from './host-sheet';

const TONE: Record<HostLineCopy['tone'], string> = {
  ok: 'text-app-ok',
  warn: 'text-app-danger',
  info: 'text-app-muted',
};

/** Where the conversation runs, or why it cannot; the account-wide chat can change it. A project chat
 * (`projectId`) offers its own sheet instead, the way to the project's accounts and model (spec
 * 2026-09-30 project AI accounts §8); an account the project chose is never picked here. It also leads
 * to the project's recent Markdown files (spec 2026-10-04 recent Markdown files D7). */
export function HostLine({ host, canChange, projectId = null }: { host: ChatHostState; canChange: boolean; projectId?: string | null }) {
  const { t } = useTranslation();
  const router = useRouter();
  const [picking, setPicking] = useState(false);
  const line = hostLine(host);
  const pick = canChange && projectId === null && !accountFromProject(host);
  return (
    <View className="gap-1 border-b border-app-border px-4 py-2">
      <Text className={`text-sm ${TONE[line.tone]}`}>{line.text}</Text>
      {pick ? (
        <>
          <Button label={t('Trocar máquina ou conta')} variant="ghost" onPress={() => setPicking(true)} />
          <HostSheet open={picking} onClose={() => setPicking(false)} />
        </>
      ) : projectId !== null ? (
        <>
          <View className="flex-row flex-wrap gap-2">
            <Button label={t('Conta e modelo')} variant="ghost" onPress={() => setPicking(true)} />
            <Button label={t('Arquivos')} variant="ghost" onPress={() => router.push(fileRecentRoute(projectId))} />
          </View>
          <HostSheet open={picking} onClose={() => setPicking(false)} project={{ id: projectId, host }} />
        </>
      ) : null}
    </View>
  );
}
