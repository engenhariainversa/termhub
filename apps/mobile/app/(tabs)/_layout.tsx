import { Tabs } from 'expo-router';
import { SymbolView, type SymbolViewProps } from 'expo-symbols';
import type { ColorValue } from 'react-native';
import { useNotificationsStore } from '@/features/notifications/viewmodel/useNotificationsStore';
import { useTranslation } from '@/i18n';

type IosSymbol = Extract<SymbolViewProps['name'], string>;
type AndroidSymbol = NonNullable<Exclude<SymbolViewProps['name'], string>['android']>;

/** SF Symbols on iOS (the selected tab shows the filled variant), Material Symbols on Android. */
const tabIcon =
  (ios: IosSymbol, iosSelected: IosSymbol, android: AndroidSymbol) =>
  ({ color, size, focused }: { color: ColorValue; size: number; focused: boolean }) => (
    <SymbolView name={{ ios: focused ? iosSelected : ios, android }} tintColor={color} size={size} />
  );

/** Home (TER-541) first, where the app opens, then the four tabs of spec §11.2; Notificações carries
 * the unread count (design spec §7). */
export default function TabsLayout() {
  const { t } = useTranslation();
  const unread = useNotificationsStore((s) => s.unread);
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: { backgroundColor: '#0F1320', borderTopColor: '#1F2433' },
        tabBarActiveTintColor: '#7C87F7',
        tabBarInactiveTintColor: '#9CA3AF',
      }}
    >
      <Tabs.Screen name="index" options={{ title: t('Home'), tabBarIcon: tabIcon('house', 'house.fill', 'home') }} />
      <Tabs.Screen name="chats" options={{ title: t('Chats'), tabBarIcon: tabIcon('bubble.left.and.bubble.right', 'bubble.left.and.bubble.right.fill', 'forum') }} />
      <Tabs.Screen
        name="notifications"
        options={{ title: t('Notificações'), tabBarBadge: unread > 0 ? unread : undefined, tabBarIcon: tabIcon('bell', 'bell.fill', 'notifications') }}
      />
      <Tabs.Screen name="progress" options={{ title: t('Progresso'), tabBarIcon: tabIcon('chart.bar', 'chart.bar.fill', 'bar_chart') }} />
      <Tabs.Screen name="settings" options={{ title: t('Ajustes'), tabBarIcon: tabIcon('gearshape', 'gearshape.fill', 'settings') }} />
    </Tabs>
  );
}
