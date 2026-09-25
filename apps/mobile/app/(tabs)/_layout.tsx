import { Tabs } from 'expo-router';
import { SymbolView, type SymbolViewProps } from 'expo-symbols';
import type { ColorValue } from 'react-native';
import { useNotificationsStore } from '@/features/notifications/viewmodel/useNotificationsStore';

type IosSymbol = Extract<SymbolViewProps['name'], string>;
type AndroidSymbol = NonNullable<Exclude<SymbolViewProps['name'], string>['android']>;

/** SF Symbols on iOS (the selected tab shows the filled variant), Material Symbols on Android. */
const tabIcon =
  (ios: IosSymbol, iosSelected: IosSymbol, android: AndroidSymbol) =>
  ({ color, size, focused }: { color: ColorValue; size: number; focused: boolean }) => (
    <SymbolView name={{ ios: focused ? iosSelected : ios, android }} tintColor={color} size={size} />
  );

/** The three tabs of spec §11.2; Notificações carries the unread count (design spec §7). */
export default function TabsLayout() {
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
      <Tabs.Screen name="index" options={{ title: 'Chats', tabBarIcon: tabIcon('bubble.left.and.bubble.right', 'bubble.left.and.bubble.right.fill', 'forum') }} />
      <Tabs.Screen
        name="notifications"
        options={{ title: 'Notificações', tabBarBadge: unread > 0 ? unread : undefined, tabBarIcon: tabIcon('bell', 'bell.fill', 'notifications') }}
      />
      <Tabs.Screen name="settings" options={{ title: 'Ajustes', tabBarIcon: tabIcon('gearshape', 'gearshape.fill', 'settings') }} />
    </Tabs>
  );
}
