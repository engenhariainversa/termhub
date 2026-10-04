import { memo, useState } from 'react';
import { Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { AppText, Icon, type IconName } from '@/ui';
import type { ToolRow } from '../model/timeline';

export const MONOSPACE = Platform.select({ ios: 'Menlo', default: 'monospace' });

const STATUS: Record<ToolRow['status'], { label: string; icon: IconName; tone: string }> = {
  running: { label: 'em andamento', icon: { ios: 'circle.dotted', android: 'pending' }, tone: 'accent' },
  done: { label: 'concluída', icon: { ios: 'checkmark', android: 'check' }, tone: 'muted' },
  error: { label: 'erro', icon: { ios: 'xmark', android: 'close' }, tone: 'danger' },
};

/** One tool: its mark, name and summary; a tap shows its result's preview in monospace. */
function ToolLine({ tool }: { tool: ToolRow }) {
  const [open, setOpen] = useState(false);
  const status = STATUS[tool.status];
  return (
    <View className="gap-1">
      <Pressable accessibilityRole="button" accessibilityLabel={`${tool.name}: ${status.label}`} onPress={() => setOpen((o) => !o)} className="flex-row items-center gap-2 py-1">
        <Icon name={status.icon} size={12} tone={status.tone} />
        <Text className="text-sm font-semibold text-app-text">{tool.name}</Text>
        {tool.summary ? (
          <Text className="shrink text-sm text-app-muted" numberOfLines={1}>
            {tool.summary}
          </Text>
        ) : null}
      </Pressable>
      {open && tool.preview ? (
        <ScrollView horizontal className="rounded-lg bg-app-surface2 px-3 py-2">
          <Text style={{ fontFamily: MONOSPACE, fontSize: 12 }} className="text-app-text">
            {tool.preview}
          </Text>
        </ScrollView>
      ) : null}
    </View>
  );
}

/** Consecutive tool calls folded in one row (spec 2026-10-01 tab chat §6): "3 ferramentas", opening to
 * one line per tool. A tool alone is its own line, with no count. */
export const ToolsRow = memo(function ToolsRow({ tools }: { tools: ToolRow[] }) {
  const [open, setOpen] = useState(false);
  if (tools.length === 1) {
    return (
      <View className="self-start rounded-xl border border-app-border px-3 py-1">
        <ToolLine tool={tools[0]!} />
      </View>
    );
  }
  const running = tools.some((t) => t.status === 'running');
  const failed = tools.some((t) => t.status === 'error');
  const label = `${tools.length} ferramentas`;
  return (
    <View className="self-start gap-1 rounded-xl border border-app-border px-3 py-1">
      <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ expanded: open }} onPress={() => setOpen((o) => !o)} className="flex-row items-center gap-2 py-1">
        <Icon name={open ? { ios: 'chevron.down', android: 'expand_more' } : { ios: 'chevron.right', android: 'chevron_right' }} size={12} tone="muted" />
        <AppText variant="muted">{label}</AppText>
        {running ? <AppText variant="muted" className="text-app-accent">em andamento</AppText> : failed ? <AppText variant="muted" className="text-app-danger">com erro</AppText> : null}
      </Pressable>
      {open ? tools.map((t) => <ToolLine key={t.id} tool={t} />) : null}
    </View>
  );
});
