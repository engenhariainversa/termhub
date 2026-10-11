import { setLocale } from '@/i18n';
import { PERMISSIONS_MSG } from './messages';

afterEach(() => setLocale(null));

it('reads the permission prompts in English, the status table included', () => {
  setLocale('en');
  expect(PERMISSIONS_MSG.pushAccept).toBe('Turn on notifications');
  expect(PERMISSIONS_MSG.notificationStatus.denied).toBe('Off. To get notified, turn them on in the system settings.');
  setLocale('pt-BR');
  expect(PERMISSIONS_MSG.pushAccept).toBe('Ativar notificações');
});
