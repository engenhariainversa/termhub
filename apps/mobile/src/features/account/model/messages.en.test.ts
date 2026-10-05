import { setLocale } from '@/i18n';
import { ACCOUNT_MSG, deletionDate } from './messages';

afterEach(() => setLocale(null));

it('writes the deletion copy and its date in English', () => {
  setLocale('en');
  const date = deletionDate(new Date(2026, 9, 31, 12).toISOString())!;
  expect(date).toBe('October 31, 2026');
  expect(ACCOUNT_MSG.pendingOn(date)).toBe('Your account will be deleted on October 31, 2026.');
  expect(ACCOUNT_MSG.confirmWhen).toMatch(/^Your account is deactivated now and permanently deleted in \d+ days\.$/);
  expect(ACCOUNT_MSG.deleteButton).toBe('Delete my account');
  setLocale('pt-BR');
  expect(deletionDate(new Date(2026, 9, 31, 12).toISOString())).toBe('31 de outubro de 2026');
});
