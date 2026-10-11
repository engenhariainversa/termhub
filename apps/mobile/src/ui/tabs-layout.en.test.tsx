// The tab bar's titles (app/(tabs)/_layout.tsx) in English. The test lives here, not in app/, so
// expo-router never sees it as a route.
import { render } from '@testing-library/react-native';
import type { ReactNode } from 'react';

const mockTitles: string[] = [];
jest.mock('expo-router', () => {
  const Tabs = ({ children }: { children: ReactNode }) => children;
  Tabs.Screen = ({ options }: { options: { title: string } }) => {
    mockTitles.push(options.title);
    return null;
  };
  return { Tabs };
});
jest.mock('expo-symbols', () => ({ SymbolView: () => null }));

import { setLocale } from '@/i18n';
import TabsLayout from '../../app/(tabs)/_layout';

afterEach(() => setLocale(null));

it('titles the tabs in the language the app shows', async () => {
  setLocale('en');
  const { unmount } = await render(<TabsLayout />);
  expect(mockTitles).toEqual(['Home', 'Chats', 'Notifications', 'Progress', 'Settings']);
  await unmount();
  mockTitles.length = 0;
  setLocale('pt-BR');
  await render(<TabsLayout />);
  expect(mockTitles).toEqual(['Home', 'Chats', 'Notificações', 'Progresso', 'Ajustes']);
});
