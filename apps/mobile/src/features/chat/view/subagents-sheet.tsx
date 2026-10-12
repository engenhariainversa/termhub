import { Pressable, ScrollView, View } from 'react-native';
import { useTranslation } from '@/i18n';
import { AppText, Sheet } from '@/ui';
import { elapsedLabel, SUBAGENT_STATUS_LABEL } from '../model/subagents';
import type { SubagentView } from '../model/types';

/** A raw `Pressable`, not the shared `Button`: several rows can each show "Cancelar", so the
 * accessibility name needs to name which one (spec 2026-09-26 panel §4, lesson from the web review). */
function CancelButton({ description, onPress }: { description: string; onPress(): void }) {
  const { t } = useTranslation();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={t('Cancelar {{description}}', { description })} onPress={onPress} className="self-start rounded-xl bg-app-surface2 px-4 py-2">
      <AppText>{t('Cancelar')}</AppText>
    </Pressable>
  );
}

export interface SubagentsSheetProps {
  open: boolean;
  onClose(): void;
  subagents: SubagentView[];
  /** Ids whose "Cancelar" came back with `subagent_cancel_failed`, or any other cancel failure the
   * store marks the same way (spec 2026-09-26 panel §5.4). */
  cancelFailed: string[];
  onCancel(id: string): void;
  /** Defaults to `Date.now()`: a prop only so a test can pin the elapsed labels. */
  now?: number;
}

/**
 * The subagents panel (spec 2026-09-26 panel §4): one row per subagent of the conversation, newest
 * first — `conversation-settings-screen.tsx` owns the list and the button that opens it (TER-1039), and
 * reuses `Sheet`, the same container `HostSheet` uses for its own list. Always closable: that button is
 * always there, and `Sheet`'s own backdrop closes it too.
 */
export function SubagentsSheet({ open, onClose, subagents, cancelFailed, onCancel, now }: SubagentsSheetProps) {
  const { t } = useTranslation();
  const at = now ?? Date.now();
  return (
    <Sheet open={open} onClose={onClose} title={t('Subagentes')}>
      <ScrollView className="max-h-96">
        <View className="gap-3">
          {subagents.map((s) => (
            <View key={s.id} className="gap-1 rounded-xl bg-app-surface2 px-4 py-3">
              <AppText>{s.description}</AppText>
              <AppText variant="muted">{`${SUBAGENT_STATUS_LABEL[s.status]} · ${elapsedLabel(s, at)}`}</AppText>
              {s.status === 'running' ? <CancelButton description={s.description} onPress={() => onCancel(s.id)} /> : null}
              {cancelFailed.includes(s.id) ? <AppText className="text-app-danger">{t('Não foi possível cancelar')}</AppText> : null}
            </View>
          ))}
        </View>
      </ScrollView>
    </Sheet>
  );
}
