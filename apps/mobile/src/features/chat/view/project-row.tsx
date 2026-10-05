import { Pressable, Text, View } from 'react-native';
import { relativeTime } from '@/features/shared/relative-time';
import { useTranslation } from '@/i18n';
import { AppText, Icon } from '@/ui';

export type ProjectRowData = { route: string; name: string; detail?: string; busy: boolean; pending: number; lastMessageAt: string | null };

/** The pin of a project row (TER-541): the web sidebar's Favoritos. */
export type RowFavorite = { pinned: boolean; onToggle(): void; onLongPress(): void };

const PIN = { ios: 'pin', android: 'keep' } as const;
const PINNED = { ios: 'pin.fill', android: 'keep' } as const;

/** One chat of the list: Chats' rows and Home's (TER-541). The row and its pin are sibling buttons,
 * so a screen reader reaches both. */
export function ProjectRow({ row, selected, onPress, favorite }: { row: ProjectRowData; selected: boolean; onPress(): void; favorite?: RowFavorite }) {
  const { t } = useTranslation();
  return (
    <View className={`flex-row items-center border-b border-app-border ${selected ? 'bg-app-surface' : ''}`}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={row.name}
        accessibilityState={{ selected }}
        onPress={onPress}
        onLongPress={favorite?.onLongPress}
        className={`flex-1 flex-row items-center gap-3 py-4 pl-6 ${favorite ? 'pr-2' : 'pr-6'}`}
      >
        <View className="flex-1 gap-0.5">
          <AppText className="font-semibold" numberOfLines={1}>
            {row.name}
          </AppText>
          {row.detail ? <AppText variant="muted">{row.detail}</AppText> : null}
          {row.busy ? <AppText variant="muted" className="text-app-accent">{t('respondendo…')}</AppText> : null}
        </View>
        {row.pending > 0 ? (
          <View
            accessibilityLabel={t('{{count}} confirmações pendentes', { count: row.pending })}
            className="min-w-6 items-center rounded-full bg-app-accent px-2 py-0.5"
          >
            <Text className="text-xs font-semibold text-white">{row.pending}</Text>
          </View>
        ) : null}
        {row.lastMessageAt ? <AppText variant="muted">{relativeTime(row.lastMessageAt, Date.now())}</AppText> : null}
      </Pressable>
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
      ) : null}
    </View>
  );
}
