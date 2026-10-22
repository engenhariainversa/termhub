import type { ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { relativeTime } from '@/features/shared/relative-time';
import { useTranslation } from '@/i18n';
import { AppText, Icon } from '@/ui';

/** `pending`: the chat's confirmations; `needsYou`: the project's tabs waiting on the person (TER-1106), counted in the same badge. */
export type ProjectRowData = { route: string; name: string; detail?: string; busy: boolean; pending: number; needsYou?: number; lastMessageAt: string | null };

/** The pin of a project row (TER-541): the web sidebar's Favoritos. */
export type RowFavorite = { pinned: boolean; onToggle(): void; onLongPress(): void };

/** The two shortcuts of a project row in Chats (TER-1106): its sessions, and straight into its concierge chat. */
export type RowActions = { onSessions(): void; onChat(): void };

const PIN = { ios: 'pin', android: 'keep' } as const;
const PINNED = { ios: 'pin.fill', android: 'keep' } as const;
const LIST = { ios: 'list.bullet', android: 'format_list_bulleted' } as const;
const CHAT = { ios: 'bubble.left', android: 'chat_bubble' } as const;

/** A small icon button at the end of a row, sibling of the row's own button. */
function RowIcon({ label, onPress, children }: { label: string; onPress(): void; children: ReactNode }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={4}
      className="h-11 w-10 items-center justify-center"
    >
      {children}
    </Pressable>
  );
}

/** One chat of the list: Chats' rows and Home's (TER-541). The row, its shortcuts and its pin are
 * sibling buttons, so a screen reader reaches each. */
export function ProjectRow({ row, selected, onPress, favorite, actions }: { row: ProjectRowData; selected: boolean; onPress(): void; favorite?: RowFavorite; actions?: RowActions }) {
  const { t } = useTranslation();
  const needsYou = row.needsYou ?? 0;
  const count = row.pending + needsYou;
  const trailing = favorite || actions;
  return (
    <View className={`flex-row items-center border-b border-app-border ${selected ? 'bg-app-surface' : ''}`}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={row.name}
        accessibilityState={{ selected }}
        onPress={onPress}
        onLongPress={favorite?.onLongPress}
        className={`flex-1 flex-row items-center gap-3 py-4 pl-6 ${trailing ? 'pr-2' : 'pr-6'}`}
      >
        <View className="flex-1 gap-0.5">
          <AppText className="font-semibold" numberOfLines={1}>
            {row.name}
          </AppText>
          {row.detail ? <AppText variant="muted">{row.detail}</AppText> : null}
          {row.busy ? <AppText variant="muted" className="text-app-accent">{t('respondendo…')}</AppText> : null}
        </View>
        {count > 0 ? (
          <View
            accessibilityLabel={needsYou > 0 ? t('{{count}} pendências', { count }) : t('{{count}} confirmações pendentes', { count })}
            className="min-w-6 items-center rounded-full bg-app-accent px-2 py-0.5"
          >
            <Text className="text-xs font-semibold text-white">{count}</Text>
          </View>
        ) : null}
        {row.lastMessageAt ? <AppText variant="muted">{relativeTime(row.lastMessageAt, Date.now())}</AppText> : null}
      </Pressable>
      {actions ? (
        <>
          <RowIcon label={t('Sessões de {{name}}', { name: row.name })} onPress={actions.onSessions}>
            <Icon name={LIST} size={18} tone="muted" />
          </RowIcon>
          <RowIcon label={t('Chat de {{name}}', { name: row.name })} onPress={actions.onChat}>
            <Icon name={CHAT} size={18} tone="muted" />
          </RowIcon>
        </>
      ) : null}
      {favorite ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={favorite.pinned ? t('Tirar {{name}} de Favoritos', { name: row.name }) : t('Fixar {{name}} em Favoritos', { name: row.name })}
          accessibilityState={{ selected: favorite.pinned }}
          onPress={favorite.onToggle}
          hitSlop={8}
          className="h-11 w-11 items-center justify-center mr-3"
        >
          <Icon name={favorite.pinned ? PINNED : PIN} size={18} tone={favorite.pinned ? 'accent' : 'muted'} />
        </Pressable>
      ) : actions ? (
        <View className="w-2" />
      ) : null}
    </View>
  );
}
